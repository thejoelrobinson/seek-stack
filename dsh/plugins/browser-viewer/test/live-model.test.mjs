// Explicitly authorized live-harness integration test. Uses only a local form.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const origin='http://127.0.0.1:3080';
async function rpc(method,payload) {
  const r=await fetch(origin+'/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload}),signal:AbortSignal.timeout(15000)});
  const body=await r.json();if(!body.result?.ok)throw new Error(JSON.stringify(body));return body.result.value;
}
let submitted='';
const fixture=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url.startsWith('/done')) {submitted=new URL(req.url,'http://local').searchParams.get('note');res.end('<title>Browser test passed</title><h1>Saved successfully</h1>');}
  else res.end('<title>Local browser verification</title><h1>Browser verification</h1><form action="/done"><label>Note <input name="note"></label><button>Save note</button></form>');
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const target=`http://127.0.0.1:${fixture.address().port}`;
const cwd=await mkdtemp(join(tmpdir(),'dsh-live-browser-test-'));
let sessionId,completed=false;
try {
  ({sessionId}=await rpc('session.create',{cwd}));
  await rpc('session.rename',{sessionId,title:'Browser control verification'});
  await rpc('session.prompt',{sessionId,mode:'queue',content:[{type:'text',text:`This is an authorized local browser integration test. Use only the viewer_* browser tools, using run_code if needed to call them. Do not delegate, use shell tools, or modify files. Navigate to ${target}, fill Note with exactly Browser works ✓, click Save note, and verify Saved successfully on the resulting page. Then stop and report the result. The local form has no external effects.`}]});
  console.log('Live harness test session:',sessionId);
  const deadline=Date.now()+150000;
  while(Date.now()<deadline) {
    await new Promise(r=>setTimeout(r,2000));
    const sessions=await rpc('session.list',{});
    const state=sessions.items.find(s=>s.sessionId===sessionId);
    if(state && !state.running) {completed=true;break;}
  }
  const history=await rpc('session.history',{sessionId,maxMessages:30});
  const serialized=JSON.stringify(history);
  await writeFile(join(cwd,'verification.json'),serialized);
  assert.ok(completed,'Model test did not finish before timeout');
  assert.equal(submitted,'Browser works ✓','Local form did not receive the expected Unicode text');
  assert.match(serialized,/viewer_navigate/);
  assert.match(serialized,/viewer_fill/);
  assert.match(serialized,/viewer_click/);
  console.log('PASS: running DeepSeek harness model used browser tools and submitted the exact text. Evidence:',join(cwd,'verification.json'));
} finally {
  if(sessionId&&!completed)await rpc('session.cancel',{sessionId}).catch(()=>{});
  await new Promise(r=>fixture.close(r));
}
