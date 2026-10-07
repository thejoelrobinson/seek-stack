import test from 'node:test';import assert from 'node:assert/strict';
import {DesktopSession} from '../src/session.js';import {createBridgeService} from '../src/service.js';
test('HTTP boundary fences browsers, replay, takeover and stale stop',async t=>{
 const session=new DesktopSession(),auth=session.grant('task'),calls=[];
 const server=createBridgeService({session,token:'secret',status:()=>({...session.snapshot(),capabilities:{input:true}}),capture:async()=>({display:{x:0,y:0,width:100,height:100},image:'data:image/png;base64,AA=='}),native:{execute:async c=>calls.push(c)},stop:()=>session.revoke()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}`;
 const request=(path,body,headers={})=>fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer secret','Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
 assert.equal((await fetch(url+'/status')).status,403);
 assert.equal((await request('/status',null,{Origin:'https://seek.joelcrobinson.com'})).status,403);
 const observation=await (await request('/observe',auth)).json();
 const action={...auth,command:{kind:'click',x:10,y:20,observationId:observation.id,extra:'ignored'}};
 assert.equal((await request('/action',action)).status,200);
 assert.equal((await request('/action',action)).status,409);assert.equal(calls.length,1);assert.equal(calls[0].extra,undefined);
 session.revoke();session.grant('next');assert.equal((await request('/stop',auth)).status,409);assert.equal(session.taskId,'next');
});
test('takeover while capture is pending invalidates its result',async t=>{
 const session=new DesktopSession(),auth=session.grant('task');let finish,started;
 const ready=new Promise(r=>started=r),frame=new Promise(r=>finish=r);
 const server=createBridgeService({session,token:'x',status:()=>session.snapshot(),native:{},stop:()=>session.revoke(),capture:()=>{started();return frame;}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const response=fetch(`http://127.0.0.1:${server.address().port}/observe`,{method:'POST',headers:{Authorization:'Bearer x','Content-Type':'application/json'},body:JSON.stringify(auth)});
 await ready;session.revoke();finish({display:{x:0,y:0,width:1,height:1}});assert.equal((await response).status,409);
});
