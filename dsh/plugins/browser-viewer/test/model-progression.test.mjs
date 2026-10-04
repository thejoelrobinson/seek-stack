import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageService} from '../../qwen-image/lib/image-service.js';
import {WorkModelStatus} from '../lib/work-model-status.js';
import {imageProgress,modelRibbon} from '../lib/work-model-client.js';
import {WorkAssets} from '../lib/work-assets.js';
import {WorkUpdates} from '../lib/work-updates.js';
import {CdpBrowser} from '../lib/cdp.js';
import {WorkEngine} from '../lib/work-server.js';
import {FakeHarness} from './fake-harness.mjs';
import {WorkModelQueue} from '../lib/work-model-queue.js';

const hold=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function serviceFixture(fn){
 const create=hold(),restore=hold();let language='loaded',failRestore=false,generateBody=null;
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):{};
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/health')return json({available:true,ready:true,loaded:!!generateBody,progress:generateBody?{id:generateBody.id,phase:'creating'}:null});
  if(req.url==='/v1/models')return json({data:[{id:'qwen3.8-27b',status:{value:language}}]});
  if(req.url==='/models/unload'){language='unloaded';return json({});}
  if(req.url==='/models/load'){if(failRestore)return json({error:'Fixture unavailable'},503);language='loading';await restore.promise;language='loaded';return json({});}
  if(req.url==='/unload'){generateBody=null;return json({released:true});}
  if(req.url==='/generate'){generateBody=body;await create.promise;await writeFile(join(body.outputDir,body.id+'.png'),Buffer.alloc(128,1));return json({file:body.id+'.png',width:body.width,height:body.height});}
  return json({},404);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const service=await new ImageService(await mkdtemp(join(tmpdir(),'seek-model-handoff-')),{runnerUrl:origin,routerUrl:origin,log:{warn(){}}}).init();
 async function until(predicate){const deadline=Date.now()+3000;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Fixture phase timeout');}
 try{await fn({service,create,restore,until,setFail:value=>{failRestore=value;},language:()=>language,runnerCreating:()=>!!generateBody});}finally{service.close();create.resolve();restore.resolve();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
test('image progression keeps ownership through confirmed chat restoration',async()=>{await serviceFixture(async f=>{
 const job=f.service.generate({prompt:'Fixture only.'});await f.until(()=>f.service.active?.phase==='loadingImage');
 assert.equal(f.language(),'unloaded');await f.until(f.runnerCreating);await f.service.status();assert.equal(f.service.active.phase,'creating');
 assert.equal(f.service.progress().job.prompt,undefined,'Global model status must not expose prompts');
 f.create.resolve();await f.until(()=>f.service.active?.phase==='restoringChat');assert.equal(f.service.progress().active,true);await f.until(()=>f.language()==='loading');
 f.restore.resolve();await job;assert.equal(f.language(),'loaded');assert.equal(f.service.progress().active,false);assert.equal(f.service.progress().job.phase,'complete');assert.deepEqual(f.service.progress().job.phases.map(p=>p.phase),['preparing','releasingChat','loadingImage','creating','savingImage','restoringChat','complete']);
});});
test('a saved image survives restoration failure and can restore without regenerating',async()=>{await serviceFixture(async f=>{
 f.setFail(true);const job=f.service.generate({prompt:'Fixture only.'});await f.until(()=>f.service.active?.phase==='loadingImage');f.create.resolve();const image=await job;
 assert.ok(image.warning);assert.equal(f.service.progress().recoveryRequired,true);assert.equal(f.service.history().items.length,1);assert.equal(f.service.progress().job.imageReady,true);
 await assert.rejects(f.service.generate({prompt:'Another fixture.'}),/Restore/);f.setFail(false);const retry=f.service.retryRestore();await f.until(()=>f.service.active?.phase==='restoringChat');f.restore.resolve();await retry;assert.equal(f.service.progress().recoveryRequired,false);assert.equal(f.service.history().items.length,1);assert.equal(f.service.progress().job.phase,'complete');
});});
test('image jobs acknowledge promptly and stay pending through chat restoration',async()=>{await serviceFixture(async f=>{
 const accepted=await f.service.start({prompt:'Asynchronous fixture.',requestId:'fixture-start'});assert.equal(accepted.accepted,true);assert.equal((await f.service.start({prompt:'Asynchronous fixture.',requestId:'fixture-start'})).duplicate,true);await f.until(()=>f.service.active?.phase==='loadingImage');assert.equal(f.service.jobStatus(accepted.id).job.phase,'loadingImage');f.create.resolve();await f.until(()=>f.service.active?.phase==='restoringChat');assert.ok(f.service.jobStatus(accepted.id).image);assert.equal(f.service.jobStatus(accepted.id).job.finishedAt,undefined);f.restore.resolve();await f.until(()=>!f.service.active);assert.equal(f.service.jobStatus(accepted.id).job.phase,'complete');assert.equal(f.service.jobStatus(accepted.id).image.id,accepted.id);assert.throws(()=>f.service.jobStatus('unknown'),/not found/);
});});
test('image admission reserves the GPU and rejected admission leaves chat untouched',async()=>{
 const check=hold();let unloads=0;const service=await new ImageService(await mkdtemp(join(tmpdir(),'seek-image-admission-')),{canStart:()=>check.promise}).init();service.runner=async()=>{unloads++;throw new Error('No runner access expected');};
 const job=service.generate({prompt:'Admission fixture.'});await new Promise(r=>setImmediate(r));assert.equal(service.progress().active,true);assert.equal(service.progress().job.phase,'preparing');check.resolve(false);await assert.rejects(job,/using the language model/);assert.equal(unloads,0);assert.equal(service.progress().active,false);
});
test('recovery waits for an existing load and accepts an already ready model',async()=>{
 const service=await new ImageService(await mkdtemp(join(tmpdir(),'seek-image-existing-load-'))).init();let loads=0,waits=0;service.runner=async()=>({released:true});service.routerState=async()=> 'loading';service.setRouter=async()=>loads++;service.waitRouter=async()=>waits++;
 await service.restore(['qwen3.8-27b']);assert.equal(loads,0);assert.equal(waits,1);assert.equal(service.recoveryRequired,false);service.routerState=async()=> 'loaded';await service.restore(['qwen3.8-27b']);assert.equal(loads,0);assert.equal(waits,1);
});
test('queued chat and helper inference wait until the image handoff finishes',async()=>{await serviceFixture(async f=>{
 const image=f.service.generate({prompt:'Ownership fixture.'});await f.until(()=>f.service.active?.phase==='loadingImage');
 const engine=new WorkEngine(new FakeHarness(),await mkdtemp(join(tmpdir(),'seek-image-queue-')),console);await engine.init();engine.resourceBusy=()=>!!f.service.active||!!f.service.recoveryRequired;
 let launches=0;engine.launch=async task=>{launches++;task.status='running';};const task=await engine.create({objective:'Queued chat fixture.',mode:'chat'});await engine.tick();assert.equal(task.status,'queued');assert.equal(launches,0);
 const queue=new WorkModelQueue({busy:engine.resourceBusy,pollMs:10});let helpers=0;const helper=queue.submit(async()=>{helpers++;return true;});
 try{f.create.resolve();await f.until(()=>f.service.active?.phase==='restoringChat');await engine.tick();assert.equal(launches,0);assert.equal(helpers,0);f.restore.resolve();await image;await helper;assert.equal(helpers,1);await engine.tick();assert.equal(launches,1);}finally{queue.close();}
});});
test('main model switching follows observed loading and loaded states',async()=>{
 let rows=[{id:'qwen3.8-27b',status:{value:'loaded'}}],now=1;const monitor=new WorkModelStatus({fetchImpl:async()=>Response.json({data:rows}),now:()=>now});
 await monitor.refresh();assert.equal(monitor.snapshot().language.name,'Qwen 3.8 · 27B');rows=[{id:'gemma-4-26b-a4b',status:{value:'loading'}}];now=2;await monitor.refresh();assert.equal(monitor.snapshot().language.state,'loading');assert.equal(monitor.snapshot().transition.from,'qwen3.8-27b');rows[0].status.value='loaded';now=3;await monitor.refresh();assert.equal(monitor.snapshot().language.state,'ready');assert.equal(monitor.snapshot().transition.phase,'complete');
});
test('image loading is shown as a handoff and router outages remain explicit',async()=>{
 let offline=false;const image={snapshot:()=>({active:true,job:{phase:'loadingImage',resumeModels:['qwen3.8-27b']},available:true}),refresh:async()=>{}};
 const monitor=new WorkModelStatus({images:()=>image,fetchImpl:async()=>{if(offline)throw new Error('Fixture offline');return Response.json({data:[]});}});await monitor.refresh();assert.equal(monitor.snapshot().language.state,'standby');assert.equal(monitor.snapshot().image.state,'loading');image.snapshot=()=>({active:false});offline=true;await monitor.refresh();assert.equal(monitor.snapshot().language.state,'offline');
});
test('confirmed chat restoration takes precedence over an older router frame',async()=>{
 let now=10;const image={snapshot:()=>({active:true,job:{phase:'restoringChat',resumeModels:['qwen3.8-27b']}}),refresh:async()=>{}};
 const monitor=new WorkModelStatus({now:()=>now,images:()=>image,fetchImpl:async()=>Response.json({data:[{id:'qwen3.8-27b',status:{value:'loading'}}]})});await monitor.refresh();image.snapshot=()=>({active:false,job:{phase:'complete',finishedAt:20,resumeModels:['qwen3.8-27b']}});assert.equal(monitor.snapshot().language.state,'ready');now=30;await monitor.refresh();assert.equal(monitor.snapshot().language.state,'loading','A later model load must remain visible');
});
test('health changes notify SSE without resending stored conversation history',()=>{
 const u=new WorkUpdates({store:{version:1,settings:{},tasks:[]}});let signals=0;u.subscribe(()=>signals++);const revision=u.revision;u.notifyHealth();assert.equal(signals,1);assert.equal(u.revision,revision);assert.equal(u.changed(revision).unchanged,true);
});
test('load stages are indeterminate, completion and recovery remain distinct',()=>{
 const job={phase:'loadingImage',startedAt:Date.now(),phases:[{phase:'loadingImage'}]},models={language:{name:'Qwen chat',state:'standby'},image:{name:'Qwen Image 2.1',state:'loading'},active:true,job};
 const loading=imageProgress(models);assert.match(loading,/aria-current="step"/);assert.match(loading,/role="progressbar"/);assert.ok(!loading.includes('aria-valuenow'),'Model loading has no invented percentage');assert.match(modelRibbon(models),/Loading Qwen Image/);
 job.phase='error';job.imageReady=true;job.error='<Fixture failure>';models.active=false;models.recoveryRequired=true;assert.match(imageProgress(models),/Image saved\. Chat needs attention/);assert.match(imageProgress(models),/data-model-restore/);assert.ok(!imageProgress(models).includes('<Fixture failure>'));
});

test('desktop/mobile visual model stages preserve drafts and show restoration before ready',async()=>{
 const assets=await new WorkAssets().init(),streams=new Set(),state={language:{name:'Qwen 3.8 · 27B',state:'ready'},image:{name:'Qwen Image 2.1',state:'standby'},active:false,job:null};
 const updates=new WorkUpdates({store:{version:1,settings:{name:'Seek'},tasks:[]}},{health:()=>({model:'ready',models:state})});
 let acceptedJobs=0;const image={id:'async-fixture',prompt:'Keep this next image draft',url:'/fixture.png',createdAt:Date.now(),width:1024,height:1024};
 const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://local'),json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
  if(url.pathname==='/work/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: revision\ndata: 1\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(url.pathname==='/work/api/updates')return json(updates.changed(url.searchParams.get('since')));
  if(url.pathname==='/qwen-image/api/status')return json({ready:true,available:true,active:state.active?state.job:null});
  if(url.pathname==='/qwen-image/api/history')return json({items:state.job?.id===image.id&&state.job.imageReady?[image]:[]});
  if(url.pathname==='/qwen-image/api/start'){let body='';for await(const chunk of req)body+=chunk;assert.equal(JSON.parse(body).prompt,image.prompt);acceptedJobs++;state.active=true;state.language.state='standby';state.image.state='loading';state.job={id:image.id,phase:'loadingImage',startedAt:Date.now(),phases:[],resumeModels:['qwen3.8-27b']};for(const s of streams)s.write('event: revision\ndata: 1\n\n');return json({id:image.id,accepted:true},202);}
  if(url.pathname==='/qwen-image/api/job')return json({job:state.job,image:state.job?.imageReady?image:null});
  if(!assets.serve(req,res,url)){res.writeHead(404);res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-model-visual-')),windowSize:'1440,1050'});
 async function wait(tab,expression){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await ui.evaluate(tab,expression))return;await new Promise(r=>setTimeout(r,30));}throw new Error('Model UI timeout: '+expression);}
 const output=process.env.SEEK_MODEL_TEST_OUTPUT;
 async function compactHeader(tab){assert.equal(await ui.evaluate(tab,"(()=>{const status=document.querySelector('#model-status'),header=document.querySelector('.topbar'),s=status.getBoundingClientRect(),h=header.getBoundingClientRect();return header.contains(status)&&s.top>=h.top&&s.bottom<=h.bottom&&s.height<=24&&!status.querySelector('.model-tile')&&getComputedStyle(status.querySelector('.model-indicator')).backgroundColor==='rgba(0, 0, 0, 0)'})()"),true,'Model activity fits inside the existing header without cards or a separate band');assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true);}
 try{await ui.launch();const tab=await ui.newTab('http://127.0.0.1:'+server.address().port+'/work');await wait(tab,"document.querySelector('#model-status')?.textContent.includes('Qwen 3.8')");await compactHeader(tab);assert.equal(await ui.evaluate(tab,"document.querySelector('#model-status').getAttribute('aria-live')"),'polite');if(output){await mkdir(output,{recursive:true});await writeFile(join(output,'idle-desktop.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));}await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},ui.tabs.get(tab));await compactHeader(tab);if(output)await writeFile(join(output,'idle-mobile.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false},ui.tabs.get(tab));await ui.evaluate(tab,"document.querySelector('[data-view=images]').click();true");await wait(tab,"!!document.querySelector('#image-create')");
 await ui.evaluate(tab,"const input=document.querySelector('#image-create textarea');input.value='Keep this next image draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();true");
 const now=Date.now();state.active=true;state.language.state='standby';state.image.state='loading';state.job={id:'fixture',phase:'loadingImage',phaseAt:now,startedAt:now-35000,resumeModels:['qwen3.8-27b'],phases:[{phase:'releasingChat'},{phase:'loadingImage'}]};for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');
 await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Loading Qwen Image 2.1'");await compactHeader(tab);assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create textarea').value"),'Keep this next image draft');assert.equal(await ui.evaluate(tab,"document.activeElement.id||document.activeElement.name"),'prompt');assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create button').disabled"),false);
 if(output){await mkdir(output,{recursive:true});await writeFile(join(output,'loading-desktop.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));}
 await wait(tab,"document.querySelector('[data-buddy=studio]')?.dataset.s==='tools-out'");await ui.evaluate(tab,"window.fixtureStudio=document.querySelector('[data-buddy=studio]');true");
 state.job.phase='creating';state.image.state='creating';state.job.phaseAt++;for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Creating your image'");
 await wait(tab,"document.querySelector('[data-buddy=studio]')?.dataset.s==='paint'");assert.equal(await ui.evaluate(tab,"document.querySelector('[data-buddy=studio]')===fixtureStudio"),true,'Model updates retain the character rig');await ui.evaluate(tab,"(async()=>{await SeekImages.refresh();return true})()");assert.equal(await ui.evaluate(tab,"document.querySelector('[data-buddy=studio]')===fixtureStudio"),true,'Gallery/status refresh does not replay the model exchange');if(output)await writeFile(join(output,'creating-desktop.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
 state.job.sampling={step:12,total:30,secondsPerStep:2.12,updatedAt:Date.now()};for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('.model-sampling strong')?.textContent==='Step 12 of 30'");assert.equal(await ui.evaluate(tab,"document.querySelector('.model-track[role=progressbar]').getAttribute('aria-valuenow')"),'12');assert.equal(await ui.evaluate(tab,"document.querySelector('.model-track.determinate i').style.width"),'40%');await compactHeader(tab);if(output)await writeFile(join(output,'sampling-desktop.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
 state.job.sampling={step:21,total:30,secondsPerStep:2.1,updatedAt:Date.now()};for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('.model-sampling strong')?.textContent==='Step 21 of 30'");assert.equal(await ui.evaluate(tab,"document.querySelector('[data-buddy=studio]')===fixtureStudio"),true,'Sampling updates retain the painting rig');assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create textarea').value"),'Keep this next image draft');assert.equal(await ui.evaluate(tab,"document.activeElement.id||document.activeElement.name"),'prompt');await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},ui.tabs.get(tab));await compactHeader(tab);if(output)await writeFile(join(output,'sampling-mobile.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false},ui.tabs.get(tab));
 state.job.sampling={step:30,total:30,updatedAt:Date.now()};for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Finishing your image'");assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create button').disabled"),false);
 state.job.phase='restoringChat';state.job.phaseAt++;state.language.state='loading';state.image.state='standby';state.job.imageReady=true;for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Bringing chat back'");
 assert.equal(await ui.evaluate(tab,"!!document.querySelector('.model-track[aria-valuenow]')"),false,'Chat restoration does not reuse completed sampling percentage');
 await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},ui.tabs.get(tab));await compactHeader(tab);if(output)await writeFile(join(output,'restoring-mobile.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
 await ui.evaluate(tab,"document.querySelector('[data-view=chat]').click();true");assert.ok(await ui.evaluate(tab,"document.querySelector('#model-status').textContent.includes('Bringing chat back')"),'The handoff stays visible after leaving Images');
 state.active=false;state.job.phase='complete';state.job.finishedAt=Date.now();state.language.state='ready';state.image.state='standby';for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"!document.querySelector('#model-status').textContent.includes('Bringing chat back')");
 await ui.evaluate(tab,"document.querySelector('[data-view=images]').click();true");await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Your image is ready'");assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create textarea').value"),'Keep this next image draft');
 await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false},ui.tabs.get(tab));if(output)await writeFile(join(output,'complete-desktop.png'),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
 state.transition={phase:'complete',startedAt:Date.now()-20000,finishedAt:Date.now()-9500};for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"!!document.querySelector('#model-status [data-model-recent]')");await wait(tab,"!document.querySelector('#model-status [data-model-recent]')");assert.ok(await ui.evaluate(tab,"document.querySelector('#model-status').textContent.includes('Ready')"));
 state.recoveryRequired=true;state.language.state='error';for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"!!document.querySelector('#model-status [data-model-restore]')");await ui.send('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true},ui.tabs.get(tab));await compactHeader(tab);state.recoveryRequired=false;state.language.state='ready';for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');await wait(tab,"!document.querySelector('#model-status [data-model-restore]')");await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false},ui.tabs.get(tab));
 await ui.evaluate(tab,"document.querySelector('#image-create').requestSubmit();true");await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Loading Qwen Image 2.1'");assert.equal(acceptedJobs,1);assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create textarea').value"),image.prompt);
 state.job.phase='restoringChat';state.job.imageReady=true;state.language.state='loading';state.image.state='standby';for(const s of streams)s.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Bringing chat back'");assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create button').disabled"),false);
 state.active=false;state.job.phase='complete';state.job.finishedAt=Date.now();state.language.state='ready';for(const s of streams)s.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('.model-journey h3')?.textContent==='Your image is ready'");assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create textarea').value"),image.prompt,'Studio keeps the prompt for revisions after completion');assert.equal(acceptedJobs,1);assert.equal(await ui.evaluate(tab,"document.querySelector('#image-create button').disabled"),false);assert.equal(await ui.evaluate(tab,"document.querySelectorAll('.image-card').length"),1,'Early gallery refresh and completion retain one image');
 await ui.evaluate(tab,"document.querySelector('[data-view=chat]').click();document.querySelector('#image-mode').click();document.querySelector('#prompt').value='Keep this next image draft';document.querySelector('#composer').requestSubmit();true");await wait(tab,"!!document.querySelector('nav [data-view=images].active')&&document.querySelector('.model-journey h3')?.textContent==='Loading Qwen Image 2.1'");assert.equal(acceptedJobs,2,'Chat image mode acknowledges once and opens the progression view immediately');state.active=false;state.job.phase='complete';state.job.imageReady=true;state.job.finishedAt=Date.now();state.language.state='ready';state.image.state='standby';for(const s of streams)s.write('event: revision\ndata: 1\n\n');await wait(tab,"document.querySelector('#prompt')?.value===''");
 }finally{for(const s of streams)s.end();await ui.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
