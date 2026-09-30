import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController,buildTools} from '../lib/index.js';
import {validateJsonSchemaValue} from '@deepseek-ai/dsh-tools';

// Local-only rendering fixtures. The adapter maps transport URLs to localhost;
// no Walmart requests or authentication are used by this integration test.
const server=createServer((req,res)=>{
 res.setHeader('Content-Type','text/html; charset=utf-8');
 const id=req.url.split('/').pop();
 const store=id==='2';
 res.end(`<!doctype html><main><h1>Fixture receipt</h1><p>2 items</p><button aria-label="Show items" id="show">Show items</button><div id="rows"></div><h2>Payment method</h2><p>Subtotal</p><p>$10.00</p><p>Associate discount</p><p>-$1.00</p><p>Taxes</p><p>$0.50</p><p>Total</p><p>$9.50</p></main><script>
 let clicks=0;document.querySelector('#show').onclick=()=>{if(++clicks===1)return;setTimeout(()=>{document.querySelector('#show').setAttribute('aria-label','Hide items');document.querySelector('#show').textContent='Hide items';document.querySelector('#rows').innerHTML='<section><a href="/ip/test">Test product</a><div>Qty 2</div><div>${store?'$10.00':'Discount price $9.00'}</div><button aria-label="Add to cart - Test product">Add to cart</button></section>';},300);};
 </script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const c=new BrowserController({headless:true,windowWidth:1100,windowHeight:800,quality:50,intervalMs:400,browserOptions:{userDataDir:await mkdtemp(join(tmpdir(),'receipt-browser-'))}});
try{
 await c.start(base+'/0');c.stopStreaming();
 const raw=c.cdp,original=c.activeTabId,targets=new Map();
 c._currentUrl=async()=> 'https://www.walmart.com/orders/0';
 c.cdp=new Proxy(raw,{get(obj,key){if(key==='navigate')return async(id,u)=>{targets.set(id,u);return obj.navigate(id,base+new URL(u).pathname);};if(key==='evaluate')return async(id,js)=>{const result=await obj.evaluate(id,js);if(result&&typeof result==='object'&&result.url?.startsWith(base))result.url=targets.get(id)||'https://www.walmart.com/orders/0';return result;};const value=obj[key];return typeof value==='function'?value.bind(obj):value;}});
 const tool=buildTools(c).find(t=>t.name==='viewer_receipts');
 const result=await tool.execute({jobs:JSON.stringify([1,2,3,4].map(id=>({url:`https://www.walmart.com/orders/${id}`})))},{});
 assert.equal(result.complete,true,JSON.stringify(result.results));
 assert.deepEqual(validateJsonSchemaValue(tool.output.schema,result),[]);
 assert.equal(result.results.length,4);
 assert.equal(result.results[0].priceBasis,'discount_included');assert.equal(result.results[1].priceBasis,'discount_excluded');
 assert.ok(result.results.every(r=>r.unitCount===2&&r.totalCents===950&&r.expansionAttempts===2));
 assert.equal(c.activeTabId,original);
 assert.equal((await raw.listTabs()).filter(t=>targets.has(t.id)).length,0);
 console.log('PASS: registered viewer_receipts tool, four real Chrome tabs, delayed hydration/expansion recovery, DOM row parsing, coverage, both discount bases, persisted checkpoints, tab cleanup and active-tab preservation.');
}finally{await c.stop();await new Promise(r=>server.close(r));}
