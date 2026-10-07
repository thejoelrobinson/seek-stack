import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,copyFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer,WebSocket} from 'ws';
import {removeFixture} from './fixture-cleanup.mjs';
import {DesktopDevices} from '../lib/work-desktop.js';
import {identity} from '../lib/desktop/secure-link.js';

test('proxy: pairing needs no session; the computer link needs a device key and never a cookie',{timeout:25000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'seek-deskproxy-')),seen=[];
  const upstream=createServer((req,res)=>{seen.push({path:req.url,cookie:!!req.headers.cookie,authorization:!!req.headers.authorization});res.writeHead(200,{'Content-Type':'application/json'});res.end('{"deviceId":"x","secret":"y"}');});
  const wss=new WebSocketServer({noServer:true}),links=[];
  upstream.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{links.push({device:req.headers['x-seek-desktop-device'],cookie:!!req.headers.cookie,authorization:req.headers.authorization});ws.send('hello');}));
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  await copyFile(fileURLToPath(new URL('../../../proxy/server.js',import.meta.url)),join(root,'server.cjs'));await copyFile(fileURLToPath(new URL('../../../proxy/work-session-store.cjs',import.meta.url)),join(root,'work-session-store.cjs'));await writeFile(join(root,'.secret'),'synthetic-secret');
  const work=join(root,'work'),devices=new DesktopDevices(work),{device,secret}=await devices.create({name:'Studio Mac',os:'darwin',publicKey:identity().publicKey});
  const child=spawn(process.execPath,[join(root,'server.cjs')],{env:{...process.env,DSH_PROXY_USER:'fixture-owner',DSH_PROXY_PASS:'fixture-pass',DSH_WORK_HOME:work,DSH_PROXY_LISTEN_PORT:'0',DSH_PROXY_TARGET_PORT:String(upstream.address().port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const base=await new Promise((resolve,reject)=>{let out='';const timeout=setTimeout(()=>reject(new Error('Fixture proxy did not start')),5000);child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Fixture proxy exited '+code));});child.stdout.on('data',chunk=>{out+=chunk;const match=/listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);if(match){clearTimeout(timeout);resolve(match[1]);}});});
  t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));wss.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await removeFixture(root,'seek-deskproxy-');});

  const pair=await fetch(base+'/work/desktop/pair',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'dsh_auth=nope'},body:'{"code":"ABCDEFGH"}'});
  assert.equal(pair.status,200);assert.deepEqual(seen.at(-1),{path:'/work/desktop/pair',cookie:false,authorization:false});
  assert.equal((await fetch(base+'/work/api/desktop')).status,401,'the rest of Work still needs a session');

  const open=headers=>new Promise(resolve=>{const ws=new WebSocket(base.replace('http:','ws:')+'/work/desktop/link',{headers});ws.once('message',m=>{resolve({ok:true,message:String(m)});ws.close();});ws.once('unexpected-response',(_r,res)=>resolve({ok:false,status:res.statusCode}));ws.once('error',()=>resolve({ok:false,status:0}));});
  assert.deepEqual(await open({}),{ok:false,status:401});
  assert.deepEqual(await open({Authorization:`Bearer ${device.id}.${'0'.repeat(64)}`}),{ok:false,status:401});
  assert.deepEqual(await open({Cookie:'dsh_auth=whatever'}),{ok:false,status:401},'a browser cookie is not a computer key');
  const good=await open({Authorization:`Bearer ${device.id}.${secret}`,Cookie:'dsh_auth=whatever'});assert.deepEqual(good,{ok:true,message:'hello'});
  assert.equal(links.at(-1).device,device.id);assert.equal(links.at(-1).cookie,false);assert.equal(links.at(-1).authorization,`Bearer ${device.id}.${secret}`);
  await devices.remove(device.id);await new Promise(r=>setTimeout(r,50));
  assert.deepEqual(await open({Authorization:`Bearer ${device.id}.${secret}`}),{ok:false,status:401},'removing a computer revokes its link at once');
});
