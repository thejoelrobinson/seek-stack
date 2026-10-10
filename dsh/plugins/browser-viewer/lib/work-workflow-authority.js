import {WorkflowError} from './work-capabilities.js';

// Only reviewed adapters construct intents and provider evidence. A recipe cannot do so.
export function workflowWriteBroker(authority,authorizationForTask){
  return async(capability,input,perform,context)=>{
    if(typeof capability.intent!=='function'||typeof capability.receipt!=='function')throw new WorkflowError('policy_denied','Write adapter has no authority contract.');
    const authorization=await authorizationForTask(context.task),intent=capability.intent(input,context);
    const decision=await authority.execute(intent,authorization,perform,{verify:async output=>{
      const evidence=await capability.receipt(output,input,context);
      return {...evidence,verified:!!evidence?.verified&&!!(evidence.providerId||evidence.sourceUrl)&&await capability.verify(output,input,context)};
    }});
    if(!decision.allowed)throw new WorkflowError(decision.needsVerification?'uncertain_write':'authorization_required',decision.needsVerification?'An earlier provider action needs reconciliation.':'This exact external action needs authorization.');
    if(decision.state!=='verified'||decision.result===undefined)throw new WorkflowError('uncertain_write','External action requires provider verification.');return decision.result;
  };
}
