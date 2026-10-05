import test from 'node:test';import assert from 'node:assert/strict';import {DesktopSession} from '../src/session.js';
test('text-only navigation binds controls and focus to one observation',()=>{
 const session=new DesktopSession(),auth=session.grant('t'),display={x:0,y:0,width:100,height:100};
 const frame={windowId:'w',elements:[{id:'button',enabled:true,x:10,y:10,width:20,height:20},{id:'edit',enabled:true,focused:false},{id:'password',enabled:true,focused:true,password:true}]};
 let observation=session.observe(auth,display,frame);
 assert.throws(()=>session.action(auth,{kind:'click',observationId:observation.id,x:1,y:1}),/Choose an element/);
 assert.throws(()=>session.action(auth,{kind:'type',text:'hello',elementId:'edit',observationId:observation.id}),/Focus/);
 assert.throws(()=>session.action(auth,{kind:'type',text:'hello',elementId:'password',observationId:observation.id}),/protected/);
 assert.equal(session.action(auth,{kind:'click',elementId:'button',observationId:observation.id}).x,20);
 observation=session.observe(auth,display,{windowId:'w',elements:[{id:'edit',enabled:true,focused:true}]});
 const action=session.action(auth,{kind:'type',text:'hello',elementId:'edit',observationId:observation.id});assert.equal(action.focusId,'edit');assert.equal(action.windowId,'w');
});
test('fill and invoke use advertised semantics without keyboard focus',()=>{
 const session=new DesktopSession(),auth=session.grant('t'),display={x:0,y:0,width:100,height:100};
 let observation=session.observe(auth,display,{windowId:'w',elements:[{id:'edit',enabled:true,canFill:true,focused:false}]});
 const fill=session.action(auth,{kind:'fill',text:'',elementId:'edit',observationId:observation.id});assert.equal(fill.text,'');assert.equal(fill.focusId,undefined);assert.equal(fill.targetId,'edit');
 observation=session.observe(auth,display,{windowId:'w',elements:[{id:'button',enabled:true,canInvoke:false}]});assert.throws(()=>session.action(auth,{kind:'invoke',elementId:'button',observationId:observation.id}),/support/);
});
