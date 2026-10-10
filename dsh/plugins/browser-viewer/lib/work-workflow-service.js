import {CapabilityRegistry,objectSchema,validate,jsonValue,contentHash,canonical,WorkflowError} from './work-capabilities.js';
import {validateRecipe,bind} from './work-workflows.js';
import {WorkflowStore} from './work-workflow-store.js';
import {WorkflowRunner} from './work-workflow-runner.js';
import {availability,groceryPlan} from './work-routines.js';
import {parseWhen} from './work-calendar-tools.js';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {verifyOutcome} from './work-outcomes.js';
const str={type:'string',minLength:1,maxLength:200},integer={type:'integer',minimum:0,maximum:1000000},json={type:'json'};
const qty=objectSchema({productId:str,quantity:{type:'integer',minimum:0,maximum:10000}},['productId','quantity']);
const qtys={type:'array',items:qty,maxItems:500};
const product=objectSchema({productId:str,name:{type:'string',maxLength:300},priceCents:{type:'integer',minimum:0,maximum:100000000},available:{type:'boolean'}},['productId','priceCents','available']);
export const CALENDAR_INPUT=objectSchema({from:str,to:str,minutes:{type:'integer',minimum:1,maximum:1440}},['from','to']);
export const GROCERY_INPUT=objectSchema({items:qtys,catalog:{type:'array',items:product,maxItems:500},pantry:qtys,cart:qtys,budgetCents:integer},['items','catalog']);
const one=(id,title,capability,input)=>({id,version:1,title,input,steps:[{id:'calculate',capability,version:1,input:{$ref:'input'}}],result:'calculate'});
export const BUILTIN_RECIPES=[one('calendar_availability','Calendar availability','calendar.availability',CALENDAR_INPUT),one('grocery_cart_plan','Grocery cart plan','grocery.plan',GROCERY_INPUT)];
export function workflowCoversRequest(id,request){
  if(id==='calendar_availability')return !/\b(move|reschedule|create|add|delete|cancel|invite|send|book|change|update)\b[\s\S]{0,80}\b(event|appointment|meeting|calendar|summary|invite)\b/i.test(request);
  if(id==='grocery_cart_plan')return !/\b(check ?out|buy|purchase|place (?:an? |the )?order|purchase history|order history)\b|\b(add|put|remove|update)\b[\s\S]{0,60}\b(?:my|the|walmart|target|amazon)\b[\s\S]{0,30}\bcart\b/i.test(request);
  return true;
}

