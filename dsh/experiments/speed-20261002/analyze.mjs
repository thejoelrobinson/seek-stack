import {readSession} from './readsession.mjs';
import {readdirSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root='C:/Users/Joel Robinson/.dsh/sessions';
const dirs=readdirSync(root).filter(d=>d.includes('Joel~0020Robinson-.dsh-work-tasks'));
const rows=[],toolTotals={},stepRows=[];
for(const d of dirs){
  for(const s of readdirSync(join(root,d))){
    const file=join(root,d,s,'session.jsonl.zstd');try{statSync(file);}catch{continue;}
    const ev=readSession(file);if(ev.length<5)continue;
    const steps=new Map();
    const stepOf=e=>{const k=(e.data?.turn??0)+':'+(e.data?.step??0);if(!steps.has(k))steps.set(k,{reasoning:0,text:0,toolArgs:0,tools:[],toolMs:0,firstTok:null});return steps.get(k);};
    let compactions=0,searches=0,userMsgs=0,firstTime=ev.find(e=>e.time)?.time,lastTime=0;const calls=new Map();
    for(const e of ev){
      const t=e.time||e.time0;if(t)lastTime=Math.max(lastTime,t);
      if(e.type==='step/start')Object.assign(stepOf(e),{start:e.time});
      if(e.type==='step/end')Object.assign(stepOf(e),{end:e.time});
      if(e.type==='reasoning-chunks'){const st=stepOf(e);st.reasoning+=e.data.texts.join('').length;st.firstTok??=e.time0;}
      if(e.type==='text-chunks'||e.type==='assistant/chunk'){const st=stepOf(e);const txt=e.data?.texts?e.data.texts.join(''):(e.data?.text||e.data?.delta||'');st.text+=String(txt).length;st.firstTok??=(e.time0||e.time);}
      if(e.type==='tool-call-chunks'){const st=stepOf(e);st.toolArgs+=(e.data?.texts||[]).join('').length;st.firstTok??=e.time0;}
      if(e.type==='tool/call'){const st=stepOf(e);st.tools.push(e.data.name);calls.set(e.data.callId,{t:e.time,name:e.data.name,args:e.data.arguments});toolTotals[e.data.name]=(toolTotals[e.data.name]||0)+1;}
      if(e.type==='tool/result'){const id=e.data?.message?.content?.[0]?.toolCallId;const c=calls.get(id);if(c){c.ms=e.time-c.t;c.out=JSON.stringify(e.data.message.content).length;}}
      if(e.type==='compaction/start')compactions++;
      if(e.type==='web/deepseek-search-llm-request')searches++;
      if(e.type==='user/message')userMsgs++;
    }
    // Repeated identical calls (same name+args).
    const sig=new Map();for(const c of calls.values()){const k=c.name+c.args;sig.set(k,(sig.get(k)||0)+1);}
    const dupes=[...sig.values()].filter(n=>n>1).reduce((a,n)=>a+n-1,0);
    let gen=0,prefillWait=0,reasonChars=0,textChars=0,argChars=0;
    for(const st of steps.values()){if(st.start&&st.end){gen+=st.end-st.start;}if(st.start&&st.firstTok)prefillWait+=Math.max(0,st.firstTok-st.start);reasonChars+=st.reasoning;textChars+=st.text;argChars+=st.toolArgs;stepRows.push({task:d.slice(-38,-2),...st,ms:st.end-st.start});}
    const toolMs=[...calls.values()].reduce((a,c)=>a+(c.ms||0),0),toolOut=[...calls.values()].reduce((a,c)=>a+(c.out||0),0);
    rows.push({task:d.slice(-38,-2).slice(0,8),session:s.slice(8,16),wallMin:+((lastTime-firstTime)/60000).toFixed(1),steps:steps.size,calls:calls.size,dupes,compactions,searches,userMsgs,stepMin:+(gen/60000).toFixed(1),toolMin:+(toolMs/60000).toFixed(1),firstTokMin:+(prefillWait/60000).toFixed(1),reasonK:Math.round(reasonChars/1000),textK:Math.round(textChars/1000),argK:Math.round(argChars/1000),toolOutK:Math.round(toolOut/1000)});
  }
}
rows.sort((a,b)=>b.wallMin-a.wallMin);
console.table(rows);
const sum=k=>rows.reduce((a,r)=>a+r[k],0);
console.log('TOTAL',{sessions:rows.length,wallMin:sum('wallMin').toFixed(0),stepMin:sum('stepMin').toFixed(0),toolMin:sum('toolMin').toFixed(0),firstTokMin:sum('firstTokMin').toFixed(0),steps:sum('steps'),calls:sum('calls'),dupes:sum('dupes'),compactions:sum('compactions'),reasonK:sum('reasonK'),textK:sum('textK'),argK:sum('argK'),toolOutK:sum('toolOutK')});
console.log(Object.entries(toolTotals).sort((a,b)=>b[1]-a[1]).slice(0,30));
writeFileSync(new URL('./steps.json',import.meta.url),JSON.stringify(stepRows));
