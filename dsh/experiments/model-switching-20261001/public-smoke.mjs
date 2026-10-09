import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
import {WorkAssets} from '../../plugins/browser-viewer/lib/work-assets.js';
const origin='https://seek.joelcrobinson.com',assets=await new WorkAssets().init();
const basic='Basic '+Buffer.from(process.env.DSH_PROXY_USER+':'+process.env.DSH_PROXY_PASS).toString('base64');
async function api(path){const r=await fetch(origin+'/work/api/'+path,{headers:{Authorization:basic}});assert.equal(r.status,200,'Public '+path);return r.json();}
const unauthenticated=await fetch(origin+'/work/api/version');assert.equal(unauthenticated.status,401);
const previewGate=await fetch(origin+'/qwen-image/api/preview?id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');assert.equal(previewGate.status,401);
const version=await api('version');assert.equal(version.release,assets.release);assert.equal(version.plugin,assets.version);
const proxyHash=createHash('sha256').update(await readFile(join(homedir(),'.dsh','proxy','server.js'))).digest('hex').slice(0,20);assert.equal(version.proxyRelease,proxyHash);
const before=JSON.parse(await readFile(new URL('./runtime-backup/work.json',import.meta.url))),after=await api('state');
assert.equal(after.tasks.length,before.tasks.length);for(const task of before.tasks){const next=after.tasks.find(t=>t.id===task.id);assert.ok(next);assert.deepEqual(next.messages,task.messages);assert.deepEqual(next.artifacts,task.artifacts);assert.equal(next.status,task.status);}
assert.deepEqual(after.settings,before.settings);
const beforeImages=JSON.parse(await readFile(new URL('./runtime-backup/images.json',import.meta.url))),imageResponse=await fetch(origin+'/qwen-image/api/history',{headers:{Authorization:basic}});assert.equal(imageResponse.status,200);const afterImages=await imageResponse.json();assert.deepEqual(afterImages.items,beforeImages.items,'Existing image gallery is preserved');
assert.equal(createHash('sha256').update(await readFile(join(homedir(),'.dsh','settings.yaml'))).digest('hex'),createHash('sha256').update(await readFile(new URL('./runtime-backup/settings.yaml',import.meta.url))).digest('hex'));
const summary=await api('updates'),idle=await api('updates?since='+summary.revision);assert.equal(idle.unchanged,true);assert.ok(summary.tasks.every(t=>!t.messages));
const response=await fetch(origin+'/work/app.js?v='+assets.release,{headers:{Authorization:basic,'Accept-Encoding':'br'}});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/immutable/);assert.equal(response.headers.get('content-encoding'),'br');await response.arrayBuffer();
const unchanged=await fetch(origin+'/work/app.js?v='+assets.release,{headers:{Authorization:basic,'Accept-Encoding':'br','If-None-Match':response.headers.get('etag')}});assert.equal(unchanged.status,304);
const login=await fetch(origin+'/work',{headers:{Authorization:basic}});const cookie=login.headers.getSetCookie().find(value=>value.startsWith('dsh_auth='));assert.ok(cookie);
const [cookieName,cookieValue]=cookie.split(';')[0].split('=');
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-public-regression-')),windowSize:'1440,1000'});
const errors=[],requested=[],cached=new Set();let visibleMs,switchingRegression;
try{
 await ui.launch();const tab=await ui.newTab('about:blank'),session=ui.tabs.get(tab);
 await ui.send('Network.enable',{},session);await ui.send('Network.setCookie',{name:cookieName,value:cookieValue,url:origin,httpOnly:true,secure:true,sameSite:'Lax'},session);
 ui.onEvent(session,'Runtime.exceptionThrown',event=>errors.push(event.exceptionDetails.text));
 ui.onEvent(session,'Network.requestWillBeSent',event=>{if(event.request.url.startsWith(origin+'/work'))requested.push(new URL(event.request.url).pathname);});
 ui.onEvent(session,'Network.requestServedFromCache',event=>cached.add(event.requestId));
 async function wait(expression,label){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await ui.evaluate(tab,expression))return;await new Promise(r=>setTimeout(r,50));}const diagnostic=await ui.evaluate(tab,`(async()=>{const m=await import('/work/models.js?v=${assets.release}'),models=m.getModels();return {label:${JSON.stringify(label)},header:document.querySelector('#model-status')?.textContent,title:document.querySelector('.model-journey h3')?.textContent,sampling:document.querySelector('.model-sampling')?.textContent,models:{active:models?.active,phase:models?.job?.phase,id:models?.job?.id},buddies:[...document.querySelectorAll('[data-buddy=studio]')].map(b=>({state:b.dataset.s,mounted:b.dataset.mounted,easel:!!b.querySelector('.b-easel[data-on]')}))}})()`);console.error(JSON.stringify(diagnostic));throw new Error('Public UI timeout: '+label);}
 const started=performance.now();await ui.send('Page.navigate',{url:origin+'/work'},session);await wait("!!document.querySelector('.welcome')&&document.querySelectorAll('#recent [data-select]').length>0",'boot and conversation list');visibleMs=Math.round(performance.now()-started);
 await wait("document.querySelector('#model-status .model-status-label')?.textContent.includes('Qwen 3.8')",'compact model status');
 async function checkHeader(){assert.equal(await ui.evaluate(tab,"(()=>{const s=document.querySelector('#model-status'),h=document.querySelector('.topbar'),r=s.getBoundingClientRect(),b=h.getBoundingClientRect();return h.contains(s)&&!s.querySelector('.model-tile')&&r.top>=b.top&&r.bottom<=b.bottom&&r.height<=24})()"),true,'Live model activity stays inside the header');}
 async function captureHeader(name){const clip=await ui.evaluate(tab,"(()=>{const r=document.querySelector('.topbar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()"),shot=await ui.send('Page.captureScreenshot',{format:'png',clip},session);await writeFile(new URL('./validation/'+name,import.meta.url),Buffer.from(shot.data,'base64'));}
 await checkHeader();await captureHeader('public-header-desktop.png');
 assert.ok(!requested.some(p=>/finance|qwen-image/.test(p)),'Public Chat must not preload feature data');
 await ui.evaluate(tab,"document.querySelector('#recent [data-select]').click();true");await wait("!!document.querySelector('.conversation')",'existing conversation');assert.ok(await ui.evaluate(tab,"document.querySelectorAll('[data-msg]').length<=40"));
 await ui.send('Page.reload',{},session);await wait("!!document.querySelector('.conversation')",'cached reload');assert.ok(cached.size>0,'Repeat navigation must reuse assets');
 await ui.evaluate(tab,"document.querySelector('[data-view=images]').click();true");await wait("!!document.querySelector('#image-create')",'image studio');assert.equal(await ui.evaluate(tab,"document.querySelectorAll('.image-card').length"),afterImages.items.length,'Public gallery remains intact');
 // Exercise the actual served submit handler. Every image API request is
 // intercepted in this browser, so these fixture submits cannot create jobs.
 let modelFixture={...summary.health.models,language:{...summary.health.models.language,state:'standby'},image:{...summary.health.models.image,state:'creating'},active:true,recoveryRequired:false,job:{id:'sampling-visual-validation',phase:'creating',startedAt:Date.now(),phaseAt:Date.now(),sampling:{step:12,total:30,secondsPerStep:2.12,updatedAt:Date.now()},phases:[{phase:'loadingImage'},{phase:'creating'}]}};
 const staleStatus={ready:true,available:true,active:null},starts=[],heldStarts=[],interceptionErrors=[];let statusRequests=0;
 const fulfill=(requestId,value,status=200)=>ui.send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Cache-Control',value:'no-store'}],body:Buffer.from(JSON.stringify(value)).toString('base64')},session);
 const stopIntercept=ui.onEvent(session,'Fetch.requestPaused',event=>{void (async()=>{
  const path=new URL(event.request.url).pathname;
  if(path==='/work/api/updates')return fulfill(event.requestId,{unchanged:true,revision:summary.revision,health:{...summary.health,models:modelFixture}});
  if(path==='/qwen-image/api/status'){statusRequests++;return fulfill(event.requestId,staleStatus);}
  if(path==='/qwen-image/api/history')return fulfill(event.requestId,afterImages);
  if(path==='/qwen-image/api/start'){assert.equal(event.request.method,'POST');starts.push(JSON.parse(event.request.postData));heldStarts.push(event.requestId);return;}
  if(path==='/qwen-image/api/job')return fulfill(event.requestId,{job:{id:'intercepted-switching-fixture',phase:'error',error:'Model switching smoke test: generation was intercepted.'}});
  return ui.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'},session);
 })().catch(error=>interceptionErrors.push(error.message));});
 await ui.send('Fetch.enable',{patterns:[{urlPattern:origin+'/qwen-image/api/*',requestStage:'Request'},{urlPattern:origin+'/work/api/updates*',requestStage:'Request'}]},session);
 const publishFixture=()=>ui.evaluate(tab,`(async()=>{const m=await import('/work/models.js?v=${assets.release}');m.updateModels(${JSON.stringify(modelFixture)});return true})()`);
 const submitFixture=()=>ui.evaluate(tab,"document.querySelector('#image-create').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));true");
 try{
  // Keep live health polling from replacing the simulated model event between
  // its publication and the character animation's MutationObserver update.
  await publishFixture();
  await wait("document.querySelector('[data-buddy=studio]')?.dataset.s==='paint'&&!!document.querySelector('[data-buddy=studio] .b-easel[data-on]')",'served painter animation with simulated model state');
  if(summary.tasks.some(task=>task.status==='waiting')&&!summary.tasks.some(task=>task.approval||task.handoff))assert.equal(await ui.evaluate(tab,"document.querySelector('[data-buddy=top]')?.dataset.s"),'wave','Waiting tasks retain their header attention pose while the studio paints');
  await wait("document.querySelector('.model-sampling strong')?.textContent==='Step 12 of 30'",'served sampling counter');assert.equal(await ui.evaluate(tab,"document.querySelector('.model-track[role=progressbar]').getAttribute('aria-valuenow')"),'12');
  const clip=await ui.evaluate(tab,"(()=>{const r=document.querySelector('.model-journey').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()"),shot=await ui.send('Page.captureScreenshot',{format:'png',clip},session);await writeFile(new URL('./validation/public-sampling-desktop.png',import.meta.url),Buffer.from(shot.data,'base64'));
  modelFixture={...summary.health.models,language:{...summary.health.models.language,state:'loading'},image:{...summary.health.models.image,state:'standby'},active:true,recoveryRequired:false,job:{id:'switching-public-fixture',phase:'restoringChat',startedAt:Date.now()-10000,phaseAt:Date.now(),imageReady:true,resumeModels:['qwen3.8-27b'],phases:[]}};staleStatus.active=structuredClone(modelFixture.job);
  await publishFixture();await ui.evaluate(tab,"document.querySelector('[data-view=chat]').click();document.querySelector('[data-view=images]').click();true");
  await wait("!!document.querySelector('#image-create')&&document.querySelector('#image-create .primary').disabled",'reopened Images waits during actual restoration');
  await ui.evaluate(tab,"(async()=>{await SeekImages.refresh();document.querySelector('#image-create textarea').value='An intercepted watercolor lighthouse fixture.';return true})()");
  assert.ok(statusRequests>0,'Served Images loaded the stale status fixture');
  const completedAt=Date.now();modelFixture={...modelFixture,active:false,language:{...modelFixture.language,state:'ready'},job:{...modelFixture.job,phase:'complete',phaseAt:completedAt,finishedAt:completedAt}};await publishFixture();
  await wait("document.querySelector('.model-journey h3')?.textContent==='Your image is ready'&&!document.querySelector('#image-create .primary').disabled",'fresh completed model event enables generation immediately');
  assert.equal(staleStatus.active.phase,'restoringChat','The status fixture still reports the older busy phase');
  const submittedAt=Date.now();await submitFixture();
  const startDeadline=Date.now()+2000;while(!starts.length&&Date.now()<startDeadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(starts.length,1,'The served submit handler accepts a completed handoff without waiting for the status timer');const submissionMs=Date.now()-submittedAt;
  assert.equal(starts[0].prompt,'An intercepted watercolor lighthouse fixture.');
  await submitFixture();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(starts.length,1,'Pending submission prevents a second start');
  const statusAfterStart=statusRequests;for(const requestId of heldStarts.splice(0))await fulfill(requestId,{id:'intercepted-switching-fixture',accepted:true},202);
  await wait("document.querySelector('#toast')?.textContent==='Model switching smoke test: generation was intercepted.'&&!document.querySelector('#image-create .primary').disabled",'intercepted job ends and form recovers');
  assert.ok(statusRequests>statusAfterStart,'Completion refreshed the stale status fixture');
  assert.equal(await ui.evaluate(tab,"document.querySelector('.images-head p').textContent.includes('An image is rendering now.')"),false,'Stale status cannot repaint an idle model as rendering');
  assert.equal(await ui.evaluate(tab,"document.querySelectorAll('.image-card').length"),afterImages.items.length,'Intercepted generation preserves the served gallery');
  // The opposite ordering also occurs: a status read can own a newer job
  // before its model event arrives. It must block an older idle event.
  const oldRestoration=staleStatus.active;staleStatus.active={id:'status-before-event-fixture',phase:'creating',startedAt:Date.now(),phaseAt:Date.now(),phases:[]};
  await ui.evaluate(tab,"(async()=>{await SeekImages.refresh();return true})()");
  await wait("document.querySelector('.model-journey h3')?.textContent==='Creating your image'&&document.querySelector('#image-create .primary').disabled",'newer active status blocks an older idle model event');
  await submitFixture();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(starts.length,1,'A newer status job prevents another start before SSE catches up');
  staleStatus.job={...staleStatus.active,phase:'error',phaseAt:Date.now()};staleStatus.active=null;staleStatus.recoveryRequired=true;
  await ui.evaluate(tab,"(async()=>{await SeekImages.refresh();return true})()");
  await wait("document.querySelector('#image-create .primary')?.textContent==='Restore chat to continue'",'newer recovery status blocks an older idle model event');
  await submitFixture();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(starts.length,1,'A newer recovery status prevents another start before SSE catches up');
  staleStatus.active=oldRestoration;delete staleStatus.job;delete staleStatus.recoveryRequired;
  modelFixture={...modelFixture,active:true,language:{...modelFixture.language,state:'standby'},image:{...modelFixture.image,state:'creating'},job:{id:'switching-busy-fixture',phase:'creating',startedAt:Date.now(),phaseAt:Date.now(),phases:[]}};await publishFixture();
  await wait("document.querySelector('.model-journey h3')?.textContent==='Creating your image'&&document.querySelector('#image-create .primary').disabled",'genuine busy model blocks submission');
  await submitFixture();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(starts.length,1,'Active models prevent a new start');
  modelFixture={...modelFixture,active:false,recoveryRequired:true,language:{...modelFixture.language,state:'error'},job:{...modelFixture.job,phase:'error'}};await publishFixture();
  await wait("document.querySelector('#image-create .primary')?.textContent==='Restore chat to continue'",'recovery blocks submission');
  await submitFixture();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(starts.length,1,'Recovery prevents a new start');
  assert.deepEqual(interceptionErrors,[],'CDP image interception errors');
  switchingRegression={passed:true,submissionMs,interceptedStarts:starts.length,realGenerationRequests:0,staleStatusPhase:staleStatus.active.phase,duplicateGuard:true,activeGuard:true,recoveryGuard:true,newerStatusActiveGuard:true,newerStatusRecoveryGuard:true,galleryPreserved:true};
 }finally{
  // Resolve a held fixture locally even if an assertion failed before removing
  // the interception boundary. The following reload restores observed state.
  for(const requestId of heldStarts.splice(0))await fulfill(requestId,{error:'Fixture stopped.'},503).catch(()=>{});
  await ui.send('Fetch.disable',{},session);stopIntercept();
 }
 await ui.send('Page.reload',{},session);await wait("document.querySelector('#model-status')?.textContent.includes('Ready')",'return to observed idle state');
 await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},session);assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true);
 await checkHeader();await captureHeader('public-header-mobile.png');
 await ui.send('Page.reload',{},session);await wait("document.querySelector('#model-status')?.textContent.includes('Ready')",'return to observed idle state');
 await ui.evaluate(tab,"document.querySelector('[data-view=tasks]').click();true");await wait("!!document.querySelector('#task-search')",'mobile task search');
 assert.equal(errors.length,0,'Public JavaScript errors');
}finally{await ui.close();}
const endingState=await api('state');assert.equal(endingState.tasks.length,before.tasks.length);for(const task of before.tasks){const next=endingState.tasks.find(item=>item.id===task.id);assert.ok(next);assert.deepEqual(next.messages,task.messages);assert.deepEqual(next.artifacts,task.artifacts);assert.equal(next.status,task.status);}assert.deepEqual(endingState.settings,before.settings);
const endingImages=await fetch(origin+'/qwen-image/api/history',{headers:{Authorization:basic}});assert.equal(endingImages.status,200);assert.deepEqual((await endingImages.json()).items,beforeImages.items,'Public smoke left the server gallery unchanged');
const result={passed:true,release:version.release,proxyRelease:version.proxyRelease,existingTasks:after.tasks.length,existingMessages:after.tasks.reduce((n,t)=>n+t.messages.length,0),existingImages:afterImages.items.length,historyPreserved:true,settingsPreserved:true,galleryPreserved:true,publicBootMs:visibleMs,idleBodyBytes:Buffer.byteLength(JSON.stringify(idle)),summaryBodyBytes:Buffer.byteLength(JSON.stringify(summary)),cachedResources:cached.size,textureBytes:assets.files.get('work-buddy-plush.webp').body.length,switchingRegression,checks:['authenticated public boot','unauthenticated gate including live preview pixels','plugin/proxy identity','history/settings/gallery preservation','compact private updates','Brotli static compression','immutable cache','conditional 304','compact desktop/mobile model header','served painter animation with simulated model state','served immediate image submit with stale busy status and completed model event','served pending/busy/recovery submit guards','fixture starts intercepted before reaching the server','existing conversation and image gallery','cached reload','mobile layout/search','no JavaScript exceptions']};
await writeFile(new URL('./validation/public-smoke.json',import.meta.url),JSON.stringify(result,null,2));
const ssdCopy=JSON.parse(await readFile(new URL('./validation/ssd-copy.json',import.meta.url))),ssdReload=JSON.parse(await readFile(new URL('./validation/ssd-model-reload.json',import.meta.url)));assert.equal(ssdCopy.verified,true);assert.equal(ssdReload.passed,true);assert.equal(ssdReload.weightsSha256,ssdCopy.sha256);
const suiteLog=await readFile(new URL('./validation/default-suite.txt',import.meta.url),'utf8'),nodeTests=Number(suiteLog.match(/^# tests (\d+)$/m)?.[1]);assert.ok(nodeTests>=90);assert.equal(Number(suiteLog.match(/^# pass (\d+)$/m)?.[1]),nodeTests);assert.equal(Number(suiteLog.match(/^# fail (\d+)$/m)?.[1]),0);
await writeFile(new URL('./release-manifest.json',import.meta.url),JSON.stringify({deployedAt:new Date().toISOString(),version,pluginHashes:assets.hashes,scope:'Image studio reconciles model events and status by job ownership and timestamps, accepting a completed handoff immediately and retaining newer active or recovery guards. Its character follows generation progress while the header retains waiting-task cues. Qwen’s existing GGUF is loaded from a SHA-256 verified copy at C:\\Users\\Joel Robinson\\.dsh\\models\\qwen3.8\\Qwen3.8-27B-UD-Q5_K_XL.gguf. Model and inference settings are unchanged.',validation:{nodeTests,defaultSuite:'passed',modelVisualSuite:'served desktop and 390px mobile checks',publicSmoke:result,ssdCopy,ssdReload},rollback:'installed-backup and runtime-backup (private, ignored); original HDD model preserved'},null,2));
console.log(JSON.stringify(result));
