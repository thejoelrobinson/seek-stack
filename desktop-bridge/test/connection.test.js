// Full companion ↔ Seek test. Uses temporary keys, an owned loopback signaling
// server and synthetic observations; never attaches to the user's desktop.
import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import WebSocket,{WebSocketServer} from 'ws';
import {SeekLink} from '../src/link.js';import {createSecurePeer} from '../src/secure-link.js';
import {DesktopDevices,DesktopHub} from '../../dsh/plugins/browser-viewer/lib/work-desktop.js';
const waitFor=async(fn)=>{const end=Date.now()+10000;while(!await fn()){if(Date.now()>end)throw Error('Secure connection timed out');await new Promise(r=>setTimeout(r,20));}};
test('paired companion and Seek exchange RPC only over WebRTC; relays see ciphertext; removal revokes',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seek-webrtc-')),signals=[],wire=[],peers=[];
 let state={state:'idle',taskId:null,activity:'Ready'},stops=0,link;
 const peerOptions={iceAdditionalHostAddresses:['127.0.0.1'],iceInterfaceAddresses:{udp4:'127.0.0.1'},iceUseIpv6:false};
 const peerFactory=async options=>{
  const peer=await createSecurePeer({...options,peerOptions,onOpen:()=>{
   for(const t of peer.pc.iceTransports){const send=t.connection.send;t.connection.send=async bytes=>{wire.push(Buffer.from(bytes));return send(bytes);};}
   options.onOpen();
  }});peers.push(peer);return peer;
 };
 const devices=new DesktopDevices(dir),hub=new DesktopHub({devices,peerFactory,ice:()=>({iceServers:[],policy:'all'})});
 const server=createServer(async(req,res)=>{
  try{let body='';for await(const chunk of req)body+=chunk;const paired=await hub.pair(JSON.parse(body));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(paired));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
 });
 const sockets=new WebSocketServer({noServer:true});
 server.on('upgrade',async(req,socket,head)=>{
  const device=await devices.verify(String(req.headers.authorization).replace(/^Bearer /,''));if(!device){socket.destroy();return;}
  sockets.handleUpgrade(req,socket,head,ws=>{ws.on('message',m=>signals.push(String(m)));const send=ws.send.bind(ws);ws.send=(m,...args)=>{signals.push(String(m));return send(m,...args);};hub.attach(ws,device);});
 });
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  link=new SeekLink({file:join(dir,'companion.json'),encrypt:s=>'test-protected:'+s,decrypt:s=>s.replace(/^test-protected:/,''),WebSocketImpl:WebSocket,peerFactory,
   info:()=>({name:'Synthetic PC',os:'win32',arch:'x64',version:'0.4.0'}),
   localRequest:async(method,path,body)=>({status:200,body:path==='/observe'?{title:'private-marker-c7c124f6',elements:[{name:'Synthetic control',value:'x'.repeat(70000)}]}:{...state,method,path}}),
   grant:async(taskId)=>{state={state:'agent',taskId,activity:'Synthetic task'};link.sendState(state);},
   onDisconnect:()=>{stops++;state={state:'idle',taskId:null,activity:'Stopped'};link?.sendState(state);}});
  await link.pair({invitation:(await hub.createInvitation(origin)).url});const computer=(await devices.list())[0];
  assert.equal(link.status().verificationCode,computer.verificationCode);assert.equal(link.status().verified,true);assert.equal(computer.verified,true);
  await waitFor(async()=>link.online&&(await hub.machines())[0].online);
  await hub.grant(computer.id,{id:'synthetic-task',title:'private-marker-c7c124f6'});await waitFor(()=>hub.machineFor('synthetic-task'));
  const observation=await hub.clientFor(computer.id).request('/observe',{sessionId:'synthetic',epoch:1});assert.equal(observation.title,'private-marker-c7c124f6');assert.equal(observation.elements[0].value.length,70000);
  assert.ok(signals.length>=3);assert.ok(signals.every(s=>JSON.parse(s).type==='rtc'));assert.ok(signals.every(s=>!s.includes('private-marker-c7c124f6')));
  assert.ok(wire.length>0);assert.ok(wire.every(bytes=>!bytes.includes(Buffer.from('private-marker-c7c124f6'))),'application data must not appear in captured transport packets');
  for(const peer of peers){assert.equal(peer.pc.dtlsTransports[0].state,'connected');peer.pc.dtlsTransports[0].verifyRemoteCertificateFingerprint();assert.equal(peer.pc.iceTransports[0].connection.stunServer,undefined);}
  const pending=hub.clientFor(computer.id).request('/status');await hub.remove(computer.id);await pending.catch(()=>{});await waitFor(()=>!link.online);assert.ok(stops>0);assert.equal(state.taskId,null);assert.equal(hub.machineFor('synthetic-task'),null);assert.equal(link.stopped,true);
 }finally{link?.close();hub.close();peers.forEach(p=>p.close());for(const ws of sockets.clients)ws.terminate();await new Promise(r=>sockets.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
