// Speed and memory over time. After the nightly task tests, a fixed probe asks the local model the
// same thing several times and records time to first token, prefill and decode tokens/sec and peak
// VRAM; the task tests add end-to-end task time and their own peak VRAM. Each night is compared with
// the median of recent quiet nights on the same model, so a slower build or a heavier context shows
// up as a number instead of a hunch.
// Contention is controlled, not ignored: the fast-lane benchmark once swung from 8.2x to 1.5x
// between runs because something else had the GPU. Before and after measuring, the GPU must be
// idle (low utilization, no other compute app); repeated probes must agree with each other. A
// night that fails either check is kept with the reason, but never becomes a baseline or an alarm.
import {execFile} from 'node:child_process';

const ROUTER=process.env.SEEK_MODEL_URL||'http://127.0.0.1:18798';
/** Ratios to the recent median that count as a regression (VRAM also needs +512 MiB). */
export const SPEED_LIMITS={ttftMs:1.25,prefillTps:0.8,decodeTps:0.85,taskIndex:1.25,peakVramMiB:1.1,probeVramMiB:1.1};
const TEST_METRICS=new Set(['taskIndex','peakVramMiB']);
const HIGHER_IS_WORSE=new Set(['ttftMs','taskIndex','peakVramMiB','probeVramMiB']);
export const SPEED_LABELS={ttftMs:'time to first token',prefillTps:'prompt speed',decodeTps:'generation speed',taskIndex:'task time',peakVramMiB:'peak VRAM in task tests',probeVramMiB:'peak VRAM'};
const IDLE_UTIL=15;      // % utilization with nothing of Seek's running; above it, something else has the GPU
const SPREAD=1.3;        // repeated probes further apart than this are too noisy to compare
const BASELINE_NIGHTS=7, MIN_NIGHTS=3;
const OURS=/llama|ggml/i; // compute apps that are Seek's own model server

const median=xs=>{const s=xs.filter(Number.isFinite).sort((a,b)=>a-b);if(!s.length)return null;const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const round=(n,d=1)=>Number.isFinite(n)?Math.round(n*10**d)/10**d:null;
const wait=(ms,signal)=>new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(signal.reason||new Error('aborted'));},{once:true});});

