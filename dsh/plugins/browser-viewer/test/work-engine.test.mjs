import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkEngine} from '../lib/work-server.js';
import {FakeHarness} from './fake-harness.mjs';

const harness=new FakeHarness(),calls=harness.calls,sessions=harness.sessions;
const root=await mkdtemp(join(tmpdir(),'dsh-work-engine-'));
const engine=new WorkEngine(harness,root,console,id=>sessions.get(id)?.goal);
await engine.init();
const task=await engine.create({objective:'Ask my color and make a file.',files:[{name:'brief.txt',data:Buffer.from('brief').toString('base64')}]});
await engine.tick();assert.equal(task.status,'running');assert.ok(sessions.get(task.sessionId).goal);
const agent={id:task.sessionId};sessions.get(task.sessionId).running=true;
await engine.ask({agent},{question:'Which color?',choices:['Blue','Green']});assert.equal(task.status,'waiting');
await engine.control(task.id,'reply','Blue');await engine.tick();
// A quick reply waits until the previous model turn ends, but the task still shows as the active,
// running task (it used to read "I'll start when the current task is finished" while it worked).
assert.equal(task.status,'running');assert.equal(task.deliverAfterTurn,true,'A quick reply waits until the previous model turn ends.');
sessions.get(task.sessionId).running=false;
await engine.tick();assert.equal(task.status,'running');
assert.match(sessions.get(task.sessionId).goal.objective,/Blue/);
assert.equal(calls.filter(c=>c[0]==='prompt').length,0,'Goal reply is not raced with a queued user prompt.');
await writeFile(join(task.cwd,'result.md'),'A verified blue result.');await engine.artifact(task,'result.md','Result');task.result='The requested file is ready.';
task.status='waiting';task.question={text:'Old question'};sessions.get(task.sessionId).goal.phase='complete';await engine.tick();
assert.equal(task.status,'complete');assert.equal(task.question,null);
const native=await engine.create({objective:'Native approval test'});await engine.tick();
const nativeAnswer=engine.claimNative(native.sessionId,{type:'approval/requested',approvalId:'approval-1',sessionId:native.sessionId,toolName:'write',reason:'Write outside workspace'});await engine.operations;
assert.equal(native.status,'waiting');await engine.control(native.id,'reply','Reject');
assert.equal(await nativeAnswer,'rejected');assert.equal(native.status,'running');
await engine.control(native.id,'stop');assert.equal(native.status,'stopped');
const recovering=await engine.create({objective:'Recover partially created task'});
recovering.sessionId=(await harness.createSession({cwd:''})).sessionId;recovering.status='running';await engine.save();
const second=new WorkEngine(harness,root,console,id=>sessions.get(id)?.goal);await second.init();assert.equal(second.task(recovering.id).status,'queued');
await second.tick();assert.ok(sessions.get(recovering.sessionId).goal,'Goal creation recovers after interruption.');
const outside=join(root,'outside.txt');await writeFile(outside,'private');await assert.rejects(second.file(second.task(recovering.id),outside),/inside/);
await assert.rejects(second.create({objective:'Bad attachment',files:[{name:'bad',data:'%%%'}]}),/Invalid attachment/);
console.log('PASS: durable recovery, quick reply ordering, completed-state reconciliation, native approvals, file boundary and upload validation.');

// A chat-mode task that asks a question must keep waiting for the answer.
const chatEngine=new WorkEngine(harness,await mkdtemp(join(tmpdir(),'dsh-work-chat-')),console,id=>sessions.get(id)?.goal);await chatEngine.init();
const chat=await chatEngine.create({objective:'Quick question for me.',mode:'chat'});
await chatEngine.tick();assert.equal(chat.status,'running');
await chatEngine.ask({agent:{id:chat.sessionId}},{question:'Which day?'});
sessions.get(chat.sessionId).running=false;await chatEngine.tick();
assert.equal(chat.status,'waiting','Chat questions are not discarded when the turn ends.');
assert.equal(chat.question.text,'Which day?');
console.log('PASS: chat-mode question survives the end of the turn.');

