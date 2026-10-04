// Real headless Chrome against a synthetic local app; no model or user profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../lib/cdp.js';
import {WorkAssets} from '../lib/work-assets.js';
import {WorkUpdates,taskPage} from '../lib/work-updates.js';

test('desktop/mobile app, lazy features, drafts, duplicate protection, tabs, search and archive',async()=>{
 const assets=await new WorkAssets().init(),now=Date.now();
 const tasks=Array.from({length:3},(_,i)=>({id:'fixture-'+i,title:i===0?'Alpha project':i===1?'Beta project':'Archived project',objective:'Fixture only',status:'complete',mode:'chat',createdAt:now,updatedAt:now,messages:Array.from({length:i===0?85:2},(_,n)=>({role:n%2?'assistant':'user',text:'Fixture message '+n,time:now+n})),events:[],plan:[],artifacts:[],archived:i===2}));
 const engine={store:{version:1,settings:{name:'Seek',notifications:false},tasks}},updates=new WorkUpdates(engine,{health:()=>({model:'ready'})}),requests=[],streams=new Set();let creates=0,releaseSend;
 const financeData={status:{connected:true},accounts:[],summary:{assets:1000,debt:0,netWorth:1000,monthSpend:0,monthIncome:0,monthNet:0},transactions:[],budgets:[],categories:[],budgetCategories:[],cashflowMonths:[],balanceHistory:[],recurring:[],investmentHoldings:[]};
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local');requests.push(url.pathname);
  const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/work/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: revision\ndata: ${updates.revision}\n\n`);streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(url.pathname==='/work/api/updates')return json(updates.changed(url.searchParams.get('since')));
  if(url.pathname==='/work/api/task'&&req.method==='GET')return json(taskPage(tasks.find(t=>t.id===url.searchParams.get('id')),{before:url.searchParams.has('before')?url.searchParams.get('before'):undefined}));
  if(url.pathname==='/work/api/task'&&req.method==='POST'){creates++;await new Promise(resolve=>{releaseSend=resolve;});let text='';for await(const c of req)text+=c;const body=JSON.parse(text),task={...tasks[1],id:'created-'+creates,title:body.objective,messages:[{role:'user',text:body.objective,time:now}],version:undefined};tasks.push(task);updates.refresh();return json(task);}
  if(url.pathname==='/work/api/control'){let text='';for await(const c of req)text+=c;const body=JSON.parse(text),task=tasks.find(t=>t.id===body.id);task.archived=body.action==='archive';updates.refresh();return json(task);}
  if(url.pathname==='/work/api/subagents')return json({children:[]});
  if(url.pathname==='/work/api/finance/status')return json({configured:true,connected:true,canConfigure:false,connections:[]});
  if(url.pathname==='/work/api/finance/dashboard')return json(financeData);
  if(url.pathname==='/work/api/finance/transactions'){const offset=Number(url.searchParams.get('offset'))||0;return json({transactions:Array.from({length:Math.min(100,250-offset)},(_,i)=>({name:'Fixture merchant '+(offset+i),category:'FOOD_AND_DRINK',date:'2026-09-01',pending:false,amount:1,currency:'USD',flow:'spending'})),total:250,offset,nextCursor:offset+100<250?'fixture-next':null,complete:offset+100>=250,totalsByCurrency:{USD:250}});}
  if(url.pathname==='/qwen-image/api/status')return json({ready:true,available:true,active:false});
  if(url.pathname==='/qwen-image/api/history')return json({items:[]});
  if(url.pathname==='/work/api/account')return json({vault:{state:'missing'},sites:[],always:[]});
  if(!assets.serve(req,res,url)){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"fixture route"}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-ui-regression-')),windowSize:'1440,1000'});
 async function wait(tab,expression,label){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await ui.evaluate(tab,expression))return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('UI regression timeout: '+label);}
 try{
  await ui.launch();const tab=await ui.newTab('http://127.0.0.1:'+server.address().port+'/work');
  await wait(tab,"!!document.querySelector('.welcome')",'welcome');
  assert.ok(!requests.some(p=>/finance|qwen-image/.test(p)),'Chat must not fetch other feature data');
  await ui.evaluate(tab,"document.querySelector('#prompt').value='Send fixture';document.querySelector('#composer').requestSubmit();document.querySelector('#composer').requestSubmit();document.querySelector('#prompt').value='My next draft';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));true");
  const deadline=Date.now()+5000;while(!releaseSend&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(creates,1);releaseSend();
  await wait(tab,"document.querySelector('.conv-title')?.textContent==='Send fixture'",'created conversation');
  assert.equal(await ui.evaluate(tab,"document.querySelector('#prompt').value"),'My next draft');
  await ui.evaluate(tab,"document.querySelector('[data-select=\"fixture-0\"]').click();true");
  await wait(tab,"document.querySelector('.conv-title')?.textContent==='Alpha project'",'other conversation');
  assert.equal(await ui.evaluate(tab,"document.querySelectorAll('[data-msg]').length"),40);
  await ui.evaluate(tab,"document.querySelector('[data-older]').click();true");await wait(tab,"document.querySelectorAll('[data-msg]').length===80",'older page');
  await ui.evaluate(tab,"document.querySelector('[data-select=\"created-1\"]').click();true");await wait(tab,"document.querySelector('.conv-title')?.textContent==='Send fixture'",'return to draft');assert.equal(await ui.evaluate(tab,"document.querySelector('#prompt').value"),'My next draft');
  await ui.evaluate(tab,"document.querySelector('[data-view=\"tasks\"]').click();document.querySelector('#task-search').value='Beta';document.querySelector('#task-search').dispatchEvent(new Event('input',{bubbles:true}));true");assert.equal(await ui.evaluate(tab,"document.querySelectorAll('.task-card').length"),1);
  await ui.evaluate(tab,"document.querySelector('#task-search').value='';document.querySelector('#task-search').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-archive-view]').click();true");assert.equal(await ui.evaluate(tab,"document.querySelectorAll('.task-card').length"),1);
  await ui.evaluate(tab,"document.querySelector('[data-view=\"images\"]').click();true");await wait(tab,"!!document.querySelector('#image-create')",'lazy images');
  await ui.evaluate(tab,"const f=document.querySelector('#image-create textarea');f.value='Keep image draft';f.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-view=\"chat\"]').click();true");await ui.evaluate(tab,"document.querySelector('[data-view=\"images\"]').click();true");await wait(tab,"!!document.querySelector('#image-create')",'images again');assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create textarea').value"),'Keep image draft');
  await ui.evaluate(tab,"document.querySelector('[data-view=\"finance\"]').click();true");await wait(tab,"!!document.querySelector('.finance')",'lazy finance');assert.equal(await ui.evaluate(tab,"document.querySelectorAll('.fin-nav [role=tab]').length"),6);
  await ui.evaluate(tab,"document.querySelector('.fin-nav [role=tab]').focus();document.querySelector('.fin-nav [role=tab]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));true");assert.equal(await ui.evaluate(tab,"document.querySelector('.fin-nav [aria-selected=true]').textContent"),'Transactions');
  await wait(tab,"document.querySelectorAll('.fin-table tbody tr').length===100",'bounded transaction page');
  assert.equal(await ui.evaluate(tab,"document.activeElement?.getAttribute('aria-selected')"),'true','Keyboard tab activation retains focus');
  assert.ok(requests.filter(p=>p==='/work/api/finance/transactions').length<=2,'Transaction view must not fetch all history');
  await ui.evaluate(tab,"document.querySelector('[data-fin-page=next]').click();true");await wait(tab,"document.querySelector('.fin-v2-pagination span')?.textContent.startsWith('101')",'next transaction page');
  await ui.evaluate(tab,"const question=document.querySelector('#fin-ask input');question.value='Keep finance draft';question.dispatchEvent(new Event('input',{bubbles:true}));const search=document.querySelector('[data-fin-query]');search.value='Fixture';search.focus();search.setSelectionRange(2,2);search.dispatchEvent(new Event('input',{bubbles:true}));true");
  await new Promise(resolve=>setTimeout(resolve,400));assert.equal(await ui.evaluate(tab,"document.querySelector('#fin-ask input').value"),'Keep finance draft');assert.equal(await ui.evaluate(tab,"document.querySelector('[data-fin-query]').selectionStart"),2);
  await ui.evaluate(tab,"document.querySelector('[data-view=chat]').click();true");await wait(tab,"!!document.querySelector('.conversation')",'chat after finance');
  await ui.evaluate(tab,"document.querySelector('[data-action=archive]').click();true");await wait(tab,"!!document.querySelector('[data-action=unarchive]')",'archive action');await ui.evaluate(tab,"document.querySelector('[data-action=unarchive]').click();true");await wait(tab,"!!document.querySelector('[data-action=archive]')",'restore action');
  await ui.evaluate(tab,"Object.defineProperty(document,'hidden',{get:()=>true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));true");await new Promise(resolve=>setTimeout(resolve,100));assert.equal(streams.size,0,'Hidden view closes its event stream');
  await ui.evaluate(tab,"Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));document.querySelector('[data-view=finance]').click();true");await wait(tab,"!!document.querySelector('.finance')",'finance restored');assert.equal(await ui.evaluate(tab,"document.querySelector('#fin-ask input').value"),'Keep finance draft');
  await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},ui.tabs.get(tab));
  assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true,'Mobile horizontal overflow');
  const output=process.env.SEEK_TEST_OUTPUT;if(output){await mkdir(output,{recursive:true});await writeFile(join(output,'work-mobile.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},ui.tabs.get(tab));await writeFile(join(output,'work-desktop.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));}
 }finally{for(const stream of streams)stream.end();await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
