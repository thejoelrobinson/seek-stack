import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {md} from '../lib/work-markdown.js';
import {normalizeWidgets,renderWidgets,renderRichReply,widgetText,safeWidgetURL} from '../lib/work-widgets.js';
import {WorkEngine} from '../lib/work-server.js';
import {taskPage} from '../lib/work-updates.js';
import {FakeHarness} from './fake-harness.mjs';

const examples=[
  {type:'card',title:'A useful option',text:'A **clear** explanation.',badge:{label:'Ready',tone:'success'},actions:[{label:'Choose it',request:'Use option A'},{label:'Source',href:'https://example.com/?x=1&y=2'}]},
  {type:'cards',title:'Compare options',items:[{title:'A',text:'First'},{title:'B',text:'Second'}]},
  {type:'stats',title:'Measured results',items:[{label:'Rows',value:27,detail:'Verified'},{label:'Status',value:'Ready'}]},
  {type:'list',title:'Itinerary',items:['Arrive',{title:'Explore',text:'A short walk',badge:'Day 2'}]},
  {type:'table',title:'Costs',columns:['Option',{label:'Price',align:'right'}],rows:[['A',10],['B',2],['C']]},
  {type:'chart',title:'Changes',unit:'USD',data:[{label:'A',value:-10},{label:'B',value:20},{label:'C',value:0}]},
  {type:'image',title:'Chart image',src:'https://example.com/chart.png',alt:'A measured chart',caption:'Source: measured data'}
];
test('every view renders and has a complete plain text representation',()=>{
  const html=renderWidgets({version:1,widgets:examples},{markdown:md});
  for(const w of examples){assert.ok(html.includes('view-'+w.type));assert.ok(widgetText(w).includes(w.title));}
  assert.match(html,/<strong>clear<\/strong>/);
  assert.match(html,/<th scope="col"/);
  assert.match(html,/data-widget-number="10"/);
  assert.match(html,/chart-track mixed/);
  assert.match(html,/alt="A measured chart"/);
  assert.equal(normalizeWidgets(examples).length,7);
  assert.match(widgetText(examples[4]),/Option \| Price\nA \| 10\nB \| 2\nC \| /);
});

test('components escape hostile content, strip unrecognized fields and reject unsafe links',()=>{
  const view={type:'card',title:'<img src=x onerror=alert(1)>',text:'<script>alert(1)</script>',html:'<script>x</script>',style:'position:fixed',onClick:'alert(1)',actions:[{label:'" onclick="alert(1)',request:'" autofocus onfocus="alert(1)'}]};
  const html=renderWidgets(view,{markdown:md});
  assert.doesNotMatch(html,/<img|<script| onclick="| onfocus="|autofocus=/);
  assert.match(html,/&lt;script&gt;/);
  assert.equal(normalizeWidgets(view)[0].html,undefined);
  for(const href of ['javascript:alert(1)','data:text/html,test','//evil.example','https://user:pass@example.com','https:\\evil.example','https://example.com/\n']){
    assert.equal(safeWidgetURL(href),null);
    assert.throws(()=>normalizeWidgets({type:'card',actions:[{label:'Go',href}]}),/HTTP/);
  }
  assert.throws(()=>normalizeWidgets({type:'card',actions:[{label:'Do',request:'Act',href:'https://example.com'}]}),/either/);
});

test('invalid, oversized and unknown views fail before persistence or rendering',()=>{
  for(const value of [{version:2,widgets:examples},{type:'iframe',src:'https://example.com'},{type:'chart',data:[{label:'Bad',value:'20'}]},{type:'chart',data:[{label:'Bad',value:Infinity}]},{type:'card',text:'x'.repeat(65537)},{type:'table',columns:['A'],rows:[{A:1}]},{type:'list',items:Array(41).fill('x')},{type:'card',actions:[{label:'Empty',request:''}]}])assert.throws(()=>normalizeWidgets(value),/Invalid chat view/);
});

