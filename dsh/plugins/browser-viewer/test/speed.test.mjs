import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GrowthStore} from '../lib/work-growth.js';
import {NightShift} from '../lib/work-nightshift.js';
import {SpeedTracker,gpuSample,computeApps,probeOnce,taskIndex,compare,describe} from '../lib/work-speed.js';

const store=async()=>new GrowthStore(await mkdtemp(join(tmpdir(),'seek-speed-'))).init();
/** A llama-server stand-in: streams two tokens, then the final chunk with its timings. */
const fakeModel=({decode=50,prefill=900}={})=>{let call=0;return async url=>{
  if(url.endsWith('/v1/models'))return Response.json({data:[{id:'qwen-a',status:{value:'loaded'}}]});
  const d=typeof decode==='function'?decode(call++):decode;
  const chunks=[{choices:[{delta:{role:'assistant'}}]},{choices:[{delta:{content:'Hello'}}]},{choices:[{delta:{content:' there'}}]},{choices:[{delta:{},finish_reason:'length'}],timings:{prompt_n:1400,prompt_per_second:prefill,predicted_n:256,predicted_per_second:d}}];
  return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n');
};};
const quietGpu=(used=20000,util=2)=>async()=>({usedMiB:used,totalMiB:24576,util});
const ours=async()=>[{pid:1,name:'C:\\seek\\llama-server.exe'}];
const tracker=(growth,o={})=>new SpeedTracker({growth,fetchImpl:fakeModel(o),sample:o.sample||quietGpu(),apps:o.apps||ours,settleMs:0,gapMs:0});

test('nvidia-smi readings: memory and utilization of the first GPU, compute apps, nothing without a GPU',async()=>{
  assert.deepEqual(await gpuSample(async()=>'21345, 24576, 7\n'),{usedMiB:21345,totalMiB:24576,util:7});
  assert.equal(await gpuSample(async()=>null),null);
  assert.deepEqual(await computeApps(async()=>'4120, C:\\llama\\llama-server.exe\n77, python.exe\n'),[{pid:4120,name:'C:\\llama\\llama-server.exe'},{pid:77,name:'python.exe'}]);
});

test('one probe: time to first token from the stream, token rates from llama-server',async()=>{
  let t=0;const now=()=>(t+=100);
  const r=await probeOnce({fetchImpl:fakeModel({decode:48.5,prefill:1100}),router:'http://x',model:'m',messages:[],now});
  assert.equal(r.ttftMs,100,'first content token, not the role-only chunk');
  assert.equal(r.decodeTps,48.5);assert.equal(r.prefillTps,1100);assert.equal(r.promptTokens,1400);assert.equal(r.genTokens,256);
});

test('a slower night is flagged against the median of recent quiet nights on the same model',async()=>{
  const g=await store();
  for(const d of [50,52,49])await tracker(g,{decode:d}).measure();
  assert.equal(g.speedHistory().length,3);assert.deepEqual(g.speedHistory()[0].regressions,[],'the first nights only build the baseline');
  const slow=await tracker(g,{decode:38}).measure();
  assert.deepEqual(slow.regressions.map(r=>r.metric),['decodeTps']);assert.equal(slow.regressions[0].baseline,50);
  assert.match(describe(slow.regressions[0]),/generation speed 38 tok\/s \(was 50\)/);
  const fine=await tracker(g,{decode:47}).measure();assert.deepEqual(fine.regressions,[],'within 15% is noise');
});

