// No live endpoints or model processes: all resource transitions use isolated mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageService} from '../../qwen-image/lib/image-service.js';
import {WorkEngine,modelWorkBlocksImages} from '../lib/work-server.js';
import {FakeHarness} from './fake-harness.mjs';

const png=Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64'),Buffer.alloc(128)]);
const id='a9b13c91-50f8-4e6b-81c4-94512e7b0c68';
const log={warn(){}};
async function fresh(options={}){const root=await mkdtemp(join(tmpdir(),'seek-image-recovery-'));const service=await new ImageService(root,{log,...options}).init();return {root,service};}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const end=Date.now()+3000;while(Date.now()<end){if(await predicate())return;await delay(10);}throw new Error('Image recovery fixture timed out');}
function engine(service,{busy=false,generated=false}={}){const calls=[];let state='unloaded';service.runner=async(path,body)=>{calls.push([path,body]);if(path==='/health')return {available:true,ready:true,busy,loaded:busy,progress:{id,phase:'creating',phaseAt:100}};if(path==='/unload')return {released:true};if(path==='/cancel')return {accepted:true};if(path==='/generate'){await writeFile(join(body.outputDir,body.id+'.png'),png);return {file:body.id+'.png',width:body.width,height:body.height,seed:body.seed??42};}throw new Error('Unexpected mock runner action');};service.routerModels=async()=>['qwen'];service.routerState=async()=>state;service.setRouter=async(action,model)=>{calls.push([action,model]);state=action==='load'?'loaded':'unloaded';};service.waitRouter=async()=>{};return calls;}

test('accepted requests are durable, idempotent, and conflicting reuse is rejected',async()=>{
  const {root,service}=await fresh({canStart:()=>false});try{
    const [first,second]=await Promise.all([service.start({prompt:'A fixture.',requestId:'same'}),service.start({prompt:'A fixture.',requestId:'same'})]);assert.equal(first.id,second.id);assert.equal(service.queue.length,1);
    const disk=JSON.parse(await readFile(service.journal,'utf8'));assert.equal(disk.queue[0],first.id);assert.equal(disk.jobs.length,1);
    await assert.rejects(service.start({prompt:'Different fixture.',requestId:'same'}),/another image/);
    const restored=await new ImageService(root,{canStart:()=>false,log}).init();assert.equal(restored.queue[0],first.id);assert.equal((await restored.start({prompt:'A fixture.',requestId:'same'})).duplicate,true);restored.close();
  }finally{service.close();}
});

test('queue deferral and cancellation never touch the GPU; resumption respects foreground ownership',async()=>{
  let free=false;const {service}=await fresh({canStart:()=>free,queueIntervalMs:10});const calls=engine(service);try{
    const first=await service.start({prompt:'Deferred fixture.',deferred:true}),second=await service.start({prompt:'Cancelled fixture.'});
    await service.cancel(second.id);await delay(60);assert.equal(calls.length,0);assert.equal(service.jobStatus(second.id).job.phase,'cancelled');
    await service.defer(first.id,false);await delay(50);assert.equal(calls.length,0,'Foreground work owns the GPU');free=true;await until(()=>service.jobStatus(first.id).job.phase==='complete');assert.equal(calls.filter(row=>row[0]==='/generate').length,1);
    assert.equal(service.history().items[0].seed,42);assert.deepEqual(service.history().queue,[]);
  }finally{service.close();}
});

