import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageService} from '../../qwen-image/lib/image-service.js';
import {WorkModelStatus} from '../lib/work-model-status.js';
import {WorkAssets} from '../lib/work-assets.js';
import {WorkUpdates} from '../lib/work-updates.js';
import {CdpBrowser} from '../lib/cdp.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64');
const currentId='a9b13c91-50f8-4e6b-81c4-94512e7b0c68',nextId='4fe35926-c7e5-4e06-b3cd-f6c3af2a7b61';
const hold=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label='fixture condition'){
 const deadline=Date.now()+5000;while(Date.now()<deadline){if(await predicate())return;await sleep(20);}throw new Error('Preview timeout: '+label);
}
async function fixture(){
 const service=await new ImageService(await mkdtemp(join(tmpdir(),'seek-preview-'))).init();
 service.active={id:'current',phase:'creating',phaseAt:200,startedAt:100,steps:30,phases:[]};
 const data={available:true,ready:true,progress:{id:'current',phase:'creating',phaseAt:200,preview:{step:6,total:30,updatedAt:201,width:128,height:128,b64_json:'private pixels',prompt:'private prompt'}}};
 service.runner=async()=>data;return {service,data};
}
test('preview health shares only validated metadata and publishes frames without changing conversation revision',async()=>{
 const {service,data}=await fixture();await service.runnerStatus();
 const expected={step:6,total:30,updatedAt:201,width:128,height:128};
 assert.deepEqual(service.jobStatus('current').job.preview,expected);
 assert.equal(JSON.stringify(service.progress()).includes('private'),false);
 const updates=new WorkUpdates({store:{version:1,settings:{},tasks:[]}}),revision=updates.revision;
 let notices=0;const monitor=new WorkModelStatus({images:()=>({snapshot:()=>service.progress(),refresh:()=>service.runnerStatus()}),fetchImpl:async()=>Response.json({data:[]}),onChange:()=>{notices++;updates.notifyHealth();}});
 await monitor.refresh();assert.deepEqual(monitor.snapshot().job.preview,expected);assert.equal(notices,1);
 data.progress.preview={...expected,step:12,updatedAt:202};await monitor.refresh();assert.equal(notices,2);assert.equal(updates.revision,revision);assert.equal(updates.changed(revision).unchanged,true);
});
test('previews reject another job, stale frames and invalid dimensions, and survive chat restoration',async()=>{
 const {service,data}=await fixture();await service.runnerStatus();
 for(const preview of [
  {step:5,total:30,updatedAt:202,width:128,height:128},
  {step:12,total:40,updatedAt:202,width:128,height:128},
  {step:31,total:30,updatedAt:202,width:128,height:128},
  {step:12,total:30,updatedAt:99,width:128,height:128},
  {step:'12',total:30,updatedAt:202,width:128,height:128},
  {step:12,total:30,updatedAt:202,width:0,height:128},
  {step:12,total:30,updatedAt:202,width:128,height:513},
  {step:12,total:30,updatedAt:202,width:128.5,height:128},
  {step:12,total:30,updatedAt:NaN,width:128,height:128},
 ]){data.progress.preview=preview;await service.runnerStatus();assert.equal(service.active.preview.step,6);}
 data.progress={id:'old',phase:'creating',preview:{step:12,total:30,updatedAt:202,width:128,height:128}};
 await service.runnerStatus();assert.equal(service.active.preview.step,6);
 service.phase('restoringChat');await service.runnerStatus();assert.equal(service.progress().job.preview.step,6,'A saved live view remains available while chat comes back');
 service.active={id:'next',phase:'loadingImage',phaseAt:300,startedAt:300,steps:30,phases:[]};
 await service.runnerStatus();assert.equal(service.progress().job.preview,undefined,'A new image cannot inherit an earlier preview');
});
test('live preview can be disabled and the option reaches the runner as a boolean',async()=>{
 for(const [option,expected] of [[undefined,true],[false,false],[true,true]]){
  const service=await new ImageService(await mkdtemp(join(tmpdir(),'seek-preview-option-'))).init();let generated;
  service.routerModels=async()=>[];
  service.runner=async(path,body)=>{
   if(path==='/health')return {available:true,ready:true};
   if(path==='/unload')return {released:true};
   if(path==='/generate'){generated=body;await writeFile(join(body.outputDir,body.id+'.png'),Buffer.concat([png,Buffer.alloc(128)]));return {file:body.id+'.png',width:body.width,height:body.height};}
   throw new Error('Unexpected runner path '+path);
  };
  await service.generate({prompt:'Preview option fixture.',...(option===undefined?{}:{livePreview:option})});
  assert.equal(generated.livePreview,expected);assert.equal(typeof generated.livePreview,'boolean');
 }
});
test('preview pixels are bounded PNG data and an expired job never reaches the runner',async()=>{
 let requests=0,body=png;const server=createServer((req,res)=>{requests++;assert.equal(new URL(req.url,'http://local').searchParams.get('id'),'current');res.writeHead(200,{'Content-Type':'image/png','Content-Length':body.length});res.end(body);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const service=await new ImageService(await mkdtemp(join(tmpdir(),'seek-preview-pixels-')),{runnerUrl:'http://127.0.0.1:'+server.address().port}).init();
 service.active={id:'current',phase:'creating',steps:30,startedAt:100,phaseAt:200,preview:{step:6,total:30,updatedAt:201,width:1,height:1}};
 try{
  await assert.rejects(service.preview('previous'));assert.equal(requests,0);
  assert.deepEqual(await service.preview('current'),png);assert.equal(requests,1);
  body=Buffer.from('private non-image output');await assert.rejects(service.preview('current'));
  body=Buffer.from(png);body.writeUInt32BE(0,16);await assert.rejects(service.preview('current'));
  body=Buffer.from(png);body.writeUInt32BE(513,20);await assert.rejects(service.preview('current'));
  body=Buffer.alloc(1024*1024+1);png.copy(body);await assert.rejects(service.preview('current'));
  service.active=null;await assert.rejects(service.preview('current'));assert.equal(requests,5,'Completed jobs have no transient image endpoint');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Images keeps the live frame stable and fetches each version once only while visible',async()=>{
 const assets=await new WorkAssets().init(),streams=new Set(),now=Date.now();
 const state={language:{name:'Qwen 3.8 · 27B',state:'standby'},image:{name:'Qwen Image 2.1',state:'creating'},active:true,job:{id:currentId,phase:'creating',startedAt:now,phaseAt:now,steps:30,phases:[],preview:{step:6,total:30,updatedAt:now,width:1,height:1}}};
 const updates=new WorkUpdates({store:{version:1,settings:{name:'Seek'},tasks:[]}},{health:()=>({model:'ready',models:state})});
 const fetched=[];
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://local'),json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/work/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: revision\ndata: 1\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(url.pathname==='/work/api/updates')return json(updates.changed(url.searchParams.get('since')));
  if(url.pathname==='/qwen-image/api/status')return json({ready:true,available:true,active:state.active?state.job:null});
  if(url.pathname==='/qwen-image/api/history')return json({items:[]});
  if(url.pathname==='/qwen-image/api/preview'){fetched.push(url.searchParams.get('v'));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png);return;}
  if(url.pathname==='/qwen-image/api/file'){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;}
  if(!assets.serve(req,res,url)){res.writeHead(404);res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-preview-visible-')),windowSize:'1440,1050'});
 let tab;const evaluate=expression=>ui.evaluate(tab,expression),wait=expression=>until(()=>evaluate(expression),expression);
 const publish=()=>{for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');};
 const step=value=>{state.job.preview={step:value,total:30,updatedAt:Date.now(),width:1,height:1};publish();};
 try{
  await ui.launch();tab=await ui.newTab('http://127.0.0.1:'+server.address().port+'/work');
  await wait("!!document.querySelector('[data-view=images]')");
  await evaluate("window.revokedPreviewURLs=[];window.originalPreviewRevoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revokedPreviewURLs.push(url);originalPreviewRevoke(url);};true");
  await evaluate("document.querySelector('[data-view=images]').click();true");
  await wait("document.querySelector('.image-live-preview img')?.naturalWidth>0");assert.deepEqual(fetched,['6']);
  assert.equal(await evaluate("document.querySelector('[name=livePreview]').checked"),true);
  await evaluate("window.savedPreview=document.querySelector('.image-live-preview');window.savedPreviewImage=savedPreview.querySelector('img');window.initialPreviewURL=savedPreviewImage.src;true");
  state.job.sampling={step:8,total:30,updatedAt:Date.now()};publish();await wait("document.querySelector('.model-sampling strong')?.textContent==='Step 8 of 30'");
  await evaluate("(async()=>{await SeekImages.refresh();return true})()");
  assert.equal(await evaluate("document.querySelector('.image-live-preview')===savedPreview"),true,'Health and gallery refresh retain the preview frame');
  assert.equal(await evaluate("savedPreview.querySelector('img')===savedPreviewImage"),true,'An unchanged preview reuses decoded pixels');assert.deepEqual(fetched,['6']);
  assert.equal(await evaluate('revokedPreviewURLs.includes(initialPreviewURL)'),false,'A temporary detach during gallery refresh retains the live image URL');
  step(12);await until(()=>fetched.length===2,'second preview request');await wait("document.querySelector('.image-live-preview figcaption strong')?.textContent.includes('step 12 of 30')");assert.deepEqual(fetched,['6','12']);
  await evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});true");
  step(18);await wait("document.querySelector('.model-sampling strong')?.textContent==='Step 8 of 30'");await sleep(200);assert.equal(fetched.length,2,'Hidden tabs do not download previews');
  await evaluate("delete document.hidden;SeekImages.render();true");publish();await until(()=>fetched.length===3,'visible preview request');assert.equal(fetched.at(-1),'18');
  await wait("document.querySelector('.image-live-preview figcaption strong')?.textContent.includes('step 18 of 30')");
  await evaluate("window.previewLeavingURL=document.querySelector('.image-live-preview img').src;document.querySelector('[data-view=chat]').click();true");
  await wait('revokedPreviewURLs.includes(previewLeavingURL)');assert.equal(await evaluate('revokedPreviewURLs.filter(url=>url===previewLeavingURL).length'),1,'Leaving Images releases its decoded image URL exactly once');
  step(24);await sleep(200);assert.equal(fetched.length,3,'The chat view does not download image previews');
  await evaluate("document.querySelector('[data-view=images]').click();true");await until(()=>fetched.length===4,'return to Images');assert.equal(fetched.at(-1),'24');
  state.job.phase='restoringChat';state.job.imageReady=true;state.language.state='loading';publish();await wait("document.querySelector('.model-journey h3')?.textContent==='Bringing chat back'");
  assert.equal(await evaluate("document.querySelector('.image-live-preview img')?.naturalWidth>0"),true,'The latest live image remains during model restoration');assert.equal(fetched.length,4);
  await evaluate("document.querySelector('[name=livePreview]').checked=false;true");await evaluate("(async()=>{await SeekImages.refresh();return true})()");assert.equal(await evaluate("document.querySelector('[name=livePreview]').checked"),false,'The preview choice survives gallery refresh');
  state.active=false;state.job.phase='complete';state.job.finishedAt=Date.now();state.language.state='ready';publish();await wait("document.querySelector('.model-journey h3')?.textContent==='Your image is ready'");
  assert.equal(await evaluate("!!document.querySelector('.image-live-preview img')&&!!document.querySelector('.image-live-preview').offsetParent"),false,'A completed job removes its transient preview');
  await ui.send('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true},ui.tabs.get(tab));assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 }finally{for(const stream of streams)stream.end();await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('an older asynchronous frame cannot replace a new image job and only the latest pending frame is fetched',async()=>{
 const pending=new Map(),fetched=[];const module=await readFile(new URL('../lib/work-image-preview.js',import.meta.url));
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/preview.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(module);return;}
  if(url.pathname==='/qwen-image/api/preview'){
   const key=url.searchParams.get('id')+':'+url.searchParams.get('v'),gate=hold();pending.set(key,gate);fetched.push(key);await gate.promise;
   if(!res.destroyed){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png);}return;
  }
  res.writeHead(200,{'Content-Type':'text/html'});res.end('<nav><button class="active" data-view="images">Images</button></nav><main id="main"><div class="image-live-preview"></div></main>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-preview-race-'))});let tab;
 const evaluate=expression=>ui.evaluate(tab,expression);
 try{
  await ui.launch();tab=await ui.newTab('http://127.0.0.1:'+server.address().port+'/fixture');
  await evaluate(`(async()=>{window.previewModule=await import('/preview.js');window.slot=document.querySelector('.image-live-preview');window.frame=(id,step)=>({active:true,job:{id,phase:'creating',startedAt:1,phaseAt:1,preview:{step,total:30,updatedAt:Date.now(),width:1,height:1}}});window.oldFramePainted=false;new MutationObserver(()=>{if(slot.textContent.includes('step 4 of 30'))oldFramePainted=true}).observe(slot,{subtree:true,childList:true,characterData:true});previewModule.updateImagePreview(slot,frame('${currentId}',4));return true})()`);
  await until(()=>fetched.includes(currentId+':4'),'first held frame');
  await evaluate(`previewModule.updateImagePreview(slot,frame('${nextId}',6));previewModule.updateImagePreview(slot,frame('${nextId}',12));previewModule.updateImagePreview(slot,frame('${nextId}',18));true`);
  pending.get(currentId+':4').resolve();await until(()=>fetched.some(key=>key.startsWith(nextId+':')),'new job frame');
  assert.equal(fetched.includes(nextId+':12'),false,'Intermediate queued frames are skipped');
  assert.equal(fetched.includes(nextId+':18'),false,'A newer frame waits while the current request is in flight');
  pending.get(nextId+':6').resolve();await until(()=>fetched.includes(nextId+':18'),'latest waiting frame');pending.get(nextId+':18').resolve();
  await until(()=>evaluate("slot.textContent.includes('step 18 of 30')&&slot.querySelector('img')?.naturalWidth>0"),'latest preview decode');
  assert.equal(await evaluate('oldFramePainted'),false,'A response from the older job never paints the newer frame');
  assert.deepEqual(fetched.filter(key=>key.startsWith(nextId+':')),[nextId+':6',nextId+':18'],'A burst skips intermediate frames and fetches only the latest waiting version');
  await evaluate(`previewModule.updateImagePreview(slot,{active:false,job:{id:'${nextId}',phase:'complete'}});true`);assert.equal(await evaluate("!!slot.querySelector('img')&&!!slot.offsetParent"),false);
 }finally{for(const gate of pending.values())gate.resolve();await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
