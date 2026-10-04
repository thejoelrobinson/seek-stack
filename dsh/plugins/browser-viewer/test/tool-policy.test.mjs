import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools';
import {workToolDenial,installWorkToolPolicy,resolveWorkToolOwner} from '../lib/work-tool-policy.js';

const task={id:'task',sessionId:'work-session',status:'running'};
test('Work tool policy routes direct connector writes through the broker, preserves reads and Standard mode, and guards host credential files',()=>{
  assert.match(workToolDenial({name:'mcp__google__send_message',arguments:{}},task),/broker/);
  assert.match(workToolDenial({name:'mcp__google__get_or_create_document',arguments:{}},task),/broker/);
  assert.match(workToolDenial({name:'mcp__google__sendEmail',arguments:{}},task),/broker/);
  assert.match(workToolDenial({name:'mcp__google__performAction',arguments:{}},task),/broker/);
  assert.equal(workToolDenial({name:'mcp__google__customLookup',arguments:{}},task,{definition:{annotations:{readOnlyHint:true}}}),undefined);
  assert.match(workToolDenial({name:'mcp__google__getMessages',arguments:{}},task,{definition:{annotations:{readOnlyHint:false}}}),/broker/);
  assert.equal(workToolDenial({name:'mcp__google__getMessages',arguments:{}},task),undefined);
  assert.equal(workToolDenial({name:'mcp__google__list_messages',arguments:{}},task),undefined);
  assert.equal(workToolDenial({name:'apps_send_email',arguments:{}},task),undefined);
  assert.equal(workToolDenial({name:'mcp__google__send_message',arguments:{}},null),undefined);
  assert.match(workToolDenial({name:'read',arguments:{path:'C:\\host\\.secret'}},task),/Host credentials/);
  assert.equal(workToolDenial({name:'read',arguments:{path:'report.csv'}},task),undefined);
  assert.equal(workToolDenial({name:'pwsh',arguments:{command:'python report.py'}},task),undefined,'This in-process policy deliberately does not claim an arbitrary-shell sandbox.');
  assert.match(workToolDenial({name:'viewer_click',arguments:{}},{...task,status:'paused'}),/not active/);
});
test('trusted host parent-session lineage inherits Work policy, while tool arguments cannot forge it',()=>{
  const root={id:task.sessionId,session:{header:{}}},child={id:'child',session:{header:{parentSession:root.id}}},grandchild={id:'grandchild',session:{header:{parentSession:child.id}}},agents=new Map([root,child,grandchild].map(x=>[x.id,x]));
  const ctx={agents:{get:id=>agents.get(id)}},lookup=id=>id===root.id?task:null,owner=resolveWorkToolOwner(ctx,grandchild,lookup);
  assert.equal(owner.task,task);assert.equal(owner.child,true);assert.match(workToolDenial({name:'mcp__google__sendEmail',arguments:{}},owner.task,owner),/broker/);
  assert.match(workToolDenial({name:'viewer_click',arguments:{}},owner.task,owner),/Delegated/);assert.equal(workToolDenial({name:'viewer_navigate',arguments:{}},owner.task,owner),undefined);
  assert.equal(resolveWorkToolOwner(ctx,{id:'standard',arguments:{parentSession:root.id}},lookup).task,null);
});
test('native ToolRuntime guard cannot be bypassed by pre-execute allow, and unregistering the guard restores the route',async()=>{
  const ctx=new Context(),disposePrompt=ctx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{}}),runtime=new ToolRuntime(ctx);let writes=0;
  const disposeTool=runtime.register(defineTool({name:'mcp__fixture__send_message',description:'Synthetic provider write.',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:()=>{writes++;return {};}}));
  const disposeGuard=installWorkToolPolicy(ctx,id=>id===task.sessionId?task:null),disposeAllow=ctx.on('tools/pre-execute',async()=>({kind:'allow'}));
  try{
    const args={callId:'synthetic',name:'mcp__fixture__send_message',arguments:{},agent:{id:task.sessionId},signal:new AbortController().signal};
    const held=await runtime.execute(args);assert.equal(held.isError,true);assert.match(held.error.message,/broker/);assert.equal(writes,0);
    const child=await runtime.execute({...args,callId:'child',agent:{id:'child-session',session:{header:{parentSession:task.sessionId}}}});assert.equal(child.isError,true);assert.equal(writes,0);
    disposeGuard();const restored=await runtime.execute({...args,callId:'second'});assert.equal(restored.isError,false);assert.equal(writes,1);
  }finally{disposeAllow();disposeGuard();disposeTool();await disposePrompt();}
});
