import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageService} from '../../qwen-image/lib/image-service.js';
import {WorkModelStatus} from '../lib/work-model-status.js';
import {imageProgress,modelRibbon} from '../lib/work-model-client.js';

async function fixture(){
 const service=await new ImageService(await mkdtemp(join(tmpdir(),'seek-sampling-'))).init();
 service.active={id:'current',phase:'loadingImage',phaseAt:100,startedAt:100,steps:30,phases:[]};
 const data={available:true,ready:true,progress:{id:'current',phase:'creating',phaseAt:200,sampling:{step:12,total:30,secondsPerStep:2.12,updatedAt:201,prompt:'must not leak'}}};
 service.runner=async()=>data;return {service,data};
}
test('observed engine steps pass through job status and model health without exposing extra fields',async()=>{
 const {service}=await fixture();await service.runnerStatus();
 assert.equal(service.active.phaseAt,200);assert.deepEqual(service.jobStatus('current').job.sampling,{step:12,total:30,secondsPerStep:2.12,updatedAt:201});
 let notices=0;const monitor=new WorkModelStatus({images:()=>({snapshot:()=>service.progress(),refresh:()=>service.runnerStatus()}),fetchImpl:async()=>Response.json({data:[]}),onChange:()=>notices++});await monitor.refresh();assert.equal(monitor.snapshot().job.sampling.step,12);assert.equal(notices,1);
});
test('sampling rejects old jobs, mismatched totals, stale records and backwards stages',async()=>{
 const {service,data}=await fixture();await service.runnerStatus();
 for(const sample of [{step:11,total:30,updatedAt:202},{step:20,total:40,updatedAt:202},{step:31,total:30,updatedAt:202},{step:15,total:30,updatedAt:199},{step:'15',total:30,updatedAt:202}]){data.progress.sampling=sample;await service.runnerStatus();assert.equal(service.active.sampling.step,12);}
 data.progress={id:'old',phase:'creating',sampling:{step:25,total:30,updatedAt:203}};await service.runnerStatus();assert.equal(service.active.sampling.step,12);
 data.progress={id:'current',phase:'loadingImage'};await service.runnerStatus();assert.equal(service.active.phase,'creating');
 data.progress={id:'current',phase:'savingImage',phaseAt:204};await service.runnerStatus();data.progress={id:'current',phase:'creating',phaseAt:203,sampling:{step:30,total:30,updatedAt:205}};await service.runnerStatus();assert.equal(service.active.phase,'savingImage');assert.equal(service.active.sampling.step,12);
});
test('sampling alone changes model health and completed sampling does not mark the job complete',async()=>{
 const {service,data}=await fixture();let notices=0;
 const monitor=new WorkModelStatus({images:()=>({snapshot:()=>service.progress(),refresh:()=>service.runnerStatus()}),fetchImpl:async()=>Response.json({data:[]}),onChange:()=>notices++});await monitor.refresh();
 data.progress.sampling={step:30,total:30,updatedAt:205};await monitor.refresh();assert.equal(notices,2);
 const models=monitor.snapshot();assert.equal(models.active,true);assert.equal(models.job.phase,'creating');
 const html=imageProgress(models);assert.match(html,/Step 30 of 30/);assert.match(html,/Finishing your image/);assert.match(html,/aria-valuenow="30"/);assert.ok(!html.includes('HANDOFF COMPLETE'));assert.match(modelRibbon(models),/30\/30/);
 models.job.phase='restoringChat';assert.ok(!imageProgress(models).includes('aria-valuenow'));
});
test('unknown or invalid sampling leaves the phase indicator indeterminate',()=>{
 const models={active:true,language:{name:'Qwen chat',state:'standby'},image:{name:'Qwen Image',state:'creating'},job:{phase:'creating',phaseAt:100}};
 for(const sampling of [undefined,{step:-1,total:30,updatedAt:101},{step:31,total:30,updatedAt:101},{step:12,total:0,updatedAt:101},{step:12,total:30,updatedAt:99},{step:12,total:30,updatedAt:NaN}]){models.job.sampling=sampling;assert.ok(!imageProgress(models).includes('aria-valuenow'));assert.ok(!modelRibbon(models).includes('12/30'));}
});
