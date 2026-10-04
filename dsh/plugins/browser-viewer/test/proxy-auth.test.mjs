import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,copyFile,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {removeFixture} from './fixture-cleanup.mjs';
const {SessionStore}=createRequire(import.meta.url)('../../../proxy/work-session-store.cjs');
const secret='synthetic-session-fixture-secret',opts={secret,credentialsDigest:'credentials-v1'};

test('durable device sessions revoke copied tokens, legacy sessions and owner credential versions',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seek-session-'));t.after(()=>removeFixture(root,'seek-session-'));const file=join(root,'sessions.json');
  const store=new SessionStore(file,opts),expiresAt=Date.now()+60000,id=store.create('owner',expiresAt,{userAgent:'Fixture\r\nBrowser'}),token='synthetic-token';
  assert.equal(store.accept({id,identity:'owner',expiresAt,version:0,token}),true);store.revoke(id);assert.equal(store.accept({id,identity:'owner',expiresAt,version:0,token}),false);
  const legacy='legacy-token';assert.equal(store.accept({identity:'owner',expiresAt,version:0,token:legacy}),true);store.revoke(store.id(legacy));assert.equal(store.accept({identity:'owner',expiresAt,version:0,token:legacy}),false);
  const owner=store.create('owner',expiresAt),partner=store.create('partner',expiresAt);const changed=new SessionStore(file,{...opts,credentialsDigest:'credentials-v2'});
  assert.equal(changed.accept({id:owner,identity:'owner',expiresAt,version:0,token}),false);assert.equal(changed.accept({id:partner,identity:'partner',expiresAt,token}),true);assert.equal(changed.data.ownerVersion,1);
  changed.revokeIdentity('partner');assert.equal(changed.accept({id:partner,identity:'partner',expiresAt,token}),false);
});
test('corrupt session recovery preserves the original and backup; newer formats fail closed',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seek-session-recovery-'));t.after(()=>removeFixture(root,'seek-session-recovery-'));const file=join(root,'sessions.json'),store=new SessionStore(file,opts);
  const id=store.create('owner',Date.now()+60000);store.save();const backup=await readFile(file+'.bak','utf8');await writeFile(file,'{broken');
  const recovered=new SessionStore(file,opts);assert.equal(recovered.list(id).length,1);assert.equal(await readFile(file+'.bak','utf8'),backup);
  await writeFile(file,JSON.stringify({version:99,sessions:[]}));assert.throws(()=>new SessionStore(file,opts),/newer format/);assert.equal(JSON.parse(await readFile(file,'utf8')).version,99);
});
test('isolated proxy validates login CSRF, session CSRF, revocation, live sockets and upstream header stripping',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'seek-proxy-')),upstream=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authorization:!!req.headers.authorization,spoofed:!!req.headers['x-dsh-user'],release:!!req.headers['x-seek-proxy-release']}));});
  const upstreamSockets=new Set();upstream.on('connection',socket=>{upstreamSockets.add(socket);socket.on('close',()=>upstreamSockets.delete(socket));});
  upstream.on('upgrade',(req,socket)=>{const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  await copyFile(fileURLToPath(new URL('../../../proxy/server.js',import.meta.url)),join(root,'server.cjs'));await copyFile(fileURLToPath(new URL('../../../proxy/work-session-store.cjs',import.meta.url)),join(root,'work-session-store.cjs'));await writeFile(join(root,'.secret'),secret);
  const child=spawn(process.execPath,[join(root,'server.cjs')],{env:{...process.env,DSH_PROXY_USER:'fixture-owner',DSH_PROXY_PASS:'fixture-pass',DSH_WORK_HOME:join(root,'work'),DSH_PROXY_LISTEN_PORT:'0',DSH_PROXY_TARGET_PORT:String(upstream.address().port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const base=await new Promise((resolve,reject)=>{let out='';const timeout=setTimeout(()=>reject(new Error('Fixture proxy did not start')),5000);child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Fixture proxy exited '+code));});child.stdout.on('data',chunk=>{out+=chunk;const match=/listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);if(match){clearTimeout(timeout);resolve(match[1]);}});});
  const sockets=[];t.after(async()=>{for(const ws of sockets)ws.terminate();child.kill();await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));for(const socket of upstreamSockets)socket.destroy();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await removeFixture(root,'seek-proxy-');});
  const request=(path,token,options={})=>fetch(base+path,{...options,redirect:'manual',headers:{...(token?{Cookie:token}:{}),...options.headers}});
  const login=async()=>{const page=await request('/login');const nonce=page.headers.getSetCookie()[0].split(';')[0],html=await page.text(),csrf=/name="csrf" value="([^"]+)"/.exec(html)[1];const response=await request('/login',nonce,{method:'POST',body:new URLSearchParams({csrf,username:'fixture-owner',password:'fixture-pass',next:'/work'})});assert.equal(response.status,303);return response.headers.getSetCookie()[0].split(';')[0];};
  assert.equal((await request('/work/api/tasks')).status,401);assert.equal((await request('/login',null,{method:'POST',body:'username=fixture-owner&password=fixture-pass'})).status,403);
  const owner=await login(),other=await login(),index=await (await request('/auth/api/sessions',owner)).json();assert.equal(index.sessions.length,2);assert.equal(index.sessions.filter(x=>x.current).length,1);
  const otherId=index.sessions.find(x=>!x.current).id;const revoke={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf:index.csrf,id:otherId})};
  assert.equal((await request('/auth/api/sessions/revoke',owner,{...revoke,headers:{...revoke.headers,Origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/auth/api/sessions/revoke',owner,{...revoke,body:JSON.stringify({id:otherId,csrf:'wrong'})})).status,403);
  const {default:CookieWebSocket}=await import('ws'),signed=new CookieWebSocket(base.replace('http:','ws:')+'/stream',{headers:{Cookie:other}});sockets.push(signed);
  await new Promise((resolve,reject)=>{signed.once('open',resolve);signed.once('error',reject);});const closed=new Promise(resolve=>signed.once('close',resolve));
  assert.equal((await request('/auth/api/sessions/revoke',owner,revoke)).status,200);await closed;assert.equal((await request('/work/api/tasks',other)).status,401);
  const forwarded=await (await request('/work/api/tasks',owner,{headers:{Authorization:'Bearer fixture','X-Dsh-User':'spoof'}})).json();assert.deepEqual(forwarded,{authorization:false,spoofed:false,release:true});
  assert.equal((await request('/logout',owner,{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await request('/logout',owner)).status,303);assert.equal((await request('/work/api/tasks',owner)).status,401);
  // Pre-existing signed owner cookies are adopted, then revoked server-side on logout.
  const expiry=Date.now()+60000,legacy='dsh_auth='+expiry+'.'+createHmac('sha256',secret).update(String(expiry)).digest('hex');
  assert.equal((await request('/work/api/tasks',legacy)).status,200);await request('/logout',legacy);assert.equal((await request('/work/api/tasks',legacy)).status,401);
  // Security activity: recorded for sign-in, failure, revocation and sign-out, without credentials.
  {const page=await request('/login');const nonce=page.headers.getSetCookie()[0].split(';')[0],csrf=/name="csrf" value="([^"]+)"/.exec(await page.text())[1];assert.equal((await request('/login',nonce,{method:'POST',body:new URLSearchParams({csrf,username:'typed-wrong-name',password:'wrong-secret-pass',next:'/work'})})).status,401);}
  const log=await readFile(join(root,'work','security-events.jsonl'),'utf8'),types=log.trim().split('\n').map(line=>JSON.parse(line).type);
  for(const type of ['login.csrf_rejected','login.success','session.revoked','logout','login.failed'])assert.ok(types.includes(type),'security event '+type);
  for(const secretText of ['fixture-pass','wrong-secret-pass','typed-wrong-name','dsh_auth='])assert.equal(log.includes(secretText),false,'security log never stores '+secretText);
});
