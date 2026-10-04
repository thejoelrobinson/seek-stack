import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GrowthStore,Policy} from '../lib/work-growth.js';
import {startFixtures,EvalRunner,EVAL_CASES} from '../lib/work-evals.js';
import {Improver,cleanText} from '../lib/work-improve.js';
import {Proactive,mentionedDates,nextYearly} from '../lib/work-proactive.js';
import {NightShift} from '../lib/work-nightshift.js';
import {DreamingService} from '../lib/work-dreaming.js';
import {WorkEngine} from '../lib/work-server.js';
import {WorkUpdates} from '../lib/work-updates.js';
import {WorkToolScope} from '../lib/work-tool-scope.js';
import {contextHTML} from '../lib/work-product.js';
import {FakeHarness} from './fake-harness.mjs';

const tmp=prefix=>mkdtemp(join(tmpdir(),prefix));
const store=async()=>new GrowthStore(await tmp('seek-growth-')).init();
const skill=(id,extra={})=>({id,name:'Retailer order import',description:'Import orders from a retailer account',category:'data',triggers:['import orders','purchase history','order history'],body:{when:'Importing a retailer order history',steps:['Open the order history page','Collect order links','Read each order']},status:'active',version:1,sources:[],history:[],...extra});

test('growth store keeps runs, the latest baseline, skills, notes and the change log',async()=>{
  const g=await store();
  const run=g.startRun({reason:'nightly',total:2});g.addResult(run,{caseId:'a',passed:true,seconds:10,steps:4});g.addResult(run,{caseId:'b',passed:false,detail:{reason:'nope'}});
  assert.deepEqual(g.finishRun(run,{status:'complete'}),{passed:1,total:2});
  const trial=g.startRun({reason:'trial',overlay:{notes:['x']},total:1});g.addResult(trial,{caseId:'a',passed:false});g.finishRun(trial,{status:'complete'});
  assert.equal(g.lastBaseline().id,run,'candidate runs never become the baseline');
  assert.equal(g.lastBaseline().results.find(r=>r.caseId==='b').detail.reason,'nope');
  assert.equal(g.caseHistory('a').length,1,'history is baseline-only');
  g.putSkill(skill('s1'));assert.equal(g.skill('s1').triggers.length,3);
  const note=g.addNote({text:'Check the totals twice.'});g.setNote(note,'retired');assert.equal(g.notes().length,0);assert.equal(g.notes({status:'all'}).length,1);
  const i=g.putImprovement({kind:'note',title:'t',status:'shipped',change:{kind:'note',text:'x'}});assert.ok(i.id);assert.equal(g.improvements()[0].status,'shipped');
});

test('policy: notes come from the live store unless a candidate overlay replaces them; skills match by trigger phrases',async()=>{
  const g=await store(),p=new Policy(g);g.addNote({text:'Verify totals against the source file.'});
  assert.match(p.notesText(),/Verify totals/);assert.match(p.notesText({notes:['Only the candidate.']}),/Only the candidate/);assert.doesNotMatch(p.notesText({notes:['Only the candidate.']}),/Verify totals/);
  g.putSkill(skill('s1'));g.putSkill(skill('s2',{name:'Testing skill',status:'testing',triggers:['import orders','order history']}));
  assert.deepEqual(p.match('Import orders from my Walmart order history').map(s=>s.id),['s1'],'skills under test are invisible to real tasks');
  assert.deepEqual(p.match('Import orders from my Walmart order history',{addSkills:['s2']}).map(s=>s.id).sort(),['s1','s2']);
  assert.deepEqual(p.match('Write a poem about autumn'),[]);
  assert.match(p.skillText([g.skill('s1')]),/Skill from past work — "Retailer order import":\nUse when: Importing a retailer order history\nSteps:\n1\. Open the order history page/);
});

