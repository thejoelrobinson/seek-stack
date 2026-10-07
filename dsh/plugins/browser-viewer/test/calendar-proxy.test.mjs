import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,copyFile,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {removeFixture} from './fixture-cleanup.mjs';
import {DavDevices,mobileconfig,generatePassword} from '../lib/work-dav-auth.js';

test('device passwords: generated once, hashed at rest, revocable; profile carries the account',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seek-davauth-'));t.after(()=>removeFixture(root,'seek-davauth-'));
  const devices=new DavDevices(root),phone=await devices.create('Joel’s iPhone');
  assert.match(phone.password,/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);assert.equal(phone.username,'seek');
  const raw=await readFile(join(root,'caldav-devices.json'),'utf8');assert.equal(raw.includes(phone.password),false);
  assert.deepEqual((await devices.list()).map(d=>d.name),['Joel’s iPhone']);
  await devices.revoke(phone.id);assert.equal((await devices.list()).length,0);await assert.rejects(devices.revoke(phone.id),/already removed/);
  const profile=mobileconfig({host:'seek.example.com',password:'abc&def',deviceName:'iPhone'});
  assert.match(profile,/com\.apple\.caldav\.account/);assert.match(profile,/<string>seek\.example\.com<\/string>/);assert.match(profile,/abc&amp;def/);assert.match(profile,/\/work\/dav\/principal\//);
  assert.notEqual(generatePassword(),generatePassword());
});

test('proxy: CalDAV only with a device password, never the cookie; discovery redirect; revocation is immediate',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'seek-davproxy-')),seen=[];
  const upstream=createServer((req,res)=>{seen.push({path:req.url,method:req.method,device:req.headers['x-seek-dav-device']||null,authorization:!!req.headers.authorization,cookie:!!req.headers.cookie});res.writeHead(207,{'Content-Type':'application/xml'});res.end('<ok/>');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  await copyFile(fileURLToPath(new URL('../../../proxy/server.js',import.meta.url)),join(root,'server.cjs'));await copyFile(fileURLToPath(new URL('../../../proxy/work-session-store.cjs',import.meta.url)),join(root,'work-session-store.cjs'));await writeFile(join(root,'.secret'),'synthetic-secret');
  const work=join(root,'work'),devices=new DavDevices(work),phone=await devices.create('iPhone');
  const child=spawn(process.execPath,[join(root,'server.cjs')],{env:{...process.env,DSH_PROXY_USER:'fixture-owner',DSH_PROXY_PASS:'fixture-pass',DSH_WORK_HOME:work,DSH_PROXY_LISTEN_PORT:'0',DSH_PROXY_TARGET_PORT:String(upstream.address().port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const base=await new Promise((resolve,reject)=>{let out='';const timeout=setTimeout(()=>reject(new Error('Fixture proxy did not start')),5000);child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Fixture proxy exited '+code));});child.stdout.on('data',chunk=>{out+=chunk;const match=/listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);if(match){clearTimeout(timeout);resolve(match[1]);}});});
  t.after(async()=>{child.kill();await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await removeFixture(root,'seek-davproxy-');});
  const basic=(user,pass)=>'Basic '+Buffer.from(`${user}:${pass}`).toString('base64');
  const dav=(headers={},path='/work/dav/')=>fetch(base+path,{method:'PROPFIND',redirect:'manual',headers:{Depth:'0',...headers},body:'<propfind xmlns="DAV:"/>'});

  const anon=await dav();assert.equal(anon.status,401);assert.match(anon.headers.get('www-authenticate'),/Basic realm="Seek Calendar"/);
  assert.equal((await dav({Authorization:basic('seek','wrong-password-x')})).status,401);
  assert.equal((await dav({Authorization:basic('fixture-owner','fixture-pass')})).status,401,'the main password is not a CalDAV password');
  const ok=await dav({Authorization:basic('seek',phone.password),Cookie:'dsh_auth=whatever','X-Seek-Dav-Device':'spoofed'});assert.equal(ok.status,207);
  const last=seen.at(-1);assert.deepEqual(last,{path:'/work/dav/',method:'PROPFIND',device:phone.id,authorization:false,cookie:false});
  assert.equal((await dav({Authorization:basic('SEEK',phone.password)},'/work/dav/cal/seek/x.ics')).status,207,'usernames are case-insensitive like Apple sends them');
  const wk=await fetch(base+'/.well-known/caldav',{redirect:'manual'});assert.equal(wk.status,301);assert.equal(wk.headers.get('location'),'/work/dav/');
  // A spoofed device header on an ordinary request never reaches Work.
  await fetch(base+'/work/api/state',{headers:{'X-Seek-Dav-Device':'spoofed'}});assert.notEqual(seen.at(-1)?.device,'spoofed');
  await devices.revoke(phone.id);await new Promise(r=>setTimeout(r,50));
  assert.equal((await dav({Authorization:basic('seek',phone.password)})).status,401,'revoked at once');
  const log=await readFile(join(work,'security-events.jsonl'),'utf8');assert.match(log,/caldav\.failed/);assert.equal(log.includes(phone.password),false);
  // Repeated failures are rate-limited like the login page.
  let status=0;for(let i=0;i<10;i++)status=(await dav({Authorization:basic('seek','guess-'+i+'-xxxx')})).status;assert.equal(status,429);
});