test('a user task queued during image1 claims the restored model before image2',async()=>{
  const root=await mkdtemp(join(tmpdir(),'seek-image-foreground-')),order=[],sessions=[];
  const harness=new FakeHarness();
  harness.createSession=async()=>{const row=harness.add('foreground-session');sessions.push(row);return {sessionId:row.sessionId};};
  harness.prompt=async()=>{order.push('user-task');sessions[0].running=true;return {accepted:true};};
  const work=new WorkEngine(harness,root,log);await work.init();
  const image=await new ImageService(root,{log,canStart:()=>!modelWorkBlocksImages(work),queueIntervalMs:60000}).init();
  work.resourceBusy=()=>!!image.active||image.recoveryRequired;
  engine(image);let releaseFirst,firstStarted=false,generated=0;const runner=image.runner;
  image.runner=async(path,body)=>{if(path!=='/generate')return runner(path,body);order.push('image'+(++generated));if(generated===1){firstStarted=true;await new Promise(resolve=>{releaseFirst=resolve;});}await writeFile(join(body.outputDir,body.id+'.png'),png);return {file:body.id+'.png',width:body.width,height:body.height,seed:10};};
  try{
    const first=await image.start({prompt:'First isolated fixture image.'});await until(()=>firstStarted);
    const second=await image.start({prompt:'Second isolated fixture image.'}),task=await work.create({objective:'A queued foreground fixture reply.',mode:'chat'});
    await work.tick();assert.equal(task.status,'queued');assert.deepEqual(order,['image1'],'The active image retains its lease');
    releaseFirst();await until(()=>image.jobStatus(first.id).job.phase==='complete'&&!image.pumping);
    clearTimeout(image.timer);image.timer=null;await image.pump();
    assert.deepEqual(order,['image1'],'Even if the image timer wins the race, queued user work gets the restored model');
    await work.tick();assert.equal(task.status,'running');assert.deepEqual(order,['image1','user-task']);
    clearTimeout(image.timer);image.timer=null;await image.pump();assert.deepEqual(order,['image1','user-task'],'Image2 waits while the user reply is running');
    sessions[0].running=false;task.status='complete';await work.save();
    clearTimeout(image.timer);image.timer=null;await image.pump();assert.equal(image.jobStatus(second.id).job.phase,'complete');assert.deepEqual(order,['image1','user-task','image2']);
  }finally{releaseFirst?.();image.close();await work.serial;}
});

for(const phase of ['preparing','releasingChat','loadingImage','creating','savingImage','restoringChat'])test('restart accounts for accepted work after '+phase,async()=>{
  const {root,service}=await fresh(),now=Date.now();const handed=phase!=='preparing';const job={id,prompt:'Recovered fixture.',ratio:'portrait',steps:24,seed:93,livePreview:false,startedAt:now,phaseAt:now,phase,phases:[{phase,at:now}],resumeModels:handed?['qwen']:[]};service.jobs.set(id,job);service.active=job;if(handed)service.lease={jobId:id,resumeModels:['qwen'],acquiredAt:now};
  if(['savingImage','restoringChat'].includes(phase))await writeFile(join(service.output,id+'.png'),png);await service.checkpoint();service.close();
  const resumed=await new ImageService(root,{log}).init();const calls=engine(resumed);try{await resumed.reconcile();assert.equal(resumed.active,null);assert.equal(resumed.lease,null);assert.equal(resumed.recoveryRequired,false);assert.equal(resumed.jobStatus(id).job.phase,['savingImage','restoringChat'].includes(phase)?'complete':'interrupted');assert.equal(calls.filter(row=>row[0]==='/generate').length,0,'Reconciliation cannot submit inference again');if(handed)assert.equal(calls.filter(row=>row[0]==='load').length,1);if(phase==='preparing')assert.equal(calls.filter(row=>row[0]==='/unload').length,0);if(phase==='savingImage')assert.equal(resumed.history().items[0].prompt,job.prompt);}finally{resumed.close();}
});

test('restart attaches to the owned live runner and recovers its final file without resubmission',async()=>{
  const {root,service}=await fresh(),now=Date.now();const job={id,prompt:'Still running fixture.',ratio:'square',steps:30,startedAt:now,phaseAt:now,phase:'creating',phases:[{phase:'creating',at:now}],resumeModels:['qwen']};service.jobs.set(id,job);service.active=job;service.lease={jobId:id,resumeModels:['qwen']};await service.checkpoint();service.close();
  const resumed=await new ImageService(root,{log}).init(),calls=engine(resumed,{busy:true});try{await resumed.reconcile();assert.equal(resumed.active.id,id);assert.equal(calls.length,1);await writeFile(join(resumed.output,id+'.png'),png);engine(resumed,{busy:false});await resumed.reconcile();assert.equal(resumed.jobStatus(id).job.phase,'complete');assert.equal(resumed.history().items.length,1);}finally{resumed.close();}
});

