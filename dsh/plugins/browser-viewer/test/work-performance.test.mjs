import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,symlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkResultStore,previewResult} from '../lib/work-results.js';
import {WorkModelQueue} from '../lib/work-model-queue.js';
const fixture=async()=>new WorkResultStore(await mkdtemp(join(tmpdir(),'seek-result-trial-')));
const result=text=>({app:'fixture',tool:'list_rows',content:[{type:'text',text}]});
test('side by side: legacy clipping loses middle data; saved results retain every row',async()=>{
 const store=await fixture(),rows=Array.from({length:500},(_,i)=>({id:i,amountCents:i*13-120,label:'Synthetic entry '+i+' '.repeat(24)})),raw=JSON.stringify({rows,nextCursor:'next-provider-page'});
 const legacy={content:[raw.slice(0,12000)],truncated:false};assert.ok(raw.length>12000);assert.throws(()=>JSON.parse(legacy.content[0]));assert.equal(legacy.truncated,false);
 const receipt=await store.capture(result(raw));assert.equal(receipt.truncated,true);assert.ok(JSON.stringify(receipt).length<8192);assert.equal(receipt.saved.providerCoverage,'not_verified');
 const full=JSON.parse(await readFile(join(store.root,receipt.saved.path),'utf8'));assert.equal(full.content[0].text,raw);
 assert.equal((await store.access(receipt.saved.ref,{operation:'query',path:'rows',mode:'count'})).rowCount,500);
 assert.equal((await store.access(receipt.saved.ref,{operation:'query',path:'rows',mode:'sum_integer',field:'amountCents'})).total,rows.reduce((s,r)=>s+BigInt(r.amountCents),0n).toString());
 let recovered='',offset=0;do{const p=await store.access(receipt.saved.ref,{offset,limit:2000});recovered+=p.text;offset=p.nextOffset;}while(offset!==null);assert.equal(recovered,raw);
});
test('preview clipping flags one block, many blocks, and omitted non-text blocks',()=>{
 assert.equal(previewResult(result('x'.repeat(2401))).truncated,true);assert.equal(previewResult(result('x'.repeat(2400))).truncated,false);
 const r=previewResult({content:Array.from({length:10},()=>({type:'text',text:'x'.repeat(300)}))});assert.equal(r.truncated,true);assert.equal(r.content.join('').length,2400);
 assert.equal(previewResult({content:[{type:'image',data:'abc'}]}).omittedNonTextBlocks,1);
});
test('JSON fields, filters and pages retain exact values and report coverage',async()=>{
 const store=await fixture(),{saved}=await store.capture(result(JSON.stringify({data:[{id:1,kind:'a',v:10},{id:2,kind:'b',v:-2},{id:3,kind:'a',v:7}]})));
 const p=await store.access(saved.ref,{operation:'query',path:'data',mode:'select',fields:['id','v'],limit:1});assert.deepEqual(p.rows,[{id:1,v:10}]);assert.equal(p.nextOffset,1);
 const s=await store.access(saved.ref,{operation:'query',path:'data',mode:'sum_integer',field:'v',where:{field:'kind',equals:'a'}});assert.equal(s.total,'17');assert.equal(s.matchedCount,2);assert.match(s.scope,/Check pagination/);
});
test('sum rejects decimals, missing values and unsafe integers; preserves huge exact total',async()=>{
 for(const rows of [[{v:1.2}],[{}],[{v:Number.MAX_SAFE_INTEGER+1}]]){const s=await fixture(),r=await s.capture(result(JSON.stringify(rows)));await assert.rejects(s.access(r.saved.ref,{operation:'query',mode:'sum_integer',field:'v'}));}
 const s=await fixture(),r=await s.capture(result(JSON.stringify([{v:Number.MAX_SAFE_INTEGER},{v:Number.MAX_SAFE_INTEGER}])));assert.equal((await s.access(r.saved.ref,{operation:'query',mode:'sum_integer',field:'v'})).total,'18014398509481982');
});
test('invalid references and cross-task reads fail closed',async()=>{
 const s=await fixture(),r=await s.capture(result('hello')),other=await fixture();
 for(const ref of ['../private','C:\\private','',r.saved.ref+'/../x'])await assert.rejects(s.access(ref));
 await assert.rejects(other.access(r.saved.ref));
 for(const args of [{offset:-1},{limit:3001},{block:-1},{block:1},{operation:'execute'}])await assert.rejects(s.access(r.saved.ref,args));
});
test('directory junction cannot redirect saved responses outside the task',async()=>{
 const s=await fixture(),outside=await mkdtemp(join(tmpdir(),'seek-outside-'));await symlink(outside,join(s.root,'tool-results'),'junction');await assert.rejects(s.capture(result('hello')),/inside/);
});
test('prototype paths and oversized selected rows fail closed',async()=>{
 const s=await fixture(),r=await s.capture(result(JSON.stringify({rows:[{blob:'x'.repeat(5000)}]})));
 for(const path of ['__proto__','constructor','rows.__proto__'])await assert.rejects(s.access(r.saved.ref,{operation:'query',path,mode:'count'}));
 await assert.rejects(s.access(r.saved.ref,{operation:'query',path:'rows',mode:'select'}),/preview budget/);
});
test('non-JSON content and Unicode are stored without loss',async()=>{
 const s=await fixture(),raw='☃ café "quoted"\n'.repeat(900),r=await s.capture(result(raw));let reconstructed='',offset=0;
 do{const p=await s.access(r.saved.ref,{offset,limit:137});reconstructed+=p.text;offset=p.nextOffset;}while(offset!==null);assert.equal(reconstructed,raw);
 await assert.rejects(s.access(r.saved.ref,{operation:'query',mode:'count'}),/not JSON/);
});
test('escaped control characters stay below the harness pruning boundary',async()=>{
 const s=await fixture(),r=await s.capture(result('\u0000'.repeat(8000)));assert.ok(JSON.stringify(r).length<8192);assert.equal(r.truncated,true);
 const p=await s.access(r.saved.ref,{limit:3000});assert.ok(JSON.stringify(p).length<8192);assert.ok(p.nextOffset>0);
});
test('structured-only MCP output remains queryable after service restart',async()=>{
 const s=await fixture(),r=await s.capture({structuredContent:{rows:[{n:13},{n:17}]},content:[]});assert.equal(r.structuredBlock,0);
 const restarted=new WorkResultStore(s.root);assert.equal((await restarted.access(r.saved.ref,{operation:'query',path:'rows',mode:'sum_integer',field:'n'})).total,'30');
});
test('oversized provider response fails explicitly rather than clipping',async()=>{
 const s=await fixture();await assert.rejects(s.capture(result('x'.repeat(25*1024*1024))),/25 MB/);
});
test('many result captures cannot overwrite each other',async()=>{
 const s=await fixture(),receipts=await Promise.all(Array.from({length:50},(_,n)=>s.capture(result(JSON.stringify([{n}])))));assert.equal(new Set(receipts.map(r=>r.saved.ref)).size,50);
 for(let n=0;n<receipts.length;n++)assert.equal((await s.access(receipts[n].saved.ref,{operation:'query',mode:'sum_integer',field:'n'})).total,String(n));
});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
test('queue serializes helpers and uses priority with FIFO ties',async()=>{
 let busy=true,active=0,max=0;const order=[],q=new WorkModelQueue({busy:()=>busy,pollMs:5});
 const run=(name,priority)=>q.submit(async()=>{active++;max=Math.max(max,active);order.push(name);await new Promise(r=>setTimeout(r,5));active--;return name;},{priority});
 const jobs=[run('dream',50),run('title',10),run('suggest',20),run('title2',10)];busy=false;q.wake();await Promise.all(jobs);q.close();assert.equal(max,1);assert.deepEqual(order,['title','title2','suggest','dream']);
});
test('foreground preempts a helper, then retries it when idle',async()=>{
 let busy=false,attempts=0;const started=deferred(),records=[],q=new WorkModelQueue({busy:()=>busy,pollMs:5,onRecord:r=>records.push(r)});
 const job=q.submit(signal=>{attempts++;if(attempts>1)return 'done';started.resolve();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 await started.promise;busy=true;q.wake();await new Promise(r=>setTimeout(r,10));assert.equal(attempts,1);busy=false;q.wake();assert.equal(await job,'done');q.close();assert.ok(records.some(r=>r.status==='yielded'));assert.equal(attempts,2);
});
test('caller abort cancels queued jobs and does not execute them',async()=>{
 const q=new WorkModelQueue({busy:()=>true,pollMs:5}),controller=new AbortController();let executed=false;
 const job=q.submit(()=>{executed=true;},{signal:controller.signal});controller.abort(new Error('cancel'));await assert.rejects(job,/cancel/);q.close();assert.equal(executed,false);
});
test('closing queue rejects pending and active work',async()=>{
 const started=deferred(),q=new WorkModelQueue();const a=q.submit(signal=>{started.resolve();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));}),b=q.submit(()=>1);
 await started.promise;q.close();await assert.rejects(a,/closed/);await assert.rejects(b,/closed/);await assert.rejects(q.submit(()=>1),/closed/);
});
test('failure of one helper does not stall the next',async()=>{
 const q=new WorkModelQueue(),a=q.submit(()=>{throw new Error('model down');}),b=q.submit(()=>42);await assert.rejects(a,/model down/);assert.equal(await b,42);q.close();
});
