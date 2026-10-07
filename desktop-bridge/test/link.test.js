import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SeekLink,normalizeServer} from '../src/link.js';

class FakeSocket extends EventEmitter{static last=null;constructor(url,opts){super();this.url=url;this.opts=opts;this.readyState=0;this.sent=[];FakeSocket.last=this;}
  open(){this.readyState=1;this.emit('open');}send(t){this.sent.push(JSON.parse(t));}close(code=1000){this.readyState=3;this.emit('close',code);}receive(m){this.emit('message',Buffer.from(JSON.stringify(m)));}}
const secret='a'.repeat(64);
async function setup(overrides={}){
  const dir=await mkdtemp(join(tmpdir(),'seek-link-')),calls=[],grants=[],timers=[];
  const link=new SeekLink({file:join(dir,'link.json'),encrypt:s=>'enc:'+s,decrypt:s=>s.replace(/^enc:/,''),WebSocketImpl:FakeSocket,
    fetchImpl:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,status:200,json:async()=>({deviceId:'dev-1',secret})};},
    info:()=>({name:'Studio Mac',os:'darwin',arch:'arm64',version:'0.3.0'}),
    localRequest:async(method,path,body)=>({status:200,body:{method,path,body}}),grant:async(task,title)=>{grants.push([task,title]);},
    setTimer:(fn,ms)=>{timers.push(ms);return 1;},clearTimer:()=>{},...overrides});
  return {link,dir,calls,grants,timers,done:()=>rm(dir,{recursive:true,force:true})};
}
test('server addresses: https required off this computer',()=>{
  assert.equal(normalizeServer('seek.example.com'),'https://seek.example.com');
  assert.equal(normalizeServer('http://127.0.0.1:3080/work'),'http://127.0.0.1:3080');
  assert.throws(()=>normalizeServer('http://seek.example.com'),/https/);
  assert.throws(()=>normalizeServer('https://user:pw@seek.example.com'),/user name/);
});
test('pairing stores an encrypted key and connects with it',async()=>{
  const {link,dir,calls,done}=await setup();
  try{
    await assert.rejects(link.pair({server:'seek.example.com',code:'nope'}),/8-character/);
    const s=await link.pair({server:'seek.example.com',code:'abcd-efgh',name:'Studio',remoteGrant:true});
    assert.equal(calls[0].url,'https://seek.example.com/work/desktop/pair');assert.equal(calls[0].body.code,'ABCDEFGH');assert.equal(calls[0].body.os,'darwin');assert.equal(calls[0].body.name,'Studio','the chosen name is sent, not the host name');
    const saved=JSON.parse(await readFile(join(dir,'link.json'),'utf8'));assert.equal(saved.secret,'enc:'+secret);assert.equal(saved.deviceId,'dev-1');
    const ws=FakeSocket.last;assert.equal(ws.url,'wss://seek.example.com/work/desktop/link');assert.equal(ws.opts.headers.Authorization,`Bearer dev-1.${secret}`);
    ws.open();assert.equal(ws.sent[0].type,'hello');assert.equal(ws.sent[0].remoteGrant,true);assert.equal(s.paired,true);assert.equal(link.status().online,true);
  }finally{link.close();await done();}
});
test('relays only the bridge API, and phone approval needs the opt-in',async()=>{
  const {link,grants,done}=await setup();
  try{
    await link.pair({server:'https://seek.example.com',code:'ABCDEFGH',remoteGrant:false});const ws=FakeSocket.last;ws.open();
    ws.receive({type:'request',id:1,method:'POST',path:'/observe',body:{sessionId:'s',epoch:1}});await new Promise(r=>setImmediate(r));
    assert.deepEqual(ws.sent.at(-1),{type:'response',id:1,status:200,body:{method:'POST',path:'/observe',body:{sessionId:'s',epoch:1}}});
    ws.receive({type:'request',id:2,method:'POST',path:'/grant',body:{}});await new Promise(r=>setImmediate(r));assert.equal(ws.sent.at(-1).status,404);
    ws.receive({type:'grant',id:3,taskId:'t1',title:'Fill the form'});await new Promise(r=>setImmediate(r));
    assert.equal(ws.sent.at(-1).ok,false);assert.equal(grants.length,0);
    await link.setRemoteGrant(true);
    ws.receive({type:'grant',id:4,taskId:'t1',title:'Fill the form'});await new Promise(r=>setImmediate(r));
    assert.equal(ws.sent.at(-1).ok,true);assert.deepEqual(grants,[['t1','Fill the form']]);
  }finally{link.close();await done();}
});
test('requests show locally; Allow grants, Not now declines; removal stops reconnecting',async()=>{
  const {link,grants,timers,done}=await setup();
  try{
    await link.pair({server:'https://seek.example.com',code:'ABCDEFGH'});const ws=FakeSocket.last;ws.open();
    ws.receive({type:'ask',taskId:'t9',title:'Sort my downloads folder'});await new Promise(r=>setImmediate(r));
    assert.equal(link.status().requests[0].title,'Sort my downloads folder');
    await link.answer('t9',true);assert.deepEqual(grants,[['t9','Sort my downloads folder']]);assert.deepEqual(ws.sent.at(-1),{type:'answer',taskId:'t9',allowed:true});
    ws.receive({type:'ask',taskId:'t10',title:'x'});await new Promise(r=>setImmediate(r));await link.answer('t10',false);assert.equal(grants.length,1);
    await assert.rejects(link.answer('t10',true),/no longer pending/);
    ws.close(1006);assert.equal(timers.at(-1),1000,'reconnects with backoff');
    link.ws=null;link.connect();FakeSocket.last.close(4401);assert.equal(link.status().lastError,'This computer was removed from Seek. Pair it again.');
    const before=timers.length;assert.equal(timers.length,before);
  }finally{link.close();await done();}
});
test('unpairing deletes the key',async()=>{
  const {link,dir,done}=await setup();
  try{await link.pair({server:'https://seek.example.com',code:'ABCDEFGH'});await link.unpair();await assert.rejects(readFile(join(dir,'link.json')));assert.equal(link.status().paired,false);}
  finally{await done();}
});
