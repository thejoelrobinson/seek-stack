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
test('direct reads need no observation and scripts cannot run before task approval',async t=>{
 const session=new DesktopSession(),auth=session.grant('task');let scriptCalls=0;
 const server=createBridgeService({session,token:'x',status:()=>({...session.snapshot(),capabilities:{input:true}}),native:{},capture:()=>{throw Error('unnecessary observation');},operation:async c=>({entries:[{name:'remote.txt'}],path:c.path}),scripts:{run:async()=>{scriptCalls++;return {exitCode:0};}},stop:()=>session.revoke()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const post=(path,command)=>fetch(`http://127.0.0.1:${server.address().port}`+path,{method:'POST',headers:{Authorization:'Bearer x','Content-Type':'application/json'},body:JSON.stringify({...auth,command})});
 assert.equal((await (await post('/operation',{kind:'list',path:'Downloads'})).json()).result.entries[0].name,'remote.txt');
 assert.equal((await post('/script',{language:'shell',source:'echo fixture'})).status,409);assert.equal(scriptCalls,0);
 assert.equal((await post('/script-grant')).status,200);assert.equal((await post('/script',{language:'shell',source:'echo fixture'})).status,200);assert.equal(scriptCalls,1);
 session.revoke();session.grant('next');assert.equal((await post('/script',{source:'again'})).status,409);assert.equal(scriptCalls,1);
});
test('OCR clicks recheck text and bounds before sending physical input',async t=>{
 const session=new DesktopSession(),auth=session.grant('task'),display={x:0,y:0,width:100,height:100};let name='Play',writes=0;
 const capture=async()=>({display,windowId:'w',elements:[{id:'ocr1',source:'ocr',name,role:'ScreenText',x:1,y:1,width:20,height:20,enabled:true}]});
 const server=createBridgeService({session,token:'x',status:()=>({capabilities:{input:true}}),capture,native:{execute:async()=>{writes++;}},stop:()=>session.revoke()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const post=(path,body)=>fetch(`http://127.0.0.1:${server.address().port}`+path,{method:'POST',headers:{Authorization:'Bearer x','Content-Type':'application/json'},body:JSON.stringify({...auth,...body})});
 let frame=await (await post('/observe',{screenText:true})).json();name='Delete';
 assert.equal((await post('/action',{command:{kind:'click',elementId:'ocr1',observationId:frame.id}})).status,409);assert.equal(writes,0);
 frame=await (await post('/observe',{screenText:true})).json();assert.equal((await post('/action',{command:{kind:'click',elementId:'ocr1',observationId:frame.id}})).status,200);assert.equal(writes,1);
});
