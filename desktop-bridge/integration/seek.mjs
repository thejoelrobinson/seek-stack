import {DesktopRuntime} from '../src/runtime.js';
import {buildDesktopTools,DESKTOP_GUIDE} from '../src/tools.js';

// Called by the trusted Seek host. resolveOwner must use the Work store, never model arguments.
export function installDesktopBridge(ctx,{connectionFile,resolveOwner,defineTool}){
 const runtime=new DesktopRuntime({connectionFile,resolveOwner});
 const registry=ctx.get('tools');if(!registry)throw Error('Seek tool registry is unavailable');
 const disposers=buildDesktopTools({defineTool,runtime}).map(def=>registry.register(def));
 const removePrompt=ctx.systemPrompt?.set('desktop-bridge',{priority:10,text:DESKTOP_GUIDE});
 const dispose=()=>{for(const remove of disposers)remove();if(typeof removePrompt==='function')removePrompt();runtime.close();};
 return {runtime,dispose};
}

export function installWorkDesktopBridge(ctx,{engine,connectionFile,defineTool}){
 return installDesktopBridge(ctx,{connectionFile,defineTool,resolveOwner:exec=>{
  const task=engine.store.tasks.find(t=>t.sessionId===exec?.agent?.id);
  if(!task||task.eval)return null;
  return {taskId:task.id,sessionId:task.sessionId,status:task.status,child:false};
 }});
}