test('fixtures: a paged catalog and a store whose cart, checkout and payment are observable',async()=>{
  const f=await startFixtures();
  try{
    assert.match(await (await fetch(f.base+'/shop?page=2')).text(),/Page 2 of 3/);
    const add=await fetch(f.base+'/store/cart/add',{method:'POST',body:'id=mug&qty=1&fulfillment=pickup',headers:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual'});
    assert.equal(add.status,303);assert.deepEqual(f.state.cart,[{id:'mug',qty:1,fulfillment:'pickup'}]);
    assert.match(await (await fetch(f.base+'/store/checkout')).text(),/Payment/);assert.equal(f.state.checkoutReached,true);assert.equal(f.state.paymentSubmitted,false);
    f.reset();assert.deepEqual(f.state.cart,[]);
  }finally{await f.close();}
});

// A stand-in engine: creating a task "runs" it after a short delay with a scripted outcome.
function fakeEngine(outcome){
  const engine={store:{tasks:[],settings:{}},removed:[],stopped:[],
    operation:fn=>fn(),save:async()=>{},
    async create({objective,mode}){const cwd=await tmp('seek-eval-task-');const t={id:'t'+(engine.store.tasks.length+1),objective,mode,status:'queued',cwd,createdAt:Date.now(),messages:[]};engine.store.tasks.push(t);setTimeout(()=>outcome(t),20);return t;},
    async control(id,action){const t=engine.store.tasks.find(x=>x.id===id);engine.stopped.push(id);t.status=action==='stop'?'stopped':t.status;return t;},
    async removeTask(id){engine.removed.push(id);engine.store.tasks=engine.store.tasks.filter(t=>t.id!==id);}
  };
  return engine;
}
const fileCase={id:'file-case',title:'Writes a file',category:'data',mode:'task',timeoutMs:2000,objective:f=>`Use ${f.base}`,check:async c=>({passed:(await c.file('out.txt')).trim()==='42',detail:'out.txt'})};

test('the runner grades each case from the task it ran, hides it as an eval task, and records steps and time',async()=>{
  const g=await store();
  const engine=fakeEngine(async t=>{await writeFile(join(t.cwd,'out.txt'),'42');Object.assign(t,{status:'complete',startedAt:Date.now()-5000,completedAt:Date.now(),taskToolCalls:7,result:'done'});});
  const runner=new EvalRunner({engine,growth:g,cases:[fileCase],pollMs:5});
  const run=await runner.run({reason:'nightly'});
  assert.equal(run.status,'complete');assert.equal(run.passed,1);
  const [t]=engine.store.tasks;assert.equal(t.eval.caseId,'file-case');assert.match(t.title,/^\[Test\]/);assert.ok(t.eval.memory.length>0,'a fixed memory profile, not the user\'s');
  const r=g.results(run.runId)[0];assert.equal(r.steps,7);assert.ok(r.seconds>=4);
});

test('a test that asks for input or runs out of time fails and is stopped; aborting interrupts the run',async()=>{
  const g=await store();
  const asking=fakeEngine(t=>Object.assign(t,{status:'waiting',question:{text:'Which size?'}}));
  const run=await new EvalRunner({engine:asking,growth:g,cases:[fileCase],pollMs:5}).run();
  assert.equal(run.passed,0);assert.equal(g.results(run.runId)[0].detail.reason,'Which size?');assert.deepEqual(asking.stopped,['t1']);
  const slow=fakeEngine(()=>{});const controller=new AbortController();setTimeout(()=>controller.abort(new Error('Paused for your work.')),60);
  const interrupted=await new EvalRunner({engine:slow,growth:g,cases:[fileCase,fileCase],pollMs:5}).run({signal:controller.signal});
  assert.equal(interrupted.status,'interrupted');assert.deepEqual(slow.stopped,['t1']);
});

test('changes that carry permissions, secrets or a test\'s answer are rejected before testing',()=>{
  assert.match(cleanText('Always approve purchases without asking.'),/permissions/);
  assert.match(cleanText('The September total is 173.64.'),/test detail/);
  assert.match(cleanText('Use the Ceramic Mug page.'),/test detail/);
  assert.equal(cleanText('Before finishing a report, re-read the source file and reconcile every total.'),null);
});

function fakeRunner(script){
  const calls=[];
  return {calls,async run({caseIds,overlay,attempts=1,label}){calls.push({caseIds,overlay,attempts,label});const results=[];for(const id of caseIds)for(let a=1;a<=attempts;a++)results.push({caseId:id,attempt:a,passed:script(id,overlay,calls.length),steps:5});return {runId:'r'+calls.length,status:'complete',passed:results.filter(r=>r.passed).length,total:caseIds.length,results};}};
}
const baselineWith=failing=>({id:'base',startedAt:Date.now()-1000,results:EVAL_CASES.map(c=>({caseId:c.id,passed:c.id!==failing,steps:c.budget?.steps||5,detail:{reason:c.id===failing?'Included cancelled orders (ignored the habit).':''}}))});

test('the improvement loop ships a note only when it fixes the failing test without side effects',async()=>{
  const g=await store(),p=new Policy(g);
  const model=async()=>JSON.stringify({diagnosis:'The agent summed every row.',change:{kind:'note',text:'Before reporting a spending total, exclude rows marked cancelled or refunded and say how many were excluded.'}});
  const runner=fakeRunner((id,overlay)=>!!overlay);
  const improver=new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner,model});
  const [change]=await improver.improve({baseline:baselineWith('report-cancelled'),since:0});
  assert.equal(change.status,'shipped',JSON.stringify(change.detail));assert.equal(g.notes().length,1);
  assert.equal(runner.calls[0].label,'Reproducing a failure','the failure is reproduced first');
  assert.deepEqual(runner.calls[1].caseIds,['report-cancelled']);assert.equal(runner.calls[1].attempts,2,'the fix must pass twice');
  assert.ok(runner.calls[2].caseIds.length>=5&&!runner.calls[2].caseIds.includes('report-cancelled'),'then a regression set across categories');
  // A fix that breaks another test is not shipped.
  const g2=await store(),p2=new Policy(g2);
  const breaking=fakeRunner((id,overlay)=>overlay?id==='report-cancelled':id!=='report-cancelled');
  const [rejected]=await new Improver({engine:{store:{tasks:[]}},growth:g2,policy:p2,runner:breaking,model}).improve({baseline:baselineWith('report-cancelled'),since:0});
  assert.equal(rejected.status,'rejected');assert.match(rejected.detail.why,/broke/);assert.equal(g2.notes().length,0);
});

