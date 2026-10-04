import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DreamingService} from '../lib/work-dreaming.js';
import {WorkEngine} from '../lib/work-server.js';
import {FakeHarness} from './fake-harness.mjs';

const task=(id,messages,extra={})=>({id,title:'Order a card',status:'complete',createdAt:1,messages,...extra});
const card=task('t1',[
  {role:'user',text:'Order a congratulations card for my co-worker.',time:1},
  {role:'assistant',text:'I added a ship-only card to the cart.',time:2},
  {role:'user',text:'Approved "Add to cart" once.',time:3},
  {role:'user',text:"On the card, can you pick one that's in-store rather than delivery?",time:4},
  {role:'assistant',text:'Checking fulfillment options on the product page.',time:5},
  {role:'user',text:'Just stop.',time:6}
]);

test('reflection reviews whole tasks: each user turn carries the agent message it answered, button noise is dropped',async()=>{
  const dreaming=await new DreamingService(await mkdtemp(join(tmpdir(),'seek-reflect-')),{tasks:()=>[card,task('t2',[{role:'user',text:'hi',time:1}]),task('t3',[],{status:'running',objective:'Busy work in progress'})],busy:()=>false}).init();
  const [source,...rest]=dreaming.sources();
  assert.equal(rest.length,0,'greeting-only and unfinished tasks are not sources');
  assert.deepEqual(source.turns.map(t=>t.user),['Order a congratulations card for my co-worker.',"On the card, can you pick one that's in-store rather than delivery?",'Just stop.']);
  assert.equal(source.turns[1].agentBefore,'I added a ship-only card to the cart.');
  card.messages.push({role:'user',text:'You can close the task, I completed it myself.',time:7});
  assert.notEqual(dreaming.sources()[0].id,source.id,'a new reply makes the task reviewable again');
  card.messages.pop();
});

test('reflection keeps quote-verified lessons: workflows go live, facts and preferences wait for review; {} means nothing',async()=>{
  const calls=[];
  const model=async messages=>{
    calls.push(messages);const input=JSON.parse(messages.at(-1).content);
    if(messages[0].content.startsWith('Audit'))return JSON.stringify({reviews:input.candidates.map((c,index)=>({index,accept:true,confidence:0.95,conflicts:[]}))});
    if(input.title!=='Order a card')return '{}';
    return JSON.stringify({lessons:[
      {text:'The user expects the agent to halt immediately when told to stop.',kind:'workflow',scope:'interruptions',turn:2,quote:'Just stop.',replaces:[]},
      {text:'The user wants cards bought from the store.',kind:'preference',scope:'cards',turn:1,quote:'pick',replaces:[]},
      {text:'The user prefers in-store pickup over delivery for physical items.',kind:'preference',scope:'fulfillment',turn:1,quote:"pick one that's in-store rather than delivery",replaces:[]},
      {text:'The user has a co-worker who just got a new job.',kind:'fact',scope:'people',turn:0,quote:'congratulations card for my co-worker',replaces:[]},
      {text:'The agent added a ship-only card to the cart.',kind:'fact',scope:'cart',turn:1,quote:'I added a ship-only card',replaces:[]}
    ]});
  };
  const other=task('t4',[{role:'user',text:'What is the weather in town today?',time:9}],{title:'Weather'});
  const dreaming=await new DreamingService(await mkdtemp(join(tmpdir(),'seek-reflect-')),{tasks:()=>[card,other],busy:()=>false,model,log:{warn(){}}}).init();
  await dreaming.run('manual',new AbortController().signal);
  const run=dreaming.data.runs[0];
  assert.equal(run.status,'complete',run.error);
  assert.equal(run.reviewed,2);
  const byKind=Object.fromEntries(dreaming.data.lessons.map(l=>[l.kind,l]));
  assert.equal(dreaming.data.lessons.length,3,'a too-short partial quote and an agent-only quote are rejected; a whole short message is fine');
  assert.equal(byKind.workflow.status,'active');
  assert.equal(byKind.preference.status,'review');
  assert.equal(byKind.fact.status,'review');
  assert.equal(byKind.fact.sources[0].quote,'congratulations card for my co-worker');
  assert.equal(run.rejected,2);
  assert.equal(calls.filter(m=>!m[0].content.startsWith('Audit')).length,2,'one extraction call per task, and {} is not retried');
  assert.equal(dreaming.status().pending,0);
});

test('a suggestion flag left by a restart no longer keeps Work busy forever',async()=>{
  const root=await mkdtemp(join(tmpdir(),'seek-suggest-'));
  const first=new WorkEngine(new FakeHarness(),root,{warn(){}},()=>null);await first.init();
  const t=await first.create({objective:'Summarize the notes.',mode:'chat'});t.status='complete';t.suggesting=true;await first.save();
  const second=new WorkEngine(new FakeHarness(),root,{warn(){}},()=>null);await second.init();
  assert.equal(second.store.tasks.find(x=>x.id===t.id).suggesting,false);
});
