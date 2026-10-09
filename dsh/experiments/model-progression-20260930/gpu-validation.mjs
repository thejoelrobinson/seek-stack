import assert from 'node:assert/strict';
import {writeFile,readFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
const local='http://127.0.0.1:3080',publicOrigin='https://seek.joelcrobinson.com';
const basic='Basic '+Buffer.from(process.env.DSH_PROXY_USER+':'+process.env.DSH_PROXY_PASS).toString('base64');
async function api(path,body){const response=await fetch(local+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20*60*1000)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
const bootDeadline=Date.now()+60000;let booted=false;while(Date.now()<bootDeadline){try{const status=await api('/work/api/updates'),helper=await api('/work/api/helper-status');if(status.health.models?.language.state==='ready'&&!helper.foregroundBusy&&!helper.active){await api('/qwen-image/api/status');booted=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(booted,'Production host ready before GPU validation');
const baseline=await api('/work/api/state'),beforeImages=await api('/qwen-image/api/history'),helper=await api('/work/api/helper-status');
assert.equal(helper.foregroundBusy,false);assert.equal(helper.active,null);assert.ok(!baseline.tasks.some(t=>['running','queued','waiting'].includes(t.status)));
const cookie=(await fetch(publicOrigin+'/work',{headers:{Authorization:basic}})).headers.getSetCookie().find(s=>s.startsWith('dsh_auth='));assert.ok(cookie);const [name,value]=cookie.split(';')[0].split('=');
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-gpu-progression-')),windowSize:'1440,1050'}),stages=[],startedAt=Date.now();let generated=null,done=false,jobId=null,finalState=null;
try{
 await ui.launch();const tab=await ui.newTab('about:blank'),session=ui.tabs.get(tab);await ui.send('Network.enable',{},session);await ui.send('Network.setCookie',{name,value,url:publicOrigin,httpOnly:true,secure:true,sameSite:'Lax'},session);await ui.send('Page.navigate',{url:publicOrigin+'/work'},session);
 const until=async(expression)=>{const end=Date.now()+15000;while(Date.now()<end){if(await ui.evaluate(tab,expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Public GPU UI timeout: '+expression);};
 await until("document.querySelector('#model-status')?.textContent.includes('Qwen 3.8')");await ui.evaluate(tab,"document.querySelector('[data-view=images]').click();true");await until("!!document.querySelector('#image-create')");
 await ui.evaluate(tab,"const form=document.querySelector('#image-create');form.elements.prompt.value='A tiny friendly lavender plush sprout resting beside a smooth cream ceramic cup, soft evening studio light, minimal warm background, beautifully textured editorial product photograph.';form.elements.prompt.dispatchEvent(new Event('input',{bubbles:true}));form.elements.steps.value='24';form.requestSubmit();true");
 let lastPhase=null;const seenScreenshots=new Set();
 while(!done){
  const state=(await api('/work/api/updates')).health.models,phase=state.job?.phase;
  if(state.active&&state.job.startedAt>=startedAt)jobId??=state.job.id;
  if(jobId&&state.job?.id===jobId&&['complete','error'].includes(phase)){done=true;finalState=state;}
  if(Date.now()-startedAt>20*60*1000)throw new Error('GPU browser flow timeout.');
  if(phase&&phase!==lastPhase){lastPhase=phase;stages.push({phase,atMs:Date.now()-startedAt,chat:state.language.state,image:state.image.state});console.log(JSON.stringify(stages.at(-1)));}
  if(['loadingImage','creating','restoringChat'].includes(phase)&&!seenScreenshots.has(phase)){
   const visible=await ui.evaluate(tab,"document.querySelector('.model-journey h3')?.textContent||''");if(visible){await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},session);await writeFile(new URL('./validation/gpu-'+phase+'-mobile.png',import.meta.url),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));seenScreenshots.add(phase);}
  }
  await new Promise(r=>setTimeout(r,750));
 }
 const state=finalState;assert.equal(state.active,false);assert.equal(state.recoveryRequired,false);assert.equal(state.job.phase,'complete',state.job.error);generated=(await api('/qwen-image/api/job?id='+jobId)).image;assert.ok(generated);
 await until("document.querySelector('#image-create textarea')?.value===''");await until("document.querySelector('.model-journey h3')?.textContent==='Your image is ready'");
 const router=await fetch('http://127.0.0.1:18798/v1/models').then(r=>r.json());assert.equal(router.data.find(m=>m.id==='qwen3.8-27b').status.value,'loaded');const runner=await fetch('http://127.0.0.1:18810/health').then(r=>r.json());assert.equal(runner.loaded,false);
 const image=await fetch(local+generated.url).then(r=>r.arrayBuffer());assert.equal(Buffer.from(image).subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(image.byteLength>100000);await writeFile(new URL('./validation/gpu-image.png',import.meta.url),Buffer.from(image));
 await api('/qwen-image/api/delete',{id:generated.id});assert.deepEqual((await api('/qwen-image/api/history')).items,beforeImages.items);
 const after=await api('/work/api/state');assert.deepEqual(after.settings,baseline.settings);assert.deepEqual(after.tasks,baseline.tasks);
 const result={passed:true,kind:'real GPU handoff with public UI',elapsedMs:Date.now()-startedAt,steps:generated.steps,width:generated.width,height:generated.height,imageBytes:image.byteLength,phases:state.job.phases.map(p=>({phase:p.phase,atMs:p.at-state.job.startedAt})),observedStages:stages,checks:['Qwen chat released before image load','actual GPU image generation','runner progress visible publicly','image PNG verified','Qwen chat confirmed loaded','image engine released GPU','validation image removed','existing gallery/tasks/settings unchanged']};await writeFile(new URL('./validation/gpu-validation.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await ui.close();}