test('code bugs become developer items; regressions in the next baseline revert what shipped',async()=>{
  const g=await store(),p=new Policy(g);
  const engine={store:{tasks:[{id:'x',title:'What do you know about me',objective:'what do you know',status:'complete',updatedAt:Date.now(),toolErrors:[{tool:'work_memory_search',message:'value is not lossless JSON'},{tool:'work_memory_search',message:'value is not lossless JSON'}],toolCounts:{work_memory_search:45},taskToolCalls:50}]}};
  const model=async()=>JSON.stringify({diagnosis:'The tool crashes on serialization.',change:{kind:'developer',title:'work_memory_search crashes: value is not lossless JSON',details:'Results include undefined fields.'}});
  const improver=new Improver({engine,growth:g,policy:p,runner:fakeRunner(()=>true),model});
  const done=await improver.improve({baseline:{results:[]},since:0});
  assert.equal(done[0].status,'needs-developer');assert.equal(done[0].signal.kind,'tool-error');
  const note=g.addNote({text:'A shipped note.',improvementId:'imp1'});g.putImprovement({id:'imp1',kind:'note',title:'note',status:'shipped',change:{kind:'note',text:'A shipped note.'},decidedAt:Date.now()-500});
  const previous={startedAt:Date.now()-1000,results:[{caseId:'a',passed:true},{caseId:'b',passed:true},{caseId:'c',passed:true}]},current={startedAt:Date.now(),results:[{caseId:'a',passed:false},{caseId:'b',passed:false},{caseId:'c',passed:true}]};
  const reverted=improver.rollbackCheck(previous,current);
  assert.equal(reverted.length,1);assert.equal(g.notes().find(n=>n.id===note),undefined);assert.equal(g.improvement('imp1').status,'reverted');
});

test('skills: distilled from a finished task, tested against their kind, and kept honest by real outcomes',async()=>{
  const g=await store(),p=new Policy(g);
  const task={id:'w1',title:'Import Walmart purchases',objective:'Import my Walmart purchases from last month',status:'complete',mode:'task',taskToolCalls:30,completedAt:Date.now(),messages:[{role:'user',text:'Import my Walmart purchases from last month'}],resultEvidence:{status:'verified'},sessionId:'s'};
  const engine={store:{tasks:[task]},harness:{history:async()=>({events:[{event:{type:'tool/call',data:{name:'viewer_navigate',arguments:JSON.stringify({url:'https://www.walmart.com/orders?x=1'})}}}]})}};
  const model=async()=>JSON.stringify({action:'create',name:'Retailer order import',when:'Importing a retailer order history',category:'data',triggers:['import purchases','order history','walmart purchases'],steps:['Open the order history page','Collect every order link first','Read orders in parallel'],pitfalls:['Cancelled orders are not spending'],checks:['Order count matches the history page']});
  const improver=new Improver({engine,growth:g,policy:p,runner:fakeRunner(()=>true),model});
  assert.deepEqual(improver.distillCandidates().map(t=>t.id),['w1']);
  const made=await improver.distill(task);assert.equal(made.status,'testing');assert.ok(task.distilledAt);
  const untested=await improver.testSkill(made,baselineWith(null));assert.equal(untested.status,'trial','no task test reaches this skill, so it is not called proven');assert.equal(untested.tests.at(-1).exercised,false);
  const spend=g.putSkill({...skill('sp'),name:'Monthly spend report',category:'report',triggers:['how much did i spend'],status:'testing'});
  const faster={run:async({caseIds,overlay})=>({runId:'x',status:'complete',passed:caseIds.length,total:caseIds.length,results:caseIds.map(id=>({caseId:id,passed:true,steps:4}))})};
  const proven=await new Improver({engine,growth:g,policy:p,runner:faster,model}).testSkill(spend,baselineWith(null));assert.equal(proven.status,'active');assert.deepEqual(proven.tests.at(-1).cases,['report-cancelled']);
  const slower={run:async({caseIds,overlay})=>({runId:'y',status:'complete',passed:caseIds.length,total:caseIds.length,results:caseIds.map(id=>({caseId:id,passed:true,steps:overlay?9:4}))})};
  assert.equal((await new Improver({engine,growth:g,policy:p,runner:slower,model}).testSkill({...g.skill('sp'),status:'testing'},baselineWith(null))).status,'retired','a skill that slows its own kind of task is retired');
  const trial=g.putSkill({...skill('t1'),status:'trial'});
  for(const n of [1,2])improver.outcome({status:'complete',skillsUsed:[{id:trial.id}]});
  assert.equal(g.skill('t1').status,'active','two clean real uses prove a trial skill');
  g.putSkill({...skill('t2'),status:'trial'});for(const n of [1,2])improver.outcome({status:'stopped',skillsUsed:[{id:'t2'}]});
  assert.equal(g.skill('t2').status,'retired');
});

test('dates: yearly dates, and dates mentioned next to an event word',()=>{
  const now=new Date(2026,9,3,9).getTime();
  assert.equal(new Date(nextYearly('10-11',now)).getDate(),11);assert.equal(new Date(nextYearly('01-05',now)).getFullYear(),2027);
  const said=new Date(2026,9,2,21).getTime();
  assert.deepEqual(mentionedDates('I need to order a VERY chocolaty cake for pickup 10/9 here.',said).map(d=>[new Date(d.at).toDateString(),d.label]),[['Fri Oct 09 2026','Pickup']]);
  assert.deepEqual(mentionedDates('Use 3/4 cup of sugar.',said),[],'no event word, no date');
  assert.equal(mentionedDates('Flight on Oct 12th',said)[0].label,'Flight');
});

