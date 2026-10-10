// Real browser coverage with a synthetic local server; no user accounts or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../lib/cdp.js';
import {WorkAssets} from '../lib/work-assets.js';
import {WorkUpdates,taskPage} from '../lib/work-updates.js';
import {normalizeWidgets,widgetText} from '../lib/work-widgets.js';

test('native chat views, Markdown tables, sorting, follow-ups, reload and mobile themes',async()=>{
  const assets=await new WorkAssets().init(),now=Date.now(),streams=new Set(),posts=[];
  const views=normalizeWidgets([
    {type:'stats',title:'Weekend at a glance',items:[{label:'Options',value:3},{label:'Lowest cost',value:'$20'},{label:'Time outside',value:'2–4 hours'}]},
    {type:'cards',title:'Choose your afternoon',items:[
      {title:'Lake walk',text:'An easy path along the water.',badge:'Relaxed',actions:[{label:'Plan the walk',request:'Plan the lake walk for Saturday'}]},
      {title:'Museum visit',text:'An indoor option for a rainy afternoon.',actions:[{label:'Explore museums',request:'Compare the museum options'}]}
    ]},
    {type:'table',title:'Compare the options',columns:['Option',{label:'Cost',align:'right'},'Time'],rows:[['Museum',100,'2 hours'],['Lake walk',20,'3 hours'],['Garden',40,'4 hours']]},
    {type:'chart',title:'Cost by activity',unit:'USD',data:[{label:'Museum',value:100},{label:'Lake walk',value:20},{label:'Garden',value:40}]},
    {type:'list',title:'A simple plan',items:[{title:'Morning',text:'Get an early start.',badge:'9 AM'},{title:'Afternoon',text:'Leave time for a break.'}]}
  ]);
  const wide='| '+Array.from({length:10},(_,i)=>'Column '+i).join(' | ')+' |\n| '+Array(10).fill('---').join(' | ')+' |\n| '+Array(10).fill('Long table value').join(' | ')+' |';
  const fence='```seek-ui\n'+JSON.stringify({type:'card',title:'Inline view',text:'This card came from the reply.'})+'\n```';
  const task={id:'rich-fixture',title:'Plan an afternoon',objective:'Compare options',mode:'chat',status:'complete',createdAt:now,updatedAt:now,events:[],plan:[],artifacts:[],messages:[
    {role:'user',text:'Help me compare the options.',time:now},
    {role:'assistant',widgets:views,text:widgetText(views),viewSummary:'These are synthetic examples for the preview.',time:now+1},
    {role:'assistant',text:'A regular Markdown table:\n\n| Name | Expression |\n|---|---:|\n| A\\|B | `x\\|y` |\n\n'+wide+'\n\n'+fence,time:now+2}
  ]};
  const engine={store:{version:1,settings:{name:'Seek',notifications:false},tasks:[task]}},updates=new WorkUpdates(engine,{health:()=>({model:'ready'})});
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://local'),json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/work/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: revision\ndata: ${updates.revision}\n\n`);streams.add(res);res.on('close',()=>streams.delete(res));return;}
    if(url.pathname==='/work/api/updates')return json(updates.changed(url.searchParams.get('since')));
    if(url.pathname==='/work/api/task')return json(taskPage(task));
    if(url.pathname==='/work/api/subagents')return json({children:[]});
    if(req.method==='POST'){let body='';for await(const c of req)body+=c;posts.push(JSON.parse(body));return json(task);}
    if(!assets.serve(req,res,url)){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"fixture route"}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-widget-ui-')),windowSize:'1440,1100'});
  async function wait(tab,expression,label){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await ui.evaluate(tab,expression))return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('Widget UI timeout: '+label);}
  async function output(tab,name){if(process.env.SEEK_TEST_OUTPUT){await mkdir(process.env.SEEK_TEST_OUTPUT,{recursive:true});await writeFile(join(process.env.SEEK_TEST_OUTPUT,name),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));}}
  try{
    await ui.launch();const tab=await ui.newTab('http://127.0.0.1:'+server.address().port+'/work');
    await wait(tab,"!!document.querySelector('[data-select=rich-fixture]')",'task');
    await ui.evaluate(tab,"document.querySelector('[data-select=rich-fixture]').click();true");
    await wait(tab,"document.querySelectorAll('.chat-view').length===8",'all components');
    assert.equal(await ui.evaluate(tab,"document.querySelectorAll('.msg-text.md table').length"),3);
    assert.equal(await ui.evaluate(tab,"[...document.querySelectorAll('.md-table td')].some(c=>c.textContent==='A|B')"),true);
    assert.equal(await ui.evaluate(tab,"[...document.querySelectorAll('.md-table code')].some(c=>c.textContent==='x|y')"),true);
    await ui.evaluate(tab,"document.querySelector('[data-widget-sort=\"1\"]').click();true");
    assert.equal(await ui.evaluate(tab,"[...document.querySelector('.chat-view-table tbody').rows].map(r=>Number(r.cells[1].textContent))" ).then(JSON.stringify),'[20,40,100]');
    assert.equal(await ui.evaluate(tab,"document.querySelectorAll('[aria-sort=ascending]').length"),1);
    await ui.evaluate(tab,"document.querySelector('[data-widget-sort=\"1\"]').focus();true");
    await ui.keyEvent(tab,'keyDown',{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await ui.keyEvent(tab,'keyUp',{key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await wait(tab,"document.activeElement?.closest('th')?.getAttribute('aria-sort')==='descending'",'keyboard sort');
    const draft='Keep my own draft';await ui.evaluate(tab,`document.querySelector('#prompt').value=${JSON.stringify(draft)};document.querySelector('[data-widget-prompt]').click();true`);
    assert.equal(await ui.evaluate(tab,"document.querySelector('#prompt').value"),'Keep my own draft\n\nPlan the lake walk for Saturday');
    assert.equal(posts.length,0,'A view button prepares a draft, without sending a request or invoking tools');
    assert.equal(await ui.evaluate(tab,"document.activeElement.id"),'prompt');
    // Change server state to force a render; the selected sort survives updates.
    task.updatedAt++;updates.refresh();for(const stream of streams)stream.write(`event: revision\ndata: ${updates.revision}\n\n`);
    await wait(tab,"!!document.querySelector('[aria-sort=descending]')",'sort after update');
    await ui.evaluate(tab,"document.querySelector('#main').scrollTop=0;true");await output(tab,'chat-components-desktop.png');
    await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},ui.tabs.get(tab));
    assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true,'Mobile page must not overflow horizontally');
    assert.equal(await ui.evaluate(tab,"[...document.querySelectorAll('.md-table')].some(t=>t.scrollWidth>t.clientWidth)"),true,'Wide tables scroll inside their own region');
    assert.equal(await ui.evaluate(tab,"getComputedStyle(document.querySelector('.md-table table')).marginTop"),'0px','Theme must not add a second table border/margin');
    await output(tab,'chat-components-mobile.png');
    await ui.evaluate(tab,`(async()=>{document.documentElement.dataset.appearance='dark';localStorage.setItem('seek-appearance','dark');const {refreshProductPalette}=await import('/work/theme.js?v=${assets.release}');refreshProductPalette();return true;})()`);
    assert.equal(await ui.evaluate(tab,"document.documentElement.dataset.colorMode"),'dark');
    await output(tab,'chat-components-dark.png');
    await ui.send('Page.reload',{},ui.tabs.get(tab));
    await wait(tab,"!!document.querySelector('.view-table')",'views after reload');
    assert.ok((await ui.evaluate(tab,"document.querySelector('#prompt').value")).includes('Keep my own draft'));
  }finally{for(const stream of streams)stream.end();await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
