import test from 'node:test';import assert from 'node:assert/strict';import {DesktopAgent} from '../src/agent.js';import {DesktopRuntime} from '../src/runtime.js';import {buildDesktopTools} from '../src/tools.js';
const frame=(n=1)=>({id:'obs'+n,windowId:'window',title:'Editor',image:'PRIVATE-IMAGE',elements:[{id:'native1',role:'Edit',name:'Document',value:n===1?'before':'after',enabled:true,focused:true},{id:'native2',role:'Button',name:'Save',enabled:true},{id:'native3',role:'Edit',name:'Password',password:true,value:'SECRET',enabled:true}]});
test('Qwen sees only text and short shown refs; one action returns verification',async()=>{
 let n=0;const actions=[];const client={observe:async()=>frame(++n),action:async c=>actions.push(c)};const agent=new DesktopAgent({client,taskId:'t'});
 const first=await agent.observe();assert.match(first.text,/e1 Edit/);assert.ok(!JSON.stringify(first).includes('PRIVATE-IMAGE'));assert.ok(!first.text.includes('SECRET'));assert.ok(!first.text.includes('native1'));
 const next=await agent.act('type',{ref:'e1',text:'after'});assert.equal(actions.length,1);assert.equal(actions[0].elementId,'native1');assert.equal(actions[0].observationId,'obs1');assert.match(next.text,/Changes/);assert.match(next.text,/after/);
 await assert.rejects(agent.act('click',{ref:'invented'}),/latest desktop/);
});
test('successful input with failed readback is not resent',async()=>{
 let reads=0,writes=0;const agent=new DesktopAgent({taskId:'t',client:{observe:async()=>{if(reads++)throw Error('lost readback');return frame();},action:async()=>{writes++;}}});
 await agent.observe();const result=await agent.act('click',{ref:'e2'});assert.equal(result.requiresObservation,true);assert.equal(writes,1);await assert.rejects(agent.act('click',{ref:'e2'}));assert.equal(writes,1);
});
test('find makes only matching shown refs usable',async()=>{
 const agent=new DesktopAgent({taskId:'t',client:{observe:async()=>frame(),action:async()=>{throw Error('should not run');}}});
 const result=await agent.find('Save');assert.match(result.text,/e2 Button/);assert.ok(!result.text.includes('Document'));await assert.rejects(agent.act('type',{ref:'e1',text:'x'}));
});
test('host resolver fences child and paused tasks; tool arguments cannot supply credentials',async()=>{
 let reads=0;let owner={taskId:'task',sessionId:'session',status:'running'};const runtime=new DesktopRuntime({connectionFile:'host-only',resolveOwner:()=>owner,readFileImpl:async()=>{reads++;return JSON.stringify({endpoint:'http://127.0.0.1:123',token:'a'.repeat(64)});},clientFactory:()=>({auth:true,attach:async()=>{},request:async()=>({state:'agent',taskId:'task',capabilities:{structuredObservation:true}}),close(){this.auth=null;},observe:async()=>frame()})});
 const exec={agent:{id:'session'}};owner={...owner,child:true};await assert.rejects(runtime.forExecution(exec));assert.equal(reads,0);
 owner={...owner,child:false,status:'paused'};await assert.rejects(runtime.forExecution(exec));owner.status='running';
 const tools=buildDesktopTools({defineTool:x=>x,runtime});assert.ok(tools.every(t=>!('token' in t.parameters)&&!('taskId' in t.parameters)&&!('endpoint' in t.parameters)));
 const result=await tools.find(t=>t.name==='desktop_observe').execute({},exec);assert.match(result.text,/Document/);runtime.close();
});
