// Actual Work markup and character rig, with no model runner or user profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../lib/cdp.js';
import {WorkAssets} from '../lib/work-assets.js';
import {modelCharacterState} from '../lib/work-model-client.js';

const phasePoses={preparing:'tools-away',releasingChat:'tools-away',loadingImage:'tools-out',creating:'paint',savingImage:'paint-finish',restoringChat:'tools-restore'};
const modelsFor=(phase,extra={})=>({
  language:{name:'Qwen 3.8 · 27B',state:phase==='restoringChat'?'loading':phase?'standby':'ready'},
  image:{name:'Qwen Image 2.1',state:phase==='creating'?'creating':phase==='loadingImage'?'loading':'standby'},
  active:!!phase,job:phase?{id:'animation-fixture',phase,startedAt:Date.now()-30000,phases:[],resumeModels:['qwen3.8-27b']}:null,
  ...extra
});

test('character model poses follow live stages and stop after completion or recovery failure',()=>{
  assert.equal(modelCharacterState(null),null);
  assert.equal(modelCharacterState(modelsFor(null)),null);
  for(const [phase,pose] of Object.entries(phasePoses))assert.equal(modelCharacterState(modelsFor(phase)),pose,phase);
  assert.equal(modelCharacterState(modelsFor(null,{language:{state:'loading'}})),'tools-out');
  assert.equal(modelCharacterState(modelsFor(null,{language:{state:'releasing'}})),'tools-away');
  assert.equal(modelCharacterState(modelsFor(null,{job:{phase:'creating'}})),null,'An old job must not keep painting');
  assert.equal(modelCharacterState(modelsFor(null,{job:{phase:'complete'}})),null);
  assert.equal(modelCharacterState(modelsFor(null,{recoveryRequired:true,language:{state:'error'}})),'oops');
});

