import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {WorkResultStore} from '../lib/work-results.js';
const out=process.argv[2];
async function api(path,body){const r=await fetch('http://127.0.0.1:3080/work/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;}
const task=await api('task',{mode:'chat',runAt:new Date(Date.now()+86400000).toISOString(),objective:'Authorized isolated Work integration fixture. Using the saved response reference in my next message, call apps_read with app="saved", tool=that ref, args={operation:"query",path:"rows",mode:"sum_integer",field:"amountCents"}. Return the exact total. This is synthetic local data; no connected app or browser interaction is needed.'});
const rows=Array.from({length:777},(_,id)=>({id,amountCents:(id*29)%999-377})),expected=rows.reduce((s,r)=>s+BigInt(r.amountCents),0n).toString();
const receipt=await new WorkResultStore(task.cwd).capture({app:'fixture',tool:'list_rows',content:[{type:'text',text:JSON.stringify({rows,nextCursor:null})}]});
await api('control',{id:task.id,action:'reply',answer:'Saved response reference: '+receipt.saved.ref});const start=Date.now();let completed=false;
try{while(Date.now()-start<180000){await new Promise(r=>setTimeout(r,1000));const current=(await api('state')).tasks.find(t=>t.id===task.id);if(['attention','waiting','stopped'].includes(current.status))throw new Error('Task stopped: '+(current.error||current.question?.text||current.status));if(current.status==='complete'){completed=true;const answer=String(current.result||''),correct=answer.includes(expected);const result={taskId:task.id,sessionId:current.sessionId,expected,answer,correct,elapsedMs:Date.now()-start};await writeFile(join(out,'work-live.json'),JSON.stringify(result,null,2));console.log(result);if(!correct)process.exitCode=1;break;}}
 if(!completed)throw new Error('Live Work integration timed out');
}finally{if(!completed)await api('control',{id:task.id,action:'stop'}).catch(()=>{});}