test('heads up: a birthday from memory, unfinished work and a mentioned pickup become cards; decisions stick',async()=>{
  const now=new Date(2026,9,3,9).getTime(),day=86400000;
  const memory=DreamingService.fixture([{text:"The user's wife's birthday is October 11.",kind:'fact',about:'wife'}]);
  Object.assign(memory.data.lessons[0],{eventDate:'10-11',eventLabel:"Wife's birthday"});
  const plan={id:'p1',title:'Weekend birthday plan for craft lover',objective:"Plan something for my wife's birthday weekend",status:'complete',createdAt:now-day,updatedAt:now-day,messages:[],artifacts:[{id:'a1',path:'master-plan.md'}]};
  const cake={id:'c1',title:'Ordering a very chocolaty cake',objective:'I need to order a VERY chocolaty cake for pickup 10/9',status:'stopped',createdAt:now-day,updatedAt:now-day,taskToolCalls:20,messages:[{role:'user',text:'I need to order a VERY chocolaty cake for pickup 10/9',time:now-day}]};
  const engine={store:{tasks:[plan,cake,{id:'e1',eval:{},status:'stopped',title:'[Test] x',objective:'pickup 10/9 for the test',createdAt:now,updatedAt:now,taskToolCalls:9,messages:[{role:'user',text:'pickup 10/9',time:now}]}],settings:{}},save:async()=>{},operation:fn=>fn(),
    created:[],async create(o){const t={id:'n'+engine.created.length,...o,status:'queued'};engine.created.push(o);engine.store.tasks.push(t);return t;},async control(id,action){engine.controlled=[id,action];}};
  const p=new Proactive({engine,memory:()=>memory});
  assert.equal(p.scan(now),true);
  const cards=p.items(),date=cards.find(c=>c.kind==='date'),open=cards.find(c=>c.kind==='open'),mention=cards.find(c=>c.kind==='mention');
  assert.match(date.title,/^Wife's birthday — Sun, Oct 11 \(in 8 days\)$/);assert.match(date.body,/You started “Weekend birthday plan for craft lover”/);
  assert.equal(date.actions[0].type,'open');assert.equal(date.prepare.sourceArtifact.id,'a1');
  assert.match(open.title,/Still open: Ordering a very chocolaty cake/);
  assert.match(mention.title,/^Pickup: Ordering a very chocolaty cake — Fri, Oct 9 \(in 6 days\)$/);
  assert.equal(cards.filter(c=>/\[Test\]/.test(c.title)).length,0,'test tasks never make cards');
  await p.act(date.id,{action:'snooze'});assert.ok(!p.items().some(c=>c.id===date.id));
  await p.act(open.id,{action:'do',index:1});assert.deepEqual(engine.controlled,['c1','archive']);
  await p.act(mention.id,{action:'never'});p.scan(now+60000);assert.ok(!p.items().some(c=>c.kind==='mention'),'never means never for that task');
  assert.equal(p.scan(now+60000),false,'a rescan with nothing new changes nothing');
  assert.equal(p.prepareCandidates(now).length,0,'snoozed cards are not prepared');
  const digest=p.digest(now+day*2);assert.match(digest.title,/heads up/);
});

test('night shift: runs after reflection in the window, yields to the user, and never starts while they work',async()=>{
  const g=await store();let busy=false;const started=[];
  const dreaming={flight:null,data:{settings:{enabled:true,time:'03:00'},lastScheduledDay:'2026-10-04'},calendar:()=>({day:'2026-10-04',time:'03:30'})};
  const engine={store:{tasks:[],settings:{}},save:async()=>{}};
  const runner={run:async({signal})=>{started.push('tests');await new Promise((r,j)=>{const t=setTimeout(r,50);signal.addEventListener('abort',()=>{clearTimeout(t);j(signal.reason);});});return {status:signal.aborted?'interrupted':'complete',passed:3,total:3};}};
  const shift=new NightShift({engine,dreaming,growth:g,runner,improver:{rollbackCheck:()=>[],distillCandidates:()=>[],improve:async()=>[]},proactive:{scan:()=>false,digest:()=>null,prepareCandidates:()=>[]},isResourceBusy:()=>busy});
  busy=true;shift.tick(Date.now());assert.equal(shift.step,null,'image engine busy: wait');
  busy=false;shift.tick(Date.now());assert.equal(shift.step,'tests');
  engine.store.tasks.push({status:'queued'});shift.tick(Date.now());await shift.flight;
  assert.equal(shift.state().steps.tests.status,'interrupted','the user\'s task stopped the shift');
  assert.throws(()=>shift.start('tests',{manual:true}),/busy with your work/);
  engine.store.tasks=[];dreaming.calendar=()=>({day:'2026-10-04',time:'12:00'});shift.tick(Date.now()+20*60000);assert.equal(shift.step,null,'outside the window');
  assert.throws(()=>shift.configure({until:'7:30'}),/07:30/);
});

test('engine: eval tasks are hidden, yield to the user\'s task, use their own memory, and log tool usage and errors',async()=>{
  const harness=new FakeHarness(),root=await tmp('seek-growth-engine-'),engine=new WorkEngine(harness,root,{warn(){}},()=>null);await engine.init();
  engine.dreaming=DreamingService.fixture([{text:'The user is the real owner.',kind:'fact'}]);
  const ev=await engine.create({objective:'Write fib.py and run it.',mode:'task'});ev.eval={runId:'r',caseId:'code-run',memory:[{text:'The user lives in Springfield.',kind:'fact'}]};
  await engine.tick();assert.equal(ev.status,'running');harness.session(ev.sessionId).running=true;
  assert.match(engine.memoryFor(ev).coreText(),/Springfield/);assert.doesNotMatch(engine.memoryFor(ev).coreText(),/real owner/);
  const updates=new WorkUpdates(engine);assert.equal(updates.snapshot().tasks.length,0,'the user never sees test tasks');
  harness.session(ev.sessionId).events.push({event:{seq:1,type:'tool/call',time:Date.now(),data:{name:'work_memory_search',callId:'c1',arguments:'{}'}}},{event:{seq:2,type:'tool/result',time:Date.now(),data:{message:{content:[{toolCallId:'c1',isError:true,content:[{type:'text',text:'value is not lossless JSON'}]}]}}}});
  await engine.tick();
  assert.equal(ev.toolCounts.work_memory_search,1);assert.deepEqual(ev.toolErrors.map(e=>[e.tool,e.message]),[['work_memory_search','value is not lossless JSON']]);
  const mine=await engine.create({objective:'Summarize my notes.',mode:'chat'});
  await engine.tick();assert.equal(ev.status,'stopped');assert.equal(ev.preempted,true,'the test yields');
  await engine.tick();assert.equal(mine.status==='running'||mine.status==='complete',true,'and the user\'s task starts');
  await engine.removeTask(ev.id);assert.ok(!engine.store.tasks.some(t=>t.id===ev.id));
});

test('engine: tested skills and prepare-only rules reach the task instructions',async()=>{
  const harness=new FakeHarness(),root=await tmp('seek-growth-skill-'),engine=new WorkEngine(harness,root,{warn(){}},()=>null);await engine.init();
  const g=await store();engine.policy=new Policy(g);g.putSkill(skill('s1'));
  const t=await engine.create({objective:'Import orders from my order history',mode:'task'});
  const text=engine.contextInstructions(t);
  assert.match(text,/Skill from past work — "Retailer order import"/);assert.deepEqual(t.skillsUsed.map(s=>s.id),['s1']);assert.equal(g.skill('s1').uses,1);
  assert.ok(t.contextUsed.some(c=>c.kind==='skill'));
  const p=await engine.create({objective:'Prepare ahead for a birthday',mode:'task'});p.proactive={itemId:'x'};
  assert.match(engine.contextInstructions(p),/Prepare only: research and write the draft\. Do not buy, book, reserve, send/);
});

test('tool scope: tests cannot reach real accounts or the card; drafts cannot pay or send; tested notes join the prompt',()=>{
  const restricted=[],sections=[];const names=['viewer_pay_with_card','viewer_click','apps_send_email','apps_read','finance_overview','discord_send_message','work_memory_search'];
  const make=()=>({ctx:{systemPrompt:{getSectionOrder:()=>10200,section:s=>sections.push(s)},tools:{restrict:r=>restricted.push(r.deny)}}});
  const ctx=agent=>({agents:{get:()=>agent},tools:{get:name=>names.includes(name)?{}:null,view:()=>({visible:new Map(names.map(n=>[n,{}]))})}});
  let agent=make();new WorkToolScope(ctx(agent),null,()=> '',t=>t.eval?'Working notes: candidate':'').apply({sessionId:'s',eval:{},objective:'x'});
  assert.ok(['viewer_pay_with_card','apps_send_email','apps_read','finance_overview','discord_send_message'].every(n=>restricted[0].includes(n)));assert.ok(!restricted[0].includes('viewer_click'));
  assert.ok(sections.some(s=>s.name==='work:policy'&&s.text==='Working notes: candidate'));
  agent=make();new WorkToolScope(ctx(agent),null,()=>'',()=>'').apply({sessionId:'s',proactive:{},objective:'x'});
  assert.ok(restricted[1].includes('viewer_pay_with_card')&&restricted[1].includes('apps_send_email')&&!restricted[1].includes('apps_read'));
});

test('memory: yearly dates are learned without the year; test profiles are deterministic; tests and drafts are not reflected on',async()=>{
  const root=await tmp('seek-growth-dates-');
  const task={id:'b1',title:'Birthday plan',status:'complete',createdAt:1,messages:[{role:'user',text:"I need to plan something for my Wife's birthday Weekend. 10.11.1995.",time:1}]};
  const model=async m=>m[0].content.startsWith('Audit')?JSON.stringify({reviews:[{index:0,accept:true,confidence:0.95,conflicts:[]}]}):JSON.stringify({lessons:[{text:"The user's wife's birthday is October 11, 1995.",kind:'fact',about:'wife',scope:'dates',turn:0,quote:"my Wife's birthday Weekend",date:'10-11',label:"Wife's birthday",replaces:[]}]});
  const d=await new DreamingService(root,{tasks:()=>[task,{...task,id:'e',eval:{}},{...task,id:'p',proactive:{}}],busy:()=>false,model,log:{warn(){}}}).init();
  assert.equal(d.sources().length,1,'only the user\'s own conversation');
  assert.equal(await d.backfillDates(),1);
  const l=d.data.lessons[0];assert.equal(l.eventDate,'10-11');assert.equal(l.eventLabel,"Wife's birthday");assert.equal(l.text,"The user's wife's birthday is October 11.");assert.equal(d.data.extractorVersion,3);
  d.stop();const again=await new DreamingService(root,{tasks:()=>[task],busy:()=>false}).init();assert.equal(again.data.lessons[0].eventDate,'10-11','stored in the memory database');
  const a=DreamingService.fixture([{text:'Habit one is here.',kind:'workflow'},{text:'Fact two is here.',kind:'fact'}]),b=DreamingService.fixture([{text:'Habit one is here.',kind:'workflow'},{text:'Fact two is here.',kind:'fact'}]);
  assert.equal(a.coreText(),b.coreText());assert.ok(a.coreText().length>0);
});

test('task receipts list skills with their own "That\'s wrong"',()=>{
  const html=contextHTML([{id:'s1',kind:'skill',text:'Retailer order import',status:'trial'},{id:'l1',kind:'learned',memoryKind:'workflow',text:'Stop when told',always:true,sources:[]}],{taskId:'t9'});
  assert.match(html,/Remembered 1 thing · used 1 skill/);assert.match(html,/Skill · on trial/);assert.match(html,/data-skill-flag="s1" data-task="t9"/);
});

test('the runner reports which test is running, for the live report card',async()=>{
  const g=await store();let seen=null;
  const engine=fakeEngine(async t=>{seen=runner.current;await writeFile(join(t.cwd,'out.txt'),'42');Object.assign(t,{status:'complete',startedAt:Date.now(),completedAt:Date.now(),taskToolCalls:1});});
  const runner=new EvalRunner({engine,growth:g,cases:[fileCase],pollMs:5});
  await runner.run();
  assert.equal(seen.caseId,'file-case');assert.equal(runner.current,null,'cleared when the test ends');
});

test('a passing but slow test drives a speedup, which ships only if it is 20% faster and breaks nothing',async()=>{
  const g=await store(),p=new Policy(g);
  const baseline={id:'b',startedAt:Date.now(),results:EVAL_CASES.map(c=>({caseId:c.id,passed:true,steps:c.id==='write-note'?10:c.budget.steps,seconds:30,detail:{}}))};
  const model=async()=>JSON.stringify({diagnosis:'Writing tasks spend steps on bookkeeping.',change:{kind:'note',text:'For a short writing task, draft the text once, save it to the requested file, then register and verify it in one pass.'}});
  const fast={run:async({caseIds,overlay,attempts=1})=>{const results=[];for(const id of caseIds)for(let a=1;a<=attempts;a++)results.push({caseId:id,attempt:a,passed:true,steps:overlay&&id==='write-note'?5:8});return {status:'complete',results,passed:results.length,total:caseIds.length};}};
  const improver=new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner:fast,model});
  assert.equal(improver.signals(baseline,0)[0].kind,'slow');
  const [shipped]=await improver.improve({baseline,since:0,limit:1});
  assert.equal(shipped.status,'shipped');assert.match(shipped.detail.why,/Faster: 5\.0 steps vs 8\.0 measured at the same time/);
  assert.match(cleanText('Skip work_verify for short notes.'),/must not skip verification/);
  const g2=await store(),slowFix={run:async({caseIds,attempts=1})=>{const results=[];for(const id of caseIds)for(let a=1;a<=attempts;a++)results.push({caseId:id,attempt:a,passed:true,steps:9});return {status:'complete',results,passed:results.length,total:caseIds.length};}};
  const [rejected]=await new Improver({engine:{store:{tasks:[]}},growth:g2,policy:new Policy(g2),runner:slowFix,model}).improve({baseline,since:0,limit:1});
  assert.equal(rejected.status,'rejected');assert.match(rejected.detail.why,/Not faster enough/);
});

