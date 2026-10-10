import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CapabilityRegistry,objectSchema} from '../lib/work-capabilities.js';
import {validateRecipe} from '../lib/work-workflows.js';
import {WorkflowStore} from '../lib/work-workflow-store.js';
import {WorkflowRunner} from '../lib/work-workflow-runner.js';
const [dir,phase='none']=process.argv.slice(2),providerFile=join(dir,'provider.json');
const provider=async()=>JSON.parse(await readFile(providerFile,'utf8').catch(()=>'{"target":0,"writes":0}'));
const schema=objectSchema({target:{type:'integer'}},['target']);
const registry=new CapabilityRegistry().register({name:'fixture.set',version:1,effect:'write',resource:'fixture',input:schema,output:schema,lockKey:()=> 'fixture-cart',
 execute:async a=>{if(phase==='before-provider')process.exit(17);const state=await provider();await writeFile(providerFile,JSON.stringify({target:a.target,writes:state.writes+1}));if(phase==='provider-committed')process.exit(17);return a;},
 reconcile:async a=>(await provider()).target===a.target?a:undefined,verify:async r=>r.target===(await provider()).target});
const recipe={id:'crash_fixture',version:1,title:'Crash fixture',input:schema,steps:[{id:'set',capability:'fixture.set',version:1,input:{$ref:'input'}}],result:'set'};
const store=new WorkflowStore(dir);store.put(validateRecipe(recipe,registry));let run=store.create('task','request',recipe,{target:3});if(['failed','uncertain','cancelled'].includes(run.state))run=store.resume(run.id);
const runner=new WorkflowRunner(registry,store,{hook:p=>{if(phase===p)process.exit(17);}});
const result=await runner.run(run.id,{task:{id:'task',status:'running'},fixture:true,writeBroker:async(d,a,execute)=>execute()});
console.log(JSON.stringify({state:result.state,provider:await provider()}));store.close();
