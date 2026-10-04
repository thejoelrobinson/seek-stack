import {mkdir,readFile,readdir,rename,stat,writeFile,copyFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const RATIOS={square:[1024,1024],portrait:[896,1152],landscape:[1152,896],wide:[1280,720],tall:[720,1280]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const RUNNER_PHASES=['loadingImage','creating','savingImage'];
const TERMINAL=new Set(['complete','error','cancelled','interrupted']);
const SAFE_FILE=/^[-_a-zA-Z0-9]+\.png$/i;
function samplingValue(value,job){
  if(!value||!Number.isInteger(value.step)||!Number.isInteger(value.total)||value.total<1||value.total>40||value.step<0||value.step>value.total||job.steps&&value.total!==job.steps||!Number.isFinite(value.updatedAt)||value.updatedAt<job.phaseAt||job.sampling&&value.step<job.sampling.step)return null;
  return {step:value.step,total:value.total,updatedAt:value.updatedAt,...(Number.isFinite(value.secondsPerStep)&&value.secondsPerStep>0?{secondsPerStep:value.secondsPerStep}:{})};
}
function previewValue(value,job){
  if(!value||!Number.isInteger(value.step)||!Number.isInteger(value.total)||value.total<1||value.total>40||value.step<1||value.step>value.total||job.steps&&value.total!==job.steps||!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1||value.width>512||value.height>512||!Number.isFinite(value.updatedAt)||value.updatedAt<job.startedAt||job.preview&&value.step<job.preview.step)return null;
  return {step:value.step,total:value.total,updatedAt:value.updatedAt,width:value.width,height:value.height};
}
function normalized(request){
  if(typeof request?.prompt!=='string'||!request.prompt.trim()||request.prompt.trim().length>6000)throw new Error('Describe the image in 1–6000 characters.');
  const seed=request.seed===''||request.seed==null?null:Number(request.seed);
  if(seed!==null&&(!Number.isSafeInteger(seed)||seed<0||seed>2147483647))throw new Error('Seed must be a whole number from 0 to 2147483647.');
  return {prompt:request.prompt.trim(),ratio:RATIOS[request.ratio]?request.ratio:'square',transparent:!!request.transparent,steps:Math.max(20,Math.min(40,Math.trunc(Number(request.steps)||30))),livePreview:request.livePreview!==false,seed,parentId:typeof request.parentId==='string'?request.parentId:null};
}
const fingerprint=request=>createHash('sha256').update(JSON.stringify(request)).digest('hex');
async function atomic(file,value){
  const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2),{flush:true});
  await copyFile(file,file+'.bak').catch(error=>{if(error.code!=='ENOENT')throw error;});await rename(tmp,file);
}

