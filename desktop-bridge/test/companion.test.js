import test from 'node:test';import assert from 'node:assert/strict';
import {Companion} from '../src/companion.js';import {DesktopSession} from '../src/session.js';
function setup(){
 const calls=[],session=new DesktopSession();const task={id:'fixture',title:'Synthetic task',mode:'desktop',status:'paused',messages:[]};
 const link={online:true,peer:{},requestHost:async(method,body)=>{calls.push([method,body]);if(method==='create')return {...task,mode:body.mode,status:body.mode==='desktop'?'paused':'queued'};if(method==='list')return {tasks:[{...task}],name:'Seek',look:{}};return {...task,status:'queued'};}};
 const c=new Companion({link,session,grant:id=>session.grant(id),stop:reason=>session.revoke(reason)});return {c,link,session,calls,task};
}
test('desktop submission creates a paused task then grants exactly that task before start',async()=>{
 const s=setup();await s.c.submit({mode:'desktop',text:'Use Notes'});assert.equal(s.session.taskId,'fixture');assert.deepEqual(s.calls.map(c=>c[0]),['create','start']);assert.equal(s.calls[1][1].id,'fixture');
 for(const mode of ['chat','browser']){const s=setup();await s.c.submit({mode,text:'Synthetic question'});assert.notEqual(s.session.state,'agent');assert.deepEqual(s.calls.map(c=>c[0]),['create']);}
});
test('taking control while a create is in flight prevents late grant or task replay',async()=>{
 const s=setup();let finish;s.link.requestHost=()=>new Promise(r=>{finish=r;});const pending=s.c.submit({mode:'desktop',text:'Synthetic task'});s.session.revoke();finish(s.task);await assert.rejects(pending,/took control/);assert.equal(s.session.taskId,null);
});
test('failed start releases local control and no refresh can regrant after Stop',async()=>{
 const s=setup(),original=s.link.requestHost;s.link.requestHost=async(m,b)=>{if(m==='start')throw Error('offline');return original(m,b);};await assert.rejects(s.c.submit({mode:'desktop',text:'Synthetic task'}),/offline/);assert.equal(s.session.state,'human');await s.c.refresh();assert.equal(s.session.state,'human');
});
test('queue heartbeat preserves only the existing explicit grant; completed tasks release it',async()=>{
 const s=setup();s.task.status='queued';s.session.grant('fixture');s.session.expiresAt=Date.now()+1000;await s.c.refresh();assert.ok(s.session.expiresAt>Date.now()+14000);s.task.status='complete';await s.c.refresh();assert.equal(s.session.state,'human');s.task.status='queued';await s.c.refresh();assert.equal(s.session.state,'human');
});
test('pause revokes local input before waiting for the host',async()=>{
 const s=setup();s.c.remember(s.task);s.session.grant('fixture');s.link.requestHost=async()=>{assert.equal(s.session.state,'human');return s.task;};await s.c.pause('fixture');
});
test('remote desktop tasks and replies never require a grant on the initiating computer',async()=>{
 const s=setup(),original=s.link.requestHost;s.link.requestHost=async(m,b)=>({...await original(m,b),remote:true,computer:'Studio Mac'});const t=await s.c.submit({mode:'desktop',text:'Use Notes on my Mac',computerId:'remote-mac'});assert.equal(t.remote,true);assert.notEqual(s.session.state,'agent');assert.deepEqual(s.calls.map(c=>c[0]),['create']);await s.c.reply({id:t.id,text:'Continue'});await s.c.resume(t.id);assert.notEqual(s.session.state,'agent');assert.deepEqual(s.calls.map(c=>c[0]),['create','reply','resume']);
});
