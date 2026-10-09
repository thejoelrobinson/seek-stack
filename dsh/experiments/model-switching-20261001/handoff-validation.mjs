import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='http://127.0.0.1:3080',sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body){const response=await fetch(root+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});const result=await response.json();assert.ok(response.ok,result.error||'API failed');return result;}
const state=await api('/work/api/state'),gallery=await api('/qwen-image/api/history'),helpers=await api('/work/api/helper-status'),models=(await api('/work/api/updates')).health.models;
assert.ok(!helpers.foregroundBusy&&!helpers.active&&!helpers.pending&&!models.active&&!models.recoveryRequired&&models.language.state==='ready');
assert.ok(!state.tasks.some(t=>['running','queued'].includes(t.status)||t.status==='waiting'&&(t.goal?.phase!=='paused'||!t.question||t.nativeRequest||t.approval||t.handoff)),'No ongoing task may be interrupted');
const {id}=await api('/qwen-image/api/start',{prompt:'A tiny friendly lavender plush sprout resting beside a smooth cream ceramic cup, soft evening studio light, minimal warm background, beautifully textured editorial product photograph.',steps:24,ratio:'square',livePreview:true});
let final,phase,lastStep=0;const previews=[],deadline=Date.now()+20*60_000;
while(Date.now()<deadline){
 const status=await api('/qwen-image/api/job?id='+id),job=status.job;
 if(job.phase!==phase){phase=job.phase;console.log(JSON.stringify({phase}));}
 if(job.preview?.step>lastStep&&!job.imageReady){
  const response=await fetch(root+'/qwen-image/api/preview?id='+id+'&v='+job.preview.step);
  if(response.ok){const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),64);assert.equal(bytes.readUInt32BE(20),64);assert.ok(bytes.length<16000);previews.push({step:job.preview.step,bytes:bytes.length});lastStep=job.preview.step;}
 }
 if(['error','complete'].includes(phase)){final=status;break;}
 await sleep(750);
}
assert.ok(final?.image,'Validation image must have been saved');
function pngParts(bytes){assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');const pixels=[],texts=[];for(let position=8;position+12<=bytes.length;){const length=bytes.readUInt32BE(position),kind=bytes.toString('ascii',position+4,position+8),data=bytes.subarray(position+8,position+8+length);if(kind==='IDAT')pixels.push(data);if(kind==='tEXt')texts.push(data.toString('utf8'));position+=12+length;}return {pixelSha256:createHash('sha256').update(Buffer.concat(pixels)).digest('hex'),texts};}
const bytes=Buffer.from(await fetch(root+final.image.url).then(r=>r.arrayBuffer())),current=pngParts(bytes),prior=pngParts(await readFile(new URL('../image-preview-20260930/validation/final-image-with-metadata.png',import.meta.url)));
// Remove only this script's completed fixture, including on validation failure.
await api('/qwen-image/api/delete',{id});
assert.equal(final.job.phase,'complete',final.job.error);
assert.equal(current.pixelSha256,prior.pixelSha256,'Only the chat weights path changed; generated pixels must match the previous validated image');
assert.ok(current.texts.some(text=>text.startsWith('parameters\0')&&/Seed:\s*42\b/.test(text)&&/Steps:\s*24\b/.test(text)));
assert.ok(previews.length>=3,'Live sampling previews must still arrive');
assert.deepEqual((await api('/qwen-image/api/history')).items,gallery.items);
const after=await api('/work/api/state');assert.deepEqual(after.tasks,state.tasks);assert.deepEqual(after.settings,state.settings);
const runner=await fetch('http://127.0.0.1:18810/health').then(r=>r.json());assert.equal(runner.loaded,false);
const health=(await api('/work/api/updates')).health.models;assert.equal(health.active,false);assert.equal(health.recoveryRequired,false);assert.equal(health.language.state,'ready');
const phases=final.job.phases,at=name=>phases.find(p=>p.phase===name)?.at;
const result={passed:true,totalMs:final.job.finishedAt-final.job.startedAt,releaseChatMs:at('loadingImage')-at('releasingChat'),loadImageMs:at('creating')-at('loadingImage'),generationMs:at('savingImage')-at('creating'),restoreChatMs:at('complete')-at('restoringChat'),previews,pixelsUnchanged:true,pixelSha256:current.pixelSha256,metadataBytes:current.texts.reduce((n,text)=>n+Buffer.byteLength(text),0),existingTasks:state.tasks.length,existingImages:gallery.items.length,checks:['Real chat-to-image-to-chat handoff','64px native live previews retained','Identical generated pixels','Generation metadata preserved','Chat ready and image engine released','Own fixture removed; existing tasks/settings/gallery preserved']};
await writeFile(new URL('./validation/handoff-validation.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