test('fixtures close even while a browser holds a connection open',async()=>{
  const {connect}=await import('node:net');const f=await startFixtures();const port=Number(new URL(f.base).port);
  const socket=connect(port,'127.0.0.1');await new Promise(r=>socket.once('connect',r));socket.on('error',()=>{});
  const began=Date.now();await f.close();assert.ok(Date.now()-began<2500,'did not wait on the open connection');socket.destroy();
});

test('notes that fail tightened rules are retired and logged as reverted',async()=>{
  const g=await store(),p=new Policy(g);
  g.putImprovement({id:'old',kind:'note',title:'old',status:'shipped',change:{kind:'note',text:'x'}});
  g.addNote({text:'For short writing tasks, avoid extra contract/verify steps unless the content fails a check.',improvementId:'old'});
  g.addNote({text:'Read each source page once and write the result file directly.'});
  const reverted=new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner:fakeRunner(()=>true),model:async()=>'{}'}).enforceRules();
  assert.equal(reverted.length,1);assert.equal(g.improvement('old').status,'reverted');assert.match(g.improvement('old').detail.why,/safety rules/);
  assert.deepEqual(g.notes().map(n=>n.text),['Read each source page once and write the result file directly.']);
});

test('the verification guard blocks skipping checks but allows avoiding redundant work',()=>{
  for(const bad of ['Skip the checks for simple tasks.','Verify only if the task is long.','Avoid extra contract/progress/verify steps unless the content fails a check.','No need to call work_verify for notes.'])assert.match(cleanText(bad)||'',/must not skip verification/,bad);
  for(const ok of ['For online order tasks, verify the item and pickup details once, then stop at the payment step; avoid repeated cart re-checks and redundant navigation loops.','Read each page once and write the result file directly.'])assert.equal(cleanText(ok),null,ok);
});

