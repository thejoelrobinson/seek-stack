// Opt-in local-model acceptance fixture. Never reads a real Downloads directory or grants OS input.
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildDesktopTools,DESKTOP_GUIDE} from '../src/tools.js';import {listFolder} from '../src/operations.js';
const endpoint=process.env.SEEK_DESKTOP_BENCHMARK_URL||'http://127.0.0.1:18800';
if(new URL(endpoint).hostname!=='127.0.0.1')throw Error('This benchmark requires a local model endpoint');
const directory=await mkdtemp(join(tmpdir(),'seek-downloads-benchmark-')),calls=[];
const agent={operation:async c=>{calls.push({kind:c.kind,path:c.path});if(c.kind!=='list'||c.path.toLowerCase()!=='downloads')throw Error('Use desktop_list with Downloads for this request');return {text:JSON.stringify(await listFolder({path:directory,limit:100})),mode:'text'};},observe:()=>{calls.push({kind:'observe'});throw Error('Use desktop_list to read Downloads directly');}};
const definitions=buildDesktopTools({defineTool:t=>t,runtime:{forExecution:async()=>agent,owner:async()=>({}),status:async()=>({text:'Granted Windows fixture'})}});
const tools=definitions.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:{type:'object',properties:Object.fromEntries(Object.entries(t.parameters).map(([name,{required,...schema}])=>[name,schema])),required:Object.entries(t.parameters).filter(([_n,s])=>s.required).map(([name])=>name)}}}));
const messages=[{role:'system',content:'You are Seek. A Windows computer is already granted for this task. '+DESKTOP_GUIDE},{role:'user',content:'What is in my Downloads? Give a short answer.'}];
const started=performance.now();let answer='',modelCalls=0;
try{
 await writeFile(join(directory,'report.pdf'),'fixture');await writeFile(join(directory,'photo.jpg'),'fixture');await mkdir(join(directory,'receipts'));
 for(let step=0;step<4;step++){
  const response=await fetch(endpoint+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:process.env.SEEK_DESKTOP_BENCHMARK_MODEL||'qwen3.8-27b',messages,tools,max_tokens:2048,temperature:0,reasoning_effort:'low'}),signal:AbortSignal.timeout(60000)});
  const data=await response.json();if(!response.ok)throw Error('Local model failed: '+JSON.stringify(data));modelCalls++;
  const message=data.choices?.[0]?.message;if(!message)throw Error('Local model returned no message');messages.push(message);
  if(!message.tool_calls?.length){answer=message.content||'';break;}
  for(const call of message.tool_calls){let text;try{const tool=definitions.find(t=>t.name===call.function.name);if(!tool)throw Error('Unknown tool');text=(await tool.execute(JSON.parse(call.function.arguments),{})).text;}catch(e){text='Error: '+e.message;}messages.push({role:'tool',tool_call_id:call.id,content:text});}
 }
 const elapsedMs=Math.round(performance.now()-started);
 const passed=modelCalls<=2&&calls.length===1&&calls[0].kind==='list'&&elapsedMs<60000&&['report.pdf','photo.jpg','receipts'].every(name=>answer.includes(name));
 console.log(JSON.stringify({fixture:true,model:process.env.SEEK_DESKTOP_BENCHMARK_MODEL||'qwen3.8-27b',modelCalls,toolCalls:calls,elapsedMs,answer,passed},null,2));
 if(!passed)process.exitCode=1;
}finally{await rm(directory,{recursive:true,force:true});}
