import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PipedreamConnection} from '../lib/work-pipedream.js';
import {WorkResultStore} from '../lib/work-results.js';
import {complete,setWorkModelQueue} from '../lib/work-extras.js';
import {WorkModelQueue} from '../lib/work-model-queue.js';
test('actual Pipedream adapter preserves full response when capture is supplied',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-pd-regression-')),p=new PipedreamConnection(root),s=new WorkResultStore(root),text=JSON.stringify({rows:Array.from({length:1000},(_,id)=>({id,amountCents:id}))});
 p.mcp=async(_app,fn)=>fn({listTools:async()=>({tools:[{name:'list_rows',annotations:{readOnlyHint:true}}]}),callTool:async()=>({content:[{type:'text',text}]})});
 const preview=await p.read('fixture','list_rows',{});assert.equal(preview.truncated,true);assert.ok(JSON.stringify(preview).length<8192);
 const r=await p.read('fixture','list_rows',{},value=>s.capture(value));assert.equal((await s.access(r.saved.ref,{operation:'query',path:'rows',mode:'count'})).rowCount,1000);
 await assert.rejects(p.read('fixture','send_email',{}),/not found/);
 p.mcp=async(_app,fn)=>fn({listTools:async()=>({tools:[{name:'send_email',annotations:{readOnlyHint:true}}]}),callTool:()=>{throw new Error('Should not reach write');}});
 await assert.rejects(p.read('fixture','send_email',{},value=>s.capture(value)),/change data/);
});
test('model completion rejects length stops even when the partial JSON is syntactically valid',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async url=>new Response(JSON.stringify(String(url).endsWith('/models')?{data:[{id:'qwen3.8-27b',status:{value:'loaded'}}]}:{choices:[{finish_reason:'length',message:{content:'{"items":[]}'}}]}),{status:200});
 try{await assert.rejects(complete([{role:'user',content:'fixture'}]),/response limit/);}finally{globalThis.fetch=original;}
});
test('Work complete calls share queue without changing sampling',async()=>{
 const original=globalThis.fetch,bodies=[];let active=0,max=0;
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'qwen3.8-27b',status:{value:'loaded'}}]}));
  const body=JSON.parse(options.body);bodies.push(body);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'OK'}}]}));
 };
 const q=new WorkModelQueue();setWorkModelQueue(q);
 try{assert.deepEqual(await Promise.all([complete([], {temperature:0.2,maxTokens:24}),complete([])]),['OK','OK']);assert.equal(max,1);assert.equal(bodies[0].temperature,0.2);assert.equal(bodies[0].max_tokens,24);assert.equal(bodies[0].chat_template_kwargs.enable_thinking,false);}
 finally{q.close();setWorkModelQueue(null);globalThis.fetch=original;}
});
test('foreground cancellation reaches the actual helper fetch, then retries when idle',async()=>{
 const original=globalThis.fetch;let busy=false,attempts=0,aborted=false,start;
 const started=new Promise(resolve=>{start=resolve;}),q=new WorkModelQueue({busy:()=>busy,pollMs:5});
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'qwen3.8-27b',status:{value:'loaded'}}]}));
  attempts++;
  if(attempts===1){start();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(options.signal.reason);},{once:true}));}
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'retried'}}]}));
 };
 setWorkModelQueue(q);
 try{
  const pending=complete([]);await started;busy=true;q.wake();
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(aborted,true);assert.equal(attempts,1);
  busy=false;q.wake();assert.equal(await pending,'retried');assert.equal(attempts,2);
 }finally{q.close();setWorkModelQueue(null);globalThis.fetch=original;}
});
