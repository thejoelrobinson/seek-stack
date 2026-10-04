// A native monotonic ToolRuntime guard, scoped to Work task identities. This
// narrows direct tool routes; it is not a security sandbox for same-user shells.
const WRITE=/(?:^|[_-])(?:create|update|delete|remove|send|post|put|patch|publish|invite|add|edit|set|upsert|archive|submit|execute|transfer|trade)(?:[_-]|$)/i;
const READ=/^(?:[a-z0-9]+[_-])?(?:get|list|search|find|fetch|retrieve|read|query|lookup|describe|inspect|check|download|browse|preview)(?:[_-]|$)/i;
const normalized=value=>String(value).replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
const CREDENTIAL=/(?:^|[\\/])(?:\.secret|config\.dpapi|key\.dpapi|partner-login\.json|auth-sessions\.json)(?:$|[\\/])/i;
const FILE_TOOLS=new Set(['read','write','edit','read_image','read_file','write_file','edit_file','apply_patch']);
export function workToolDenial(execution,task,{definition,child=false}={}){
  if(!task)return undefined;
  const name=execution.name||'',args=execution.arguments||{};
  if(/^mcp__/.test(name)){
    const operation=normalized(name.split('__').slice(2).join('_')),readOnly=definition?.annotations?.readOnlyHint;
    if(WRITE.test(operation)||readOnly===false||readOnly!==true&&!READ.test(operation))return 'Use a typed apps_send_email/apps_create_event/apps_create_document action or the authorized browser flow. Direct connector writes and undeclared non-read actions cannot bypass the task authority broker.';
  }
  if(child&&/^viewer_(?:click|fill|type|key|select|handoff|stop)$/.test(name))return 'Delegated Work agents have browser read/navigation tools. Ask the parent Work task to perform interactive form actions so it retains authority and handoff ownership.';
  if(/^finance_/.test(name)&&WRITE.test(name))return 'Finance integrations are read-only. Use the explicit supported action flow for external changes.';
  if(['paused','stopped','attention','complete'].includes(task.status)&&(/^(?:viewer_|apps_)/.test(name))&&name!=='viewer_status')return 'This Work task is not active. Resume it before taking an external action.';
  if(FILE_TOOLS.has(name)){
    const paths=[args.path,args.file,args.file_path,args.filename,args.source,args.destination,...(Array.isArray(args.paths)?args.paths:[])].filter(x=>typeof x==='string');
    if(paths.some(path=>CREDENTIAL.test(path)))return 'Host credentials and session signing material stay behind the connection/vault adapter. Use the relevant Settings or connection tool.';
  }
  return undefined;
}
export function resolveWorkToolOwner(ctx,agent,taskForSession){
  const seen=new Set();let current=agent;
  for(let depth=0;depth<32&&current?.id&&!seen.has(current.id);depth++){
    seen.add(current.id);const task=taskForSession(current.id);if(task)return {task,child:agent.id!==task.sessionId};
    const parent=current.session?.header?.parentSession;if(typeof parent!=='string'||!parent)break;
    const parentTask=taskForSession(parent);if(parentTask)return {task:parentTask,child:true};
    current=ctx.agents?.get?.(parent);
  }
  return {task:null,child:false};
}
export function installWorkToolPolicy(ctx,taskForSession){
  if(typeof ctx.tools?.guard!=='function')throw new Error('Work tool policy needs the native monotonic tools.guard API. Upgrade the harness before enabling this boundary.');
  return ctx.tools.guard(execution=>{const {task,child}=resolveWorkToolOwner(ctx,execution.agent,taskForSession);return workToolDenial(execution,task,{child,definition:ctx.tools.get?.(execution.name,execution.agent)});});
}
