// Lists file edits/writes and shell commands a Work task's session made (to recover lost edits).
import {readdirSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readSession} from './readsession.mjs';
const [taskId,dump]=process.argv.slice(2);const root='C:/Users/Joel Robinson/.dsh/sessions';
for(const d of readdirSync(root).filter(d=>d.includes(taskId)))for(const s of readdirSync(join(root,d))){
  const f=join(root,d,s,'session.v4.jsonl.zstd');try{statSync(f);}catch{continue;}
  const ev=readSession(f),calls=new Map(),edits=[];
  for(const e of ev){
    if(e.type==='tool/call'&&/^(edit|write|pwsh)$/.test(e.data.name)){let a;try{a=JSON.parse(e.data.arguments);}catch{a={};}calls.set(e.data.callId,{name:e.data.name,a,time:e.time});}
    if(e.type==='tool/result'){const c=e.data?.message?.content?.[0],call=c&&calls.get(c.toolCallId);if(call){const ok=!e.data.message.content[0].isError;edits.push({...call,ok,result:JSON.stringify(c.content).slice(0,140)});}}
  }
  console.log('session',s,'events',ev.length);
  for(const x of edits)console.log(new Date(x.time).toLocaleTimeString(),x.name,x.ok?'ok':'ERR',(x.a.file_path||x.a.path||'')+' '+String(x.a.command||'').slice(0,160).replace(/\s+/g,' '),'|',x.result.slice(0,90));
  if(dump)writeFileSync(dump,JSON.stringify(edits.filter(x=>x.name!=='pwsh').map(x=>({name:x.name,ok:x.ok,args:x.a,time:x.time})),null,1));
}