test('explicit view fences mix with Markdown, ordinary and nested fences remain code',()=>{
  const fence='```seek-ui\n'+JSON.stringify(examples[0])+'\n```';
  const html=renderRichReply('Before **this**.\n\n'+fence+'\n\n| A | B |\n|---|---|\n|1|2|',{markdown:md,key:'task:2'});
  assert.match(html,/<strong>this<\/strong>/);assert.match(html,/view-card/);assert.match(html,/<table/);
  assert.ok(html.indexOf('Before')<html.indexOf('view-card')&&html.indexOf('view-card')<html.indexOf('<table'));
  assert.doesNotMatch(renderRichReply('````markdown\n'+fence+'\n````',{markdown:md}),/class="chat-view /);
  assert.doesNotMatch(renderRichReply('````markdown title="example"\n'+fence+'\n````',{markdown:md}),/class="chat-view /);
  assert.doesNotMatch(renderRichReply('```json\n'+JSON.stringify(examples[0])+'\n```',{markdown:md}),/class="chat-view /);
  assert.match(renderRichReply('```seek-ui\n{"type":',{markdown:md}),/Preparing view/);
  assert.match(renderRichReply('```seek-ui\n{"type":"bogus"}\n```',{markdown:md}),/show source/);
  assert.match(renderRichReply('```seek-ui\n<script>bad</script>\n```',{markdown:md}),/&lt;script&gt;/);
});

test('local images use only recorded artifacts and sorting survives renders',()=>{
  const local={type:'image',src:'chart.png',alt:'Task chart'};
  assert.match(renderWidgets(local),/image unavailable/);
  assert.match(renderWidgets(local,{resolveFile:p=>p==='chart.png'?{url:'/work/api/artifact?task=t&id=a'}:null}),/src="\/work\/api\/artifact\?task=t&amp;id=a"/);
  assert.doesNotMatch(renderWidgets({...local,src:'file:///C:/private.png'}),/<img/);
  const html=renderWidgets(examples[4],{key:'task:2',sorts:new Map([['task:2-0',{column:1,direction:'ascending'}]])});
  assert.ok(html.indexOf('>2</td>')<html.indexOf('>10</td>'));
  assert.match(html,/aria-sort="ascending"/);
});

test('agent views are authorized, durable, paginated, retried and updated without duplicates',async()=>{
  const harness=new FakeHarness(),root=await mkdtemp(join(tmpdir(),'seek-chat-view-'));
  const engine=new WorkEngine(harness,root);await engine.init();
  const task=await engine.create({objective:'Compare measured costs',mode:'chat'});await engine.tick();
  const exec={agent:{id:task.sessionId}};
  await assert.rejects(engine.present({agent:{id:'unknown'}},{view:examples[4]}),/Work mode/);
  const before=task.messages.length;
  await assert.rejects(engine.present(exec,{view:{type:'chart',data:[{label:'bad',value:'x'}]}}),/Invalid/);
  assert.equal(task.messages.length,before);
  const first=await engine.present(exec,{view:examples[4],text:'Here are the verified costs.'});
  const retry=await engine.present(exec,{view:examples[4],text:'Here are the verified costs.'});
  assert.equal(first.id,retry.id);assert.equal(task.messages.length,before+1);
  await engine.present(exec,{view:examples[2],id:'summary'});
  await engine.present(exec,{view:{...examples[2],items:[{label:'Rows',value:28}]},id:'summary'});
  assert.equal(task.messages.filter(m=>m.viewId==='summary').length,1);
  const restored=new WorkEngine(harness,root);await restored.init();const saved=restored.task(task.id);
  assert.equal(saved.messages.at(-1).widgets[0].items[0].value,28);
  const page=taskPage(saved);assert.ok(page.messages.some(m=>m.widgets));
  assert.match(saved.messages.find(m=>m.viewId===first.id).text,/A \| 10/);
  assert.equal(saved.messages.find(m=>m.viewId===first.id).viewSummary,'Here are the verified costs.');
});
