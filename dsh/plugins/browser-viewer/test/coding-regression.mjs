import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const out=process.argv[2],label=process.argv[3]||'baseline';await mkdir(out,{recursive:true});
async function rpc(method,payload){const response=await fetch('http://127.0.0.1:3080/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload}),signal:AbortSignal.timeout(15000)});const value=await response.json();if(!value.result?.ok)throw new Error(value.result?.error?.message||'RPC failed');return value.result.value;}
const root=await mkdtemp(join(tmpdir(),'seek-coding-'+label+'-')),file=join(root,'ledger.cjs');
await writeFile(file,'// Implement these three exported functions.\nmodule.exports={parseCents:()=>0, groupTotals:()=>({}), stableUnique:()=>[]};\n');
const session=await rpc('session.create',{cwd:root,agentPreset:'code'});await rpc('session.rename',{sessionId:session.sessionId,title:'Isolated coding regression: '+label});
const started=Date.now();let done=false,history;
try{
 await rpc('session.prompt',{sessionId:session.sessionId,mode:'queue',content:[{type:'text',text:'This is an authorized isolated coding regression fixture. Fix ledger.cjs using the standard coding tools. Implement CommonJS exports: parseCents(text) accepts a string matching optional leading minus, one or more digits, optionally a decimal point followed by exactly two digits. Return integer cents; reject invalid strings or unsafe integer cents with an exception. groupTotals(rows) receives {category,amountCents} and returns an object summing safe integer cents by category, correctly including negative amounts, rejecting unsafe sums. stableUnique(values) returns first occurrences in original order, preserving 0, false, empty string and null. Do not modify other files, use external apps, use browser tools or delegate. You may run local checks. Finish after writing and verifying the implementation.'}]});
 const deadline=Date.now()+300000;
 while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1500));const state=(await rpc('session.list',{})).items.find(s=>s.sessionId===session.sessionId);if(state&&!state.running){history=await rpc('session.history',{sessionId:session.sessionId,maxMessages:50});if(history.events?.some(({event:e})=>e.type==='assistant/message')){done=true;break;}}}
 if(!done)throw new Error('Coding session timed out');
 const require=createRequire(import.meta.url),m=require(file),checks=[];
 const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});}};
 for(const [input,expected] of [['0',0],['0.01',1],['-0.01',-1],['12.34',1234],['-70',-7000],['001.09',109]])check('parse '+input,()=>assert.equal(m.parseCents(input),expected));
 for(const input of ['1.2','1.234','x','','1e3','+1',' 1','900719925474099100'])check('reject '+input,()=>assert.throws(()=>m.parseCents(input)));
 check('group negative',()=>assert.deepEqual(m.groupTotals([{category:'a',amountCents:20},{category:'b',amountCents:0},{category:'a',amountCents:-30}]),{a:-10,b:0}));
 check('group empty',()=>assert.deepEqual(m.groupTotals([]),{}));
 check('group unsafe',()=>assert.throws(()=>m.groupTotals([{category:'a',amountCents:Number.MAX_SAFE_INTEGER},{category:'a',amountCents:1}])));
 check('unique falsy',()=>assert.deepEqual(m.stableUnique([0,false,'',null,0,null,false,'',2,2]),[0,false,'',null,2]));
 check('unique empty',()=>assert.deepEqual(m.stableUnique([]),[]));
 const result={label,sessionId:session.sessionId,agentPreset:session.agentPreset,elapsedMs:Date.now()-started,root,checks,passed:checks.filter(c=>c.passed).length,total:checks.length,toolCalls:history.events.filter(({event:e})=>e.type==='tool/call').map(({event:e})=>e.data?.name)};
 await writeFile(join(out,'coding-'+label+'.json'),JSON.stringify(result,null,2));await writeFile(join(out,'coding-'+label+'.cjs'),await readFile(file));console.log(JSON.stringify(result,null,2));
 if(result.passed!==result.total)process.exitCode=1;
}finally{if(!done)await rpc('session.cancel',{sessionId:session.sessionId}).catch(()=>{});}
