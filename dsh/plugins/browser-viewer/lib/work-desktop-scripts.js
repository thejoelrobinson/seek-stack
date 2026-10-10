export async function requestScriptApproval({engine,control,hub},owner,exec,computer){
 const task=engine.task(owner.taskId),agent=control.current,status=await agent.client.request('/status');
 if(task.desktopScriptAsk&&task.status==='waiting')return 'Waiting for scripting approval. End your turn.';
 const remote=computer.id!=='local'&&hub.online().some(m=>m.id===computer.id&&m.remoteGrant);
 await engine.operation(async()=>{
  await engine.ask(exec,{question:remote?`Allow Seek to run scripts on ${computer.name} for “${task.title}”? This allows AppleScript and shell commands on Mac, or PowerShell on Windows, for this task. Scripts can read and change files and apps. Stop on the computer ends execution.`:`To run scripts for “${task.title}”, open Seek Desktop settings on ${computer.name} and choose Allow scripts for this task, then reply here.`,choices:[remote?'Allow scripts for this task':'I approved on the computer','Not now']});
  task.desktopScriptAsk={deviceId:computer.id,sessionId:status.sessionId,epoch:status.epoch,remote};await engine.save();
 });
 return 'Asked for scripting approval for this task. End your turn now and wait for the answer.';
}
export async function answerScriptApproval({control,hub},task,answer){
 const pending=task.desktopScriptAsk;
 if(!pending||task.status!=='waiting')throw Error('This scripting request is no longer waiting for approval.');
 if(![pending.remote?'Allow scripts for this task':'I approved on the computer','Not now'].includes(answer))throw Error('Choose a scripting approval option.');
 if(answer==='Not now'){task.desktopScriptAsk=null;return 'The user declined scripting for this task. Continue using direct desktop tools.';}
 const agent=control.current;
 if(!agent||agent.taskId!==task.id||control.computer?.id!==pending.deviceId||agent.client.auth?.sessionId!==pending.sessionId||agent.client.auth?.epoch!==pending.epoch)throw Error('Desktop control changed. Continue the task and request scripting again.');
 if(pending.remote){
  if(!hub.online().some(m=>m.id===pending.deviceId&&m.remoteGrant))throw Error('This computer no longer allows approval from your phone. Approve scripting locally.');
  await agent.client.allowScripts();
 }else if(!(await agent.client.request('/status')).scriptsAllowed)throw Error('Allow scripts for this task in Seek Desktop settings first.');
 task.desktopScriptGrant={deviceId:pending.deviceId,at:Date.now()};task.desktopScriptAsk=null;
 return 'The user approved scripts for this task on the selected computer. Continue with desktop_script.';
}
