import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SeekLink,normalizeServer} from '../src/link.js';
import {identity,challenge,signSignal} from '../src/secure-link.js';
class Socket extends EventEmitter{static last;constructor(url,opts){super();Object.assign(this,{url,opts,readyState:0,sent:[]});Socket.last=this;}open(){this.readyState=1;this.emit('open');}send(t){this.sent.push(JSON.parse(t));}close(code=1000){if(this.readyState===3)return;this.readyState=3;this.emit('close',code);}receive(m){this.emit('message',Buffer.from(JSON.stringify(m)));}}
const tick=()=>new Promise(r=>setImmediate(r));
const sdp='v=0\r\na=fingerprint:sha-256 '+Array(32).fill('AB').join(':')+'\r\n';
async function setup(overrides={}){
 const dir=await mkdtemp(join(tmpdir(),'seek-link-')),calls=[],grants=[],timers=[],peers=[],host=identity(),secret='a'.repeat(64);let disconnects=0;
 const link=new SeekLink({file:join(dir,'link.json'),encrypt:s=>'enc:'+s,decrypt:s=>s.replace(/^enc:/,''),WebSocketImpl:Socket,
  fetchImpl:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,status:200,json:async()=>({deviceId:'dev-1',secret,hostKey:host.publicKey})};},
  info:()=>({name:'Studio Mac',os:'darwin',arch:'arm64',version:'0.4.0'}),
  localRequest:async(method,path,body)=>({status:200,body:{method,path,body}}),grant:async(task,title)=>{grants.push([task,title]);},
  onDisconnect:()=>{disconnects++;},setTimer:(fn,ms)=>{timers.push(ms);return 1;},clearTimer:()=>{},
  peerFactory:async options=>{const peer={ready:false,sent:[],options,async offer(){return {type:'offer',sdp};},async accept(){this.ready=true;options.onOpen();},send(m){this.sent.push(m);},close(){this.ready=false;},receive:m=>options.onMessage(m)};peers.push(peer);return peer;},...overrides});
 async function connect(remoteGrant=true){await link.pair({server:'seek.example.com',code:'ABCDEFGH',remoteGrant});await link.confirm(link.status().verificationCode);await tick();const ws=Socket.last;ws.open();ws.receive(signSignal(host.privateKey,{...challenge(),deviceId:'dev-1',kind:'ready'}));await tick();const offer=ws.sent.at(-1);ws.receive(signSignal(host.privateKey,{...offer,kind:'answer',sdp}));await tick();return {ws,peer:peers.at(-1)};}
 return {link,dir,calls,grants,timers,peers,host,secret,connect,get disconnects(){return disconnects;},done:async()=>{link.close();await rm(dir,{recursive:true,force:true});}};
}
test('server addresses require HTTPS off this computer',()=>{
 assert.equal(normalizeServer('seek.example.com'),'https://seek.example.com');assert.equal(normalizeServer('http://127.0.0.1:3080/work'),'http://127.0.0.1:3080');assert.throws(()=>normalizeServer('http://seek.example.com'),/https/);assert.throws(()=>normalizeServer('https://user:pw@seek.example.com'),/user name/);
});
test('pairing protects both private keys, pins the host and requires a code comparison',async()=>{
 const s=await setup();try{
  await assert.rejects(s.link.pair({server:'seek.example.com',code:'nope'}),/8-character/);
  await s.link.pair({server:'seek.example.com',code:'abcd-efgh',name:'Studio'});
  assert.equal(s.calls[0].body.code,'ABCDEFGH');assert.equal(s.calls[0].body.name,'Studio');assert.equal(s.calls[0].body.protocol,1);assert.equal(s.link.status().online,false);assert.equal(s.link.status().verified,false);
  const saved=JSON.parse(await readFile(join(s.dir,'link.json'),'utf8'));assert.equal(saved.secret,'enc:'+s.secret);assert.ok(saved.privateKey.startsWith('enc:'));assert.equal(saved.hostKey,s.host.publicKey);
  await assert.rejects(s.link.confirm('0000-0000-0000-0000'),/do not match/);await s.link.confirm(s.link.status().verificationCode);await tick();assert.equal(Socket.last.opts.headers.Authorization,'Bearer dev-1.'+s.secret);
 }finally{await s.done();}
});
test('WebSocket cannot execute requests or grants; encrypted channel enforces route and approval opt-in',async()=>{
 const s=await setup();try{
  const {ws,peer}=await s.connect(false);assert.equal(s.link.status().online,true);assert.equal(s.link.status().transport,'webrtc');assert.ok(ws.sent.every(m=>m.type==='rtc'));
  ws.receive({type:'grant',id:99,taskId:'attacker'});ws.receive({type:'request',id:98,method:'POST',path:'/action'});await tick();assert.equal(s.grants.length,0);assert.equal(peer.sent.filter(m=>m.id===98).length,0);
  peer.receive({type:'request',id:1,method:'POST',path:'/observe',body:{sessionId:'s',epoch:1}});await tick();assert.equal(peer.sent.at(-1).status,200);
  peer.receive({type:'request',id:2,method:'POST',path:'/grant'});await tick();assert.equal(peer.sent.at(-1).status,404);
  peer.receive({type:'grant',id:3,taskId:'t1'});await tick();assert.equal(peer.sent.at(-1).ok,false);
  await s.link.setRemoteGrant(true);peer.receive({type:'grant',id:4,taskId:'t1',title:'Synthetic task'});await tick();assert.equal(peer.sent.at(-1).ok,true);assert.deepEqual(s.grants,[['t1','Synthetic task']]);assert.ok(ws.sent.every(m=>m.type==='rtc'));
 }finally{await s.done();}
});
test('local approvals use WebRTC; disconnect clears requests and revokes; removal prevents reconnect',async()=>{
 const s=await setup();try{
  const {ws,peer}=await s.connect();peer.receive({type:'ask',taskId:'t9',title:'Synthetic request'});await tick();await s.link.answer('t9',true);assert.deepEqual(peer.sent.at(-1),{type:'answer',taskId:'t9',allowed:true});
  peer.receive({type:'ask',taskId:'t10',title:'Later'});await tick();ws.close(1006);assert.equal(s.link.status().online,false);assert.equal(s.link.status().requests.length,0);assert.ok(s.disconnects>0);assert.equal(s.timers.at(-1),1000);
  await assert.rejects(s.link.answer('t10',true),/no longer pending/);s.link.connect();await tick();const before=s.timers.length;Socket.last.close(4401);assert.match(s.link.status().lastError,/removed/);assert.equal(s.timers.length,before);
 }finally{await s.done();}
});
test('forged host identity never establishes a peer or permits a plaintext fallback',async()=>{
 const s=await setup();try{
  await s.link.pair({server:'seek.example.com',code:'ABCDEFGH'});await s.link.confirm(s.link.status().verificationCode);await tick();const ws=Socket.last;ws.open();ws.receive(signSignal(identity().privateKey,{...challenge(),deviceId:'dev-1',kind:'ready'}));await tick();assert.equal(s.peers.length,0);assert.equal(s.link.online,false);assert.match(s.link.lastError,/verification failed/);
 }finally{await s.done();}
});
test('legacy pairing cannot silently reuse the readable WebSocket path; unpair deletes keys',async()=>{
 const s=await setup();try{
  await s.connect();await s.link.unpair();await assert.rejects(readFile(join(s.dir,'link.json')));assert.equal(s.link.status().paired,false);
  s.link.config={deviceId:'legacy',secret:'enc:'+s.secret,server:'https://seek.example.com'};s.link.connect();assert.equal(s.link.ws,null);
 }finally{await s.done();}
});
