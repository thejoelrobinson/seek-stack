import assert from 'node:assert/strict';
import {writeFile,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
const local='http://127.0.0.1:3080',origin='https://seek.joelcrobinson.com';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,body){const response=await fetch(local+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20*60_000)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
const before=await api('/work/api/state'),gallery=await api('/qwen-image/api/history'),helper=await api('/work/api/helper-status');
assert.ok(!helper.foregroundBusy&&!helper.active&&!gallery.active&&!before.tasks.some(t=>['running','queued','waiting'].includes(t.status)));
const basic='Basic '+Buffer.from(process.env.DSH_PROXY_USER+':'+process.env.DSH_PROXY_PASS).toString('base64');
const cookie=(await fetch(origin+'/work',{headers:{Authorization:basic}})).headers.getSetCookie().find(value=>value.startsWith('dsh_auth='));assert.ok(cookie);const [name,value]=cookie.split(';')[0].split('=');
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-live-preview-')),windowSize:'1440,1100'});
const result={runs:[],browserErrors:[],previewTransfers:[]},validationIds=[];
try{
 await ui.launch();const tab=await ui.newTab('about:blank'),session=ui.tabs.get(tab);await ui.send('Network.enable',{},session);await ui.send('Network.setCookie',{name,value,url:origin,httpOnly:true,secure:true,sameSite:'Lax'},session);
 ui.onEvent(session,'Runtime.exceptionThrown',event=>result.browserErrors.push(event.exceptionDetails.text));
 ui.onEvent(session,'Network.responseReceived',event=>{if(event.response.url.includes('/qwen-image/api/preview?'))result.previewTransfers.push({status:event.response.status,url:new URL(event.response.url).searchParams.get('v'),mime:event.response.mimeType,bytes:Number(event.response.headers['content-length']||event.response.headers['Content-Length'])});});
 const until=async(expression)=>{const end=Date.now()+20000;while(Date.now()<end){if(await ui.evaluate(tab,expression))return;await sleep(100);}throw new Error('UI timeout: '+expression);};
 await ui.send('Page.navigate',{url:origin+'/work'},session);await until("document.querySelector('#model-status')?.textContent.includes('Qwen 3.8')");await ui.evaluate(tab,"document.querySelector('[data-view=images]').click();true");await until("!!document.querySelector('#image-create [name=livePreview]')");
 for(const livePreview of [false,true]){
  const startedAt=Date.now(),run={livePreview,sampling:[],previews:[],phases:[]};result.runs.push(run);let id,finished=false,lastPhase;
  await ui.evaluate(tab,`(()=>{const form=document.querySelector('#image-create');form.elements.prompt.value='A tiny friendly lavender plush sprout resting beside a smooth cream ceramic cup, soft evening studio light, minimal warm background, beautifully textured editorial product photograph.';form.elements.prompt.dispatchEvent(new Event('input',{bubbles:true}));form.elements.steps.value='24';form.elements.livePreview.checked=${livePreview};form.requestSubmit();return true})()`);
  while(!finished){
   const models=(await api('/work/api/updates')).health.models,job=models.job;
   if(models.active&&job.startedAt>=startedAt&&!id){id=job.id;validationIds.push(id);}
   if(id&&job?.id===id){
    if(lastPhase!==job.phase){lastPhase=job.phase;run.phases.push({phase:job.phase,at:Date.now()});console.log(JSON.stringify({livePreview,phase:job.phase,elapsedMs:Date.now()-startedAt}));}
    if(job.sampling&&run.sampling.at(-1)?.step!==job.sampling.step)run.sampling.push(job.sampling);
    if(job.preview&&run.previews.at(-1)?.step!==job.preview.step){
     run.previews.push(job.preview);console.log(JSON.stringify({preview:job.preview.step,width:job.preview.width,height:job.preview.height}));
     if(livePreview&&run.previews.length===2){
      await until("!!document.querySelector('.image-live-preview img')");
      run.publicPreview=await ui.evaluate(tab,"(()=>{const img=document.querySelector('.image-live-preview img');window.validationPreviewFrame=document.querySelector('.image-preview-frame');return {width:img.naturalWidth,height:img.naturalHeight,caption:document.querySelector('.image-live-preview figcaption').textContent}})()");
      await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},session);assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true);
      await ui.evaluate(tab,"document.querySelector('.image-live-preview').scrollIntoView({block:'center',behavior:'instant'});true");
      const clip=await ui.evaluate(tab,"(()=>{const r=document.querySelector('.image-live-preview').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()"),shot=await ui.send('Page.captureScreenshot',{format:'png',clip},session);await writeFile(new URL('./validation/live-preview-mobile.png',import.meta.url),Buffer.from(shot.data,'base64'));
     }
    }
    if(['complete','error'].includes(job.phase)){assert.equal(job.phase,'complete',job.error);assert.equal(models.recoveryRequired,false);assert.equal(models.active,false);run.job=job;finished=true;}
   }
   assert.ok(Date.now()-startedAt<20*60_000,'Generation deadline');await sleep(500);
  }
  const image=(await api('/qwen-image/api/job?id='+id)).image;assert.ok(image);const bytes=Buffer.from(await fetch(local+image.url).then(r=>r.arrayBuffer()));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(bytes.length>100000);
  run.imageBytes=bytes.length;run.imageSha256=createHash('sha256').update(bytes).digest('hex');run.elapsedMs=Date.now()-startedAt;
  const phases=run.job.phases,creating=phases.find(p=>p.phase==='creating'),saving=phases.find(p=>p.phase==='savingImage');assert.ok(creating&&saving);run.creatingMs=saving.at-creating.at;const rates=run.sampling.map(sample=>sample.secondsPerStep).filter(rate=>Number.isFinite(rate)&&rate>0);run.meanSecondsPerStep=rates.reduce((sum,rate)=>sum+rate,0)/rates.length;
  await writeFile(new URL('./validation/gpu-partial.json',import.meta.url),JSON.stringify(result,null,2));
  if(livePreview){assert.ok(run.previews.length>=3);assert.ok(run.publicPreview.width<=512&&run.publicPreview.height<=512);await until("!document.querySelector('.image-live-preview img')");await writeFile(new URL('./validation/final-validation-image.png',import.meta.url),bytes);}else assert.equal(run.previews.length,0,'Disabled preview produces no intermediate images');
  await until("!document.querySelector('#image-create .primary').disabled");
  const health=await fetch('http://127.0.0.1:18810/health').then(r=>r.json());assert.equal(health.loaded,false);assert.ok(!health.progress?.preview);
  const router=await fetch('http://127.0.0.1:18798/v1/models').then(r=>r.json());assert.equal(router.data.find(m=>m.id==='qwen3.8-27b').status.value,'loaded');
  await api('/qwen-image/api/delete',{id});
  console.log(JSON.stringify({livePreview,creatingMs:run.creatingMs,meanSecondsPerStep:run.meanSecondsPerStep,imageBytes:run.imageBytes}));
 }
 assert.equal(result.runs[0].imageSha256,result.runs[1].imageSha256,'Preview must not change the final image');assert.equal(result.browserErrors.length,0);
 assert.ok(result.previewTransfers.length>=3);assert.ok(result.previewTransfers.every(frame=>frame.status===200&&frame.mime==='image/png'&&frame.bytes>0&&frame.bytes<=1024*1024));
 assert.deepEqual((await api('/qwen-image/api/history')).items,gallery.items);const after=await api('/work/api/state');assert.deepEqual(after.tasks,before.tasks);assert.deepEqual(after.settings,before.settings);
 result.previewOverheadPercent=(result.runs[1].creatingMs/result.runs[0].creatingMs-1)*100;result.passed=true;result.checks=['Real GPU matched settings, seed and prompt','Public live pixels during sampling','Small PNGs every fourth step','Identical final PNG with preview on/off','Mobile layout','Preview disabled option','Chat restored and image GPU released after both jobs','Private preview cache cleared','Existing tasks, gallery and settings preserved'];
 await writeFile(new URL('./validation/gpu-validation.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,previewOverheadPercent:result.previewOverheadPercent,transfers:result.previewTransfers}));
}finally{await ui.close();}
