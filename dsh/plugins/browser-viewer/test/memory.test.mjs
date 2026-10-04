import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DreamingService} from '../lib/work-dreaming.js';
import {WorkToolScope} from '../lib/work-tool-scope.js';
import {contextHTML} from '../lib/work-product.js';

const lesson=(id,text,kind,extra={})=>({id,key:id,text,kind,scope:'',status:'active',confirmedAt:1,createdAt:Number(id.replace(/\D/g,''))||1,updatedAt:1,sources:[{id:'s'+id,taskId:'t1',title:'Birthday plan',quote:text.slice(-20)}],project:null,person:'owner',...extra});
const tasks=[{id:'t1',title:'Birthday plan',status:'complete',messages:[]}];
async function service(lessons=[],options={}){
  const root=await mkdtemp(join(tmpdir(),'seek-mem-'));
  if(lessons.length)await writeFile(join(root,'dreaming.json'),JSON.stringify({version:1,settings:{enabled:true,time:'03:00',timezone:'America/Chicago'},lessons,processed:{},forgotten:[],runs:[],lastScheduledDay:null,retryAt:0}));
  return {root,dreaming:await new DreamingService(root,{busy:()=>false,log:{warn(){}},...options,tasks:()=>options.tasks||tasks}).init()};
}
const seed=()=>[
  lesson('l1','The user wants the agent to stop immediately when told to stop.','workflow'),
  lesson('l2',"The user's wife loves massages.",'fact'),
  lesson('l3','The user is located in Northwest Arkansas.','fact'),
  lesson('l4','The user prefers in-store pickup over delivery.','preference')
];

test('JSON lessons move into the memory database once, with dossiers inferred from who they are about',async()=>{
  const {root,dreaming}=await service(seed());
  await access(join(root,'memory.sqlite'));await access(join(root,'dreaming.pre-memory-db.json'));
  assert.deepEqual(JSON.parse(await readFile(join(root,'dreaming.json'),'utf8')).lessons,[]);
  const byId=Object.fromEntries(dreaming.data.lessons.map(l=>[l.id,l]));
  assert.equal(byId.l1.entity,null);assert.equal(byId.l2.entity,'wife');assert.equal(byId.l3.entity,'self');assert.equal(byId.l4.entity,'self');
  assert.ok(dreaming.entities.get('wife').aliases.includes('date night'));
  dreaming.stop();
  const again=await new DreamingService(root,{tasks:()=>tasks,busy:()=>false}).init();
  assert.equal(again.data.lessons.length,4,'the database is the source of truth after the move');
  assert.equal(again.store.events({limit:10}).filter(e=>e.action==='imported').length,4);
});

test('people are recalled by the words that mean them; habits and facts about the user are always on and stable',async()=>{
  const {dreaming}=await service(seed());
  assert.deepEqual(dreaming.recall('Plan a date night for Saturday').map(l=>l.id),['l2'],'"date night" recalls the wife dossier with no shared words');
  assert.deepEqual(dreaming.recall('Order printer paper').map(l=>l.id).filter(id=>id==='l2'),[]);
  assert.deepEqual(dreaming.core().map(l=>l.id),['l1','l3','l4'],'habits first, then facts about the user, in creation order');
  const text=dreaming.coreText();assert.match(text,/stop immediately/);assert.doesNotMatch(text,/massages/);
  dreaming.data.lessons.find(l=>l.id==='l3').useCount=99;assert.equal(dreaming.coreText(),text,'use counts never reorder the cached block');
  assert.ok(!dreaming.recall('stop pickup Arkansas',{excludeCore:true}).length,'per-task recall does not repeat the always-on block');
  const used=dreaming.used('date night ideas',{});assert.deepEqual(used.map(u=>[u.id,!!u.always]),[['l1',true],['l3',true],['l4',true],['l2',false]]);
});

test('use is counted once per task and logged; forgetting removes the words from history too',async()=>{
  const {dreaming}=await service(seed());
  await dreaming.markUsed(['l2','l2'],'task-a');await dreaming.markUsed(['l2'],'task-a');await dreaming.markUsed(['l2'],'task-b');
  const wife=dreaming.data.lessons.find(l=>l.id==='l2');assert.equal(wife.useCount,2);assert.ok(wife.lastUsedAt);
  assert.equal(dreaming.store.events({lessonId:'l2'}).filter(e=>e.action==='used').length,2);
  await dreaming.manage({id:'l2',action:'forget'});
  const events=dreaming.store.events({lessonId:'l2'});
  assert.ok(events.some(e=>e.action==='forgotten'));assert.ok(events.every(e=>!e.text),'no event keeps the forgotten words');
  assert.ok(!dreaming.store.search('massages').length,'nor does the search index');
});

