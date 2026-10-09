// Where does a browser task's time go? Per step: model time (prefill + reasoning + output) vs
// tool time, plus tokens (new prompt tokens, cache hits, output) and observation sizes by tool.
// Usage: node browser-time.mjs <taskIdPrefix>
import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {readSession} from './readsession.mjs';
const root='C:/Users/Joel Robinson/.dsh/sessions',prefix=process.argv[2];
const files=[];for(const d of readdirSync(root).filter(d=>d.includes(prefix)))for(const s of readdirSync(join(root,d))){const f=join(root,d,s,'session.v4.jsonl.zstd');try{files.push({f,t:statSync(f).mtimeMs,s});}catch{}}
files.sort((a,b)=>a.t-b.t);
const byTool={},T={model:0,tool:0,steps:0,input:0,cache:0,output:0,reasoningChars:0,textChars:0,overflow:0,wall:0};
for(const {f,s} of files){
  const ev=readSession(f);let stepStart=null,first=null,last=null;const calls=new Map();
  for(const e of ev){
    if(!first&&e.time)first=e.time;if(e.time)last=e.time;
    if(e.type==='step/start')stepStart=e.time;
    if(e.type==='assistant/message'){
      const u=e.data?.message?.source?.replayState?.response?.usage||e.data?.usage||null;
      const usage=u||findUsage(e.data);
      if(stepStart){T.model+=e.time-stepStart;T.steps++;}
      if(usage){T.input+=usage.inputTokens||0;T.cache+=usage.cacheReadTokens||0;T.output+=usage.outputTokens||0;}
      for(const c of e.data?.message?.content||[]){if(c.type==='reasoning')T.reasoningChars+=String(c.text||'').length;if(c.type==='text')T.textChars+=String(c.text||'').length;}
    }
    if(e.type==='tool/call')calls.set(e.data.callId,{name:e.data.name,at:e.time});
    if(e.type==='tool/result'){const id=e.data?.message?.toolCallId||e.data?.message?.content?.[0]?.toolCallId;const c=calls.get(id);if(c){calls.delete(id);// compaction re-emits results under the same id; only the first is the real one
      const ms=e.time-c.at,size=JSON.stringify(e.data?.message?.content||'').length;const b=byTool[c.name]??={n:0,ms:0,chars:0,max:0};b.n++;b.ms+=ms;b.chars+=size;b.max=Math.max(b.max,size);T.tool+=ms;}}
    if(e.type==='turn/end'&&/context/i.test(JSON.stringify(e.data?.reason||'')))T.overflow++;
  }
  T.wall+=(last-first);console.log(`session ${s.slice(8,16)}: ${ev.length} events, ${Math.round((last-first)/1000)}s`);
}
function findUsage(o){if(!o||typeof o!=='object')return null;if(o.usage&&typeof o.usage==='object'&&'inputTokens' in o.usage)return o.usage;for(const v of Object.values(o)){const u=findUsage(v);if(u)return u;}return null;}
const s=x=>Math.round(x/1000);
console.log(`\nwall ${s(T.wall)}s | model ${s(T.model)}s (${Math.round(T.model/T.wall*100)}%) | tools ${s(T.tool)}s (${Math.round(T.tool/T.wall*100)}%) | model turns ${T.steps} | avg model turn ${(T.model/T.steps/1000).toFixed(1)}s`);
console.log(`tokens: new prompt ${T.input} | cache hits ${T.cache} | output ${T.output} (avg ${Math.round(T.output/T.steps)}/turn) | reasoning chars ${T.reasoningChars} | visible text chars ${T.textChars} | context overflows ${T.overflow}`);
console.log('\ntool'.padEnd(26),'calls','total s','avg s','avg obs chars','max obs chars');
for(const [k,b] of Object.entries(byTool).sort((a,b)=>b[1].ms-a[1].ms))console.log(k.padEnd(25),String(b.n).padStart(5),String(s(b.ms)).padStart(7),(b.ms/b.n/1000).toFixed(1).padStart(6),String(Math.round(b.chars/b.n)).padStart(13),String(b.max).padStart(13));
