import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'seek-recovery-smoke-'));t.after(async()=>{const target=resolve(root),part=relative(resolve(tmpdir()),target);if(!part||part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part)||!basename(target).startsWith('seek-recovery-smoke-'))throw new Error('Unsafe fixture cleanup.');await rm(target,{recursive:true,force:true,maxRetries:8,retryDelay:200});});return root;}
async function run(binary,args){return new Promise((ok,no)=>{const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.once('error',no);child.once('exit',code=>code===0?ok(out):no(new Error('Synthetic fixture process failed: '+err)));});}

test('recovery authentication performs nonce-cookie and CSRF form sign-in, then reuses the session cookie',{timeout:15000},async t=>{
 const root=await fixture(t),requests=[];
 const server=createServer(async(req,res)=>{
  requests.push({method:req.method,url:req.url});const origin='http://127.0.0.1:'+server.address().port;
  if(req.method==='GET'&&req.url.startsWith('/login')){res.setHeader('Set-Cookie','dsh_login_csrf=fixture-nonce; Path=/login; HttpOnly; SameSite=Strict');return res.end('<input type="hidden" name="csrf" value="fixture-csrf">');}
  if(req.method==='POST'&&req.url==='/login'){
   let text='';for await(const chunk of req)text+=chunk;const body=new URLSearchParams(text);
   const valid=req.headers.cookie?.includes('dsh_login_csrf=fixture-nonce')&&req.headers.origin===origin&&req.headers.referer===origin+'/login?next=%2Fwork'&&body.get('csrf')==='fixture-csrf'&&body.get('username')==='fixture+owner'&&body.get('password')==='synthetic&pass=with punctuation'&&body.get('next')==='/work';
   if(!valid){res.writeHead(403);return res.end('Fixture auth rejected.');}res.writeHead(303,{Location:'/work','Set-Cookie':'dsh_auth=v2.fixture-session.signature; Path=/; HttpOnly; SameSite=Lax'});return res.end();
  }
  if(req.url==='/work/api/version'&&req.headers.cookie==='dsh_auth=v2.fixture-session.signature'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({release:'fixture'}));}
  res.writeHead(401);res.end('Synthetic authentication required.');
 });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
 const scriptPath=fileURLToPath(new URL('./recovery-smoke.ps1',import.meta.url)),fixturePath=join(root,'auth.ps1'),origin='http://127.0.0.1:'+server.address().port;
 await writeFile(fixturePath,`$ErrorActionPreference='Stop'\n$tokens=$null;$errors=$null\n$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(scriptPath)},[ref]$tokens,[ref]$errors)\nif($errors.Count){throw 'Fixture parser failed.'}\n$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Establish-Session'},$true)\n. ([scriptblock]::Create($function.Extent.Text))\nEstablish-Session -AuthOrigin ${quote(origin)} -User 'fixture+owner' -Password 'synthetic&pass=with punctuation'\n`);
 const output=(await run(join(process.env.WINDIR,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',fixturePath])).trim();
 assert.equal(output,'dsh_auth=v2.fixture-session.signature');assert.equal((await fetch(origin+'/work/api/version',{headers:{Cookie:output}})).status,200);assert.deepEqual(requests.map(x=>x.method),['GET','POST','GET']);
});
test('read-only data fingerprint remains stable and detects changed artifact bytes',async t=>{
 const root=await fixture(t);await mkdir(join(root,'images','outputs'),{recursive:true});await mkdir(join(root,'tasks','task'),{recursive:true});
 await writeFile(join(root,'tasks','task','result.txt'),'Synthetic artifact');await writeFile(join(root,'images','outputs','fixture.png'),'Synthetic pixels');
 await writeFile(join(root,'images','images.json'),JSON.stringify({items:[{id:'image',file:'fixture.png',prompt:'Synthetic image'}]}));await writeFile(join(root,'work.json'),JSON.stringify({tasks:[{id:'task',cwd:join(root,'tasks','task'),messages:[{role:'user',text:'Synthetic task'}],artifacts:[{id:'artifact',path:'result.txt'}]}]}));
 const helper=fileURLToPath(new URL('./recovery-fingerprint.mjs',import.meta.url)),read=async()=>JSON.parse(await run(process.execPath,[helper,root]));
 const before=await read();assert.deepEqual(await read(),before);assert.equal(before.tasks,1);assert.equal(before.artifacts,1);assert.equal(before.images,1);
 await writeFile(join(root,'tasks','task','result.txt'),'Changed synthetic artifact');const after=await read();assert.notEqual(after.artifactSHA256,before.artifactSHA256);assert.equal(after.workSHA256,before.workSHA256);assert.equal(after.outputSHA256,before.outputSHA256);
});
