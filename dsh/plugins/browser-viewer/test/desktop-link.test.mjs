import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopDevices,DesktopHub,DesktopControl} from '../lib/work-desktop.js';
import {identity,nonce,signSignal} from '../lib/desktop/secure-link.js';

class FakeWs extends EventEmitter{constructor(){super();this.sent=[];this.signals=[];this.closed=null;}send(t){this.signals.push(JSON.parse(t));}ping(){}close(code){if(this.closed!==null)return;this.closed=code;this.emit('close',code);}reply(m){this.peer.options.onMessage(m);}raw(m){this.emit('message',Buffer.from(JSON.stringify(m)));}}
const tick=()=>new Promise(r=>setImmediate(r));
const sdp='v=0\r\na=fingerprint:sha-256 '+Array(32).fill('AB').join(':')+'\r\n';
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'seek-desk-')),keys=identity(),peers=[];
 const devices=new DesktopDevices(dir),hub=new DesktopHub({devices,log:{warn(){}},ice:()=>({iceServers:[],policy:'all'}),peerFactory:async options=>{
  const peer={options,ready:false,async answer(){return {type:'answer',sdp};},send(m){peer.ws.sent.push(m);},close(){this.ready=false;}};peers.push(peer);return peer;
 }});
 const pair=hub.pair.bind(hub);hub.pair=body=>pair({...body,protocol:1,publicKey:keys.publicKey});
 async function attach(ws,device){
  const listed=(await devices.list()).find(d=>d.id===device.id);await hub.confirm(device.id,listed.verificationCode);
  hub.attach(ws,{...device,publicKey:keys.publicKey,verified:true});
  const end=Date.now()+5000;while(!ws.signals.length){if(Date.now()>end)throw Error('Secure handshake did not start');await new Promise(r=>setTimeout(r,10));}
  const ready=ws.signals.at(-1);assert.equal(ready.kind,'ready');await hub.signal(hub.links.get(device.id),signSignal(keys.privateKey,{...ready,kind:'offer',deviceNonce:nonce(),sdp}));
  const peer=peers.at(-1);peer.ws=ws;ws.peer=peer;peer.ready=true;peer.options.onOpen();
  assert.ok(ws.signals.every(m=>m.type==='rtc'));
 }
 return {dir,devices,hub,keys,attach,done:()=>{hub.close();return rm(dir,{recursive:true,force:true});}};
}

