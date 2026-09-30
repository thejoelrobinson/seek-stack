import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateReceiptJobs,normalizeReceipt,readReceiptBatch} from '../lib/receipt-batch.js';
const url=id=>`https://www.walmart.com/orders/${id}`;
const jobs=[1,2,3,4].map(n=>({url:url(n),expectedLines:1}));
const state=(id=1)=>({url:url(id),gate:null,expandCount:0,declaredUnits:2,rows:[{name:'Fixture',raw:'Fixture\nQty 2\nDiscount price $9.00\n$10.00',truncated:false}],summary:'Payment method\nSubtotal\n$10.00\nAssociate discount\n-$1.00\nTaxes\n$0.50\nTotal\n$9.50',truncated:false});
function harness(overrides={}){
 let next=0,active=0,peak=0,closed=[],tabs=new Map();
 const c={running:true,paused:false,activeTabId:'original',_currentUrl:async()=>url(99),requestHandoff:async function(h){this.paused=true;this.handoff=h;},cdp:{
  newTab:async()=>{const id=++next;tabs.set(id,null);peak=Math.max(peak,++active);return id;},
  navigate:async(id,u)=>{tabs.set(id,Number(new URL(u).pathname.split('/').pop()));},
  evaluate:async(id,js)=>{if(overrides.evaluate)return overrides.evaluate(id,js,c,tabs);return state(tabs.get(id));},
  closeTab:async id=>{closed.push(id);active--;tabs.delete(id);}
 }};
 return {c,get peak(){return peak;},closed,tabs};
}
test('URLs, bounds, duplicate protection, stable string identifiers',()=>{
 assert.equal(validateReceiptJobs([{url:url('78120492001894404312')}])[0].orderId,'78120492001894404312');
 for(const input of [[],[...jobs,jobs[0]],[jobs[0],jobs[0]],[{url:'https://evil.test/orders/1'}],[{url:url(1)+'/returns'}],[{url:url(1)+'?action=delete'}],[{url:url(1),expectedLines:0}]])assert.throws(()=>validateReceiptJobs(input));
});
test('extended prices are not multiplied by units; discount basis reconciles',()=>{
 const j=validateReceiptJobs([jobs[0]])[0],s=state();
 let r=normalizeReceipt(s,j);assert.equal(r.verified,true);assert.equal(r.totalCents,950);assert.equal(r.unitCount,2);assert.equal(r.priceBasis,'discount_included');
 s.rows[0].raw='Fixture\nQty 2\n$10.00';r=normalizeReceipt(s,j);assert.equal(r.verified,true);assert.equal(r.priceBasis,'discount_excluded');
});
test('missing quantities, mismatched totals, adjustments and truncation fail closed',()=>{
 const j=validateReceiptJobs([jobs[0]])[0];
 for(const change of [s=>s.rows[0].raw='Fixture\n$9.00',s=>s.summary=s.summary.replace('$9.50','$8.00'),s=>s.summary+='\nDriver tip $1.00',s=>s.rows[0].truncated=true,s=>s.declaredUnits=3,s=>s.truncated=true]){const s=state();change(s);assert.equal(normalizeReceipt(s,j).verified,false);}
});
test('four workers preserve active tab and checkpoint every verified receipt',async()=>{
 const h=harness(),outputDir=await mkdtemp(join(tmpdir(),'receipt-test-'));
 const r=await readReceiptBatch(h.c,{jobs},{outputDir});assert.equal(r.complete,true);assert.equal(h.peak,4);assert.equal(h.closed.length,4);assert.equal(h.c.activeTabId,'original');
 assert.deepEqual(JSON.parse(await readFile(r.path,'utf8')),r);
 assert.equal(JSON.parse(await readFile(join(outputDir,r.batchId,'0.json'),'utf8')).status,'verified');
});
test('explicit two-worker cap is enforced',async()=>{
 const h=harness();const r=await readReceiptBatch(h.c,{jobs,concurrency:2},{outputDir:await mkdtemp(join(tmpdir(),'receipt-test-'))});assert.equal(r.complete,true);assert.equal(h.peak,2);
});
test('login stops the batch and preserves the gated tab for handoff',async()=>{
 const h=harness({evaluate:async(id,js,c,tabs)=>({url:url(tabs.get(id)),gate:'login'})});
 const r=await readReceiptBatch(h.c,{jobs,concurrency:1},{outputDir:await mkdtemp(join(tmpdir(),'receipt-test-'))});assert.equal(r.complete,false);assert.equal(r.results.filter(x=>x.status==='not_started').length,3);assert.equal(h.c.handoff.reason,'login');assert.equal(h.tabs.size,1);
});
test('navigation failure closes owned tabs and leaves pending work explicit',async()=>{
 const h=harness();h.c.cdp.navigate=async()=>{throw Error('network failure');};const r=await readReceiptBatch(h.c,{jobs,concurrency:1},{outputDir:await mkdtemp(join(tmpdir(),'receipt-test-'))});assert.equal(r.complete,false);assert.equal(h.tabs.size,0);assert.equal(r.results[1].status,'failed');assert.equal(r.results[3].status,'not_started');
});
test('pause and abort prevent new work',async()=>{
 const h=harness();h.c.paused=true;await assert.rejects(readReceiptBatch(h.c,{jobs}),/paused/);assert.equal(h.peak,0);h.c.paused=false;const a=new AbortController();a.abort();await assert.rejects(readReceiptBatch(h.c,{jobs},{signal:a.signal}),/abort/i);assert.equal(h.peak,0);
});
test('pause during navigation prevents item inspection and closes workers',async()=>{
 const h=harness();h.c.cdp.navigate=async()=>{h.c.paused=true;};const r=await readReceiptBatch(h.c,{jobs,concurrency:1},{outputDir:await mkdtemp(join(tmpdir(),'receipt-test-'))});assert.equal(r.complete,false);assert.equal(h.tabs.size,0);
});
test('collapsed rows are retried, then stable complete rows are required',async()=>{
 let clicks=0;const h=harness({evaluate:async(id,js,c,tabs)=>{if(js.includes('function expandReceiptItems')){clicks++;return 1;}const s=state(tabs.get(id));if(clicks<2){s.expandCount=1;s.rows=[];}return s;}});
 const r=await readReceiptBatch(h.c,{jobs:[jobs[0]]},{outputDir:await mkdtemp(join(tmpdir(),'receipt-test-'))});assert.equal(r.complete,true);assert.equal(clicks,2);
});
test('wrong origin stops extraction',async()=>{
 const h=harness({evaluate:async()=>({...state(),url:'https://example.org/'})});const r=await readReceiptBatch(h.c,{jobs:[jobs[0]]},{outputDir:await mkdtemp(join(tmpdir(),'receipt-test-'))});assert.equal(r.complete,false);assert.equal(h.tabs.size,0);
});
test('duplicate delivery groups are excluded from totals and checkpointed for review',async()=>{
 const h=harness();const outputDir=await mkdtemp(join(tmpdir(),'receipt-test-'));
 const r=await readReceiptBatch(h.c,{jobs:[{url:url(1)+'?groupId=a',expectedLines:1},{url:url(1)+'?groupId=b',expectedLines:1}]},{outputDir});
 assert.equal(r.complete,false);assert.ok(r.results.every(x=>x.status==='needs_review'));
 assert.match(r.digest,/Verified, unique-order subtotal: \$0\.00 \(0 orders\)/);
 assert.equal(JSON.parse(await readFile(join(outputDir,r.batchId,'0.json'),'utf8')).status,'needs_review');
});
