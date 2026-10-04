import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryItems,libraryHTML,taskSummary,contextHTML,memoryScopeLabel,templateObjective,templateForm,BUILTIN_TEMPLATES,financeDebtHTML,approvalDetails,wallTimeToUTC} from '../lib/work-product.js';

test('Library preserves source, versions and trusted artifact links while filtering and paging',()=>{
 const tasks=[{id:'one',title:'Research topic',artifacts:Array.from({length:130},(_,i)=>({id:'file-'+i,title:i===0?'<script>bad</script>.pdf':'Report '+i+'.md',type:i===0?'pdf':'md',at:i,version:i+1,bytes:2048}))},{id:'two',title:'Other project',artifacts:[{id:'other',title:'Budget.csv',type:'csv'}]}];
 assert.equal(libraryItems(tasks,{query:'Research topic',type:'md'}).length,129);
 assert.equal(libraryItems(tasks,{query:'Budget',type:'csv'})[0].taskId,'two');
 const first=libraryHTML(tasks),more=libraryHTML(tasks,{limit:200});assert.equal((first.match(/class="file-card library-card"/g)||[]).length,100);assert.equal((more.match(/class="file-card library-card"/g)||[]).length,131);assert.match(first,/library-more/);assert.doesNotMatch(more,/id="library-more"/);
 assert.doesNotMatch(more,/<script>bad/);assert.match(more,/&lt;script&gt;bad/);assert.match(more,/task=one&amp;/,'expected escaped HTML link separator');
});
test('Task progress uses measured counts and distinguishes deliverable checks from factual certainty',()=>{
 const html=taskSummary({title:'Fixture',objective:'Finish this',status:'running',progress:{step:3,total:10,current:'Read sources'},deliveries:[{text:'Use 2026 data',receivedAt:1,status:'received'},{text:'Add citations',appliedAt:2,status:'applied'}],contextUsed:[{text:'Use concise prose',scope:'personal',sourceTaskId:'old'}]});
 assert.match(html,/<progress value="3" max="10"/);assert.match(html,/Received/);assert.match(html,/Applied to this task/);assert.match(html,/Context used/);assert.match(html,/data-action="stop"/);
 assert.doesNotMatch(taskSummary({title:'Done',status:'complete',progress:{step:11,total:10}}),/<progress/);
 assert.match(taskSummary({title:'Done',status:'complete'}),/Result needs verification/);
 assert.match(taskSummary({title:'Done',status:'complete',resultEvidence:{status:'verified',checks:[{label:'PDF opens',status:'passed'}]}}),/Deliverable checks passed/);
});
test('Workflow typed inputs validate required fields, email and URL and keep authority explicit',()=>{
 const email=BUILTIN_TEMPLATES.find(t=>t.id==='email-draft');assert.throws(()=>templateObjective(email,{recipient:'invalid',instructions:'Thanks'}),/email/);assert.throws(()=>templateObjective(email,{recipient:'x@example.com'}),/Complete/);
 const prompt=templateObjective(email,{recipient:'x@example.com',instructions:'Thanks for the update'});assert.match(prompt,/x@example.com/);assert.match(prompt,/exact-action approval/);assert.doesNotMatch(prompt,/\{\{/);
 assert.throws(()=>templateObjective({objective:'Read {{url}}',fields:[{name:'url',label:'URL',type:'url'}]},{url:'javascript:alert(1)'}),/HTTPS/);
 assert.match(templateForm({title:'<unsafe>',fields:[{name:'date',label:'Date',type:'date',required:true}],permissions:'read'}),/type="date" required/);
});
test('Final and waiting states override stale working steps without inventing finished counts',()=>{
 const stale={title:'Create a report',progress:{step:2,total:5,current:'Register artifact',startedAt:1000},plan:[{title:'Register artifact',status:'working'}],activity:'Creating report'};
 for(const [status,label]of Object.entries({complete:'Work has finished',stopped:'Stopped',paused:'Paused by you',waiting:'Waiting for your answer',attention:'Needs attention',scheduled:'Waiting for its scheduled time',queued:'Waiting for available capacity'})){
  const html=taskSummary({...stale,status,completedAt:6000}),finished=['complete','stopped'].includes(status);assert.doesNotMatch(html,/Register artifact/);assert.doesNotMatch(html,/Create a report/,'the request is not repeated');
  // Finished work collapses to one quiet line; everything else keeps the progress card.
  if(finished){assert.match(html,/class="work-done"/);assert.match(html,new RegExp('work-done-label">'+(status==='complete'?'Finished':'Stopped')+'<'));assert.doesNotMatch(html,/<progress|work-summary/);}
  else{assert.match(html,new RegExp('<strong>'+label+'</strong>'));assert.match(html,/2 of 5/);}
  if(status==='complete')assert.match(html,/data-work-finished="6000"/);
 }
 assert.doesNotMatch(taskSummary({...stale,status:'complete'}),/data-work-elapsed/,'Legacy completion with no end time must not run a growing timer');
 assert.match(taskSummary({...stale,status:'running'}),/<strong>Register artifact<\/strong>/);
});
test('Debt labels keep minimum due separate from current and statement balances, including zero',()=>{
 const data={accounts:[{id:'card',name:'Card account',current:3500}],liabilities:{credit:[{account_id:'card',minimum_payment_amount:25.99,last_statement_balance:3000},{account_name:'Paid card',minimum_payment_amount:0}]}};
 const html=financeDebtHTML({data,status:{products:{liabilities:true}},cash:n=>'$'+n.toFixed(2),date:x=>x});
 assert.match(html,/<dt>Minimum due<\/dt><dd>\$25.99/);assert.match(html,/<dt>Statement balance<\/dt><dd>\$3000.00/);assert.match(html,/<dt>Current balance<\/dt><dd>\$3500.00/);assert.match(html,/<dt>Minimum due<\/dt><dd>\$0.00/);assert.match(html,/Card account/);
 assert.match(financeDebtHTML({data:{liabilities:{credit:[{name:'Unknown'}]}},status:{products:{liabilities:true}},cash:String,date:String}),/Not supplied/);
});
test('Exact-action review escapes payloads and omits credential authority internals',()=>{
 const html=approvalDetails({proposal:{kind:'email.send',target:'x@example.com',payload:{body:'<script>steal</script>',headers:{Authorization:'nested-secret'},attachments:[{token:'attachment-token',title:'Visible attachment'}]},password:'secret-value',fingerprint:'private-digest'}});
 assert.match(html,/x@example.com/);assert.match(html,/&lt;script&gt;steal/);assert.match(html,/Visible attachment/);assert.doesNotMatch(html,/<script>|secret-value|private-digest|nested-secret|attachment-token/);assert.equal(approvalDetails({label:'Send'}),'');
});
test('Memory recall labels expose the actual task scope and supporting conversation',()=>{
 assert.equal(memoryScopeLabel({}),'All tasks');assert.equal(memoryScopeLabel({person:'owner',project:'Project A'}),'Owner tasks · Project: Project A');
 const html=contextHTML([{text:'A useful preference',sources:[{taskId:'source',title:'Original correction'}]}]);assert.match(html,/data-select="source"/);assert.match(html,/Original correction/);
});
test('Schedules use selected time zone and reject the spring-forward gap',()=>{
 assert.equal(wallTimeToUTC('2026-10-01T09:00','America/Chicago'),'2026-10-01T14:00:00.000Z');
 assert.equal(wallTimeToUTC('2026-12-01T09:00','America/Chicago'),'2026-12-01T15:00:00.000Z');
 assert.equal(wallTimeToUTC('2026-10-01T09:00','Asia/Tokyo'),'2026-10-01T00:00:00.000Z');
 assert.throws(()=>wallTimeToUTC('2026-03-08T02:30','America/Chicago'),/does not exist/);
});
test('Library filters by date range and surfaces artifact-content matches with escaped excerpts',async()=>{
 const {librarySince}=await import('../lib/work-product.js');
 const now=new Date(2026,9,2,15).getTime(),day=86400000;
 const tasks=[{id:'t',title:'Trip planning',artifacts:[{id:'today',title:'Itinerary.md',type:'md',at:now-3600000},{id:'week',title:'Budget.csv',type:'csv',at:now-5*day},{id:'old',title:'Packing.md',type:'md',at:now-90*day}]}];
 assert.equal(librarySince('today',now),new Date(2026,9,2).getTime());assert.equal(librarySince('all',now),null);
 assert.deepEqual(libraryItems(tasks,{date:'today',now}).map(a=>a.id),['today']);
 assert.deepEqual(libraryItems(tasks,{date:'7',now}).map(a=>a.id),['today','week']);
 assert.deepEqual(libraryItems(tasks,{date:'365',now}).map(a=>a.id),['today','week','old']);
 const hits=[{taskId:'t',id:'old',excerpt:'…bring the <b>passport</b> and charger…'}];
 assert.deepEqual(libraryItems(tasks,{query:'passport',now}).map(a=>a.id),[],'no metadata match without content hits');
 assert.deepEqual(libraryItems(tasks,{query:'passport',contentHits:hits,now}).map(a=>a.id),['old']);
 assert.deepEqual(libraryItems(tasks,{query:'passport',contentHits:hits,date:'30',now}).map(a=>a.id),[],'date still applies to content hits');
 const html=libraryHTML(tasks,{query:'passport',contentHits:hits});assert.match(html,/library-match/);assert.match(html,/&lt;b&gt;passport/);assert.doesNotMatch(html,/<b>passport/);assert.match(html,/id="library-date"/);
 assert.match(libraryHTML(tasks,{query:'zzz'}),/No outputs match these filters/);
});
