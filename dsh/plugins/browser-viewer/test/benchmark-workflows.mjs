// CPU-runner measurement only. This does not claim model latency improvements.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityRegistry,objectSchema} from '../lib/work-capabilities.js';
import {registerWorkflowCapabilities,BUILTIN_RECIPES} from '../lib/work-workflow-service.js';
import {validateRecipe} from '../lib/work-workflows.js';
import {WorkflowStore} from '../lib/work-workflow-store.js';
import {WorkflowRunner} from '../lib/work-workflow-runner.js';
const root=await mkdtemp(join(tmpdir(),'seek-wf-bench-'));
const calendar={zone:'UTC',range:(from,to)=>({events:Array.from({length:5},(_,i)=>({id:'event-'+i,kind:'event',title:'Fixture event',start:from+(i+1)*3600000,end:from+(i+1)*3600000+1800000})).filter(e=>e.end<=to),todos:[]})};
const registry=registerWorkflowCapabilities(new CapabilityRegistry(),{calendar}),store=new WorkflowStore(root),runner=new WorkflowRunner(registry,store);
const inputSchema=objectSchema({values:{type:'array',items:{type:'integer'},maxItems:5000}},['values']);
const chain={id:'ten_step',version:1,title:'Ten pure steps',input:inputSchema,steps:Array.from({length:10},(_,i)=>({id:'sum_'+i,capability:'data.sum_cents',version:1,input:{values:{$ref:'input.values'}}})),result:'sum_9'};
for(const r of [...BUILTIN_RECIPES,chain])store.put(validateRecipe(r,registry));
const cases=[];
for(const count of [0,1,10,100,1000])cases.push({name:'sum-'+count,recipe:chain,input:{values:Array.from({length:count},(_,i)=>i)},check:r=>assert.equal(r.totalCents,Math.max(0,count*(count-1)/2))});
for(const count of [1,10,50,100,200])cases.push({name:'groceries-'+count,recipe:BUILTIN_RECIPES[1],input:{items:Array.from({length:count},(_,i)=>({productId:'p'+i,quantity:3})),catalog:Array.from({length:count},(_,i)=>({productId:'p'+i,priceCents:199,available:true})),pantry:Array.from({length:count},(_,i)=>({productId:'p'+i,quantity:1}))},check:r=>assert.equal(r.subtotalCents,count*398)});
for(const hours of [2,4,8,12,24])cases.push({name:'calendar-'+hours,recipe:BUILTIN_RECIPES[0],input:{from:'2026-10-09T00:00',to:hours===24?'2026-10-10T00:00':`2026-10-09T${String(hours).padStart(2,'0')}:00`},check:r=>assert.equal(r.free.reduce((n,w)=>n+w.minutes,0)+r.events.length*30,hours*60)});
const percentile=(v,p)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
try{
 const rows=[];
 for(const c of cases){const times=[];for(let i=0;i<10;i++){const task={id:c.name+'-'+i,status:'running'},run=store.create(task.id,'bench',c.recipe,c.input),started=performance.now(),out=await runner.run(run.id,{task});times.push(performance.now()-started);assert.equal(out.state,'succeeded');c.check(out.steps.find(s=>s.step_id===c.recipe.result).output);}rows.push({case:c.name,repetitions:10,modelCalls:0,p50Ms:+percentile(times,.5).toFixed(2),p95Ms:+percentile(times,.95).toFixed(2)});}
 const pure=rows.filter(r=>r.case.startsWith('sum-'));const report={at:new Date().toISOString(),scope:'Local CPU runner, SQLite checkpoints and verification; excludes model/provider/UI/queue time',cases:rows,totalRuns:150,verifiedRuns:150,pureTenStepP95MaxMs:Math.max(...pure.map(r=>r.p95Ms)),inferenceBenchmark:'Not measured; no inference server was used.'};
 report.pureTenStepTargetMet=report.pureTenStepP95MaxMs<50;
 const output=process.argv[2];if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await runner.close();store.close();await rm(root,{recursive:true,force:true});}