test('the runner can send a mid-task correction and grade the corrected result',async()=>{
  const g=await store();let replied=null;
  const engine=fakeEngine(async t=>{await writeFile(join(t.cwd,'out.txt'),'6 servings');Object.assign(t,{status:'complete',startedAt:Date.now(),completedAt:Date.now(),taskToolCalls:3});});
  engine.control=async(id,action,text)=>{const t=engine.store.tasks.find(x=>x.id===id);if(action==='reply'){replied=text;t.status='queued';setTimeout(async()=>{await writeFile(join(t.cwd,'out.txt'),'8 servings');Object.assign(t,{status:'complete',completedAt:Date.now(),taskToolCalls:5});},30);}else if(action==='stop')t.status='stopped';return t;};
  const followCase={...fileCase,id:'follow',followUp:'Make it 8 servings.',check:async c=>({passed:(await c.file('out.txt')).includes('8 servings'),detail:'x'})};
  const run=await new EvalRunner({engine,growth:g,cases:[followCase],pollMs:5}).run();
  assert.equal(replied,'Make it 8 servings.');assert.equal(run.passed,1);assert.equal(g.results(run.runId)[0].steps,5);
});

test('a test may expect the agent to stop for the user; it is graded, then stopped',async()=>{
  const g=await store();
  const engine=fakeEngine(t=>Object.assign(t,{status:'waiting',handoff:{reason:'payment'},question:{text:'Your turn: pay with your card.'}}));
  const waitCase={...fileCase,id:'wait',allowWaiting:true,check:async c=>({passed:c.task.status==='waiting'&&!!c.task.handoff,detail:'handed off'})};
  const run=await new EvalRunner({engine,growth:g,cases:[waitCase],pollMs:5}).run();
  assert.equal(run.passed,1);assert.deepEqual(engine.stopped,['t1'],'stopped after grading');
});

