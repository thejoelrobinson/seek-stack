import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DesktopRelay} from '../lib/work-desktop-relay.js';
const protectedStore=async(action,s)=>action==='protect'?Buffer.from(s).toString('base64'):Buffer.from(s,'base64').toString();
test('relay stores protected credentials and returns only expiring per-device allocations or safe status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-relay-')),secret='private-turn-test-secret-'.repeat(3),relay=new DesktopRelay(root,{protect:protectedStore,env:{}});
 try{
  assert.equal((await relay.status()).configured,false);assert.deepEqual(await relay.ice(),{iceServers:[],policy:'all'});
  await relay.configure({provider:'coturn',urls:'turn:relay.example.com:3478',secret});
  assert.ok(!(await readFile(relay.file,'utf8')).includes(secret));assert.ok(!JSON.stringify(await relay.status()).includes(secret));
  const a=await relay.ice({deviceId:'one'}),b=await relay.ice({deviceId:'two'});assert.ok(a.iceServers[0].username.endsWith(':seek-one'));assert.notEqual(a.iceServers[0].credential,b.iceServers[0].credential);
  await assert.rejects(relay.configure({provider:'coturn',urls:'https://not-turn.example',secret}));assert.equal((await relay.status()).provider,'coturn');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('managed relay mints short-lived credentials on the host, validates endpoints, and preserves working settings on failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-relay-')),token='test-private-api-token-'.repeat(3),calls=[];let denied=false,malformed=false;
 const relay=new DesktopRelay(root,{protect:protectedStore,env:{},fetchImpl:async(url,opts)=>{calls.push({url,opts});return {ok:!denied,json:async()=>({iceServers:[{urls:[malformed?'turn:attacker.invalid:3478':'turn:turn.cloudflare.com:3478?transport=udp'],username:'short-lived-user',credential:'short-lived-secret'}]})};}});
 try{
  await relay.configure({provider:'cloudflare',keyId:'fixture-key-id',token,relayOnly:true});assert.equal(JSON.parse(calls[0].opts.body).ttl,3600);assert.equal(calls[0].opts.headers.Authorization,'Bearer '+token);
  const ice=await relay.ice({deviceId:'one'});assert.equal(ice.policy,'relay');assert.ok(!JSON.stringify(ice).includes(token));assert.ok(!(await readFile(relay.file,'utf8')).includes(token));
  denied=true;await assert.rejects(relay.configure({provider:'cloudflare',keyId:'replacement-key',token}),/refused/);assert.equal((await relay.status()).relayOnly,true);
  denied=false;malformed=true;await assert.rejects(relay.ice(),/Invalid relay/);
 }finally{await rm(root,{recursive:true,force:true});}
});