test('animated toolbox and painter preserve attention priority, reduced motion and responsive layout',async()=>{
  const assets=await new WorkAssets().init(),initial=modelsFor('creating');
  // Keep the real responsive shell and SVG icon definitions, but avoid all app APIs.
  const html=assets.files.get('work.html').body.toString().replace('<body>','<body class="panel-open">').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>',`<script type="module">
    window.fixtureErrors=[];
    window.addEventListener('error',event=>fixtureErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>fixtureErrors.push(String(event.reason)));
    window.fixtureControl='';
    window.SeekBrowser={status:()=>({control:fixtureControl})};
    document.querySelector('#composer').addEventListener('submit',event=>event.preventDefault());
    const models=await import('/work/models.js?v=${assets.release}');
    window.setFixtureModels=value=>{
      models.updateModels(value);
      document.querySelector('#main').innerHTML='<section class="images">'+models.imageProgress(value)+'</section>'+
        '<div id="fixture-copies"><span id="pinned-buddy" class="buddy" data-buddy="inline" data-pose="happy"></span>'+ 
        '<span id="task-buddy" class="buddy" data-buddy="inline" data-task="fixture-task"></span></div>';
    };
    document.querySelector('#page-title').textContent='Images';
    setFixtureModels(${JSON.stringify(initial)});
    await import('/work/buddy.js?v=${assets.release}');
    window.fixtureReady=true;
  </script></body>`);
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/character-fixture'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
    if(!assets.serve(req,res,url)){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-buddy-animation-')),windowSize:'1440,1000'});
  const output=process.env.SEEK_BUDDY_TEST_OUTPUT;
  async function wait(tab,expression,label=expression){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if(await ui.evaluate(tab,expression))return;await new Promise(resolve=>setTimeout(resolve,25));}
    throw new Error('Character UI timeout: '+label);
  }
  const globalBuddy="document.querySelector('[data-buddy=panel]')";
  const shown=selector=>`(()=>{const prop=${globalBuddy}.querySelector(${JSON.stringify(selector)});return !!prop?.hasAttribute('data-on')&&getComputedStyle(prop).visibility==='visible'})()`;
  async function setModels(tab,value){await ui.evaluate(tab,`setFixtureModels(${JSON.stringify(value)});true`);}
  async function pose(tab,value){await wait(tab,`SeekBuddy.state===${JSON.stringify(value)}&&${globalBuddy}.dataset.s===${JSON.stringify(value)}`);}
  async function studioPose(tab,value){await wait(tab,`document.querySelector('[data-buddy=studio]')?.dataset.s===${JSON.stringify(value)}`);}
  async function save(tab,name){if(output){await mkdir(output,{recursive:true});await writeFile(join(output,name+'.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));}}
  async function noOverflow(tab){assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true,'Character props must not add horizontal overflow');}
  async function staticProps(tab){
    assert.equal(await ui.evaluate(tab,`(async()=>{
      const buddy=${globalBuddy};
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const read=()=>JSON.stringify([...buddy.querySelectorAll('.b-root,.b-toolbox,.b-tool,.b-easel,.b-brush,.b-palette')].map(prop=>[prop.getAttribute('transform'),prop.getAttribute('data-on')]));
      const before=read();await new Promise(resolve=>setTimeout(resolve,600));return before===read();
    })()`),true,'Reduced motion keeps the tool and brush poses still');
  }
  try{
    await ui.launch();const tab=await ui.newTab('about:blank'),session=ui.tabs.get(tab);
    await ui.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},session);
    await ui.navigate(tab,'http://127.0.0.1:'+server.address().port+'/character-fixture');
    await wait(tab,'window.fixtureReady===true');
    await pose(tab,'paint');await wait(tab,shown('.b-easel'));
    assert.equal(await ui.evaluate(tab,"document.querySelector('#model-status').getAttribute('aria-live')"),'polite','Text status remains available alongside animation');
    assert.equal(await ui.evaluate(tab,`${globalBuddy}.querySelector('svg').getAttribute('aria-hidden')`),'true','Character artwork does not replace the accessible text state');
    await staticProps(tab);

    // Model work takes priority over a chat pose hold, focused draft and sent impulse.
    await ui.evaluate(tab,"SeekBuddy.hold('type',10000);document.querySelector('#prompt').value='A fixture draft';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#prompt').focus();document.querySelector('#composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));true");
    await pose(tab,'paint');
    await ui.evaluate(tab,"SeekBuddy.hold('idle',0);document.querySelector('#prompt').value='';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#prompt').blur();true");

    // Existing privacy and attention cues retain priority during image work.
    await ui.evaluate(tab,"SeekBuddy.update({tasks:[]},{online:false});true");await pose(tab,'offline');await studioPose(tab,'offline');
    await ui.evaluate(tab,"SeekBuddy.update({tasks:[]});document.querySelector('#prompt').value='password: FixtureSecret!123';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));true");await pose(tab,'blind');await studioPose(tab,'blind');
    await ui.evaluate(tab,"document.querySelector('#prompt').value='';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));SeekBuddy.update({tasks:[{id:'fixture-task',status:'running',approval:{label:'Continue'}}]});true");await pose(tab,'approve');await studioPose(tab,'approve');
    await ui.evaluate(tab,"fixtureControl='user';SeekBuddy.update({tasks:[]});true");await pose(tab,'blind');await studioPose(tab,'blind');
    // An ordinary paused question keeps the global attention cue, while the
    // image studio explains its own work instead of waving throughout a render.
    await ui.evaluate(tab,"fixtureControl='';SeekBuddy.update({tasks:[{id:'fixture-task',status:'waiting',question:{text:'Which color?'}}]});true");await pose(tab,'wave');await studioPose(tab,'paint');
    await wait(tab,"!!document.querySelector('[data-buddy=studio] .b-easel[data-on]')");
    assert.equal(await ui.evaluate(tab,"document.querySelector('[data-buddy=top]').dataset.s"),'wave','The header retains the waiting-task attention cue');
    assert.equal(await ui.evaluate(tab,"document.querySelector('#task-buddy').dataset.s"),'wave','Task-specific waiting copies retain their attention pose');
    assert.equal(await ui.evaluate(tab,"document.querySelector('#pinned-buddy').dataset.s"),'happy','A pinned pose is unaffected by the studio override');
    await ui.evaluate(tab,"SeekBuddy.update({tasks:[{id:'fixture-task',status:'waiting',handoff:{}}]});true");await pose(tab,'wave');await studioPose(tab,'wave');
    await wait(tab,"!document.querySelector('[data-buddy=studio] .b-easel[data-on]')");
    await ui.evaluate(tab,"SeekBuddy.update({tasks:[{id:'fixture-task',status:'running',activity:'Reading a page'}]});true");await pose(tab,'paint');
    assert.equal(await ui.evaluate(tab,"document.querySelector('#task-buddy').dataset.s"),'browse','Task-specific copies retain the task state');
    assert.equal(await ui.evaluate(tab,"document.querySelector('#pinned-buddy').dataset.s"),'happy','Pinned copies retain their pose');

    for(const [phase,expected] of Object.entries(phasePoses)){
      await setModels(tab,modelsFor(phase));await pose(tab,expected);
      await wait(tab,shown(expected.startsWith('tools')?'.b-toolbox':'.b-easel'));
      await wait(tab,`!(${shown(expected.startsWith('tools')?'.b-easel':'.b-toolbox')})`);
      await wait(tab,`document.querySelector('[data-buddy=studio]')?.dataset.s===${JSON.stringify(expected)}`,'The newly mounted studio character picks up the current model phase');
      await noOverflow(tab);
      if(phase==='loadingImage'){await staticProps(tab);await save(tab,'toolbox-desktop');}
      if(phase==='creating'){await staticProps(tab);await save(tab,'painter-desktop');}
    }

    // A restored/remounted view joins the live state without resetting its pose.
    await setModels(tab,modelsFor('creating'));await pose(tab,'paint');
    await ui.evaluate(tab,"const copy=document.createElement('span');copy.id='late-buddy';copy.className='buddy';copy.dataset.buddy='panel';document.querySelector('#main').append(copy);true");
    await wait(tab,"document.querySelector('#late-buddy')?.dataset.s==='paint'&&!!document.querySelector('#late-buddy .b-easel[data-on]')");

    // Check the real responsive shell at narrow phone and tablet widths.
    for(const width of [390,320,900]){
      await ui.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<641},session);
      await noOverflow(tab);
      const topHeader=await ui.evaluate(tab,"(()=>{const header=document.querySelector('.topbar').getBoundingClientRect();return {height:header.height,character:document.querySelector('[data-buddy=top]').getBoundingClientRect().height}})()");
      assert.ok(topHeader.height<=94&&topHeader.character<=54,'Animation preserves the compact header');
    }
    await setModels(tab,modelsFor('restoringChat'));await pose(tab,'tools-restore');await save(tab,'restoring-tablet');

    // Motion changes the tool/brush position normally but settles with reduce enabled.
    await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},session);
    await ui.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},session);
    await setModels(tab,modelsFor('creating'));await pose(tab,'paint');await wait(tab,shown('.b-easel'));
    assert.equal(await ui.evaluate(tab,`(async()=>{const prop=${globalBuddy}.querySelector('.b-brush');const before=prop.getAttribute('transform');await new Promise(resolve=>setTimeout(resolve,350));return before!==prop.getAttribute('transform')})()`),true,'The painter gently moves the brush');
    await setModels(tab,modelsFor('loadingImage'));await pose(tab,'tools-out');await wait(tab,shown('.b-toolbox'));
    assert.equal(await ui.evaluate(tab,`(async()=>{const prop=${globalBuddy}.querySelector('.b-toolbox-lid');const before=prop.getAttribute('transform');await new Promise(resolve=>setTimeout(resolve,350));return before!==prop.getAttribute('transform')})()`),true,'The toolbox opens during the exchange');
    await ui.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},session);
    await setModels(tab,modelsFor('restoringChat'));await pose(tab,'tools-restore');await wait(tab,shown('.b-toolbox'));await staticProps(tab);

    await setModels(tab,modelsFor(null,{recoveryRequired:true,language:{name:'Qwen chat',state:'error'},job:{phase:'error'}}));await pose(tab,'oops');
    await wait(tab,`!(${shown('.b-toolbox')})&&!(${shown('.b-easel')})`);
    await setModels(tab,modelsFor(null,{job:{phase:'complete',finishedAt:Date.now()}}));
    await wait(tab,`!(${shown('.b-toolbox')})&&!(${shown('.b-easel')})`);
    await wait(tab,`(()=>{const buddy=${globalBuddy};return [...buddy.querySelectorAll('.b-toolbox,.b-tool,.b-easel,.b-brush,.b-palette')].every(prop=>getComputedStyle(prop).visibility==='hidden')})()`);
    assert.ok(!['paint','paint-finish','tools-away','tools-out','tools-restore'].includes(await ui.evaluate(tab,'SeekBuddy.state')),'Completion stops the model activity animation');
    assert.deepEqual(await ui.evaluate(tab,'fixtureErrors'),[],'No character script errors');
  }finally{
    await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
