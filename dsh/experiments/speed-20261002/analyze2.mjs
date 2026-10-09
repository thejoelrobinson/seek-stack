import {readSession} from './readsession.mjs';
import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
const root='C:/Users/Joel Robinson/.dsh/sessions';
const dirs=readdirSync(root).filter(d=>d.includes('Joel~0020Robinson-.dsh-work-tasks'));
const q=(arr,p)=>{if(!arr.length)return 0;const s=[...arr].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
const compactMs=[],firstTok=[],reasonPerStep=[],stepMs=[],decodeRate=[];
const outByTool={},dupByTool={},afterTool={};let reasonAfterBrowser=[],reasonAfterOther=[];
const waitMs=[];let modelBetweenMs=0,toolBetweenMs=0;
for(const d of dirs)for(const s of readdirSync(join(root,d))){
  const file=join(root,d,s,'session.jsonl.zstd');try{statSync(file);}catch{continue;}
  const ev=readSession(file);if(ev.length<5)continue;
  let cstart=null,lastTool=null;const seen=new Set();const steps=new Map();const calls=new Map();
  for(const e of ev){
    if(e.type==='compaction/start')cstart=e.time;
    if(e.type==='compaction/end'&&cstart){compactMs.push(e.time-cstart);cstart=null;}
    const key=e.data&&(e.data.turn+':'+e.data.step);
    if(e.type==='step/start'){steps.set(key,{start:e.time,reason:0,toks:0,firstTok:null,last:null,prevTool:lastTool});}
    const st=steps.get(key);
    if(st&&(e.type==='reasoning-chunks'||e.type==='text-chunks'||e.type==='tool-call-chunks'||e.type==='assistant/chunk')){
      const n=(e.data.texts||[]).length||1;st.toks+=n;if(e.type==='reasoning-chunks')st.reason+=(e.data.texts||[]).join('').length;
      st.firstTok??=(e.time0||e.time);const dt=(e.data.dt||[]).reduce((a,b)=>a+b,0);st.last=(e.time0||e.time)+dt;
    }
    if(e.type==='step/end'&&st){stepMs.push(e.time-st.start);if(st.firstTok)firstTok.push(st.firstTok-st.start);reasonPerStep.push(st.reason);if(st.firstTok&&st.last&&st.last>st.firstTok&&st.toks>50)decodeRate.push(st.toks/((st.last-st.firstTok)/1000));
      const browser=/^viewer_/.test(st.prevTool||'');(browser?reasonAfterBrowser:reasonAfterOther).push(st.reason);}
    if(e.type==='tool/call'){const sig=e.data.name+e.data.arguments;if(seen.has(sig))dupByTool[e.data.name]=(dupByTool[e.data.name]||0)+1;seen.add(sig);lastTool=e.data.name;calls.set(e.data.callId,{name:e.data.name,t:e.time});}
    if(e.type==='tool/result'){const id=e.data?.message?.content?.[0]?.toolCallId,c=calls.get(id);if(c){const len=JSON.stringify(e.data.message.content).length;(outByTool[c.name]||=[]).push(len);if(c.name==='viewer_wait')waitMs.push(e.time-c.t);}}
  }
}
const ksum=a=>Math.round(a.reduce((x,y)=>x+y,0)/1000);
console.log('compactions',compactMs.length,'total min',(compactMs.reduce((a,b)=>a+b,0)/60000).toFixed(0),'p50 s',(q(compactMs,.5)/1000).toFixed(0),'p95 s',(q(compactMs,.95)/1000).toFixed(0));
console.log('first token s p50/p90/p99',[.5,.9,.99].map(p=>(q(firstTok,p)/1000).toFixed(1)),'steps',firstTok.length,'>20s',firstTok.filter(x=>x>20000).length);
console.log('step s p50/p90',[.5,.9].map(p=>(q(stepMs,p)/1000).toFixed(1)));
console.log('decode tok/s p50',q(decodeRate,.5).toFixed(0));
console.log('reasoning chars/step p50/p90/p99',[.5,.9,.99].map(p=>q(reasonPerStep,p)));
console.log('reason after browser tool p50/p90',[.5,.9].map(p=>q(reasonAfterBrowser,p)),'n',reasonAfterBrowser.length,'total K',ksum(reasonAfterBrowser));
console.log('reason after other p50/p90',[.5,.9].map(p=>q(reasonAfterOther,p)),'n',reasonAfterOther.length,'total K',ksum(reasonAfterOther));
console.log('viewer_wait ms total min',(waitMs.reduce((a,b)=>a+b,0)/60000).toFixed(1),'n',waitMs.length);
console.log('output by tool (K chars total, p50, p90, n):');
for(const [k,v] of Object.entries(outByTool).sort((a,b)=>ksum(b[1])-ksum(a[1])).slice(0,15))console.log(' ',k,ksum(v),q(v,.5),q(v,.9),v.length);
console.log('dupes by tool',Object.entries(dupByTool).sort((a,b)=>b[1]-a[1]).slice(0,12));
