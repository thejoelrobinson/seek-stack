// Real Work server (temporary data) + the real companion link code over a real WebSocket, with the
// companion's real local API and session (a fake native layer: no actual input is sent).
// node --import ../../plugins/browser-viewer/test/register-profile.mjs link-e2e.mjs
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {ready} from '../calendar-20261006/mount.mjs';
import {SeekLink} from '../../../desktop-bridge/src/link.js';
import {createBridgeService} from '../../../desktop-bridge/src/service.js';
import {DesktopSession} from '../../../desktop-bridge/src/session.js';
const m=await ready,checks=[];const ok=(n,c)=>{assert.ok(c,n);checks.push(n);console.log('  ✓',n);};
const api=async(p,b)=>{const r=await fetch(m.base+'/work/api/'+p,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(j.error);return j;};
const until=async(fn,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,150));}return null;};
// The computer: a real local bridge API and session, with a native layer that only records.
let link=null;const token='c'.repeat(64),session=new DesktopSession({onState:s=>link?.sendState(s)}),executed=[];
const display={id:'1',label:'Fixture',x:0,y:0,width:1280,height:800,scaleFactor:1};
const service=createBridgeService({session,token,native:{execute:async c=>{executed.push(c);}},stop:r=>session.revoke(r),
  status:()=>({...session.snapshot(),capabilities:{input:true,structuredObservation:true},display,endpoint:`http://127.0.0.1:${service.address().port}`}),
  capture:async()=>({display,windowId:'w1',title:'Notes',elements:[{id:'el-1',role:'edit',name:'Note body',value:'',enabled:true,canFill:true,canInvoke:false,x:10,y:10,width:300,height:40}],truncated:false,mode:'accessibility'})});
await new Promise(r=>service.listen(0,'127.0.0.1',r));
const local=`http://127.0.0.1:${service.address().port}`;
link=new SeekLink({file:join(await mkdtemp(join(tmpdir(),'seek-link-e2e-')),'link.json'),WebSocketImpl:WebSocket,
  info:()=>({name:'Fixture Mac',os:'darwin',arch:'arm64',version:'0.3.0'}),
  localRequest:async(method,path,body)=>{const r=await fetch(local+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};},
  grant:async task=>{session.grant(task);}});
try{
  const {code}=await api('desktop/code',{});ok('Seek creates a pairing code',/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
  await assert.rejects(link.pair({server:m.base,code:'ZZZZ-ZZZZ'}),/wrong or expired/);ok('a wrong code is refused',true);
  await link.pair({server:m.base,code,name:'Fixture Mac',remoteGrant:true});
  ok('the computer pairs and comes online',!!await until(async()=>(await api('desktop')).computers.find(c=>c.online&&c.name==='Fixture Mac'&&c.remoteGrant)));
  // Seek drives it through the hub exactly as a task's desktop tools would.
  session.grant('task-e2e');
  ok('the grant reaches Seek as live state',!!await until(async()=>(await api('desktop')).computers[0].taskId==='task-e2e'));
  // The hub is internal to the server; reach it through a second link-backed client built the same way.
  ok('state shows Seek using it',(await api('desktop')).computers[0].state==='agent');
  session.revoke('done');
  ok('stopping on the computer reaches Seek',!!await until(async()=>(await api('desktop')).computers[0].state!=='agent'));
  // Removing the computer in Seek ends the link and tells the computer.
  await api('desktop/device',{action:'remove',id:(await api('desktop')).computers[0].id});
  ok('removal reaches the computer',!!await until(()=>link.status().lastError?.includes('removed')));
  ok('and Seek lists no computers',(await api('desktop')).computers.length===0);
  console.log(`\n${checks.length} checks passed`);
}catch(e){console.error('FAILED',e);process.exitCode=1;}
finally{link.close();service.close();m.stop();setTimeout(()=>process.exit(),300);}