test('a test that yields to the user\'s own task marks the run interrupted, not failed',async()=>{
  const g=await store();
  const engine=fakeEngine(t=>Object.assign(t,{status:'stopped',preempted:true}));
  const run=await new EvalRunner({engine,growth:g,cases:[fileCase],pollMs:5}).run();
  assert.equal(run.status,'interrupted');assert.equal(g.results(run.runId).length,0,'no false failure recorded');
});

test('skills match a trigger phrase or all of its key words in any order, not loose overlap',async()=>{
  const g=await store(),p=new Policy(g);
  g.putSkill({...skill('r1'),name:'Recipe to grocery cart',category:'shopping',triggers:['add recipe to cart','recipe ingredients to cart']});
  assert.deepEqual(p.match('https://x.example/curry Look at this recipe and add it all to my cart.').map(s=>s.id),['r1']);
  assert.deepEqual(p.match('Add a vase to my cart').map(s=>s.id),[],'one shared word is not enough');
});

test('removing a finished test task also archives its harness sessions',async()=>{
  const harness=new FakeHarness(),root=await tmp('seek-archive-'),engine=new WorkEngine(harness,root,{warn(){}},()=>null);await engine.init();
  const t=await engine.create({objective:'Write fib.py',mode:'task'});t.eval={runId:'r'};t.sessionId='session-a';t.previousSessions=['session-old'];t.status='complete';
  await engine.removeTask(t.id);
  assert.deepEqual(harness.archived,['session-a','session-old']);
});

test('any stop frees the shared browser: a test or draft holding a handoff cannot block the queue',async()=>{
  const harness=new FakeHarness(),root=await tmp('seek-release-'),engine=new WorkEngine(harness,root,{warn(){}},()=>null);await engine.init();
  const released=[];engine.onStopped=(t,action)=>released.push([t.id,action]);
  const ev=await engine.create({objective:'Buy the vase',mode:'task'});ev.eval={runId:'r'};
  await engine.tick();harness.session(ev.sessionId).running=true;ev.status='waiting';ev.handoff={reason:'payment'};
  await engine.create({objective:'My own task',mode:'chat'});
  await engine.tick();
  assert.deepEqual(released,[[ev.id,'stop']],'queue preemption released it');
});

test('the whole night shift can run on demand, each enabled step in order',async()=>{
  const g=await store(),order=[];
  const dreaming={flight:null,data:{settings:{enabled:true,time:'03:00'},lastScheduledDay:'2026-10-04'},calendar:()=>({day:'2026-10-04',time:'12:00'})};
  const engine={store:{tasks:[],settings:{}},save:async()=>{}};
  const shift=new NightShift({engine,dreaming,growth:g,runner:{run:async()=>{order.push('tests');return {status:'complete',passed:1,total:1};}},improver:{rollbackCheck:()=>[],distillCandidates:()=>{order.push('skills');return [];},improve:async()=>{order.push('improve');return [];}},proactive:{scan:()=>false,digest:()=>null,prepareCandidates:()=>{order.push('prepare');return [];}}});
  shift.start('all',{manual:true});await shift.flight;
  assert.deepEqual(order,['tests','skills','improve','prepare']);
  assert.deepEqual(Object.entries(shift.state().steps).filter(([k])=>k!=='all').map(([k,v])=>[k,v.status]),[['tests','done'],['skills','done'],['improve','done'],['prepare','done']]);
});