export function nvidiaSmi(args,{timeoutMs=5000}={}){
  return new Promise(resolve=>{try{execFile('nvidia-smi',args,{timeout:timeoutMs,windowsHide:true},(err,stdout)=>resolve(err?null:String(stdout)));}catch{resolve(null);}});
}
/** First GPU's memory and utilization, and the compute apps on it; null without nvidia-smi. */
export async function gpuSample(run=nvidiaSmi){
  const out=await run(['--query-gpu=memory.used,memory.total,utilization.gpu','--format=csv,noheader,nounits']);
  const row=out?.split(/\r?\n/).find(l=>l.trim());if(!row)return null;
  const [used,total,util]=row.split(',').map(s=>Number(s.trim()));if(!Number.isFinite(used))return null;
  return {usedMiB:used,totalMiB:Number.isFinite(total)?total:null,util:Number.isFinite(util)?util:null};
}
export async function computeApps(run=nvidiaSmi){
  const out=await run(['--query-compute-apps=pid,process_name','--format=csv,noheader']);
  return (out||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(l=>{const [pid,...name]=l.split(',');return {pid:Number(pid),name:name.join(',').trim()};});
}

/** Samples the GPU in the background; stop() gives the peak memory seen. */
export class GpuMonitor {
  constructor({sample=gpuSample,everyMs=1000}={}){this.sample=sample;this.everyMs=everyMs;this.peakMiB=null;this.samples=0;this.timer=null;this.busy=null;}
  start(){const tick=()=>{if(this.busy)return;this.busy=this.sample().then(s=>{if(s){this.samples++;this.peakMiB=Math.max(this.peakMiB??0,s.usedMiB);}}).catch(()=>{}).finally(()=>{this.busy=null;});};tick();this.timer=setInterval(tick,this.everyMs);this.timer.unref?.();return this;}
  async stop(){clearInterval(this.timer);this.timer=null;await this.busy;return {peakMiB:this.peakMiB,samples:this.samples};}
}

/** A fixed prompt (~1.5k tokens): the same work every night, so only the system changes. */
export function probePrompt(){
  const rows=Array.from({length:60},(_,i)=>`${String(i+1).padStart(2,'0')},${['Lamp','Mug','Notebook','Candle','Scarf','Planter'][i%6]} ${i+1},${((i*37)%89+5).toFixed(2)},${['in stock','low stock','out of stock'][i%3]}`).join('\n');
  return [{role:'system',content:'You are a careful assistant. Answer in plain prose.'},
    {role:'user',content:`Here is an inventory export (id,name,price,stock):\n${rows}\n\nWrite a short report for a store manager: which items need restocking, which are the most and least expensive, and two suggestions. About 200 words.`}];
}

/** One streamed request; time to first token is measured here, token rates come from llama-server. */
export async function probeOnce({fetchImpl=globalThis.fetch,router=ROUTER,model,messages,maxTokens=256,signal,now=()=>performance.now()}){
  const t0=now();
  const res=await fetchImpl(`${router}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},signal,
    body:JSON.stringify({model,messages,stream:true,max_tokens:maxTokens,n_predict:maxTokens,ignore_eos:true,temperature:0,seed:7,cache_prompt:false,stream_options:{include_usage:true},chat_template_kwargs:{enable_thinking:false}})});
  if(!res.ok)throw new Error(`The local model returned ${res.status}.`);
  let first=null,timings=null,usage=null,pieces=0,buffer='';
  const decoder=new TextDecoder(),reader=res.body.getReader();
  const line=l=>{if(!l.startsWith('data:'))return;const data=l.slice(5).trim();if(!data||data==='[DONE]')return;let j;try{j=JSON.parse(data);}catch{return;}
    const d=j.choices?.[0]?.delta||{};if(first===null&&(d.content||d.reasoning_content))first=now();if(d.content||d.reasoning_content)pieces++;
    if(j.timings)timings=j.timings;if(j.usage)usage=j.usage;};
  for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop();lines.forEach(line);}
  if(buffer)line(buffer);
  const end=now();if(first===null)throw new Error('The local model streamed no tokens.');
  const genTokens=timings?.predicted_n??usage?.completion_tokens??pieces,promptTokens=timings?.prompt_n??usage?.prompt_tokens??null;
  return {ttftMs:first-t0,wallMs:end-t0,promptTokens,genTokens,
    prefillTps:timings?.prompt_per_second??null,
    decodeTps:timings?.predicted_per_second??(end>first?(genTokens-1)/((end-first)/1000):null)};
}

export class SpeedTracker {
  constructor({growth,fetchImpl=globalThis.fetch,sample=gpuSample,apps=computeApps,queue=null,router=ROUTER,reps=3,settleMs=20000,gapMs=700,log=console}){
    Object.assign(this,{growth,fetchImpl,sample,apps,queue,router,reps,settleMs,gapMs,log});
  }
  async model(){
    try{const {data}=await (await this.fetchImpl(`${this.router}/v1/models`,{signal:AbortSignal.timeout(5000)})).json();return (data.find(m=>m.status?.value==='loaded')||data.find(m=>m.id==='qwen3.8-27b')||data[0])?.id||null;}
    catch{return null;}
  }
  /** Is the GPU quiet? A few samples while Seek itself is idle; retried briefly before giving up. */
  async idle(signal,{tries=3}={}){
    let last;
    for(let i=0;i<tries;i++){
      if(i)await wait(this.settleMs,signal);
      const samples=[];for(let k=0;k<3;k++){if(k)await wait(this.gapMs,signal);const s=await this.sample().catch(()=>null);if(s)samples.push(s);}
      if(!samples.length)return {gpu:false,contended:false,why:null};
      const util=median(samples.map(s=>s.util)),others=(await this.apps().catch(()=>[])).filter(a=>!OURS.test(a.name)).map(a=>a.name);
      const why=[util!==null&&util>IDLE_UTIL?`GPU ${util}% busy before measuring`:null,others.length?`other GPU apps: ${[...new Set(others)].slice(0,3).join(', ')}`:null].filter(Boolean);
      last={gpu:true,util,usedMiB:median(samples.map(s=>s.usedMiB)),others,contended:why.length>0,why:why.join('; ')||null};
      if(!last.contended)return last;
    }
    return last;
  }
  /** Watches a stretch of work (the task tests) for peak VRAM. */
  watch(){return new GpuMonitor({sample:this.sample}).start();}
  /** The probe itself: one warm-up, then `reps` measured requests, while sampling VRAM. */
  async probe(signal){
    const model=await this.model();if(!model)throw new Error('The local model is not reachable.');
    const run=async(queueSignal)=>{
      const s=queueSignal?AbortSignal.any([signal,queueSignal].filter(Boolean)):signal,messages=probePrompt();
      await probeOnce({fetchImpl:this.fetchImpl,router:this.router,model,messages,maxTokens:32,signal:s});
      const monitor=this.watch(),runs=[];
      try{for(let i=0;i<this.reps;i++){s?.throwIfAborted();runs.push(await probeOnce({fetchImpl:this.fetchImpl,router:this.router,model,messages,signal:s}));}}
      catch(e){await monitor.stop();throw e;}
      return {model,runs,gpu:await monitor.stop()};
    };
    return this.queue?this.queue.submit(run,{priority:0,signal,label:'speed-probe'}):run();
  }
  /** Tonight's numbers: the probe, plus end-to-end task time and peak VRAM from tonight's tests. */
  async measure({signal,tests=null}={}){
    const before=await this.idle(signal);
    const {model,runs,gpu}=await this.probe(signal);
    const after=await this.idle(signal,{tries:1});
    const decode=runs.map(r=>r.decodeTps).filter(Number.isFinite),spread=decode.length>1?Math.max(...decode)/Math.max(0.001,Math.min(...decode)):1;
    const why=[before.contended?before.why:null,after.contended?after.why.replace('before','after'):null,spread>SPREAD?`repeated runs disagreed (${spread.toFixed(2)}×)`:null].filter(Boolean);
    const caseSeconds=tests?.caseSeconds||null;
    const sample={model,contended:why.length>0,why:why.join('; ')||null,
      ttftMs:round(median(runs.map(r=>r.ttftMs)),0),prefillTps:round(median(runs.map(r=>r.prefillTps))),decodeTps:round(median(decode)),
      probeVramMiB:gpu.peakMiB,peakVramMiB:tests?.peakMiB??null,taskSeconds:caseSeconds?round(Object.values(caseSeconds).reduce((a,b)=>a+b,0)):null,
      detail:{runs:runs.map(r=>({ttftMs:round(r.ttftMs,0),decodeTps:round(r.decodeTps),prefillTps:round(r.prefillTps),promptTokens:r.promptTokens,genTokens:r.genTokens})),
        spread:round(spread,2),gpu:before.gpu,caseSeconds,testsContended:tests?.contended||false,testsWhy:tests?.why||null,testsRunId:tests?.runId||null}};
    const history=this.growth.speedHistory({model,limit:BASELINE_NIGHTS*3}).filter(s=>!s.contended);
    sample.taskIndex=taskIndex(caseSeconds,history.filter(s=>!s.detail?.testsContended).slice(0,BASELINE_NIGHTS));
    // Task time and test VRAM are only as clean as the test run they came from.
    sample.regressions=sample.contended?[]:compare(sample,history).filter(r=>!(tests?.contended&&TEST_METRICS.has(r.metric)));
    sample.id=this.growth.addSpeed(sample);
    return sample;
  }
}

/** Geometric mean, over cases passed tonight, of tonight's time ÷ that case's recent median. */
export function taskIndex(caseSeconds,history){
  if(!caseSeconds)return null;
  const ratios=Object.entries(caseSeconds).map(([id,sec])=>{const m=median(history.map(h=>h.detail?.caseSeconds?.[id]));return m&&sec>0?sec/m:null;}).filter(Number.isFinite);
  return ratios.length?round(Math.exp(ratios.reduce((a,r)=>a+Math.log(r),0)/ratios.length),3):null;
}

/** Each metric against the median of the last few quiet nights on the same model. */
export function compare(sample,history){
  const out=[];
  for(const [metric,limit] of Object.entries(SPEED_LIMITS)){
    const now=sample[metric];if(!Number.isFinite(now))continue;
    // The task index is already a ratio to recent nights; 1 is the baseline.
    const past=metric==='taskIndex'?null:history.filter(h=>!(TEST_METRICS.has(metric)&&h.detail?.testsContended)).map(h=>h[metric]).filter(Number.isFinite).slice(0,BASELINE_NIGHTS);
    if(past&&past.length<MIN_NIGHTS)continue;
    const base=metric==='taskIndex'?1:median(past),ratio=now/base;
    const worse=HIGHER_IS_WORSE.has(metric)?ratio>limit:ratio<limit;
    if(worse&&(!/Vram/.test(metric)||now-base>=512))out.push({metric,label:SPEED_LABELS[metric],now,baseline:round(base,metric==='taskIndex'?3:1),ratio:round(ratio,2)});
  }
  return out;
}

/** "generation speed 38 tok/s (was 49)" — for the journal, the report card and the morning summary. */
export function describe(r){
  const unit={ttftMs:' ms',prefillTps:' tok/s',decodeTps:' tok/s',peakVramMiB:' MiB',probeVramMiB:' MiB'}[r.metric];
  if(r.metric==='taskIndex')return `${r.label} ${Math.round((r.ratio-1)*100)}% slower`;
  return `${r.label} ${Math.round(r.now)}${unit} (was ${Math.round(r.baseline)})`;
}