export function registerWorkflowCapabilities(registry,{calendar,pipedream}={}){
  registry.register({name:'calendar.availability',version:1,effect:'read',resource:'calendar',input:CALENDAR_INPUT,output:json,
    execute:a=>({...availability(calendar,a),source:'Shared Seek calendar',capturedAt:Date.now()}),verify:r=>Array.isArray(r.events)&&Array.isArray(r.free)&&r.free.every(x=>x.minutes>0)});
  registry.register({name:'grocery.plan',version:1,effect:'pure',input:GROCERY_INPUT,output:json,execute:groceryPlan,verify:r=>r.checkout===false&&r.externalChanges===false&&Number.isSafeInteger(r.subtotalCents)&&r.lines.every(l=>l.addQuantity>0&&l.targetQuantity===l.existingQuantity+l.addQuantity)});
  registry.register({name:'data.count',version:1,effect:'pure',input:objectSchema({items:{type:'array',items:json,maxItems:5000}},['items']),output:objectSchema({count:integer},['count']),execute:({items})=>({count:items.length}),verify:(r,a)=>r.count===a.items.length});
  registry.register({name:'data.sum_cents',version:1,effect:'pure',input:objectSchema({values:{type:'array',items:{type:'integer'},maxItems:5000}},['values']),output:objectSchema({totalCents:{type:'integer'}},['totalCents']),execute:({values})=>{let totalCents=0;for(const v of values){totalCents+=v;if(!Number.isSafeInteger(totalCents))throw new WorkflowError('invalid_input','Total is outside supported integer range.');}return {totalCents};},verify:(r,a)=>BigInt(r.totalCents)===a.values.reduce((n,x)=>n+BigInt(x),0n)});
  registry.register({name:'data.field',version:1,effect:'pure',input:objectSchema({items:{type:'array',items:json,maxItems:5000},field:str},['items','field']),output:objectSchema({values:{type:'array',items:json,maxItems:5000}},['values']),execute:({items,field})=>({values:items.map(x=>{if(!x||typeof x!=='object'||!Object.hasOwn(x,field))throw new WorkflowError('missing_input','Requested field is missing.');return x[field];})}),verify:(r,a)=>r.values.length===a.items.length});
  if(pipedream)registry.register({name:'apps.read',version:1,effect:'read',resource:'connected-apps',input:objectSchema({app:str,tool:str,args:json},['app','tool','args']),output:json,execute:(a,c)=>pipedream.read(a.app,a.tool,a.args,r=>c.capture(r)),verify:r=>!!r?.saved?.captureComplete});
  return registry;
}
export class WorkflowService {
  constructor(root,{calendar,pipedream,engine,registry,store,writeBroker,runnerOptions={}}={}){
    this.engine=engine;this.calendar=calendar;this.writeBroker=writeBroker;this.registry=registry||registerWorkflowCapabilities(new CapabilityRegistry(),{calendar,pipedream});this.store=store||new WorkflowStore(root);
    this.progressAt=new Map();this.runner=new WorkflowRunner(this.registry,this.store,{...runnerOptions,onStep:async(s,outputs,ctx)=>{if(ctx.background){const t=ctx.task;engine.record(t,'Finished '+s.capability);t.plan=t.plan.map(p=>p.id===s.id?{...p,status:'done'}:p);if(Date.now()-(this.progressAt.get(t.id)||0)>150){this.progressAt.set(t.id,Date.now());await engine.save();}}await runnerOptions.onStep?.(s,outputs,ctx);}});
    for(const r of BUILTIN_RECIPES)if(!registry)this.store.put(validateRecipe(r,this.registry));
  }
  list(){return {items:this.store.list().map(({recipe,state,hash,provenance})=>({id:recipe.id,version:recipe.version,title:recipe.title,description:recipe.description||'',input:recipe.input,state,hash,source:provenance?.source})),calendarZone:this.calendar?.zone,capabilities:this.registry.list(),generatedCode:{enabled:false,reason:'No enforced isolated runtime is configured.'}};}
  select(id,version){const def=this.store.definition(id,version);if(!def||def.state!=='enabled')throw new WorkflowError('disabled','Workflow is unavailable or disabled.');validateRecipe(def.recipe,this.registry);return def.recipe;}
  attach(t,selection){const recipe=this.select(selection.id,selection.version||1);validate(recipe.input,jsonValue(selection.input));if(!workflowCoversRequest(recipe.id,t.objective)||t.contract?.requiresExternal&&!recipe.steps.some(s=>this.registry.get(s.capability,s.version).effect==='write'))throw new WorkflowError('incomplete_workflow','This workflow cannot fulfill the whole request. Use normal chat; the agent may still use it as a calculation step.');const run=this.store.create(t.id,selection.requestId||'initial',recipe,selection.input);t.workflow={id:recipe.id,version:recipe.version,runId:run.id,state:run.state};return run;}
  async execute(t,{background=true}={}){
    const run=await this.runner.run(t.workflow.runId,{task:t,background,writeBroker:this.writeBroker,capture:async result=>{const {WorkResultStore}=await import('./work-results.js');return new WorkResultStore(t.cwd).capture(result);}});
    return run;
  }
  async toolRun(t,selection){
    if(this.engine?.workflowEnabled===false)throw new WorkflowError('disabled','CPU workflows are disabled.');
    const recipe=this.select(selection.id,selection.version||1);validate(recipe.input,jsonValue(selection.input));
    const run=this.store.create(t.id,selection.requestId||contentHash(selection),recipe,selection.input);
    const outcome=await this.runner.run(run.id,{task:t,writeBroker:this.writeBroker,capture:async result=>{const {WorkResultStore}=await import('./work-results.js');return new WorkResultStore(t.cwd).capture(result);}});
    this.engine?.telemetry?.record({kind:'workflow',phase:'agent-tool',taskId:t.id,ms:Date.now()-outcome.created_at,status:outcome.state});
    const result=this.result(outcome,recipe);if(JSON.stringify(result).length<6000)return result;
    const file='workflow-'+run.id+'.json';await writeFile(join(t.cwd,file),JSON.stringify(result,null,2));return {runId:run.id,workflow:recipe.id,version:recipe.version,state:outcome.state,error:outcome.error,modelCalls:0,saved:{path:file},summary:workflowText(result).slice(0,4000)};
  }
  result(run,recipe=this.store.definition(run.recipe_id,run.recipe_version).recipe){return {runId:run.id,workflow:recipe.id,version:recipe.version,state:run.state,error:run.error,modelCalls:0,result:run.steps.find(s=>s.step_id===recipe.result)?.output};}
  async recordResult(t,run){
    const outcome=this.result(run),file='workflow-result.json';await writeFile(join(t.cwd,file),JSON.stringify(outcome,null,2));
    await this.engine.artifact(t,file,'Workflow result');
    t.workflow.state=run.state;t.workflow.durationMs=run.updated_at-run.created_at;t.workflowResult=outcome.result;t.error=run.error?.message||null;
    this.progressAt.delete(t.id);t.plan=t.plan.map(s=>({...s,status:run.steps.find(x=>x.step_id===s.id)?.state==='verified'?'done':'pending'}));
    const text=workflowText(outcome);
    if(t.messages.at(-1)?.text!==text)t.messages.push({role:'assistant',text,time:Date.now()});t.result=text;
    t.resultEvidence={status:run.state==='succeeded'?'verified':'needs-verification',summary:run.state==='succeeded'?'Versioned CPU workflow; registered capability checks passed.':'Workflow needs a decision or verification.',checks:run.steps.map(s=>({label:s.step_id,ok:s.state==='verified'}))};
    if(run.state==='succeeded'){
      const receipts=this.engine.authority?.list?.({taskId:t.id,createdAfter:t.contractCreatedAt})||[];
      const evidence=await verifyOutcome(t,{file:this.engine.file.bind(this.engine),receipts:receipts.map(r=>({...r,taskId:t.id}))});
      if(evidence.status==='needs-verification'){t.status='attention';t.resultEvidence=evidence;t.question={text:'The calculation passed, but the full requested outcome is not verified.',choices:['Continue in chat','Stop']};}else{t.status='complete';t.completedAt=Date.now();t.question=null;}
    }else if(run.state==='needs_input'){t.status='waiting';t.question={text:run.error?.message||'Workflow needs your input.',choices:['Continue in chat','Stop']};}else if(run.state==='cancelled'){t.status='stopped';}else{t.status='attention';t.question={text:run.error?.message||'Workflow needs attention.',choices:['Retry workflow','Continue in chat','Stop']};}
    this.engine.record(t,run.state==='succeeded'?'Verified workflow result ready':run.state==='needs_input'?'Waiting for your decision':'Workflow needs attention');
    this.engine.telemetry?.record({kind:'workflow',phase:'completion',taskId:t.id,ms:t.workflow.durationMs,status:run.state});await this.engine.save();
  }
  async candidate(definition,examples,task){
    const checked=validateRecipe(definition,this.registry),recipe=checked.recipe;
    if(recipe.steps.some(s=>this.registry.get(s.capability,s.version).effect!=='pure'))throw new WorkflowError('invalid_recipe','Candidate tests currently support pure capabilities only.');
    if(!Array.isArray(examples)||examples.length<2||examples.length>20||new Set(examples.map(x=>contentHash(x.input))).size<2)throw new WorkflowError('invalid_recipe','Provide at least two different input examples with expected results.');
    for(const ex of examples){validate(recipe.input,jsonValue(ex.input));const out={};for(const s of recipe.steps)out[s.id]=await this.registry.call(s.capability,s.version,bind(s.input,ex.input,out),{task});if(canonical(out[recipe.result])!==canonical(jsonValue(ex.expected)))throw new WorkflowError('verification_failed','Candidate does not match its expected example.');}
    return this.store.put(checked,'tested',{source:'agent-candidate',taskId:task.id,exampleCount:examples.length,at:Date.now()});
  }
  async close(){await this.runner.close();await Promise.allSettled([...(this.engine?.workflowFlights?.values()||[])]);this.store.close();}
}
export function workflowText({workflow,state,result,error}){
  if(!result)return `Workflow ${state}: ${error?.message||'No verified result.'}`;
  if(workflow==='calendar_availability'){
    const date=new Intl.DateTimeFormat('en-US',{timeZone:result.zone,weekday:'short',month:'short',day:'numeric',year:'numeric'}),time=new Intl.DateTimeFormat('en-US',{timeZone:result.zone,hour:'numeric',minute:'2-digit'});
    const window=w=>{const start=new Date(parseWhen(w.start,result.zone).ms),end=new Date(parseWhen(w.end,result.zone).ms),sameDay=date.format(start)===date.format(end);return `${date.format(start)}, ${time.format(start)} – ${sameDay?'':date.format(end)+', '}${time.format(end)} (${w.minutes} minutes free)`;};
    return `Calendar availability (${result.zone})\n\n${result.events.length} events · ${result.conflictCount} conflicts\n\n`+(result.free.length?result.free.map(w=>'- '+window(w)).join('\n'):'No free windows of the requested duration.');
  }
  if(workflow==='grocery_cart_plan')return `Grocery cart plan\n\n`+(result.lines.map(l=>`- ${l.name}: add ${l.addQuantity}; target ${l.targetQuantity}`).join('\n')||'No additions needed.')+`\n\nAdditions: $${(result.subtotalCents/100).toFixed(2)}. Cart subtotal: ${result.cartSubtotalCents===null?'unknown':'$'+(result.cartSubtotalCents/100).toFixed(2)}. Taxes and fees excluded.\n\n`+(result.exceptions.length?result.exceptions.map(e=>`- ${e.productId?e.productId+': ':''}${e.reason}`).join('\n'):'Plan verified. No retailer cart has been changed.');
  const text=JSON.stringify(result,null,2);return `Workflow ${state}\n\n\`\`\`json\n${text.slice(0,4000)}\n\`\`\``+(text.length>4000?'\nFull result is attached.':'');
}
