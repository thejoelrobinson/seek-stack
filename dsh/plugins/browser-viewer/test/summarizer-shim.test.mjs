import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('summarizer shim disables reasoning for dsh 0.1 and 0.2 compaction requests only',{timeout:20000},async t=>{
  const seen=[];
  const upstream=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen.push(JSON.parse(body));res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'seek-shim-'));await copyFile(fileURLToPath(new URL('../../../proxy/summarizer-shim.js',import.meta.url)),join(dir,'shim.cjs'));
  const port=18000+Math.floor(Math.random()*1500);
  const child=spawn(process.execPath,[join(dir,'shim.cjs')],{env:{...process.env,SEEK_SHIM_PORT:String(port),SEEK_LLAMA_PORT:String(upstream.address().port)},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{child.kill();upstream.close();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('shim did not start')),5000);child.stdout.on('data',d=>{if(String(d).includes('summarizer shim on')){clearTimeout(timer);resolve();}});});
  const send=body=>fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  const history=[{role:'system',content:'You are Seek.'},{role:'user',content:'Plan my weekend.'},{role:'assistant',content:'Working.'}];
  await send({model:'qwen3.8-27b',max_tokens:65536,messages:[...history,{role:'user',content:[{type:'text',text:'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE.'}]}]});
  await send({model:'qwen3.8-27b',max_tokens:8192,messages:history});
  await send({model:'qwen3.8-27b',max_tokens:24576,messages:history});
  assert.deepEqual(seen[0].chat_template_kwargs,{enable_thinking:false},'0.2 compaction directive is recognized');assert.equal(seen[0].max_tokens,8192,'0.2 summaries are capped');
  assert.deepEqual(seen[1].chat_template_kwargs,{enable_thinking:false},'0.1 summarizer cap still recognized');
  assert.equal(seen[2].chat_template_kwargs,undefined,'agent turns pass through unchanged');assert.equal(seen[2].max_tokens,24576);
});
