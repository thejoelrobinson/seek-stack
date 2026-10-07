import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {identity} from '../src/secure-link.js';
import {invitation,parseInvitation,invitationRequest,verifyInvitationRequest,signInvitationResult,verifyInvitationResult} from '../src/pairing.js';
import {DesktopDevices,DesktopHub} from '../../dsh/plugins/browser-viewer/lib/work-desktop.js';
import {SeekLink} from '../src/link.js';
const fields=()=>({publicKey:identity().publicKey,name:'Test PC',os:'win32',arch:'x64',version:'0.4.0',remoteGrant:true});
test('invitation validates its origin and carries a key pin; secret never enters the network request',()=>{
 const host=identity(),v=invitation('https://seek.example.com',host.publicKey),parsed=parseInvitation(v.url),b=invitationRequest(parsed,fields());
 assert.equal(parsed.hostKey,host.publicKey);assert.equal(parsed.token.length,64);assert.ok(!JSON.stringify(b).includes(v.token));verifyInvitationRequest(v.token,b);
 for(const patch of [{publicKey:identity().publicKey},{remoteGrant:false},{name:'Changed'},{nonce:'f'.repeat(32)}])assert.throws(()=>verifyInvitationRequest(v.token,{...b,...patch}));
 assert.throws(()=>parseInvitation(v.url+'&id='+v.id));assert.throws(()=>invitation('http://remote.example.com',host.publicKey));
 const result={deviceId:'11111111-1111-1111-1111-111111111111',secret:'a'.repeat(64),name:b.name,hostKey:host.publicKey},signed=signInvitationResult(host.privateKey,b,result);
 verifyInvitationResult(v,b,signed);assert.throws(()=>verifyInvitationResult(v,b,{...signed,secret:'b'.repeat(64)}));assert.throws(()=>verifyInvitationResult({...v,hostKey:identity().publicKey},b,signed));
});
test('host enrolls a proved invitation exactly once; expiry and forged requests cannot enroll',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-invite-')),devices=new DesktopDevices(root);let now=Date.now();const hub=new DesktopHub({devices,now:()=>now});
 try{
  const link=await hub.createInvitation('https://seek.example.com'),v=parseInvitation(link.url),b=invitationRequest(v,fields());
  await assert.rejects(hub.pair({...b,publicKey:identity().publicKey}));assert.equal((await devices.list()).length,0);
  const attempts=await Promise.allSettled([hub.pair(b),hub.pair(b)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  const paired=attempts.find(x=>x.status==='fulfilled').value;verifyInvitationResult(v,b,paired);assert.equal((await devices.list())[0].verified,true);
  const expired=parseInvitation((await hub.createInvitation('https://seek.example.com')).url);now+=11*60000;await assert.rejects(hub.pair(invitationRequest(expired,fields())),/expired/);
  const saved=await readFile(devices.file,'utf8');assert.ok(!saved.includes(v.token));assert.ok(!saved.includes(paired.secret));
 }finally{hub.close();await rm(root,{recursive:true,force:true});}
});
test('companion verifies the pinned invitation before saving or connecting; a forged response cannot replace an existing pairing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-invite-')),devices=new DesktopDevices(root),hub=new DesktopHub({devices});let tamper=false,connects=0;
 const link=new SeekLink({file:join(root,'companion.json'),encrypt:s=>'protected:'+s,decrypt:s=>s.slice(10),info:fields,WebSocketImpl:class{},localRequest:()=>{},grant:()=>{},fetchImpl:async(_url,opts)=>{const r=await hub.pair(JSON.parse(opts.body));return {ok:true,status:200,json:async()=>tamper?{...r,hostKey:identity().publicKey}:r};}});link.connect=()=>{connects++;};
 try{
  await link.pair({invitation:(await hub.createInvitation('https://seek.example.com')).url});assert.equal(link.status().verified,true);assert.equal(connects,1);const original=link.config;
  tamper=true;await assert.rejects(link.pair({invitation:(await hub.createInvitation('https://seek.example.com')).url}),/identity/);assert.equal(link.config,original);assert.equal(connects,1);
 }finally{link.close();hub.close();await rm(root,{recursive:true,force:true});}
});
