import {WorkModelQueue} from '../lib/work-model-queue.js';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Slot {
 constructor(){this.jobs=[];this.active=null;}
 run(ms,signal){return new Promise((resolve,reject)=>{const job={ms,signal,resolve,reject};job.cancel=()=>{clearTimeout(job.timer);this.jobs=this.jobs.filter(j=>j!==job);if(this.active===job)this.active=null;reject(signal.reason);this.pump();};signal?.addEventListener('abort',job.cancel,{once:true});this.jobs.push(job);this.pump();});}
 pump(){if(this.active||!this.jobs.length)return;const job=this.jobs.shift();this.active=job;job.timer=setTimeout(()=>{job.signal?.removeEventListener('abort',job.cancel);this.active=null;job.resolve();this.pump();},job.ms);}
}
const results=[];
for(let round=0;round<10;round++)for(const arm of round%2?['priority','current']:['current','priority']){
 const slot=new Slot();let busy=false;const q=new WorkModelQueue({busy:()=>busy,pollMs:5}),duration=40+(round%3)*10;
 const helpers=Array.from({length:3},()=>arm==='current'?slot.run(duration):q.submit(signal=>slot.run(duration,signal)));
 await sleep(5);const started=performance.now();busy=true;if(arm==='priority')q.wake();await slot.run(15);const foregroundMs=Math.round(performance.now()-started);busy=false;q.wake();await Promise.all(helpers);q.close();results.push({round,arm,foregroundMs});
}
const summary={};for(const arm of ['current','priority']){const times=results.filter(r=>r.arm===arm).map(r=>r.foregroundMs).sort((a,b)=>a-b);summary[arm]={trials:times.length,medianMs:times[5],p95Ms:times[9]};}
assert.ok(summary.priority.p95Ms<summary.current.medianMs/2,'Priority queue must materially reduce controlled foreground wait');
await writeFile(join(process.argv[2],'queue-comparison.json'),JSON.stringify({note:'Controlled single-slot simulation with cancellable jobs; these timings are not GPU benchmarks.',summary,results},null,2));console.log(summary);