// Browser handoff: the task waits for the user, then resumes itself on hand back.
const hEngine=new WorkEngine(harness,await mkdtemp(join(tmpdir(),'dsh-work-handoff-')),console,id=>sessions.get(id)?.goal);await hEngine.init();
const shop=await hEngine.create({objective:'Order the usual coffee.'});
await hEngine.tick();assert.equal(shop.status,'running');sessions.get(shop.sessionId).running=true;
await hEngine.handoff({sessionId:shop.sessionId,reason:'login',message:'Sign in to the coffee shop.',url:'https://shop.example/login',title:'Sign in'});
assert.equal(shop.status,'waiting');assert.equal(shop.handoff.reason,'login');assert.equal(shop.question.kind,'handoff');
assert.equal(sessions.get(shop.sessionId).goal.phase,'paused','Handoff pauses the goal so the driver does not continue.');
sessions.get(shop.sessionId).running=false;await hEngine.tick();assert.equal(shop.status,'waiting','A handoff waits for the user.');
await hEngine.handBack({sessionId:shop.sessionId,url:'https://shop.example/account',title:'Your account'});
assert.equal(shop.handoff,null);assert.equal(shop.status,'queued');assert.match(shop.pendingReply,/handed over|gave control back/);assert.match(shop.pendingReply,/shop\.example\/account/);
await hEngine.tick();assert.equal(shop.status,'running');assert.match(sessions.get(shop.sessionId).goal.objective,/gave control back/);
// Approval for a hard-to-undo action.
const approval={id:'ap-1',sessionId:shop.sessionId,label:'Place order',host:'shop.example',url:'https://shop.example/checkout',title:'Checkout',at:Date.now()};
await hEngine.approvalRequested(approval);
assert.equal(shop.status,'waiting');assert.deepEqual(shop.question.choices,['Approve once','For this task','Always this action','Reject']);
await hEngine.approvalDecided(approval,'approve','once');
assert.equal(shop.approval,null);assert.equal(shop.status,'queued');assert.match(shop.pendingReply,/APPROVED/);
sessions.get(shop.sessionId).running=false;await hEngine.tick();
await hEngine.approvalRequested({...approval,id:'ap-2'});await hEngine.approvalDecided({...approval,id:'ap-2'},'reject','once');
assert.match(shop.pendingReply,/REJECTED/);
// Stopping clears a pending handoff so the UI does not keep asking.
await hEngine.handoff({sessionId:shop.sessionId,reason:'captcha',message:'Solve the check.'});await hEngine.control(shop.id,'stop');
assert.equal(shop.handoff,null);assert.equal(shop.status,'stopped');
console.log('PASS: browser handoff waits and resumes on hand back; approvals and rejections resume the task; stop clears handoff.');

// One-tap suggestions and proactive ideas.
const sEngine=new WorkEngine(harness,await mkdtemp(join(tmpdir(),'dsh-work-suggest-')),console,id=>sessions.get(id)?.goal);await sEngine.init();
const gas=await sEngine.create({objective:'Watch gas prices for me.'});
await sEngine.tick();assert.equal(gas.status,'running');
await sEngine.suggest({agent:{id:gas.sessionId}},[{label:'Set it up',request:'Set up the Monday outlook.'},{label:'',request:'x'},{label:'A',request:'a'},{label:'B',request:'b'},{label:'C',request:'c'}]);
assert.deepEqual(gas.suggestions.map(s=>s.label),['Set it up','A','B'],'blank suggestions dropped, capped at three');
gas.status='queued';sessions.get(gas.sessionId).running=false;await sEngine.tick();
assert.deepEqual(gas.suggestions,[],'suggestions clear when the task runs again');
await assert.rejects(sEngine.refreshIdeas(async()=>[{title:'x',why:'y',request:'z'}]),/Busy/);
gas.status='complete';
const ideas=await sEngine.refreshIdeas(async({memory,tasks})=>{assert.ok(Array.isArray(tasks));return [{title:'Weekly gas outlook',why:'You asked about gas prices.',request:'Every Monday, send me a gas price outlook.'}];});
assert.equal(sEngine.store.ideas.items[0].title,'Weekly gas outlook');assert.ok(ideas.at<=Date.now());
console.log('PASS: suggestions are capped, validated and cleared on the next run; ideas refresh only when idle.');

// A handoff the agent no longer needs (it finished another way) is withdrawn, not left as "Your turn".
const dEngine=new WorkEngine(harness,await mkdtemp(join(tmpdir(),'dsh-work-drop-')),console,id=>sessions.get(id)?.goal);await dEngine.init();
let dropped=null;dEngine.onHandoffDropped=t=>dropped=t.id;
const hikes=await dEngine.create({objective:'Suggest three hikes.',mode:'chat'});
await dEngine.tick();sessions.get(hikes.sessionId).running=true;
await dEngine.handoff({sessionId:hikes.sessionId,reason:'captcha',message:'Solve the check.',at:Date.now()-1000});
hikes.messages.push({role:'assistant',text:'Here are three hikes.',time:Date.now()});
sessions.get(hikes.sessionId).running=false;await dEngine.tick();
assert.equal(hikes.handoff,null);assert.equal(hikes.status,'complete');assert.equal(dropped,hikes.id);
console.log('PASS: a stale handoff is withdrawn when the agent finishes without it.');

// The thread shows the browser where the latest request first used it (browserAt), not at the bottom.
const bEngine=new WorkEngine(harness,await mkdtemp(join(tmpdir(),'dsh-work-browse-')),console,id=>sessions.get(id)?.goal);await bEngine.init();
const browse=await bEngine.create({objective:'Look something up in the browser.'});await bEngine.tick();
const bs=sessions.get(browse.sessionId);bs.running=true;const T=Date.now();
bs.events.push({event:{seq:1,type:'tool/call',time:T+1000,data:{name:'viewer_navigate'}}},{event:{seq:2,type:'tool/call',time:T+2000,data:{name:'viewer_click'}}});
await bEngine.tick();assert.equal(browse.usesBrowser,true);assert.equal(browse.browserAt,T+1000);
browse.messages.push({role:'user',text:'Check it again.',time:T+3000});
bs.events.push({event:{seq:3,type:'tool/call',time:T+4000,data:{name:'viewer_snapshot'}}},{event:{seq:4,type:'tool/call',time:T+5000,data:{name:'viewer_click'}}});
await bEngine.tick();assert.equal(browse.browserAt,T+4000,'A follow-up request moves the browser to where that turn first used it.');
console.log('PASS: browser placement in the thread follows the latest request.');