test('corrupt gallery and journal originals are preserved and backups remain recoverable',async()=>{
  const {root,service}=await fresh();service.data.items=[{id,file:id+'.png',prompt:'Preserved fixture.',createdAt:1}];await writeFile(join(service.output,id+'.png'),png);await service.save();await service.save();await service.start({prompt:'Queued fixture.',deferred:true,requestId:'recover-queue'});await service.checkpoint();service.close();
  await writeFile(service.store,'broken json');await writeFile(service.journal,'broken jobs');const restored=await new ImageService(root,{log}).init();try{assert.equal(restored.history().items.length,1);assert.equal(restored.queue.length,1);const files=await readdir(restored.root);assert.equal(files.filter(file=>file.startsWith('images.json.corrupt-')).length,1);assert.equal(files.filter(file=>file.startsWith('jobs.json.corrupt-')).length,1);await restored.save();assert.equal((await readFile(join(restored.root,files.find(file=>file.startsWith('images.json.corrupt-'))),'utf8')),'broken json');}finally{restored.close();}
});

test('history keeps older records and soft deletion supports undo across reload without losing pixels',async()=>{
  const {root,service}=await fresh();service.data.items=Array.from({length:125},(_,index)=>({id:'record-'+index,file:'record-'+index+'.png',prompt:'Saved '+index,createdAt:index}));await writeFile(join(service.output,'record-124.png'),png);await service.save();await service.remove('record-124');assert.equal(service.history().items.length,124);assert.equal((await stat(join(service.output,'record-124.png'))).size,png.length);service.close();const restored=await new ImageService(root,{log}).init();try{assert.equal(restored.history().deleted[0].id,'record-124');await restored.undelete('record-124');assert.equal(restored.history().items.length,125);assert.equal(restored.file('record-124'),join(restored.output,'record-124.png'));}finally{restored.close();}
});

test('a failed restoration retains its exact durable lease and blocks subsequent generation',async()=>{
  const {root,service}=await fresh();engine(service);service.setRouter=async action=>{if(action==='load')throw new Error('Restoration fixture unavailable');};const image=await service.generate({prompt:'Restoration fixture.'});assert.ok(image.warning);const disk=JSON.parse(await readFile(service.journal,'utf8'));assert.deepEqual(disk.recoveryModels,['qwen']);assert.equal(disk.lease.jobId,image.id);await assert.rejects(service.generate({prompt:'Cannot steal GPU.'}),/Restore/);service.close();const restored=await new ImageService(root,{log}).init();engine(restored);try{await restored.retryRestore();assert.equal(restored.recoveryRequired,false);assert.equal(restored.history().items.length,1);}finally{restored.close();}
});

test('cancelling an active image waits for safe chat restoration and preserves any final output',async()=>{
  const {service}=await fresh();const calls=engine(service);let reject,requested=false;const runner=service.runner;service.runner=async(path,body)=>{if(path==='/generate'){requested=true;return new Promise((_,no)=>{reject=no;});}if(path==='/cancel'){reject(new Error('Cancelled mock generation'));return {accepted:true};}return runner(path,body);};
  const generation=service.generate({prompt:'Active cancellation fixture.'});const result=generation.catch(error=>error);await until(()=>requested);const jobId=service.active.id;await service.cancel(jobId);assert.ok(await result instanceof Error);assert.equal(service.jobStatus(jobId).job.phase,'cancelled');assert.equal(service.recoveryRequired,false);assert.equal(calls.filter(row=>row[0]==='load').length,1);service.close();
});

test('sampling estimates use observed steps and phase estimates require three successful histories',async()=>{
  const {service}=await fresh();try{const job={phase:'creating',phaseAt:Date.now(),sampling:{step:12,total:30,secondsPerStep:2}};assert.equal(service.estimate(job).remainingSeconds,36);assert.equal(service.estimate({phase:'loadingImage',phaseAt:Date.now()}),null);for(let index=0;index<3;index++)service.jobs.set('past'+index,{phase:'complete',phases:[{phase:'loadingImage',at:1000},{phase:'creating',at:21000}]});assert.equal(service.estimate({phase:'loadingImage',phaseAt:Date.now()}).samples,3);}finally{service.close();}
});
