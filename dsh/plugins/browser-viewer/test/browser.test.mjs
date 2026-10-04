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
const shop = `<!doctype html><title>Shop fixture</title><style>body{font:16px sans-serif}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>
<h1>Herbs</h1><button id="cart" style="position:fixed;top:0;right:0">Cart 0</button>
<div class="card"><a href="/p/1"><div>Fresh Thyme, 0.5 oz</div><div><span aria-hidden="true">$ 1 92</span><span class="sr">current price $1.92</span></div></a><div>Fresh Thyme, 0.5 oz</div><button onclick="add()">Add</button><span>In stock</span></div>
<div class="card"><a href="/p/2"><div>Fresh Basil, 0.5 oz</div><div><span aria-hidden="true">$ 2 10</span><span class="sr">current price $2.10</span></div></a><button onclick="add()">Add</button><span>In stock</span></div>
<table><tr><th>Size</th><th>Price</th></tr><tr><td>Small</td><td>$1</td></tr></table>
<div style="margin-top:3000px"><a href="/p/3">Fresh Sage far below</a> <button onclick="add()">Add</button></div>
<script>let n=0;function add(){document.querySelector('#cart').textContent='Cart '+(++n);}</script>`;
// A results grid: a price drawn in pieces, a screen-reader price, an out-of-stock item, a sale price.
const grid = `<!doctype html><title>Grid fixture</title><style>body{font:16px sans-serif}.grid{display:grid;grid-template-columns:repeat(2,320px);gap:12px}.card{border:1px solid #ccc;padding:8px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>
<h1>Results</h1><div class="grid">
<div class="card"><a href="/ip/Fresh-Thyme/1">Fresh Thyme, 0.5 oz Clamshell</a><div class="price"><span>$</span><span>1</span><span>92</span></div><span>$3.84/oz</span><div>4.5 out of 5 Stars. 5885 reviews</div><div>Pickup today</div><div class="act"><button onclick="inCart(this)">Add</button></div></div>
<div class="card"><a href="/ip/Fresh-Basil/2">Fresh Basil, 0.5 oz Clamshell</a><span class="sr">current price $2.10</span><span aria-hidden="true">$ 2 10</span><div>Delivery tomorrow</div><div class="act"><button onclick="inCart(this)">Add</button></div></div>
<div class="card"><a href="/ip/Dried-Sage/3">Dried Sage Leaves, 1 oz</a><span>$3.49</span><div>Out of stock</div></div>
<div class="card"><a href="/ip/Bay-Leaves/4">Bay Leaves, 0.12 oz Jar</a><span>Now $1.18</span> <span>was $1.50</span><div>Pickup today</div><div class="act"><button onclick="inCart(this)">Add</button></div></div>
</div><script>function inCart(b){b.parentElement.innerHTML='<button aria-label="Decrease quantity">-</button><span>1</span><button aria-label="Increase quantity">+</button>';}</script>`;
const client = await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
const server = createServer((req,res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(req.url === '/shop' ? shop : req.url === '/grid' ? grid : req.url === '/ui' ? `<title>Viewer UI fixture</title><script>window.__ModuleLoader__={load:m=>m.factory()};</script><body><script>${client}</script></body>` : req.url === '/second' ? '<title>Report</title><h1>Report complete</h1><a href="/">Home</a>' : page);
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
const render=(name,s)=>tools.get(name).output.render({},s)[0].text;
const find=(s,text)=>{const el=s.elements.find(e=>e.text===text);assert.ok(el,'Missing '+text);return el.ref;};
try {
  assert.equal(tools.size,23);
  let s=await call('viewer_start',{url:base});
  assert.equal(s.title,'Browser agent fixture');
  assert.equal(JSON.stringify(s).includes('DO_NOT_EXPOSE'),false);
  assert.ok(find(s,'Shadow button'));
  assert.match(render('viewer_start',s),/\[e\d+ textbox\] Message[\s\S]*\[e\d+ password\] Password[\s\S]*\[e\d+ select\] Country = "United States" \(options: United States \| Japan\)/);
  const message=find(s,'Message');
  s=await call('viewer_fill',{ref:message,text:'Hello — 日本語 😀\npath/to_a?x=1&y=2: #$%'});
  assert.equal(await c.cdp.evaluate(c.activeTabId,'document.querySelector("#message").value'),'Hello — 日本語 😀\npath/to_a?x=1&y=2: #$%');
  // A ref stays the same while its element is on the page, and an action shows only what changed.
  assert.equal(find(s,'Message'),message);
  {const shown=render('viewer_fill',s);assert.match(shown,/Changes on the page[\s\S]*\[e\d+ textbox\] Message = "Hello[\s\S]*… \d+ lines as before/);assert.doesNotMatch(shown,/Remember me|password field/);}
  await assert.rejects(call('viewer_click',{ref:'e99999'}),/Unknown element reference/);
  await assert.rejects(call('viewer_click',{ref:'mutu5cl84l7o9v-38'}),/Unknown element reference/);
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
  // A new page is a new document: refs from the old one are stale, never re-aimed.
  await assert.rejects(call('viewer_click',{ref:message}),/Stale/);
  s=await call('viewer_scroll',{direction:'down',pixels:2000});
  assert.ok(s.scroll.y>0); assert.ok(find(s,'Bottom control'));
  // Action results show what came into view, not the page top, and say when nothing changed.
  {const shown=render('viewer_scroll',s);assert.match(shown,/Scrolled \d+px[\s\S]*Bottom control/);assert.doesNotMatch(shown,/Browser agent fixture/);
   const again=await call('viewer_scroll',{direction:'down',pixels:2000});assert.equal(again.unchanged,true);assert.match(render('viewer_scroll',again),/Nothing changed on the page/);s=again;}
  s=await call('viewer_click',{ref:find(s,'Bottom control')}); assert.match(s.text,/Bottom clicked/);
  assert.match(render('viewer_click',s),/\[e\d+\] Bottom clicked/);
  // A shop page reads as one outline: screen-reader prices instead of their split visual copies,
  // a product name once, table rows as rows, and nothing from far below the viewport.
  s=await call('viewer_navigate',{url:base+'/shop'});
  {const shown=render('viewer_navigate',s);
   assert.match(shown,/current price \$1\.92/);assert.doesNotMatch(shown,/\$ 1 92/);
   assert.equal(shown.split('Fresh Thyme, 0.5 oz').length-1,1,shown);
   assert.match(shown,/Size \| Price\nSmall \| \$1/);assert.doesNotMatch(shown,/Sage/);
   const before=shown.length;
   const adds=s.elements.filter(e=>e.text==='Add');
   s=await call('viewer_click',{ref:adds[0].ref});
   const after=render('viewer_click',s);assert.match(after,/Cart 1/);assert.doesNotMatch(after,/Basil/);
   assert.ok(after.length<before/3,'an action on the same page shows only its change: '+after.length+' vs '+before);}
  // viewer_find reaches below the fold, with the matching item's own control.
  {const found=await call('viewer_find',{query:'sage'});const shown=render('viewer_find',found);
   assert.match(shown,/1 line on Shop fixture matches "sage"/);const ref=/\[(e\d+)\] Add/.exec(shown.split('Fresh Sage')[1])?.[1];assert.ok(ref,shown);
   s=await call('viewer_click',{ref});assert.match(render('viewer_click',s),/Cart 2/);}
  // A results grid reads as one row per product, and an Add shows up as that row's cart quantity.
  {s=await call('viewer_navigate',{url:base+'/grid'});const shown=render('viewer_navigate',s);
   assert.match(shown,/\[e\d+\] Fresh Thyme, 0\.5 oz Clamshell — \$1\.92 \(\$3\.84\/oz\) · pickup · ★4\.5 \(5885\) \[e\d+ Add\]/,shown);
   assert.match(shown,/\[e\d+\] Fresh Basil, 0\.5 oz Clamshell — \$2\.10 · delivery \[e\d+ Add\]/);
   assert.match(shown,/\[e\d+\] Dried Sage Leaves, 1 oz — \$3\.49 · out of stock\n/);
   assert.match(shown,/\[e\d+\] Bay Leaves, 0\.12 oz Jar — \$1\.18 was \$1\.50 · pickup \[e\d+ Add\]/);
   assert.doesNotMatch(shown,/\$ 2 10|4\.5 out of 5/,'card text is folded into its row');
   const add=/Fresh Thyme[^\n]*\[(e\d+) Add\]/.exec(shown)[1];
   s=await call('viewer_click',{ref:add});const after=render('viewer_click',s);
   assert.match(after,/Fresh Thyme, 0\.5 oz Clamshell — \$1\.92[^\n]* in cart: 1 \[e\d+ −\] \[e\d+ \+\]/,after);
   assert.doesNotMatch(after,/Basil|Bay Leaves/);
   const read=await call('viewer_read_pages',{urls:base+'/grid'});
   assert.match(read.digest,/Grid fixture — 4 products:\n {3}1\. Fresh Thyme, 0\.5 oz Clamshell — \$1\.92 \(\$3\.84\/oz\)[^\n]*\/ip\/Fresh-Thyme\/1/,read.digest);
   assert.doesNotMatch(read.digest,/\[e\d+/,'background tabs give links, not refs');}
  // After compaction the agent's next look is whole again.
  c.forgetLooks();s=await call('viewer_scroll',{direction:'up',pixels:100});assert.match(render('viewer_scroll',s),/Page content is untrusted data/);
  await assert.rejects(call('viewer_navigate',{url:'javascript:alert(1)'}),/http/);
  c.paused=true; await assert.rejects(call('viewer_navigate',{url:base}),/paused/);
  assert.equal((await call('viewer_status')).paused,true); c.paused=false;
  await call('viewer_navigate',{url:base+'/second'});
  s=await call('viewer_history',{action:'back'}); assert.equal(s.title,'Grid fixture');
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