test('remember and forget from chat: explicit requests apply, others wait; forget pauses the best match',async()=>{
  const {dreaming}=await service(seed());
  const task={id:'t1',title:'Chat',messages:[{role:'user',text:'Remember that I like window seats.'}]};
  const told=await dreaming.remember({text:'The user likes window seats on flights.',kind:'preference',about:'self',task,explicit:true});
  assert.equal(told.status,'active');assert.equal(told.origin,'told');assert.equal(told.sources[0].quote,'Remember that I like window seats.');
  const hinted=await dreaming.remember({text:'The user enjoys long road trips.',kind:'preference',task,explicit:false});assert.equal(hinted.status,'review','a page cannot make the agent store something unasked');
  assert.equal((await dreaming.remember({text:'The user likes window seats on flights!',kind:'preference',task,explicit:true})).id,told.id,'duplicates are not stored twice');
  assert.equal((await dreaming.forgetMatching({query:'massages for my wife',task,explicit:false})).proposed,true);
  const paused=await dreaming.forgetMatching({query:'my wife and massages',task,explicit:true});
  assert.equal(paused.id,'l2');assert.equal(paused.status,'paused');
  assert.ok(!dreaming.recall('date night').some(l=>l.id==='l2'));
});

test('lookup answers "what do you know about my wife", time-limited facts expire, export and search cover everything',async()=>{
  const {dreaming}=await service([...seed(),lesson('l5',"The user's wife is busy Friday afternoons this month.",'fact',{expiresAt:Date.now()-1000})]);
  const answer=dreaming.lookup('What do you know about my wife?');
  assert.deepEqual(answer.dossiers,[{about:'Wife',facts:["The user's wife loves massages."],awaitingConfirmation:[]}],'expired facts are left out');
  assert.equal(dreaming.status().counts.expired,1);
  assert.ok(dreaming.searchIds('massage').includes('l2'),'stemmed full-text search');
  assert.ok(dreaming.searchIds('wife').includes('l2'),'people by name');
  const md=dreaming.exportMarkdown();
  assert.match(md,/## About you\n/);assert.match(md,/## Wife\n\n- The user's wife loves massages\./);assert.match(md,/## How I work/);assert.match(md,/> “/);
  await dreaming.manage({action:'alias',id:'wife',name:'Sarah',aliases:['wife','sarah','anniversary']});
  assert.deepEqual(dreaming.recall('anniversary dinner').map(l=>l.id),['l2']);assert.equal(dreaming.lookup('sarah').dossiers[0].about,'Sarah');
  await dreaming.manage({action:'add',text:'The user is allergic to nothing.',kind:'fact',about:'self'});
  assert.equal(dreaming.data.lessons.at(-1).origin,'manual');assert.equal(dreaming.data.lessons.at(-1).status,'active');
});

test('a finished task is learned from immediately and the facts it yields wait for review',async()=>{
  const finished={id:'tx',title:'Card order',status:'complete',createdAt:1,messages:[{role:'user',text:'Get a card for my sister, she loves sunflowers.',time:1}]};
  const model=async messages=>messages[0].content.startsWith('Audit')?JSON.stringify({reviews:[{index:0,accept:true,confidence:0.95,conflicts:[]}]}):JSON.stringify({lessons:[{text:"The user's sister loves sunflowers.",kind:'fact',about:'sister',scope:'gifts',turn:0,quote:'she loves sunflowers',expires:null,replaces:[]}]});
  const {dreaming}=await service([],{tasks:[finished],model});
  const learned=await dreaming.learnNow(finished);
  assert.equal(learned.length,1);assert.equal(learned[0].status,'review');assert.equal(learned[0].entity,'sister');
  assert.equal(dreaming.data.runs.length,0,'live learning does not clutter the nightly journal');
  assert.equal(dreaming.status().pending,0);
  assert.deepEqual(await dreaming.learnNow(finished),[],'a task is only learned from once');
});

test('task receipts show what was noted (with undo) and each remembered note has a "That’s wrong" button',()=>{
  const html=contextHTML([{id:'l1',text:'Stop when told',kind:'learned',memoryKind:'workflow',always:true,sources:[]},{id:'l2',text:'Wife loves massages',kind:'learned',memoryKind:'fact',about:'Wife',sources:[{taskId:'t1',title:'Birthday plan'}]}],{taskId:'task-9',learned:[{id:'n1',text:'Stop means stop',status:'active',action:'learned'},{id:'n2',text:'Sister loves sunflowers',status:'review',action:'learned'},{id:'n3',text:'Old note',status:'paused',action:'forgotten'}]});
  assert.match(html,/Remembered 2 things/);assert.match(html,/always on/);assert.match(html,/Fact · Wife/);
  assert.match(html,/data-memory-flag="l2" data-task="task-9"/);
  assert.match(html,/Noted<\/span> Stop means stop <button type="button" data-memory-undo="n1" data-memory-action="forget">Undo/);
  assert.match(html,/Saved for your OK/);assert.match(html,/Forgot<\/span> Old note <button type="button" data-memory-undo="n3" data-memory-action="accept">/);
  assert.equal(contextHTML([],{learned:[]}),'');
});

test('the always-on block is an agent-scoped system prompt section placed after the persona suffix',()=>{
  const sections=[];const agent={ctx:{systemPrompt:{getSectionOrder:()=>10200,section:s=>sections.push(s)},tools:{restrict(){}}}};
  const scope=new WorkToolScope({agents:{get:()=>agent},tools:{get:()=>null,view:()=>({visible:new Map()})}},null,()=>'What you have learned...\n- habit');
  scope.apply({sessionId:'s'});
  assert.deepEqual(sections.map(s=>[s.name,s.order,s.text]),[['deployment:persona-suffix',10200,''],['work:memory',10250,'What you have learned...\n- habit']]);
  assert.equal(sections[1].interpolate,false);
});

test('a broad question returns the whole picture: habits, confirmed facts, and notes awaiting confirmation',async()=>{
  const {dreaming}=await service([...seed(),lesson('l6',"The user's wife enjoys escape rooms.",'fact',{status:'review',confirmedAt:null})]);
  const all=dreaming.lookup('What do you know about me?',{project:null,person:'owner'});
  assert.ok(all.notes.some(n=>/stop immediately/.test(n.note)),'working habits count as knowing the user');
  const wife=all.dossiers.find(d=>d.about==='Wife');assert.deepEqual(wife.awaitingConfirmation,["The user's wife enjoys escape rooms."]);assert.deepEqual(wife.facts,["The user's wife loves massages."]);
  assert.match(all.summary,/4 confirmed notes in use; 1 learned note awaiting/);
  assert.ok(!dreaming.recall('escape rooms').length,'unconfirmed notes are never recalled into tasks');
});

test('memory tool results are lossless JSON (the harness rejects undefined values)',async()=>{
  const {dreaming}=await service(seed());
  for(const q of ['What do you know about me?','stop','my wife','nothing matches this'])
    {const out=dreaming.lookup(q,{project:null,person:'owner'});assert.deepEqual(JSON.parse(JSON.stringify(out)),out,q);}
  const notes=dreaming.recall('stop pickup');assert.deepEqual(JSON.parse(JSON.stringify(notes)),notes);
});

test('forgetting a note blocks it and its rewordings, not the rest of that conversation',async()=>{
  const chat={id:'c1',title:'Birthday plan',status:'complete',createdAt:1,messages:[{role:'user',text:"Plan my wife's birthday. She loves massages and escape rooms.",time:1}]};
  let proposals=[{text:"The user's wife loves massages.",kind:'fact',about:'wife',scope:'gifts',turn:0,quote:'She loves massages',replaces:[]}];
  const model=async m=>m[0].content.startsWith('Audit')?JSON.stringify({reviews:proposals.map((_,index)=>({index,accept:true,confidence:0.95,conflicts:[]}))}):JSON.stringify({lessons:proposals});
  const {dreaming}=await service([],{tasks:[chat],model});
  await dreaming.run('manual',new AbortController().signal);
  const massage=dreaming.data.lessons[0];await dreaming.manage({id:massage.id,action:'forget'});
  chat.messages.push({role:'user',text:'Also she is a big fan of escape rooms.',time:2});
  proposals=[{text:"The user's wife really loves massages.",kind:'fact',about:'wife',scope:'gifts',turn:0,quote:'She loves massages',replaces:[]},{text:"The user's wife enjoys escape rooms.",kind:'fact',about:'wife',scope:'gifts',turn:1,quote:'big fan of escape rooms',replaces:[]}];
  await dreaming.run('manual',new AbortController().signal);
  assert.deepEqual(dreaming.data.lessons.map(l=>l.text),["The user's wife enjoys escape rooms."]);
  assert.ok(!JSON.stringify(dreaming.data.forgottenSigs).includes('massage'),'fingerprints keep no words');
});
