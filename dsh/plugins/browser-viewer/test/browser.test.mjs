import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController, buildTools, isTrustedApiRequest} from '../lib/index.js';
import {validateJsonSchemaValue} from '@deepseek-ai/dsh-tools';

const page = `<!doctype html><title>Browser agent fixture</title><style>body{font:16px sans-serif}label{display:block;margin:12px}button{padding:10px}#bottom{margin-top:1600px}</style>
<h1>Browser agent fixture</h1><label>Message<textarea id="message"></textarea></label>
<label>Password<input type="password" value="DO_NOT_EXPOSE"></label>
<label>Country<select id="country"><option value="us">United States</option><option value="jp">Japan</option></select></label>
<label><input id="check" type="checkbox">Remember me</label>
<button id="save" onclick="document.querySelector('#result').textContent='Saved: '+document.querySelector('#message').value">Save</button>
<button id="delayed" onclick="setTimeout(()=>document.querySelector('#result').textContent='Delayed success',400)">Delayed</button>
<a href="/second" target="_blank">Open report</a><p id="result"></p>
<button disabled>Disabled</button><div id="shadow"></div>
<button id="bottom" onclick="this.textContent='Bottom clicked'">Bottom control</button>
<script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';</script>`;
const client = await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
const server = createServer((req,res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(req.url === '/ui' ? `<title>Viewer UI fixture</title><script>window.__ModuleLoader__={load:m=>m.factory()};</script><body><script>${client}</script></body>` : req.url === '/second' ? '<title>Report</title><h1>Report complete</h1><a href="/">Home</a>' : page);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(),'dsh-browser-test-'));
const c = new BrowserController({headless:true,windowWidth:1100,windowHeight:800,quality:50,intervalMs:400,browserOptions:{userDataDir:profile}});
const tools = new Map(buildTools(c).map(t=>[t.name,t]));
let checks=0;
async function call(name,args={}) {
  const tool=tools.get(name), result=await tool.execute(args,{});
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema,result),[]);
  assert.equal(typeof tool.output.render(args,result)[0].text,'string');
  checks++; return result;
}
const find=(s,text)=>{const el=s.elements.find(e=>e.text===text);assert.ok(el,'Missing '+text);return el.ref;};
try {
  assert.equal(tools.size,22);
  let s=await call('viewer_start',{url:base});
  assert.equal(s.title,'Browser agent fixture');
  assert.equal(JSON.stringify(s).includes('DO_NOT_EXPOSE'),false);
  assert.ok(find(s,'Shadow button'));
  const stale=find(s,'Message');
  s=await call('viewer_fill',{ref:stale,text:'Hello — 日本語 😀\npath/to_a?x=1&y=2: #$%'});
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("#message").value'),'Hello — 日本語 😀\npath/to_a?x=1&y=2: #$%');
  await assert.rejects(call('viewer_click',{ref:stale}),/Stale/);
  s=await call('viewer_select',{ref:find(s,'Country'),label:'Japan'});
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("#country").value'),'jp');
  s=await call('viewer_click',{ref:find(s,'Remember me')});
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("#check").checked'),true);
  s=await call('viewer_click',{ref:find(s,'Save')});
  assert.match(s.text,/Saved: Hello/);
  s=await call('viewer_fill',{ref:find(s,'Message'),text:''});
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("#message").value'),'');
  s=await call('viewer_type',{ref:find(s,'Message'),text:'exact_✓'});
  s=await call('viewer_key',{key:'Control+A'});
  s=await call('viewer_type',{text:'replacement'});
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("#message").value'),'replacement');
  s=await call('viewer_click',{ref:find(s,'Delayed')});
  s=await call('viewer_wait',{text:'Delayed success',timeoutMs:3000});
  await assert.rejects(call('viewer_wait',{text:'missing text',timeoutMs:100}),/Timed out/);
  s=await call('viewer_snapshot');
  s=await call('viewer_click',{ref:find(s,'Open report')});
  const tabs=await call('viewer_tabs');
  const report=tabs.tabs.find(t=>t.url.endsWith('/second')); assert.ok(report);
  s=await call('viewer_tab',{action:'switch',tabId:report.id}); assert.equal(s.title,'Report');
  await call('viewer_tab',{action:'close',tabId:report.id});
  await call('viewer_navigate',{url:base});
  s=await call('viewer_scroll',{direction:'down',pixels:2000});
  assert.ok(s.scroll.y>0); assert.ok(find(s,'Bottom control'));
  // Action results show the viewport, not the page top, and say when nothing changed.
  {const shown=tools.get('viewer_scroll').output.render({},s)[0].text;assert.match(shown,/Visible around the viewport now:[\s\S]*Bottom control/);assert.doesNotMatch(shown.split('Controls (')[0],/Browser agent fixture\n/);
   const again=await call('viewer_scroll',{direction:'down',pixels:2000});assert.equal(again.unchanged,true);assert.match(tools.get('viewer_scroll').output.render({},again)[0].text,/unchanged since your last observation/);s=again;}
  s=await call('viewer_click',{ref:find(s,'Bottom control')}); assert.match(s.text,/Bottom clicked/);
  await assert.rejects(call('viewer_navigate',{url:'javascript:alert(1)'}),/http/);
  c.paused=true; await assert.rejects(call('viewer_navigate',{url:base}),/paused/);
  assert.equal((await call('viewer_status')).paused,true); c.paused=false;
  await call('viewer_navigate',{url:base+'/second'});
  s=await call('viewer_history',{action:'back'}); assert.equal(s.title,'Browser agent fixture');
  s=await call('viewer_history',{action:'forward'}); assert.equal(s.title,'Report');
  await call('viewer_navigate',{url:base+'/ui'});
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("#dsh-bv-fab").tagName'),'BUTTON');
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("[aria-label=\\"Browser tabs\\"]").tagName'),'SELECT');
  await c.cdp.evaluate(c.activeTabId,'document.querySelector("#dsh-bv-fab").click(); true');
  const shot=await call('viewer_screenshot'); console.log('UI screenshot:',shot.path);
  await call('viewer_stop');
  s=await call('viewer_start',{url:base}); assert.equal(s.title,'Browser agent fixture');
  // Exercise recovery from Chrome death, not just explicit stop.
  await c.cdp.close();
  s=await call('viewer_navigate',{url:base+'/second'}); assert.equal(s.title,'Report');
  assert.equal(isTrustedApiRequest({headers:{host:'127.0.0.1:3080',origin:'http://evil.example'}},[]),false);
  assert.equal(isTrustedApiRequest({headers:{host:'seek.example.test',origin:'https://seek.example.test'}},['seek.example.test']),true);
  console.log(`PASS: ${checks} validated tool calls; input, refs, dropdowns, tabs, scrolling, history, pause, recovery and trust fence.`);
} finally {await c.close(); await new Promise(r=>server.close(r));}
