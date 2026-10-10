import {randomUUID} from 'node:crypto';
import {bind,validateRecipe} from './work-workflows.js';
import {WorkflowError,validate,contentHash} from './work-capabilities.js';

export class WorkflowRunner {
  constructor(registry,store,{onStep=async()=>{},hook=async()=>{}}={}){this.registry=registry;this.store=store;this.onStep=onStep;this.hook=hook;this.active=new Map();}
  async run(id,context){
    const existing=this.active.get(id);if(existing)return existing.promise;
    const controller=new AbortController(),pending=this.execute(id,{...context,signal:controller.signal}).finally(()=>this.active.delete(id));this.active.set(id,{promise:pending,controller});return pending;
  }
  cancel(id){this.active.get(id)?.controller.abort();this.store.cancel(id);}
  async execute(id,context){
    const original=this.store.get(id);if(!original||original.task_id!==context.task?.id)throw new WorkflowError('policy_denied','Run belongs to another task.');
    if(original.state==='succeeded')return original;
    const definition=this.store.definition(original.recipe_id,original.recipe_version);if(!definition||definition.state!=='enabled'&&!original.steps.length)throw new WorkflowError('disabled','Workflow is disabled.');
    const {recipe,hash}=validateRecipe(definition.recipe,this.registry);if(hash!==definition.hash)throw new WorkflowError('invalid_recipe','Workflow definition hash changed.');validate(recipe.input,original.input);
    // Authorize every capability before any execution; a denied late step cannot cause partial work.
    for(const s of recipe.steps)this.registry.check(this.registry.get(s.capability,s.version),context);
    const owner=process.pid+':'+randomUUID(),lease=this.store.claim(id,owner,125000);if(!lease)return this.store.get(id);
    const epoch=lease.epoch,outputs={},buffer=[];
    const flush=()=>{this.store.batch(id,owner,epoch,buffer);buffer.length=0;};
    try{
      for(const s of recipe.steps){
        this.store.fence(id,owner,epoch);if(context.signal.aborted)throw new WorkflowError('cancelled','Workflow cancelled.');
        const cap=this.registry.get(s.capability,s.version),input=bind(s.input,lease.input,outputs),inputHash=contentHash(input),prior=lease.steps.find(x=>x.step_id===s.id);
        if(cap.effect!=='pure'||lease.lease_until-this.store.now()<cap.timeoutMs+5000){this.store.renew(id,owner,epoch,125000);lease.lease_until=this.store.now()+125000;}
        if(cap.effect!=='pure')flush();
        validate(cap.input,input);
        const ctx={...context,runId:id,stepId:s.id,idempotencyKey:`${id}:${s.id}`,signal:context.signal};
        if(prior?.state==='verified'&&cap.effect!=='read'&&prior.input_hash===inputHash){
          validate(cap.output,prior.output);if(!await cap.verify(prior.output,input,ctx))throw new WorkflowError('verification_failed','Stored output no longer verifies.');outputs[s.id]=prior.output;continue;
        }
        if(prior?.state==='verified'&&cap.effect==='write')throw new WorkflowError('uncertain_write','A completed write has different inputs; reconcile before continuing.');
        let output;
        const lock=cap.effect==='write'?cap.lockKey(input,ctx):null;if(lock)this.store.lock(lock,id,s.id);
        if(cap.effect==='write'&&['dispatched','uncertain'].includes(prior?.state)){
          output=await cap.reconcile(input,ctx);if(output===undefined)throw new WorkflowError('uncertain_write','Prior write requires provider reconciliation.');
          validate(cap.output,output);if(!await cap.verify(output,input,ctx))throw new WorkflowError('verification_failed','Reconciled output did not verify.');
        }else{
          if(cap.effect!=='pure')this.store.step(id,owner,epoch,s.id,cap.effect==='write'?'dispatched':'running',{inputHash});await this.hook('before-dispatch',s,ctx);
          for(let attempt=0;;attempt++){
            try{output=await this.registry.call(s.capability,s.version,input,ctx);break;}
            catch(e){if(cap.effect!=='read'||attempt>=2||!['timeout','rate_limited','temporarily_unavailable'].includes(e.code)||ctx.signal.aborted)throw e;
              const delay=Math.min(2000,Math.max(50,e.retryAfterMs||100*2**attempt));await new Promise(resolve=>{const timer=setTimeout(resolve,delay);ctx.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});this.store.fence(id,owner,epoch);
            }
          }
          await this.hook('after-return',s,ctx);
        }
        if(cap.effect==='pure')buffer.push({id:s.id,output,inputHash});else this.store.step(id,owner,epoch,s.id,'verified',{output,inputHash});if(lock)this.store.unlock(lock,id);outputs[s.id]=output;if(cap.effect!=='pure')await this.hook('after-checkpoint',s,ctx);await this.onStep(s,outputs,ctx);
      }
      flush();const result=outputs[recipe.result];
      return this.store.finish(id,owner,epoch,result?.exceptions?.length?'needs_input':'succeeded',result?.exceptions?.length?{code:'decision_required',message:'Some items need a decision.',details:result.exceptions}:null);
    }catch(error){
      if(error.code==='lease_lost'||context.signal.aborted)return this.store.get(id);
      flush();
      if(error.code==='authorization_required')for(const s of this.store.get(id).steps.filter(s=>s.state==='dispatched')){this.store.step(id,owner,epoch,s.step_id,'held',{inputHash:s.input_hash});const def=recipe.steps.find(x=>x.id===s.step_id),cap=this.registry.get(def.capability,def.version);this.store.unlock(cap.lockKey(bind(def.input,lease.input,outputs),context),id);}
      const message={code:error.code||'execution_failed',message:String(error.message).slice(0,1000)},run=this.store.get(id);
      const uncertain=run.steps.some(s=>s.state==='dispatched');return this.store.finish(id,owner,epoch,uncertain||error.code==='uncertain_write'?'uncertain':['decision_required','authorization_required','login_required'].includes(error.code)?'needs_input':'failed',message);
    }
  }
  async close(){for(const id of this.active.keys())this.cancel(id);await Promise.allSettled([...this.active.values()].map(a=>a.promise));}
}
