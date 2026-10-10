import test from 'node:test';import assert from 'node:assert/strict';
import {requestScriptApproval,answerScriptApproval} from '../lib/work-desktop-scripts.js';
function setup(){
 const task={id:'task',title:'Organize Downloads',status:'running'};let grants=0,remote=true;
 const status={sessionId:'session',epoch:4,scriptsAllowed:false};
 const computer={id:'mac',name:'Mac'},control={computer,current:{taskId:task.id,client:{auth:status,request:async()=>({...status}),allowScripts:async()=>{grants++;}}}},hub={online:()=>[{id:'mac',remoteGrant:remote}]};
 const engine={task:()=>task,operation:fn=>fn(),ask:async(_e,question)=>{task.status='waiting';task.question=question;},save:async()=>{}};
 return {task,control,hub,engine,status,computer,grants:()=>grants,disableRemote:()=>remote=false};
}
test('phone approval is per task and binds the current computer/session/epoch',async()=>{
 const s=setup();await requestScriptApproval(s,{taskId:'task'},null,s.computer);assert.equal(s.grants(),0);assert.match(s.task.question.question,/AppleScript/);
 await answerScriptApproval(s,s.task,'Allow scripts for this task');assert.equal(s.grants(),1);assert.equal(s.task.desktopScriptGrant.deviceId,'mac');assert.equal(s.task.desktopScriptAsk,null);
 await assert.rejects(answerScriptApproval(s,s.task,'Allow scripts for this task'));
});
test('stale approval and withdrawn remote opt-in cannot grant scripts',async()=>{
 const s=setup();await requestScriptApproval(s,{taskId:'task'},null,s.computer);s.control.current.client.auth={sessionId:'replacement',epoch:5};await assert.rejects(answerScriptApproval(s,s.task,'Allow scripts for this task'),/changed/);assert.equal(s.grants(),0);
 s.control.current.client.auth=s.status;s.disableRemote();await assert.rejects(answerScriptApproval(s,s.task,'Allow scripts for this task'),/no longer/);assert.equal(s.grants(),0);
});
test('local-only approval verifies the local permission; denial never grants',async()=>{
 const s=setup();s.disableRemote();await requestScriptApproval(s,{taskId:'task'},null,s.computer);
 await assert.rejects(answerScriptApproval(s,s.task,'I approved on the computer'),/settings first/);s.status.scriptsAllowed=true;await answerScriptApproval(s,s.task,'I approved on the computer');assert.equal(s.grants(),0);
 const denied=setup();await requestScriptApproval(denied,{taskId:'task'},null,denied.computer);await answerScriptApproval(denied,denied.task,'Not now');assert.equal(denied.grants(),0);assert.equal(denied.task.desktopScriptGrant,undefined);
});
