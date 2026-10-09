// Runs the actual release UI with synthetic local data in an unsigned-in Chrome profile.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {WorkAssets} from './candidate/dsh/plugins/browser-viewer/lib/work-assets.js';
import {WorkUpdates,taskPage} from './candidate/dsh/plugins/browser-viewer/lib/work-updates.js';
import {contrast} from './candidate/dsh/plugins/browser-viewer/lib/work-theme.js';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const {WebSocketServer}=createRequire(join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/package.json'))('ws');
const assets=await new WorkAssets().init(),now=Date.now(),streams=new Set(),errors=[],checks=[];
const tasks=[{id:'fixture-report',title:'A clearer plan for the week',objective:'Make a useful weekly plan',status:'complete',mode:'task',createdAt:now,updatedAt:now,messages:[{role:'user',text:'Help me plan the week around my priorities.',time:now},{role:'assistant',text:'## A little room to breathe\nYour plan is ready.\n\n- Protect the morning for focused work.\n- Keep one afternoon free for the unexpected.\n\nSee the attached plan for the full schedule.',time:now+1}],events:[],plan:[],artifacts:[{id:'draft',title:'Weekly plan.md',type:'md',version:1,bytes:220,at:now},{id:'final',title:'Weekly plan revised.md',type:'md',version:2,parentId:'draft',bytes:300,at:now+1}]},{id:'fixture-research',title:'Compare a few good options',objective:'Research options',status:'paused',createdAt:now-1000,updatedAt:now-1000,messages:[{role:'user',text:'Compare a few good options.',time:now-1000}],events:[],plan:[],artifacts:[]}];
const models={language:{name:'Fixture chat',state:'ready'},image:{name:'Qwen Image 2.1',state:'standby'},active:false},engine={store:{version:1,settings:{name:'Seek',look:{color:'lavender',accessory:'none'},notifications:false},tasks}},updates=new WorkUpdates(engine,{health:()=>({model:'ready',models})});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://local'),json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 const body=async()=>{let text='';for await(const data of req)text+=data;return JSON.parse(text||'{}');};
 if(url.pathname==='/work/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: revision\ndata: '+updates.revision+'\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
 if(url.pathname==='/work/api/updates')return json(updates.changed(url.searchParams.get('since')));
 if(url.pathname==='/work/api/state')return json(updates.snapshot());
 if(url.pathname==='/work/api/task'&&req.method==='GET')return json(taskPage(tasks.find(t=>t.id===url.searchParams.get('id'))));
 if(url.pathname==='/work/api/settings'){Object.assign(engine.store.settings,await body());updates.refresh();return json(engine.store.settings);}
 if(url.pathname==='/work/api/task'&&req.method==='POST'){const b=await body();assert.ok(b.requestId);const task={id:'created-'+tasks.length,title:b.objective,objective:b.objective,status:'queued',mode:b.mode,createdAt:now,updatedAt:Date.now(),messages:[{role:'user',text:b.objective,time:Date.now()}],events:[],plan:[],artifacts:[]};tasks.push(task);updates.refresh();return json(task);}
 if(url.pathname==='/work/api/task/update'){const b=await body(),task=tasks.find(t=>t.id===b.id);Object.assign(task,b);updates.refresh();return json(taskPage(task));}
 if(url.pathname==='/work/api/artifact'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><style>body{font:15px Georgia;color:#302839;padding:40px;line-height:1.7}h1{font-weight:normal}small{color:#796c86}</style><small>YOUR WEEK, WITH ROOM TO BREATHE</small><h1>Make space for what matters.</h1><p>Monday · one focused morning</p><p>Tuesday · bring the loose ends together</p><p>Wednesday · leave a little room</p><p>Thursday · make something useful</p><p>Friday · review, reflect, wrap up</p>');return;}
 if(url.pathname==='/work/api/search')return json({tasks:[{id:tasks[0].id,title:tasks[0].title,excerpt:'Weekly plan'}],artifacts:[],memories:[]});
 if(url.pathname==='/work/api/subagents')return json({children:[]});
 if(url.pathname==='/work/api/templates')return json({items:[]});
 if(url.pathname==='/work/api/account')return json({vault:{state:'missing'},sites:[],always:[]});
 if(url.pathname==='/work/api/backups')return json({encrypted:true,canConfigure:false});
 if(url.pathname==='/auth/api/sessions')return json({sessions:[],csrf:'fixture'});
 if(url.pathname==='/work/api/dreaming')return json({config:{enabled:false},lessons:[],cycles:[]});
 if(url.pathname==='/work/api/growth')return json({config:{enabled:false},evaluations:[],skills:[],lessons:[]});
 if(url.pathname==='/work/api/finance/status')return json({configured:true,connected:true,canConfigure:false,connections:[],products:{liabilities:true}});
 if(url.pathname==='/work/api/finance/answers')return json({answers:[]});
 if(url.pathname==='/work/api/finance/dashboard')return json({status:{connected:true,updatedAt:now},accounts:[],summary:{assets:1200,debt:200,netWorth:1000,monthSpend:0,monthIncome:0,monthNet:0},transactions:[],budgets:[],categories:[],budgetCategories:[],cashflowMonths:[],balanceHistory:[],recurring:[],investmentHoldings:[],liabilities:{credit:[]}});
 if(url.pathname==='/qwen-image/api/status')return json({ready:true,available:true,active:false,loaded:false,queue:[]});
 if(url.pathname==='/qwen-image/api/history')return json({items:[],queue:[]});
 if(!assets.serve(req,res,url)){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"Fixture route unavailable"}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browserSockets=new WebSocketServer({server,path:'/browser/stream'}),browserActions=[];
browserSockets.on('connection',socket=>{let control='user';const status=()=>socket.send(JSON.stringify({type:'status',control,running:true,title:'Fixture browser',url:'https://fixture.example',mirror:{available:false,active:false},activeTabId:'one',tabs:[{id:'one',title:'First fixture',url:'https://fixture.example'},{id:'two',title:'Second fixture',url:'https://fixture.example/two'}]}));status();socket.on('message',raw=>{const message=JSON.parse(raw);browserActions.push(message);if(message.type==='handback'){control='idle';status();}});});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),base='http://127.0.0.1:'+server.address().port;
page.on('pageerror',error=>errors.push(error.message));
await mkdir(new URL('./results/',import.meta.url),{recursive:true});
function check(name,pass){assert.ok(pass,name);checks.push(name);}
async function noOverflow(name){const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);if(!fits){console.log(JSON.stringify(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,outside:[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,id:e.id,cls:String(e.className),rect:e.getBoundingClientRect().toJSON()})).filter(x=>x.rect.x>=innerWidth||x.rect.right>innerWidth+1&&x.rect.width>0).slice(0,14)}))));await shot('overflow');}check(name,fits);}
async function shot(name){await page.screenshot({animations:'disabled',path:new URL('./results/'+name+'.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1').replaceAll('%20',' ')});}
try{
 await page.goto(base+'/work');await page.waitForSelector('.recent-work .editorial-row');await page.waitForSelector('.home-greet .buddy[data-mounted]');
 check('Home uses actual task summaries',await page.locator('.recent-work').innerText().then(x=>x.includes(tasks[0].title)));
 check('Original textured sidekick is prominent',await page.locator('.home-greet .buddy').evaluate(e=>e.getBoundingClientRect().width===144&&!!e.querySelector('.b-plush-detail')));
 check('Only one live composer',await page.locator('#composer').count()===1);await noOverflow('Desktop home fits');await shot('home-desktop');
 await page.locator('.recent-work [data-select=fixture-report]').click();await page.waitForSelector('.conv-title');await page.waitForSelector('#result-pane iframe');
 check('Result pane is visible on desktop',await page.locator('#result-pane').isVisible());
 check('Result preview is isolated from Seek',await page.locator('#result-pane iframe').getAttribute('sandbox')==='allow-scripts');
 check('Both file revisions remain accessible',await page.locator('[data-result-select]').count()===2);await page.locator('[data-result-select=draft]').click();check('Switch result revision',await page.locator('#result-pane iframe').getAttribute('src').then(x=>x.includes('id=draft')));
 await page.locator('#prompt').fill('Keep this detail while I change the layout.');await page.locator('#experience-layout').click();check('Canvas preserves current draft',await page.locator('#prompt').inputValue()==='Keep this detail while I change the layout.');await noOverflow('Canvas task fits');await shot('task-canvas');
 await page.locator('#experience-layout').click();await shot('task-editorial');
 await page.locator('[data-view=settings]').first().click();await page.waitForSelector('#look-editor');await page.locator('#seek-appearance').selectOption('light');
 const colors=['lavender','peach','mint','sky','honey','cream','midnight'],accents=[];
 for(const color of colors){await page.locator('[name=look-color][value='+color+']').check({force:true});accents.push(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent')));check(color+' updates the entire product seed',await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand-seed').trim())===await page.evaluate(color=>SeekBuddy.PALETTES[color].deep,color));}
 check('Seven distinct primary colors',new Set(accents).size===7);
 const rgbHex=value=>'#'+value.match(/[\d.]+/g).slice(0,3).map(x=>Number(x).toString(16).padStart(2,'0')).join('');
 for(const mode of ['light','dark']){await page.locator('#seek-appearance').selectOption(mode);for(const color of colors){await page.locator('[name=look-color][value='+color+']').check({force:true});await page.waitForTimeout(200);const actual=await page.locator('#new-task').evaluate(e=>{const style=getComputedStyle(e);return {fg:style.color,bg:style.backgroundColor};});if(contrast(rgbHex(actual.fg),rgbHex(actual.bg))<4.5)console.log(JSON.stringify({mode,color,actual}));check(color+' '+mode+' actual primary button contrast',contrast(rgbHex(actual.fg),rgbHex(actual.bg))>=4.5);}}
 await page.locator('[name=look-color][value=mint]').check({force:true});await page.locator('#memory-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('saved'));
 await page.locator('#seek-appearance').selectOption('dark');check('Dark appearance changes all surfaces',await page.evaluate(()=>document.documentElement.dataset.colorMode==='dark'));await shot('settings-mint-dark');
 await page.locator('[data-editorial-home]').click();await page.waitForSelector('.welcome');await shot('home-mint-dark');await page.reload();await page.waitForSelector('.welcome');check('Saved mascot color survives reload',await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand-seed').trim())==='#5db58c');check('Appearance survives reload',await page.evaluate(()=>document.documentElement.dataset.colorMode)==='dark');
 await page.locator('[data-view=finance]').first().click();await page.waitForSelector('#fin-ask');
 const finance=await page.locator('#fin-ask button').evaluate(e=>{const s=getComputedStyle(e);return {fg:s.color,bg:s.backgroundColor};});check('Finance controls follow the selected palette with readable text',contrast(rgbHex(finance.fg),rgbHex(finance.bg))>=4.5);await shot('finance-mint-dark');
 await page.locator('[data-view=images]').first().click();await page.waitForSelector('#image-create');const studio=await page.locator('#image-create button.primary').evaluate(e=>{const s=getComputedStyle(e);return {fg:s.color,bg:s.backgroundColor};});check('Studio controls follow the selected palette with readable text',contrast(rgbHex(studio.fg),rgbHex(studio.bg))>=4.5);await shot('studio-mint-dark');
 await page.locator('[data-editorial-home]').click();await page.waitForSelector('.welcome');
 await page.locator('#editorial-search').click();await page.waitForSelector('#search-dialog[open]');await page.keyboard.press('Escape');check('Search returns keyboard focus',await page.locator('#editorial-search').evaluate(e=>document.activeElement===e)||await page.locator('#search-work').evaluate(e=>document.activeElement===e));
 await page.setViewportSize({width:390,height:844});await page.locator('#menu').click();await page.locator('[data-view=settings]').first().click();await page.waitForSelector('#seek-appearance');await page.locator('#seek-appearance').selectOption('light');await page.locator('[name=look-color][value=lavender]').check({force:true});await page.locator('#memory-form [type=submit]').click();await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand-seed').trim()==='#8b73c6');
 await page.locator('[data-view=chat]').last().click();await page.locator('#menu').click();await page.locator('[data-editorial-home]').click();await page.waitForSelector('.welcome');await noOverflow('Phone home fits');check('Phone home has integrated composer',await page.locator('#composer-area').evaluate(e=>e.parentElement.id==='composer-slot'));await shot('home-phone');
 await page.locator('.recent-work [data-select=fixture-report]').click();await page.waitForSelector('.conv-title');await noOverflow('Phone conversation fits');check('Phone keeps result files in conversation',await page.locator('.conversation [data-preview=final]').count()>0);await shot('task-phone');
 await page.locator('#watch-browser').click();await page.waitForSelector('#bv-main[data-bv=handback]');check('Phone browser covers the window',await page.locator('#bv-sheet').evaluate(e=>{const r=e.getBoundingClientRect();return r.width>=innerWidth-1&&r.height>=innerHeight-1;}));
 check('Phone browser gives the page most of the screen',await page.locator('#bv-stage').evaluate(e=>e.getBoundingClientRect().height/innerHeight>=.7));check('Hand back is always accessible',await page.locator('#bv-main').isVisible());await shot('browser-phone');
 await page.locator('#bv-tools').click();check('Browser options retains tabs and reload',await page.locator('#bv-tools').getAttribute('aria-expanded')==='true'&&await page.locator('[data-bv=reload]').isVisible()&&await page.locator('#bv-tabs').isVisible());
 await page.locator('#bv-main').click();await page.waitForSelector('#bv-main[data-bv=control]');check('Hand back reaches the real control handler',browserActions.some(x=>x.type==='handback'));await page.locator('[data-bv=close]').click();
 await page.locator('#menu').click();await page.locator('[data-editorial-home]').click();await page.waitForSelector('.welcome');
 for(const width of [320,375,640,768,1024,1600]){await page.setViewportSize({width,height:900});await noOverflow('Home fits '+width+'px');}
 await page.setViewportSize({width:1440,height:1000});await page.locator('[data-editorial-home]').click();await page.waitForSelector('.welcome');await page.locator('#prompt').fill('Make a useful fixture task.');await page.locator('#composer').evaluate(e=>{e.requestSubmit();e.requestSubmit();});await page.waitForFunction(()=>document.querySelector('.conv-title')?.textContent==='Make a useful fixture task.');check('Actual task submission retains duplicate protection',tasks.filter(t=>t.objective==='Make a useful fixture task.').length===1);
 check('No browser runtime errors',errors.length===0);
 console.log(JSON.stringify({release:assets.release,checks:checks.length,errors}));
}finally{await writeFile(new URL('./results/editorial-checks.json',import.meta.url),JSON.stringify({release:assets.release,checks,errors},null,2));await browser.close();for(const stream of streams)stream.end();for(const socket of browserSockets.clients)socket.terminate();browserSockets.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
