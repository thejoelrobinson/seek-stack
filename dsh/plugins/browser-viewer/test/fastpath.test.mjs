import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {namedDeliverables,taskContract,verifyOutcome} from '../lib/work-outcomes.js';
import {WorkEngine} from '../lib/work-server.js';
import {FakeHarness} from './fake-harness.mjs';

test('files a request names are its deliverables; attached inputs and framework names are not',()=>{
  assert.deepEqual(namedDeliverables('Find the 5 cheapest items and save them to cheapest-items.md as a table.'),['cheapest-items.md']);
  assert.deepEqual(namedDeliverables('Write fib.py that prints F(30). Run it and save the output to fib.txt.'),['fib.py','fib.txt']);
  assert.deepEqual(namedDeliverables('Using the attached orders.csv, save the total to september-total.txt.'),['september-total.txt']);
  assert.deepEqual(namedDeliverables('Total expenses.csv and save it to totals.json.',['1-expenses.csv']),['totals.json']);
  assert.deepEqual(namedDeliverables('Build a next.js app'),[]);assert.deepEqual(namedDeliverables('Summarize report.pdf for me'),[]);
  assert.deepEqual(namedDeliverables('Open http://example.com/page.html and tell me the title'),[]);
  const c=taskContract('Save the count to count.txt');assert.equal(c.kind,'artifact');assert.deepEqual(c.deliverables,['count.txt']);
});

test('verification records a named deliverable it finds, so no registration call is needed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'seek-fast-'));await writeFile(join(root,'count.txt'),'8');
  const task={id:'t',objective:'Save just the number to count.txt',contract:taskContract('Save just the number to count.txt'),artifacts:[],result:'8'};
  const file=async(_t,p)=>({full:join(root,p),path:p});
  const register=async(t,p)=>{const a={id:'a1',path:p,title:p};t.artifacts.push(a);return a;};
  const evidence=await verifyOutcome(task,{file,register});
  assert.equal(evidence.status,'verified',JSON.stringify(evidence.checks));
  assert.ok(evidence.checks.some(c=>c.label==='Requested deliverable exists'&&c.ok));
});

test('a task that asked for a file but named none gets its new result documents recorded, not scripts or inputs',async()=>{
  const harness=new FakeHarness(),root=await mkdtemp(join(tmpdir(),'seek-fast-engine-')),engine=new WorkEngine(harness,root,{warn(){}},()=>null);await engine.init();
  const t=await engine.create({objective:'Create a report file about my week',mode:'task',files:[{name:'notes.md',data:Buffer.from('input').toString('base64')}]});
  t.startedAt=Date.now()-5000;
  await writeFile(join(t.cwd,'week-report.md'),'# My week');await writeFile(join(t.cwd,'helper.py'),'print(1)');
  const old=join(t.cwd,'stale.md');await writeFile(old,'old');const past=new Date(Date.now()-3600000);await utimes(old,past,past);
  const recorded=await engine.collectResultFiles(t);
  assert.deepEqual(recorded.map(a=>a.originalPath||a.path),['week-report.md']);
  assert.equal(t.contract.kind,'artifact');
});

test('instructions ask for one finish call instead of contract, artifact, verify and goal bookkeeping',async()=>{
  const harness=new FakeHarness(),root=await mkdtemp(join(tmpdir(),'seek-fast-instr-')),engine=new WorkEngine(harness,root,{warn(){}},()=>null);await engine.init();
  const t=await engine.create({objective:'Write a note to note.md',mode:'task'});
  const text=engine.instructions(t);
  assert.match(text,/call work_finish once/);assert.match(text,/do not need work_contract or work_artifact/);assert.doesNotMatch(text,/call work_verify before/);
  assert.doesNotMatch(text,/When you finish, or when you propose/,'Seek writes the follow-up suggestions itself');
  assert.deepEqual(t.contract.deliverables,['note.md']);
  const s=harness.add('s1',{goal:{id:'g',revision:3,phase:'active'}});await harness.completeGoal('s1',{id:'g',revision:3});assert.equal(s.goal.phase,'complete');
});

test('reassigning a tracked list (list=list.filter(...)) never stacks proxy layers',async()=>{
  const {WorkDatabase}=await import('../lib/work-database.js');
  const root=await mkdtemp(join(tmpdir(),'seek-layers-'));const db=new WorkDatabase(root);
  const store=await db.load({version:1,settings:{},tasks:[]});
  store.headsUp=[{id:'a',title:'Birthday',actions:[{label:'Open'}]},{id:'b',title:'Pickup',actions:[]}];
  for(let i=0;i<500;i++)store.headsUp=store.headsUp.filter(x=>x.id);
  const item=store.headsUp[0];assert.equal(store.headsUp[0],item,'the same proxy every read');
  const began=performance.now();for(let i=0;i<200;i++)JSON.stringify(store);
  assert.ok(performance.now()-began<500,`200 serializations took ${Math.round(performance.now()-began)}ms`);
  assert.equal(JSON.parse(JSON.stringify(store)).headsUp[0].actions[0].label,'Open');
  await db.close();
});

test('a tool call the model wrote as text is removed from the message; a leaked suggestion still becomes buttons',async()=>{
  const {stripLeakedToolCalls}=await import('../lib/work-server.js');
  const raw='Done. I saved the draft to reply.md.\n<work_suggest> <parameter name="suggestions">[{"label":"Send this reply","request":"Send the drafted reply to Dana."},{"label":"Adjust the times","request":"Offer different times."}]</parameter> </work_suggest>';
  const out=stripLeakedToolCalls(raw);
  assert.equal(out.text,'Done. I saved the draft to reply.md.');assert.deepEqual(out.suggestions.map(s=>s.label),['Send this reply','Adjust the times']);
  assert.deepEqual(stripLeakedToolCalls('Plain answer with <b>html</b>.'),{text:'Plain answer with <b>html</b>.',suggestions:null});
  const harness=new FakeHarness(),root=await mkdtemp(join(tmpdir(),'seek-leak-')),engine=new WorkEngine(harness,root,{warn(){}},()=>null);await engine.init();
  const t=await engine.create({objective:'Draft a reply',mode:'chat'});await engine.tick();
  harness.session(t.sessionId).events.push({event:{seq:1,type:'assistant/message',time:Date.now(),data:{message:{content:[{type:'text',text:raw}]}}}});
  await engine.tick();
  assert.equal(t.messages.at(-1).text,'Done. I saved the draft to reply.md.');assert.equal(t.suggestions.length,2);
});

test('no source file carries stray control characters (a mangled \b in a regex becomes a backspace)',async()=>{
  const {readdir,readFile}=await import('node:fs/promises');const dir=new URL('../lib/',import.meta.url);
  for(const name of (await readdir(dir)).filter(n=>/\.(js|css|html)$/.test(n))){
    const text=await readFile(new URL(name,dir),'utf8'),bad=[...text].filter(c=>{const n=c.charCodeAt(0);return n<32&&n!==9&&n!==10&&n!==13;});
    assert.equal(bad.length,0,`${name} has ${bad.length} control characters`);
  }
});