test('pairing: single-use codes, hashed keys, lockout after repeated wrong codes',async()=>{
  const {dir,devices,hub,done}=await setup();
  try{
    const {code}=hub.createCode();assert.match(code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const paired=await hub.pair({code,name:'Studio Mac',os:'darwin',arch:'arm64',version:'0.3.0',remoteGrant:true});
    assert.match(paired.secret,/^[a-f0-9]{64}$/);
    await assert.rejects(hub.pair({code,name:'again'}),/wrong or expired/,'a code works once');
    const raw=await readFile(join(dir,'desktop-devices.json'),'utf8');assert.equal(raw.includes(paired.secret),false);
    assert.equal((await devices.verify(`${paired.deviceId}.${paired.secret}`)).name,'Studio Mac');
    assert.equal(await devices.verify(`${paired.deviceId}.${'0'.repeat(64)}`),null);
    assert.equal(await devices.verify('garbage'),null);
    for(let i=0;i<9;i++)await assert.rejects(hub.pair({code:'ZZZZZZZZ'}));
    await assert.rejects(hub.pair({code:hub.createCode().code}),/Too many/,'locks out after 10 wrong codes');
    await hub.remove(paired.deviceId);assert.equal(await devices.verify(`${paired.deviceId}.${paired.secret}`),null);
  }finally{await done();}
});

test('a linked computer: requests round-trip, task routing, grants and answers',async()=>{
  const {hub,attach,done}=await setup();
  try{
    const {code}=hub.createCode(),p=await hub.pair({code,name:'Studio Mac',os:'darwin',remoteGrant:false});
    const device=(await hub.devices.list())[0],ws=new FakeWs(),events=[];hub.on(e=>events.push(e));
    await attach(ws,{...device,id:p.deviceId});ws.reply({type:'hello',name:'Studio Mac',os:'darwin',version:'0.3.0',remoteGrant:true});
    assert.equal((await hub.machines())[0].online,true);assert.equal((await hub.machines())[0].remoteGrant,true);
    // The bridge client's HTTP calls travel over the link.
    const client=hub.clientFor(p.deviceId),pending=client.request('/status');
    const req=ws.sent.at(-1);assert.deepEqual([req.type,req.method,req.path],['request','GET','/status']);
    ws.reply({type:'response',id:req.id,status:200,body:{state:'idle'}});assert.deepEqual(await pending,{state:'idle'});
    const failing=client.request('/observe',{sessionId:'s',epoch:1});ws.reply({type:'response',id:ws.sent.at(-1).id,status:409,body:{error:'Desktop control is paused'}});
    await assert.rejects(failing,/paused/);
    // Granting and routing by task.
    const g=hub.grant(p.deviceId,{id:'task-1',title:'Sort downloads'});const gm=ws.sent.at(-1);assert.equal(gm.type,'grant');ws.reply({type:'grant-result',id:gm.id,ok:true});assert.equal(await g,true);
    ws.reply({type:'state',state:'agent',taskId:'task-1',activity:'Agent has control'});
    assert.deepEqual(hub.machineFor('task-1'),{id:p.deviceId,name:'Studio Mac'});assert.equal(hub.machineFor('task-2'),null);
    const refused=hub.grant(p.deviceId,{id:'task-3',title:'x'});ws.reply({type:'grant-result',id:ws.sent.at(-1).id,ok:false,error:'Only on its own screen'});await assert.rejects(refused,/own screen/);
    hub.ask({id:'task-4',title:'Rename files'});assert.deepEqual(ws.sent.at(-1),{type:'ask',taskId:'task-4',title:'Rename files'});
    ws.reply({type:'answer',taskId:'task-4',allowed:true});assert.deepEqual(events.at(-1),{type:'answer',id:p.deviceId,name:'Studio Mac',taskId:'task-4',allowed:true});
    // Going offline fails anything in flight and drops routing.
    const inflight=client.request('/status');ws.close(1006);await assert.rejects(inflight,/disconnected/);
    assert.equal(hub.machineFor('task-1'),null);await assert.rejects(hub.clientFor(p.deviceId).request('/status'),/offline/);
    // Removing a computer closes its link with the "removed" code.
    const ws2=new FakeWs();await attach(ws2,{...device,id:p.deviceId});await hub.remove(p.deviceId);assert.equal(ws2.closed,4401);
  }finally{await done();}
});

test('desktop tools route to the allowed computer, and ask when none is allowed',async()=>{
  const {hub,attach,done}=await setup();
  try{
    const {code}=hub.createCode(),p=await hub.pair({code,name:'Studio Mac',os:'darwin'}),device=(await hub.devices.list())[0],ws=new FakeWs();
    await attach(ws,{...device,id:p.deviceId});
    const task={taskId:'task-9',sessionId:'sess-9',status:'running',child:false},asked=[];
    const control=new DesktopControl({hub,resolveOwner:()=>task,requestGrant:async o=>{asked.push(o.taskId);return 'Asked the user to allow desktop control. End your turn now.';}});
    const exec={agent:{id:'sess-9'}};
    await assert.rejects(control.forExecution(exec),/Asked the user/);assert.deepEqual(asked,['task-9']);
    const status=JSON.parse((await control.status(exec)).text);assert.equal(status.granted,false);assert.equal(status.computers[0].name,'Studio Mac');
    await assert.rejects(control.forExecution({agent:{id:'someone-else'}}),/active parent task/);
    ws.reply({type:'state',state:'agent',taskId:'task-9',activity:'Agent has control'});
    // Attach: the agent's /status over the link must show this task's grant.
    const attaching=control.forExecution(exec);await new Promise(r=>setImmediate(r));
    const s=ws.sent.at(-1);assert.equal(s.path,'/status');ws.reply({type:'response',id:s.id,status:200,body:{state:'agent',taskId:'task-9',sessionId:'ds-1',epoch:4}});
    const agent=await attaching;assert.equal(agent.taskId,'task-9');assert.equal(control.computer.name,'Studio Mac');
    ws.close(1006);assert.equal(control.current,null);assert.equal(agent.client.auth,null,'offline transport invalidates the cached session');
    await assert.rejects(control.forExecution(exec),/Asked the user/,'reconnect requires a fresh grant');
    control.close();
  }finally{await done();}
});

test('verification gates connections and raw signaling cannot change task ownership',async()=>{
 const {hub,devices,attach,done}=await setup();try{
  const p=await hub.pair({code:hub.createCode().code,name:'Fixture'}),device=(await devices.list())[0],unverified=new FakeWs();
  hub.attach(unverified,device);assert.equal(unverified.closed,4003);assert.equal(hub.links.size,0);
  await assert.rejects(hub.confirm(p.deviceId,'0000-0000-0000-0000'),/do not match/);
  const ws=new FakeWs();await attach(ws,device);ws.raw({type:'state',state:'agent',taskId:'injected'});ws.raw({type:'answer',allowed:true,taskId:'injected'});await tick();assert.equal(hub.machineFor('injected'),null);
  const before=ws.signals.length;hub.ask({id:'fixture',title:'private fixture title'});assert.equal(ws.sent.at(-1).type,'ask');assert.equal(ws.signals.length,before);
 }finally{await done();}
});
test('a selected remote computer is granted on first use; Stop never silently regrants',async()=>{
 const {hub,attach,done}=await setup();try{
  const p=await hub.pair({code:hub.createCode().code,name:'Remote Mac',os:'darwin'}),device=(await hub.devices.list())[0],ws=new FakeWs();await attach(ws,{...device,id:p.deviceId});
  const task={taskId:'remote-task',sessionId:'remote-session',status:'running',execution:{mode:'desktop',deviceId:p.deviceId,autoRemote:true,granted:false}},exec={agent:{id:task.sessionId}};let grants=0;
  const control=new DesktopControl({hub,resolveOwner:()=>task,requestGrant:async()=>{grants++;task.execution.granted=true;ws.reply({type:'state',state:'agent',taskId:task.taskId});return 'Granted';}});
  const attaching=control.forExecution(exec);await tick();const req=ws.sent.at(-1);assert.equal(req.path,'/status');ws.reply({type:'response',id:req.id,status:200,body:{state:'agent',taskId:task.taskId,sessionId:'local-session',epoch:1}});await attaching;assert.equal(grants,1);
  ws.reply({type:'state',state:'human',taskId:null});await assert.rejects(control.forExecution(exec),/paused/);assert.equal(grants,1);control.close();
 }finally{await done();}
});

test('device identity survives restart and concurrent enrollment does not lose pins or verification',async()=>{
 const {devices,dir,done}=await setup();try{
  const first=await devices.identity();assert.equal((await new DesktopDevices(dir).identity()).publicKey,first.publicKey);
  const enrolled=await Promise.all(Array.from({length:5},(_,i)=>devices.create({name:'Fixture '+i,publicKey:identity().publicKey})));
  await Promise.all(enrolled.map(({device})=>devices.update(device.id,{verified:true})));
  const all=await devices.list();assert.equal(all.length,5);assert.ok(all.every(d=>d.verified&&d.publicKey));
 }finally{await done();}
});
