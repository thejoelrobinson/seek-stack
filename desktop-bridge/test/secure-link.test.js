import test from 'node:test';import assert from 'node:assert/strict';
import {identity,verificationCode,challenge,nonce,signSignal,verifySignal,SecureMessages,createSecurePeer,iceConfiguration} from '../src/secure-link.js';

const sdp='v=0\r\na=fingerprint:sha-256 '+Array(32).fill('AB').join(':')+'\r\n';
test('pinned identities authenticate fingerprints, endpoints, fresh challenges and expiry',()=>{
 const a=identity(),b=identity(),c=challenge(),deviceId='paired-device',deviceNonce=nonce();
 const m=signSignal(a.privateKey,{...c,deviceId,deviceNonce,kind:'offer',sdp});
 const expected={...c,deviceId,deviceNonce,kind:'offer'};
 assert.equal(verifySignal(a.publicKey,m,expected),m);
 assert.throws(()=>verifySignal(b.publicKey,m,expected),/identity/);
 assert.throws(()=>verifySignal(a.publicKey,{...m,sdp:sdp.replace('AB','CD')},expected),/identity/);
 assert.throws(()=>verifySignal(a.publicKey,m,{...expected,deviceId:'another-device'}),/Invalid/);
 assert.throws(()=>verifySignal(a.publicKey,m,{...expected,hostNonce:nonce()}),/challenge/);
 assert.throws(()=>verifySignal(a.publicKey,m,{...expected,deviceNonce:nonce()}),/challenge/);
 assert.throws(()=>verifySignal(a.publicKey,m,{...expected,now:m.at+90001}),/expired/);
 assert.throws(()=>verifySignal(a.publicKey,signSignal(a.privateKey,{...c,deviceId,deviceNonce,kind:'offer',sdp:'v=0'}),expected),/fingerprint/);
 assert.match(verificationCode(deviceId,a.publicKey,b.publicKey),/^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/);
 assert.notEqual(verificationCode(deviceId,a.publicKey,b.publicKey),verificationCode('another-device',a.publicKey,b.publicKey));
});
test('bounded ordered messages preserve large Unicode observations and reject replay, overflow and malformed fragments',()=>{
 const sent=[],received=[],errors=[],channel={readyState:'open',bufferedAmount:0,send:m=>sent.push(m)};
 const writer=new SecureMessages(channel,{onMessage:()=>{}}),reader=new SecureMessages(channel,{onMessage:m=>received.push(m),onError:e=>errors.push(e.message)});
 const payload={title:'Synthetic screen only',text:'🙂界'.repeat(20000)};writer.send(payload);sent.forEach(s=>reader.receive(s));assert.deepEqual(received,[payload]);
 reader.receive(sent[0]);assert.match(errors[0],/Invalid/);assert.equal(received.length,1);
 assert.throws(()=>writer.send({text:'x'.repeat(270000)}),/too large/);
 channel.bufferedAmount=600000;assert.throws(()=>writer.send({action:'click'}),/busy/);writer.close();reader.close();
 const r=new SecureMessages(channel,{onMessage:()=>assert.fail('Malformed data delivered'),onError:e=>errors.push(e.message)});r.receive(JSON.stringify({id:1,part:2,total:3,text:'x'}));assert.match(errors.at(-1),/Out of order/);
});
test('TURN uses expiring credentials and explicit relay-only configuration',()=>{
 assert.deepEqual(iceConfiguration({}),{iceServers:[],policy:'all'});
 assert.throws(()=>iceConfiguration({SEEK_DESKTOP_RELAY_ONLY:'1'}),/require TURN/);
 assert.throws(()=>iceConfiguration({SEEK_DESKTOP_TURN_URL:'turn:relay.example',SEEK_DESKTOP_TURN_SECRET:'short'}),/strong/);
 const c=iceConfiguration({SEEK_DESKTOP_TURN_URL:'turns:relay.example:5349?transport=tcp',SEEK_DESKTOP_TURN_SECRET:'x'.repeat(32),SEEK_DESKTOP_RELAY_ONLY:'1'},{deviceId:'test',now:100000});
 assert.equal(c.policy,'relay');assert.equal(c.iceServers[0].username,'3700:seek-test');assert.equal(c.iceServers[0].credential.length,28);
});
test('real WebRTC peers exchange fragmented data only after DTLS certificate verification',{timeout:15000},async()=>{
 let a,b;const got=[];let resolve;const arrived=new Promise(r=>{resolve=r;});
 const peerOptions={iceAdditionalHostAddresses:['127.0.0.1'],iceInterfaceAddresses:{udp4:'127.0.0.1'},iceUseIpv6:false};
 try{
  a=await createSecurePeer({peerOptions,onMessage:m=>got.push(m)});
  b=await createSecurePeer({peerOptions,onMessage:m=>{got.push(m);resolve();}});
  assert.throws(()=>a.send({text:'before authentication'}),/not ready/);
  const offer=await a.offer(),answer=await b.answer(offer);await a.accept(answer);
  const deadline=Date.now()+10000;while(!a.ready||!b.ready){if(Date.now()>deadline)throw Error('WebRTC did not connect');await new Promise(r=>setTimeout(r,20));}
  for(const p of [a,b]){assert.equal(p.pc.dtlsTransports[0].state,'connected');assert.ok(p.pc.dtlsTransports[0].dtls.remoteCertificate);p.pc.dtlsTransports[0].verifyRemoteCertificateFingerprint();}
  const message={text:'synthetic-'+ '🙂'.repeat(20000)};a.send(message);await arrived;assert.deepEqual(got,[message]);
 }finally{a?.close();b?.close();}
});
test('the actual remote DTLS certificate must match the described fingerprint',{timeout:12000},async()=>{
 let a,b;const peerOptions={iceAdditionalHostAddresses:['127.0.0.1'],iceInterfaceAddresses:{udp4:'127.0.0.1'},iceUseIpv6:false};let opened=false;
 try{
  a=await createSecurePeer({peerOptions,onMessage:()=>assert.fail('Unauthenticated payload delivered')});
  b=await createSecurePeer({peerOptions,onMessage:()=>assert.fail('Unauthenticated payload delivered'),onOpen:()=>{opened=true;}});
  const offer=await a.offer();offer.sdp=offer.sdp.replace(/^a=fingerprint:sha-256 .+$/m,'a=fingerprint:sha-256 '+Array(32).fill('00').join(':'));
  const answer=await b.answer(offer);await a.accept(answer);
  const deadline=Date.now()+8000;while(b.pc.dtlsTransports[0].state!=='failed'&&b.pc.connectionState!=='closed'){if(Date.now()>deadline)throw Error('Mismatched fingerprint was not rejected');await new Promise(r=>setTimeout(r,20));}
  assert.equal(opened,false);assert.equal(b.ready,false);
 }finally{a?.close();b?.close();}
});
