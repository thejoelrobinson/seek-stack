// Read-only by default. --run is issued by the release owner after the final idle gate.
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
const complete=process.argv.includes('--complete'),run=process.argv.includes('--run')||complete,base=process.env.SEEK_SMOKE_BASE||'http://127.0.0.1:3080',router='http://127.0.0.1:18798';
if(new URL(base).hostname!=='127.0.0.1')throw new Error('This smoke test runs only against a loopback-owned Work server.');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function get(path){const response=await fetch(base+path,{signal:AbortSignal.timeout(7000)}),value=await response.json();if(!response.ok)throw new Error(value.error||'Smoke request failed.');return value;}
async function post(path,value){const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(45000)}),body=await response.json();if(!response.ok)throw new Error(body.error||'Smoke request failed.');return body;}
const loaded=async()=>{const value=await fetch(router+'/v1/models',{signal:AbortSignal.timeout(7000)}).then(r=>r.json());return value.data.filter(m=>m.status?.value==='loaded').map(m=>m.id).sort();};
const digest=data=>createHash('sha256').update(data).digest('hex');
async function imageHashes(items){const result=new Map();for(const item of items){const response=await fetch(base+'/qwen-image/api/file?id='+encodeURIComponent(item.id),{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('A preserved gallery image is unavailable.');result.set(item.id,digest(Buffer.from(await response.arrayBuffer())));}return result;}
async function idle(){const [state,helpers,status]=await Promise.all([get('/work/api/state'),get('/work/api/helper-status'),get('/qwen-image/api/status')]);if(state.tasks.some(t=>['running','queued','waiting'].includes(t.status)||t.approval||t.handoff||t.nativeRequest)||helpers.foregroundBusy||helpers.active||helpers.pending||status.active||status.busy||status.loading||status.recoveryRequired||status.queue?.some(job=>!job.deferred))throw new Error('User work or image ownership is active; smoke deferred.');return state;}
const version=await get('/work/api/version'),state=await idle(),history=await get('/qwen-image/api/history'),models=await loaded();
if(version.plugin!=='0.5.0'||!models.includes('qwen3.8-27b'))throw new Error('Final 0.5.0 release with the original Qwen resident is required.');
if(!run){console.log(JSON.stringify({mode:'read-only-plan',tasks:state.tasks.length,images:history.items.length,models,release:version.release,willGenerate:false}));process.exit(0);}
const preserved=await imageHashes(history.items),messages=new Map(state.tasks.map(task=>[task.id,digest(JSON.stringify(task.messages||[]))])),id=randomUUID(),root=join(homedir(),'.dsh','browser','validation','image-smoke-'+id);
await mkdir(root,{recursive:true});const log={id,mode:complete?'complete':'cancel',at:Date.now(),release:version.release,initialModels:models,phases:[],preview:null,cancel:null,output:null,restored:false};let jobId=null,error=null;
const terminal=new Set(['cancelled','complete','error','interrupted']);
try{
 await idle();const request={requestId:'release-smoke-'+id,prompt:'Seek release validation only: a single simple red ceramic mug on a pale plain background, no words, no people.',steps:20,ratio:'square',seed:20261002,livePreview:true};
 const at=Date.now(),ack=await post('/qwen-image/api/start',request);jobId=ack.id;log.ackMs=Date.now()-at;
 const duplicate=await post('/qwen-image/api/start',request);if(duplicate.id!==jobId||duplicate.duplicate!==true)throw new Error('Durable image start was not idempotent.');log.idempotent=true;
 let previous=null,last=null;const deadline=Date.now()+12*60_000;
 while(Date.now()<deadline){
  await get('/qwen-image/api/status');const value=await get('/qwen-image/api/job?id='+encodeURIComponent(jobId));last=value.job;
  if(last.phase!==previous){previous=last.phase;log.phases.push({phase:previous,at:Date.now()});console.log(JSON.stringify({phase:previous,sampling:last.sampling||null}));}
  if(last.preview&&last.phase==='creating'&&!log.preview){
   const response=await fetch(base+'/qwen-image/api/preview?id='+encodeURIComponent(jobId),{signal:AbortSignal.timeout(10000)}),bytes=Buffer.from(await response.arrayBuffer());
   if(!response.ok||bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.length>1024*1024)throw new Error('Native preview bytes were invalid.');
   const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(width<1||height<1||width>512||height>512)throw new Error('Native preview dimensions were invalid.');
   log.preview={bytes:bytes.length,width,height,sha256:digest(bytes),step:last.preview.step,total:last.preview.total};await writeFile(join(root,'native-preview.png'),bytes,{flag:'wx'});
   if(!last.sampling||last.sampling.total!==20||last.preview.total!==20)throw new Error('Measured native sampling denominator did not match the requested steps.');
   if(!complete){await pause(2000);await get('/qwen-image/api/status');const current=await get('/qwen-image/api/job?id='+encodeURIComponent(jobId));if(current.job.phase!=='creating'||!current.job.canCancel)throw new Error('The image finished during the decoded-preview observation window.');log.cancel=await post('/qwen-image/api/cancel',{id:jobId});break;}
  }
  if(terminal.has(last.phase)){if(complete&&last.phase==='complete')break;throw new Error('Generation finished before an active native preview could be cancelled.');}await pause(750);
 }
 if(!log.preview||!complete&&!log.cancel)throw new Error('No native preview was observed before the bounded smoke deadline.');
 const restoreDeadline=Date.now()+5*60_000;let result;
 do{await get('/qwen-image/api/status');result=await get('/qwen-image/api/job?id='+encodeURIComponent(jobId));if(result.job.phase!==previous){previous=result.job.phase;log.phases.push({phase:previous,at:Date.now()});}if(!terminal.has(result.job.phase))await pause(750);}while(!terminal.has(result.job.phase)&&Date.now()<restoreDeadline);
 if(result.job.phase!==(complete?'complete':'cancelled'))throw new Error('The image did not finish in the expected '+(complete?'complete':'cancelled')+' state.');
 if(complete){
  if(!result.image||result.image.id!==jobId||result.image.steps!==20||result.image.seed!==20261002)throw new Error('Saved image metadata did not match this synthetic request.');
  const response=await fetch(base+'/qwen-image/api/file?id='+encodeURIComponent(jobId),{signal:AbortSignal.timeout(10000)}),bytes=Buffer.from(await response.arrayBuffer());
  if(!response.ok||bytes.length<100||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)!==1024||bytes.readUInt32BE(20)!==1024||result.image.width!==1024||result.image.height!==1024)throw new Error('Saved output was not the requested 1024 × 1024 PNG.');
  log.output={id:jobId,bytes:bytes.length,width:1024,height:1024,sha256:digest(bytes),steps:result.image.steps,seed:result.image.seed};await writeFile(join(root,'generated-output.png'),bytes,{flag:'wx'});
 }
 const status=await get('/qwen-image/api/status');if(status.active||status.recoveryRequired||JSON.stringify(await loaded())!==JSON.stringify(models))throw new Error('Original chat residency was not restored.');log.restored=true;
}catch(cause){error=cause;log.error=cause.message;}
finally{
 if(jobId){try{const value=await get('/qwen-image/api/job?id='+encodeURIComponent(jobId));if(!terminal.has(value.job.phase)&&value.job.canCancel)await post('/qwen-image/api/cancel',{id:jobId});}catch(cause){log.cleanupError=cause.message;}
  const deadline=Date.now()+5*60_000;let status;do{status=await get('/qwen-image/api/status').catch(()=>null);if(status?.active)await pause(1000);}while(status?.active&&Date.now()<deadline);
  if(status?.recoveryRequired&&!status.active){try{await post('/qwen-image/api/restore',{});}catch(cause){log.restoreError=cause.message;}}
  try{const value=await get('/qwen-image/api/job?id='+encodeURIComponent(jobId));if(value.image)await post('/qwen-image/api/delete',{id:jobId});}catch(cause){log.cleanupError=cause.message;}
 }
 const after=await get('/qwen-image/api/history'),afterHashes=await imageHashes(after.items.filter(item=>preserved.has(item.id)));if(afterHashes.size!==preserved.size||[...preserved].some(([key,hash])=>afterHashes.get(key)!==hash))throw new Error('A preexisting image changed during smoke validation.');
 const afterState=await get('/work/api/state');for(const [key,hash]of messages){const task=afterState.tasks.find(t=>t.id===key);if(!task||digest(JSON.stringify(task.messages||[]))!==hash)throw new Error('A preexisting task history changed during smoke validation.');}
 log.preservedImages=preserved.size;log.preservedTasks=messages.size;log.finalModels=await loaded();log.durationMs=Date.now()-log.at;log.phaseDurations=log.phases.map((phase,index)=>({phase:phase.phase,ms:(log.phases[index+1]?.at||Date.now())-phase.at}));await writeFile(join(root,'result.json'),JSON.stringify(log,null,2));console.log(JSON.stringify({result:root,preview:log.preview,output:log.output,cancelled:log.cancel!==null,restored:log.restored,preservedImages:log.preservedImages,preservedTasks:log.preservedTasks,error:log.error||null}));
}
if(error)throw error;