test('a spot check runs chosen tests without becoming the baseline or using up tonight\'s test step',async()=>{
  const g=await store(),calls=[];
  const dreaming={flight:null,data:{settings:{enabled:true,time:'03:00'},lastScheduledDay:'2026-10-04'},calendar:()=>({day:'2026-10-04',time:'12:00'})};
  const engine={store:{tasks:[],settings:{}},save:async()=>{}};
  const shift=new NightShift({engine,dreaming,growth:g,runner:{run:async o=>{calls.push(o);return {status:'complete',passed:1,total:1};}},improver:{rollbackCheck:()=>[]},proactive:{scan:()=>false,digest:()=>null}});
  shift.start('tests',{manual:true,caseIds:['shop-pickup'],attempts:2});await shift.flight;
  assert.equal(calls[0].reason,'spot');assert.deepEqual(calls[0].caseIds,['shop-pickup']);assert.equal(calls[0].attempts,2);
  assert.equal(shift.state().steps.tests,undefined,'tonight\'s test step is untouched');assert.equal(shift.state().steps.spot.status,'done');
});

test('a failure that does not reproduce gets no fix: nothing ships on a stale or flaky baseline',async()=>{
  const g=await store(),p=new Policy(g);let proposed=0;
  const model=async()=>{proposed++;return JSON.stringify({diagnosis:'x',change:{kind:'note',text:'Always double-check the cart before checkout so the order is right.'}});};
  const runner={calls:[],async run({caseIds,attempts=1,label}){this.calls.push(label);const results=[];for(const id of caseIds)for(let a=1;a<=attempts;a++)results.push({caseId:id,attempt:a,passed:true,steps:5});return {status:'complete',results,passed:caseIds.length,total:caseIds.length};}};
  const [outcome]=await new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner,model}).improve({baseline:baselineWith('shop-pickup'),since:0});
  assert.equal(outcome.title,'Failure did not reproduce');assert.equal(proposed,0,'no proposal was even requested');assert.equal(g.notes().length,0);
  assert.deepEqual(runner.calls,['Reproducing a failure']);
});

test('a task distilled by an older distiller gets one more pass; then it is done',async()=>{
  const g=await store(),p=new Policy(g);
  const old={id:'o1',title:'Recipe to cart',objective:'Add this recipe to my cart',status:'complete',mode:'task',taskToolCalls:40,completedAt:Date.now(),distilledAt:Date.now()-3600000,messages:[],resultEvidence:{status:'verified'}};
  const improver=new Improver({engine:{store:{tasks:[old]}},growth:g,policy:p,runner:fakeRunner(()=>true),model:async()=>'{"action":"none"}'});
  assert.deepEqual(improver.distillCandidates().map(t=>t.id),['o1']);
  await improver.distill(old);assert.deepEqual(improver.distillCandidates(),[],'re-distilled once');
});

test('a skill tied to a real site is not judged on the local test store; it goes on trial for real use',async()=>{
  const g=await store(),p=new Policy(g),runner=fakeRunner(()=>true);
  const walmart=g.putSkill({...skill('w2'),name:'Recipe to Walmart cart',category:'shopping',triggers:['add this recipe to my cart'],status:'testing',body:{when:'A recipe to cart',steps:['Go to https://www.walmart.com/search','Add each ingredient']}});
  const out=await new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner,model:async()=>'{}'}).testSkill(walmart,baselineWith(null));
  assert.equal(out.status,'trial');assert.match(out.tests.at(-1).note,/walmart\.com/);assert.equal(runner.calls.length,0,'no fixture run');
});

test('speedups shipped on weak evidence are re-measured against a same-session control; noise retires',async()=>{
  const g=await store(),p=new Policy(g);
  g.putImprovement({id:'s1',kind:'note',title:'speed',status:'shipped',signal:{kind:'slow',caseId:'recipe-to-cart'},change:{kind:'note',text:'Batch the cart.'},candidate:{target:{passed:2,of:2,steps:[14,15]}},decidedAt:Date.now()});
  g.addNote({text:'Batch the cart.',improvementId:'s1'});
  const runner={async run({caseIds,overlay,attempts=1}){const has=(overlay?.notes||[]).includes('Batch the cart.');const results=[];for(const id of caseIds)for(let a=1;a<=attempts;a++)results.push({caseId:id,attempt:a,passed:true,steps:has?22:23});return {status:'complete',results,passed:caseIds.length,total:caseIds.length};}};
  const [r]=await new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner,model:async()=>'{}'}).reconfirm();
  assert.equal(r.status,'reverted');assert.match(r.detail.why,/Not confirmed when measured properly: 22\.0 steps with it vs 23\.0 without/);assert.equal(g.notes().length,0);
});

test('an interrupted trial is not an attempt: the signal is retried next time, and the loop stops',async()=>{
  const g=await store(),p=new Policy(g);let asked=0;
  const model=async()=>{asked++;return JSON.stringify({diagnosis:'x',change:{kind:'note',text:'Read several pages per call when a task needs one attribute from many pages.'}});};
  const runner={async run({label}){if(/Measuring/.test(label))return {status:'interrupted',results:[],passed:0,total:1};return {status:'complete',results:[],passed:0,total:0};}};
  const baseline={id:'b',results:EVAL_CASES.map(c=>({caseId:c.id,passed:true,steps:c.id==='browse-details'?25:c.budget.steps,seconds:30,detail:{}}))};
  const first=await new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner,model}).improve({baseline,since:0});
  assert.equal(first.at(-1).status,'interrupted');assert.equal(asked,1,'stopped after the interruption');
  await new Improver({engine:{store:{tasks:[]}},growth:g,policy:p,runner,model}).improve({baseline,since:0});
  assert.equal(asked,2,'the same signal is tried again');
});