export class ImageService {
  constructor(root,{runnerUrl=process.env.SEEK_IMAGE_URL||'http://127.0.0.1:18810',routerUrl=process.env.SEEK_MODEL_URL||'http://127.0.0.1:18798',canStart=()=>true,log=console,queueIntervalMs=1500}={}){
    this.root=join(root,'images');this.output=join(this.root,'outputs');this.store=join(this.root,'images.json');this.journal=join(this.root,'jobs.json');this.previewRoot=join(this.root,'previews');this.runnerUrl=runnerUrl.replace(/\/$/,'');this.routerUrl=routerUrl.replace(/\/$/,'');this.canStart=canStart;this.log=log;this.queueIntervalMs=queueIntervalMs;this.data={version:2,items:[]};this.active=null;this.lastJob=null;this.recoveryModels=[];this.recoveryRequired=false;this.runnerHealth=null;this.serial=Promise.resolve();this.journalWrites=Promise.resolve();this.galleryWrites=Promise.resolve();this.jobs=new Map();this.queue=[];this.lease=null;this.enabled=false;
  }
  async readStore(file,fallback,validate){
    try{const value=JSON.parse(await readFile(file,'utf8'));if(!validate(value))throw new Error('Invalid storage structure');return value;}
    catch(error){if(error.code==='ENOENT')return fallback;const preserved=file+'.corrupt-'+Date.now()+'-'+randomUUID();await rename(file,preserved);this.log.warn('Preserved unreadable image storage: '+basename(preserved));
      try{const value=JSON.parse(await readFile(file+'.bak','utf8'));if(validate(value))return value;}catch{}return fallback;}
  }
  async init(){
    await mkdir(this.output,{recursive:true});await mkdir(this.previewRoot,{recursive:true});
    this.data=await this.readStore(this.store,this.data,value=>value&&Array.isArray(value.items));this.data.version=2;
    this.data.items=this.data.items.filter(item=>item&&typeof item.id==='string'&&SAFE_FILE.test(item.file||''));
    const journal=await this.readStore(this.journal,{version:1,jobs:[],queue:[],lease:null},value=>value&&Array.isArray(value.jobs)&&Array.isArray(value.queue));
    for(const job of journal.jobs)if(job&&typeof job.id==='string')this.jobs.set(job.id,job);
    this.queue=journal.queue.filter(id=>this.jobs.has(id)&&!TERMINAL.has(this.jobs.get(id).phase));this.lease=journal.lease;
    this.recoveryModels=journal.recoveryModels||this.lease?.resumeModels||[];this.recoveryRequired=!!journal.recoveryRequired||!!this.lease;
    this.active=journal.activeId?this.jobs.get(journal.activeId)||null:null;this.lastJob=journal.lastId?this.jobs.get(journal.lastId)||null:null;
    if(this.active){this.reconcileRequired=true;if(this.active.previewSaved)this.active.preview={...this.active.previewSaved};}
    await this.reconcileFiles();return this;
  }
  async reconcileFiles(){
    const known=new Set(this.data.items.map(item=>item.file));let changed=false;
    for(const file of await readdir(this.output)){if(!SAFE_FILE.test(file)||known.has(file))continue;const info=await stat(join(this.output,file));if(!info.isFile()||info.size<100)continue;const bytes=await readFile(join(this.output,file));if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')continue;
      const id=file.slice(0,-4),job=this.jobs.get(id),width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
      this.data.items.push({id,file,prompt:job?.prompt||'Recovered image',ratio:job?.ratio||'square',transparent:job?.transparent||false,steps:job?.steps||null,seed:job?.seed??null,livePreview:job?.livePreview!==false,parentId:job?.parentId||null,width,height,createdAt:info.mtimeMs,recovered:true});changed=true;}
    if(changed){this.data.items.sort((a,b)=>b.createdAt-a.createdAt);await this.save();}
  }
  save(){const value=structuredClone(this.data);const pending=this.galleryWrites.then(()=>atomic(this.store,value));this.galleryWrites=pending.catch(()=>{});return pending;}
  checkpoint(){const value=structuredClone({version:1,jobs:[...this.jobs.values()],queue:this.queue,activeId:this.active?.id||null,lastId:this.lastJob?.id||null,lease:this.lease,recoveryRequired:this.recoveryRequired,recoveryModels:this.recoveryModels});const pending=this.journalWrites.then(()=>atomic(this.journal,value));this.journalWrites=pending.catch(()=>{});return pending;}
  async runner(path,body){const response=await fetch(this.runnerUrl+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(path==='/generate'?20*60_000:['/unload','/cancel'].includes(path)?45000:5000)});const value=await response.json().catch(()=>({}));if(!response.ok)throw new Error(value.error||value.detail||`Image runner returned ${response.status}.`);return value;}
  async runnerStatus(){try{this.runnerHealth=await this.runner('/health');const progress=this.runnerHealth.progress;if(this.active&&progress?.id===this.active.id&&RUNNER_PHASES.includes(progress.phase)&&RUNNER_PHASES.includes(this.active.phase)){
    const old=JSON.stringify([this.active.phase,this.active.preview]);if(RUNNER_PHASES.indexOf(progress.phase)>=RUNNER_PHASES.indexOf(this.active.phase))this.phase(progress.phase,progress.phaseAt);
    if(this.active.phase==='creating'&&progress.phase==='creating'){const sample=samplingValue(progress.sampling,this.active);if(sample)this.active.sampling=sample;}
    const preview=previewValue(progress.preview,this.active);if(preview)this.active.preview=preview;
    if(old!==JSON.stringify([this.active.phase,this.active.preview]))void this.checkpoint().catch(error=>this.log.warn(error.message));
  }return this.runnerHealth;}catch(e){this.runnerHealth={available:false,ready:false,error:'Qwen Image runner is not running. Run the one-time local setup from the Images screen.',detail:e.message};return this.runnerHealth;}}
  async routerModels(){const response=await fetch(this.routerUrl+'/v1/models',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('The local language-model router is unavailable.');const value=await response.json();return (value.data||[]).filter(m=>['loaded','loading'].includes(m.status?.value)).map(m=>m.id);}
  async routerState(model){const response=await fetch(this.routerUrl+'/v1/models',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('The local language-model router is unavailable.');const value=await response.json();return value.data?.find(row=>row.id===model)?.status?.value;}
  async waitRouter(model,wanted,timeout=600_000){const until=Date.now()+timeout;while(Date.now()<until){if(await this.routerState(model)===wanted)return;await sleep(500);}throw new Error(`The local language model did not ${wanted} in time.`);}
  async setRouter(action,model){const response=await fetch(this.routerUrl+'/models/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model}),signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`Could not ${action} the local language model.`);}
  public(item){return {...item,url:'/qwen-image/api/file?id='+encodeURIComponent(item.id)};}
  phase(phase,observedAt){if(!this.active||this.active.phase===phase)return;this.active.phase=phase;this.active.phaseAt=Number.isFinite(observedAt)?Math.max(this.active.startedAt,Math.min(Date.now(),observedAt)):Date.now();this.active.phases??=[];this.active.phases.push({phase,at:this.active.phaseAt});}
  estimate(job){if(!job)return null;const elapsed=(Date.now()-job.phaseAt)/1000;if(job.phase==='creating'&&job.sampling?.secondsPerStep)return {remainingSeconds:Math.ceil((job.sampling.total-job.sampling.step)*job.sampling.secondsPerStep),basis:'sampling',samples:job.sampling.step};const durations=[];for(const past of this.jobs.values()){if(past.phase!=='complete')continue;const index=past.phases.findIndex(row=>row.phase===job.phase),next=past.phases[index+1];if(index>=0&&next)durations.push((next.at-past.phases[index].at)/1000);}if(durations.length<3)return null;durations.sort((a,b)=>a-b);return {remainingSeconds:Math.max(0,Math.ceil(durations[Math.floor(durations.length/2)]-elapsed)),basis:'recent phase history',samples:durations.length};}
  progress(job=this.active||this.lastJob){return {active:!!this.active,job:job?{id:job.id,phase:job.phase,startedAt:job.startedAt,phaseAt:job.phaseAt,finishedAt:job.finishedAt,phases:job.phases,resumeModels:job.resumeModels||[],error:job.error,imageReady:!!job.imageReady,sampling:job.sampling,preview:job.preview,livePreview:job.livePreview,cancelRequested:!!job.cancelRequested,canCancel:!TERMINAL.has(job.phase)&&!['savingImage','restoringChat'].includes(job.phase),estimate:this.estimate(job)}:null,queue:this.queue.map(id=>this.jobs.get(id)).filter(Boolean).map(job=>({id:job.id,phase:job.phase,deferred:!!job.deferred,queuedAt:job.queuedAt})),available:this.runnerHealth?.available,ready:this.runnerHealth?.ready,loaded:!!this.runnerHealth?.loaded,recoveryRequired:!!this.recoveryRequired};}
  async preview(id){
    if(!this.active||this.active.id!==id||!this.active.preview||this.active.imageReady)throw new Error('Live preview is unavailable.');
    let body,response;try{response=await fetch(this.runnerUrl+'/preview?id='+encodeURIComponent(id),{signal:AbortSignal.timeout(5000)});const size=Number(response.headers.get('content-length'));if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='image/png'||size>1024*1024)throw new Error('Live preview is unavailable.');const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>1024*1024)throw new Error('Live preview is too large.');chunks.push(chunk);}body=Buffer.concat(chunks);}catch(error){if(response||this.active.persistedPreviewStep!==this.active.preview.step)throw error;body=await readFile(join(this.previewRoot,id+'.png')).catch(()=>{throw error;});}
    if(body.length<24||body.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||body.readUInt32BE(16)<1||body.readUInt32BE(20)<1||body.readUInt32BE(16)>512||body.readUInt32BE(20)>512)throw new Error('Invalid live preview.');
    if(this.active?.id!==id)throw new Error('Live preview expired.');if(this.active.persistedPreviewStep!==this.active.preview.step){await writeFile(join(this.previewRoot,id+'.png.tmp'),body);await rename(join(this.previewRoot,id+'.png.tmp'),join(this.previewRoot,id+'.png'));this.active.persistedPreviewStep=this.active.preview.step;this.active.previewSaved={...this.active.preview};await this.checkpoint();}return body;
  }
  remember(job){this.jobs.set(job.id,job);}
  jobStatus(id){const job=this.active?.id===id?this.active:this.jobs.get(id);if(!job)throw new Error('Image job not found.');const image=this.data.items.find(row=>row.id===id&&!row.deletedAt);return {job:{...this.progress(job).job,prompt:job.prompt},image:image?this.public(image):null};}
  async waitFor(id,timeout=20*60_000){const until=Date.now()+timeout;while(Date.now()<until){const {job,image}=this.jobStatus(id);if(TERMINAL.has(job.phase)){if(image)return {...image,...(job.error?{warning:job.error}:{})};throw new Error(job.error||'Image '+job.phase+'.');}await sleep(500);}throw new Error('Your image is still queued or running. Check its saved progress in Studio.');}
  async start(request){
    const values=normalized(request),requestId=typeof request.requestId==='string'&&request.requestId.length<=128?request.requestId:null,hash=fingerprint(values);
    if(requestId){const prior=[...this.jobs.values()].find(job=>job.requestId===requestId);if(prior){if(prior.fingerprint!==hash)throw new Error('This request ID was already used for another image.');await this.checkpoint();return {id:prior.id,accepted:true,phase:prior.phase,duplicate:true};}}
    if(this.queue.length>=20)throw new Error('The image queue is full.');const now=Date.now(),job={id:randomUUID(),...values,requestId,fingerprint:hash,queuedAt:now,startedAt:now,phaseAt:now,phase:request.deferred?'deferred':'queued',deferred:!!request.deferred,phases:[],resumeModels:[]};this.remember(job);this.queue.push(job.id);await this.checkpoint();this.enabled=true;this.kick();return {id:job.id,accepted:true,phase:job.phase};
  }
  history(){return {active:this.active?{...this.progress().job,prompt:this.active.prompt}:null,lastJob:this.progress().job,queue:this.progress().queue.map(job=>({...job,prompt:this.jobs.get(job.id)?.prompt})),items:this.data.items.filter(item=>!item.deletedAt).map(x=>this.public(x)),deleted:this.data.items.filter(item=>item.deletedAt).map(x=>this.public(x)),ratios:Object.keys(RATIOS)};}
  async status(){const runner=await this.runnerStatus();return {...runner,...this.progress(),active:this.active?{...this.progress().job,prompt:this.active.prompt}:null,queue:this.progress().queue.map(job=>({...job,prompt:this.jobs.get(job.id)?.prompt})),history:this.data.items.filter(item=>!item.deletedAt).length,ratios:Object.keys(RATIOS),model:'Qwen/Qwen-Image-2.1'};}
  file(id){const item=this.data.items.find(row=>row.id===id&&!row.deletedAt);if(!item)throw new Error('Image not found.');return join(this.output,item.file);}
  async restore(models){
    this.recoveryRequired=true;this.recoveryModels=[...models];await this.checkpoint();await this.runner('/unload',{});this.runnerHealth={...this.runnerHealth,loaded:false};
    const failures=[];for(const model of models)try{const state=await this.routerState(model);if(state!=='loaded'){if(state!=='loading')await this.setRouter('load',model);await this.waitRouter(model,'loaded');}}catch(error){failures.push(model);this.log.warn('Could not restore '+model+': '+error.message);}
    this.recoveryModels=failures;if(failures.length){await this.checkpoint();throw new Error('The chat model could not be restored. Retry restoring chat.');}
    this.recoveryRequired=false;this.lease=null;await this.checkpoint();
  }
  async retryRestore(){if(this.active)throw new Error('Wait for the current image job to finish.');const models=[...this.recoveryModels];if(!this.recoveryRequired)return this.status();const now=Date.now();this.active={id:randomUUID(),startedAt:now,phaseAt:now,phase:'restoringChat',phases:[{phase:'restoringChat',at:now}],resumeModels:models,imageReady:!!this.lastJob?.imageReady};this.remember(this.active);await this.checkpoint();try{await this.restore(models);this.phase('complete');}catch(error){this.phase('error');this.active.error=error.message;throw error;}finally{this.active.finishedAt=Date.now();this.lastJob=this.active;this.active=null;await this.checkpoint();this.kick();}return this.status();}
  async generate(request,jobId){
    const values=normalized(request);const task=()=>this.execute(Object.assign(jobId&&this.jobs.get(jobId)||{id:jobId||randomUUID()},values));const job=this.serial.then(task);this.serial=job.catch(()=>{});return job;
  }
  async execute(job){
    if(this.recoveryRequired)throw new Error('Restore the chat model before starting another image.');const now=Date.now(),size=RATIOS[job.ratio];Object.assign(job,{startedAt:now,phaseAt:now,phase:'preparing',phases:[{phase:'preparing',at:now}],resumeModels:[]});this.active=job;this.remember(job);this.queue=this.queue.filter(id=>id!==job.id);this.pendingStart=false;await this.checkpoint();let item,error,handoffStarted=false;
    try{
      if(!(await this.canStart()))throw new Error('Seek is using the language model right now. Wait for the current reply or task to finish, then generate the image.');
      this.throwCancelled(job);const runner=await this.runnerStatus();if(!runner.available||!runner.ready)throw new Error(runner.error||'Qwen Image is not installed yet. Use Set up local model in Images.');if(runner.busy&&runner.progress?.id!==job.id)throw new Error('The image runner is already working on another image.');
      const loaded=await this.routerModels();job.resumeModels=loaded;this.lease={jobId:job.id,resumeModels:loaded,acquiredAt:Date.now()};this.recoveryModels=[...loaded];this.phase('releasingChat');await this.checkpoint();handoffStarted=true;
      for(const model of loaded){this.throwCancelled(job);await this.setRouter('unload',model);await this.waitRouter(model,'unloaded');}
      this.throwCancelled(job);this.phase('loadingImage');await this.checkpoint();
      this.throwCancelled(job);const result=await this.runner('/generate',{id:job.id,prompt:job.prompt,transparent:job.transparent,steps:job.steps,width:size[0],height:size[1],outputDir:this.output,livePreview:job.livePreview,seed:job.seed});this.phase('savingImage');await this.checkpoint();
      const file=basename(String(result.file||''));if(!file||!SAFE_FILE.test(file)||file!==job.id+'.png')throw new Error('The image runner returned an invalid output file.');const meta=await stat(join(this.output,file));if(!meta.isFile()||meta.size<100)throw new Error('The image runner did not create an output image.');
      item={id:job.id,file,prompt:job.prompt,ratio:job.ratio,transparent:job.transparent,steps:job.steps,width:Number(result.width)||size[0],height:Number(result.height)||size[1],seed:result.seed??job.seed??null,livePreview:job.livePreview,parentId:job.parentId||null,createdAt:Date.now()};if(!this.data.items.some(row=>row.id===job.id))this.data.items.unshift(item);await this.save();job.imageReady=true;await this.checkpoint();
    }catch(cause){error=cause;}
    finally{
      if(handoffStarted){this.phase('restoringChat');await this.checkpoint();try{await this.restore(job.resumeModels);}catch(cause){error??=cause;}}
      this.phase(error?(job.cancelRequested&&!this.recoveryRequired?'cancelled':'error'):'complete');job.error=error?.message;job.finishedAt=Date.now();this.lastJob=job;this.active=null;await this.checkpoint();
    }
    if(error&&!item)throw error;return {...this.public(item),...(error?{warning:error.message}:{})};
  }
  throwCancelled(job){if(job.cancelRequested)throw new Error('Image cancelled. Chat is being restored.');}
  async cancel(id){const job=this.jobs.get(id);if(!job)throw new Error('Image job not found.');if(TERMINAL.has(job.phase))return this.jobStatus(id);if(job===this.active){if(['savingImage','restoringChat'].includes(job.phase))throw new Error('The image is finishing safely; chat restoration cannot be cancelled.');job.cancelRequested=true;await this.checkpoint();if(RUNNER_PHASES.includes(job.phase))await this.runner('/cancel',{id});}else{this.queue=this.queue.filter(value=>value!==id);Object.assign(job,{phase:'cancelled',finishedAt:Date.now(),phaseAt:Date.now()});await this.checkpoint();}return this.jobStatus(id);}
  async defer(id,deferred=true){const job=this.jobs.get(id);if(!job||!this.queue.includes(id))throw new Error('Only queued images can be deferred.');Object.assign(job,{deferred:!!deferred,phase:deferred?'deferred':'queued',phaseAt:Date.now()});await this.checkpoint();this.kick();return this.history();}
  kick(){if(!this.enabled||this.pumping||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.pump();},20);this.timer.unref?.();}
  async resume(){this.enabled=true;if(this.reconcileRequired)await this.reconcile();else if(this.recoveryRequired&&!this.active)await this.retryRestore().catch(error=>this.log.warn(error.message));this.kick();}
  async pump(){if(this.pumping||!this.enabled)return;this.pumping=true;try{if(this.active||this.recoveryRequired)return;const job=this.queue.map(id=>this.jobs.get(id)).find(job=>job&&!job.deferred);if(!job)return;if(!(await this.canStart()))return;try{await this.generate(job,job.id);}catch(error){this.log.warn('Image job failed: '+error.message);}}finally{this.pumping=false;if(this.enabled&&this.queue.some(id=>!this.jobs.get(id)?.deferred)&&!this.recoveryRequired){this.timer=setTimeout(()=>{this.timer=null;void this.pump();},this.queueIntervalMs);this.timer.unref?.();}}}
  async reconcile(){
    if(this.reconciling)return this.reconciling;this.reconciling=this.reconcileActive().finally(()=>{this.reconciling=null;});return this.reconciling;
  }
  async reconcileActive(){
    const job=this.active;if(!job){this.reconcileRequired=false;return;}await this.reconcileFiles();const health=await this.runnerStatus();if(health.available===false&&health.detail){this.log.warn('Image recovery waits for the runner to respond.');if(this.enabled){this.timer=setTimeout(()=>{this.timer=null;void this.reconcile().catch(error=>this.log.warn(error.message));},Math.max(5000,this.queueIntervalMs));this.timer.unref?.();}return;}
    // Reattach to an owned live runner; never issue a second generation request.
    const running=health.progress?.id===job.id&&(typeof health.busy==='boolean'?health.busy:health.loaded||health.loading);
    if(running&&RUNNER_PHASES.includes(health.progress.phase)){this.timer=setTimeout(()=>{this.timer=null;void this.reconcile().catch(error=>this.log.warn(error.message));},this.queueIntervalMs);this.timer.unref?.();return;}
    job.imageReady=this.data.items.some(item=>item.id===job.id);job.error=job.imageReady?undefined:'The image job was interrupted. Your prompt and settings are saved.';
    if(this.lease||this.recoveryRequired){this.phase('restoringChat');await this.checkpoint();try{await this.restore(job.resumeModels||this.recoveryModels);}catch(error){job.error=error.message;}}
    this.phase(this.recoveryRequired?'error':job.imageReady?'complete':job.cancelRequested?'cancelled':'interrupted');job.finishedAt=Date.now();this.lastJob=job;this.active=null;this.reconcileRequired=false;await this.checkpoint();this.kick();
  }
  close(){this.enabled=false;clearTimeout(this.timer);this.timer=null;}
  async remove(id){const item=this.data.items.find(row=>row.id===id&&!row.deletedAt);if(!item)throw new Error('Image not found.');item.deletedAt=Date.now();await this.save();return this.history();}
  async favorite(id,favorite=true){const item=this.data.items.find(row=>row.id===id&&!row.deletedAt);if(!item)throw new Error('Image not found.');if(favorite)item.favoriteAt=Date.now();else delete item.favoriteAt;await this.save();return this.history();}
  async undelete(id){const item=this.data.items.find(row=>row.id===id&&row.deletedAt);if(!item)throw new Error('Deleted image not found.');delete item.deletedAt;await this.save();return this.history();}
}