test('GPU contention: a busy GPU or a foreign GPU app is recorded, never compared and never a baseline',async()=>{
  const g=await store();
  for(const d of [50,51,50])await tracker(g,{decode:d}).measure();
  const busy=await tracker(g,{decode:12,sample:quietGpu(23000,85)}).measure();
  assert.equal(busy.contended,true);assert.match(busy.why,/85% busy/);assert.deepEqual(busy.regressions,[]);
  const other=await tracker(g,{decode:20,apps:async()=>[{pid:9,name:'Game.exe'}]}).measure();
  assert.equal(other.contended,true);assert.match(other.why,/Game\.exe/);
  // Repeated probes that disagree (the 8.2x → 1.5x kind of swing) are not trusted either.
  const shaky=await tracker(g,{decode:i=>[50,50,20,50][i]}).measure();
  assert.equal(shaky.contended,true);assert.match(shaky.why,/disagreed/);
  const next=await tracker(g,{decode:49}).measure();
  assert.deepEqual(next.regressions,[],'contended nights did not drag the baseline down');
  assert.equal(g.speedHistory({model:'qwen-a'}).filter(s=>!s.contended).length,4);
});

test('task time is compared case by case; peak VRAM needs a real jump',async()=>{
  const hist=[{detail:{caseSeconds:{a:100,b:20}}},{detail:{caseSeconds:{a:110,b:22}}},{detail:{caseSeconds:{a:90,b:18}}}];
  assert.equal(taskIndex({a:100,b:20},hist),1);
  assert.equal(taskIndex({a:150,b:30,c:5},hist),1.5,'new cases with no history are ignored');
  const vram=[{peakVramMiB:21000},{peakVramMiB:21100},{peakVramMiB:20900}];
  assert.deepEqual(compare({peakVramMiB:21400},vram),[],'+400 MiB is not a regression');
  assert.deepEqual(compare({peakVramMiB:23500},vram).map(r=>r.metric),['peakVramMiB']);
  assert.deepEqual(compare({taskIndex:1.4},[]).map(r=>r.metric),['taskIndex']);
});

test('night shift: the tests feed task time and peak VRAM to the speed check, and a regression reaches the morning summary once',async()=>{
  const g=await store(),notes=[];let clock={day:'2026-10-04',time:'03:30'};
  const dreaming={flight:null,data:{settings:{enabled:true,time:'03:00'},lastScheduledDay:'2026-10-04'},calendar:()=>clock};
  const engine={store:{tasks:[],settings:{}},save:async()=>{}};
  const runner={run:async()=>{const id=g.startRun({reason:'nightly',total:2});g.addResult(id,{caseId:'a',passed:true,seconds:120});g.addResult(id,{caseId:'b',passed:false,seconds:400});g.finishRun(id,{status:'complete'});return {runId:id,status:'complete',passed:1,total:2,results:g.results(id)};}};
  const speed=tracker(g,{decode:30,sample:quietGpu(22000)});
  for(const d of [50,50,50])g.addSpeed({model:'qwen-a',decodeTps:d,ttftMs:400,prefillTps:900,detail:{caseSeconds:{a:60}}});
  const shift=new NightShift({engine,dreaming,growth:g,runner,speed,improver:{rollbackCheck:()=>[]},proactive:{scan:()=>false,digest:()=>({title:'Good morning — heads up',body:'Dentist'}),prepareCandidates:()=>[]},notify:d=>notes.push(d)});
  shift.start('tests');await shift.flight;
  assert.deepEqual(g.get('speed-tests').caseSeconds,{a:120},'only passed cases count toward task time');
  assert.equal(g.get('speed-tests').peakMiB,22000);
  shift.start('speed');await shift.flight;
  const s=shift.state().steps.speed;assert.equal(s.status,'done');
  const night=g.speedHistory()[0];assert.equal(night.taskIndex,2);assert.equal(night.peakVramMiB,22000);
  assert.deepEqual(night.regressions.map(r=>r.metric).sort(),['decodeTps','taskIndex']);
  assert.ok(shift.status().speed.length>=4,'history is on the report card');
  clock={day:'2026-10-04',time:'08:05'};shift.morningDigest(Date.now());
  assert.equal(notes.length,1);assert.match(notes[0].body,/Dentist · Slower last night: generation speed 30 tok\/s \(was 50\); task time 100% slower/);
  g.set('digest-day',null);shift.morningDigest(Date.now());assert.doesNotMatch(notes.at(-1)?.body||'',/Slower/,'announced once');
});
