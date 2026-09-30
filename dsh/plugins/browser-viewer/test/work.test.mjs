import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {CdpBrowser} from '../lib/cdp.js';
const origin=process.env.DSH_TEST_ORIGIN||'http://127.0.0.1:3081';
async function api(path,body){const r=await fetch(origin+'/work/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;}
async function wait(fn,label,timeout=150000){const until=Date.now()+timeout;while(Date.now()<until){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw new Error('Timeout: '+label);}
const taskState=async id=>(await api('state')).tasks.find(t=>t.id===id);
const ui=new CdpBrowser({headless:true,windowSize:'1440,1000',userDataDir:await mkdtemp(join(tmpdir(),'dsh-work-ui-'))});
let submitted='',first,ask,scheduled;
const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url.startsWith('/done')){submitted=new URL(req.url,'http://local').searchParams.get('note');res.end('<h1>Saved successfully</h1>');}else res.end('<h1>Verification</h1><form action="/done"><label>Note <input name="note"></label><button>Save note</button></form>');});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
try {
  await wait(()=>api('state').then(s=>s.version===1).catch(()=>false),'Work routes ready',60000);
  const denied=await fetch(origin+'/work/api/state',{headers:{Origin:'https://untrusted.example'}});assert.equal(denied.status,403);
  await ui.launch();let tab=await ui.newTab(origin+'/work');
  await wait(()=>ui.evaluate(tab,"!!document.querySelector('.welcome')"),'welcome',10000);
  const out=join(homedir(),'.dsh','browser','test-out');await mkdir(out,{recursive:true});
  await writeFile(join(out,'work-desktop.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
  await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},ui.tabs.get(tab));
  assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth <= innerWidth'),true,'Mobile horizontal overflow');
  await writeFile(join(out,'work-mobile.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
  await ui.evaluate(tab,"document.querySelector('[data-view=memory]').click(); true");
  await wait(()=>ui.evaluate(tab,"!!document.querySelector('#memory-form')"),'memory form',10000);
  await api('settings',{name:'Seek',memory:'Keep the final answer concise. Verify files before attaching.',notifications:false});
  // Hand off, then close the UI. Completion must be server-owned.
  first=await api('task',{objective:`Use the browser to open http://127.0.0.1:${fixture.address().port}, enter exactly Background works in Note and click Save note. Read the confirmation. Read the attached brief.txt, create result.txt with exactly its requested output, and register it with work_artifact. Keep a short plan with work_progress. Use get_goal/update_goal to mark complete only after verifying both the form and file.`,files:[{name:'brief.txt',data:Buffer.from('The report must contain exactly: VERIFIED WORK MODE').toString('base64')}]});
  await ui.close();
  const done=await wait(async()=>{const t=await taskState(first.id);if(t.status==='attention'||t.status==='waiting')throw new Error('Task needs attention: '+JSON.stringify({error:t.error,question:t.question,messages:t.messages.slice(-1)}));return t.status==='complete'?t:false;},'background browser + artifact');
  assert.equal(submitted,'Background works');assert.ok(done.artifacts.length>0);assert.ok(done.plan.length>0);
  const artifact=done.artifacts.find(a=>a.path.endsWith('result.txt'));assert.ok(artifact);
  const response=await fetch(`${origin}/work/api/artifact?task=${done.id}&id=${artifact.id}`);assert.equal((await response.text()).trim(),'VERIFIED WORK MODE');
  assert.match(response.headers.get('content-disposition'),/attachment/);
  console.log('PASS: task finished after UI closed; real model browsed, submitted, created and attached a verified file.');
  ask=await api('task',{objective:'Ask me which color I want using work_ask with choices Blue and Green. Wait for my answer. Then create color.txt containing exactly the selected color, attach it with work_artifact, and mark the goal complete. Do not choose for me.'});
  await wait(async()=>{const t=await taskState(ask.id);return t.status==='waiting'?t:false;},'structured question');
  scheduled=await api('task',{objective:'This scheduled test must remain queued until stopped.',runAt:new Date(Date.now()+86400000).toISOString()});
  await api('control',{id:scheduled.id,action:'pause'});assert.equal((await taskState(scheduled.id)).status,'paused');
  const waiting=await taskState(ask.id);assert.equal(waiting.goal.phase,'paused');
  await api('control',{id:ask.id,action:'reply',answer:'Blue'});
  const answered=await wait(async()=>{const t=await taskState(ask.id);if(t.status==='attention')throw new Error(t.error||JSON.stringify(t.question));return t.status==='complete'?t:false;},'answer and resume');
  assert.ok(answered.artifacts.length);assert.equal((await readFile(join(answered.cwd,answered.artifacts[0].path),'utf8')).trim(),'Blue');
  console.log('PASS: structured question paused its goal; reply resumed and finished; schedule/pause and trust fence passed.');
  await api('control',{id:scheduled.id,action:'stop'});
  console.log('Screenshots:',join(out,'work-desktop.png'),join(out,'work-mobile.png'));
} catch(error){console.error('WORK TEST FAILURE:',error.message);throw error;} finally {
  for(const t of [first,ask,scheduled].filter(Boolean)){const latest=await taskState(t.id).catch(()=>null);if(latest&&['running','queued','scheduled','waiting'].includes(latest.status))await api('control',{id:t.id,action:'stop'}).catch(()=>{});}
  await ui.close();fixture.closeAllConnections();await new Promise(r=>fixture.close(r));
}
