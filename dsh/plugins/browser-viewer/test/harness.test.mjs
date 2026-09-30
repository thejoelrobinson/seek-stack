// Defaults to a separate test harness. Set DSH_TEST_PORT=3080 only for authorized live tests.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CdpBrowser} from '../lib/cdp.js';

const port=Number(process.env.DSH_TEST_PORT || 3081);
const origin=`http://127.0.0.1:${port}`;
const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8'); res.end('<title>Agent browser verification</title><h1>Browser control is connected</h1><label>Note <input></label><p>Local test page. No external submissions.</p>');});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const target=`http://127.0.0.1:${fixture.address().port}`;
const ws=new WebSocket(`ws://127.0.0.1:${port}/browser/stream`);
let status,frames=0;
ws.onmessage=e=>{if(typeof e.data==='string') status=JSON.parse(e.data);else frames++;};
const wait=async(fn,label)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timeout: '+label);};
const ui=new CdpBrowser({headless:true,windowSize:'1440,1000',userDataDir:await mkdtemp(join(tmpdir(),'dsh-viewer-ui-'))});
try {
  await wait(()=>ws.readyState===1&&status,'socket');
  assert.equal(status.paused,false);
  ws.send(JSON.stringify({type:'start',url:target}));
  await wait(()=>status?.title==='Agent browser verification'&&frames>0,'streamed frame');
  await ui.launch(); const tab=await ui.newTab(origin);
  await wait(()=>ui.evaluate(tab,"!!document.querySelector('#dsh-bv-fab')"),'plugin client');
  await ui.evaluate(tab,"document.querySelector('#dsh-bv-fab').click(); true");
  await wait(()=>ui.evaluate(tab,"Array.from(document.querySelectorAll('#dsh-bv-panel button')).some(b=>b.textContent==='Take over' && !b.disabled) && document.querySelector('.dsh-bv-url').textContent.startsWith('http://127.0.0.1:')"),'takeover button connected');
  await ui.evaluate(tab,"Array.from(document.querySelectorAll('#dsh-bv-panel button')).find(b=>b.textContent==='Take over').click();true");
  await wait(()=>status.paused,'pause via UI');
  await wait(()=>ui.evaluate(tab,"Array.from(document.querySelectorAll('#dsh-bv-panel button')).some(b=>b.textContent==='Resume agent')"),'resume label');
  await ui.evaluate(tab,"Array.from(document.querySelectorAll('#dsh-bv-panel button')).find(b=>b.textContent==='Resume agent').click();true");
  await wait(()=>!status.paused,'resume via UI');
  ws.send(JSON.stringify({type:'tab',action:'open',url:target+'/new'}));
  await wait(()=>status.url===target+'/new','new tab');
  await wait(()=>ui.evaluate(tab,"document.querySelector('[aria-label=\"Browser tabs\"]').options.length>=2"),'tab selector');
  await new Promise(r=>setTimeout(r,700));
  const out=join(process.env.USERPROFILE,'.dsh','browser','test-out','harness-v0.2.png');
  await writeFile(out,Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
  console.log('PASS: actual DSH plugin boot, streamed Chrome frames, UI pause/resume and tab selector. Screenshot:',out);
} finally {
  if(ws.readyState===1){ws.send(JSON.stringify({type:'stop'}));await wait(()=>!status.running,'stop test browser').catch(()=>{});}
  ws.close();await ui.close();await new Promise(r=>fixture.close(r));
}
