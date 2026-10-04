// Preview pixels use their own endpoint; model-state events contain only metadata.
const frames=new WeakMap();
const livePhases=new Set(['preparing','releasingChat','loadingImage','creating','savingImage','restoringChat']);
const visible=()=>!document.hidden&&(!document.querySelector('nav [data-view].active')||document.querySelector('nav [data-view].active').dataset.view==='images');
function frameValue(job){
  const value=job?.preview;
  if(!value||!Number.isInteger(value.step)||!Number.isInteger(value.total)||value.step<1||value.step>value.total||value.total>40||!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1||value.width>512||value.height>512||!Number.isFinite(value.updatedAt)||value.updatedAt<job.startedAt)return null;
  return value;
}
export function clearImagePreview(slot){
  const state=frames.get(slot);state?.observer?.disconnect();state?.controller?.abort();if(state?.url)URL.revokeObjectURL(state.url);frames.delete(slot);slot.replaceChildren();slot.hidden=true;
}
export async function updateImagePreview(slot,models){
  const job=models?.job;
  if(!models?.active||!job||!livePhases.has(job.phase)||!/^[a-f0-9-]{36}$/.test(job.id)){clearImagePreview(slot);return;}
  if(!visible()){const state=frames.get(slot);state?.controller?.abort();if(state){state.requested=null;state.pending=null;}return;}
  let state=frames.get(slot);
  if(state?.id!==job.id){
    clearImagePreview(slot);state={id:job.id,version:null,requested:null};frames.set(slot,state);
    state.observer=new MutationObserver(()=>{if(!slot.isConnected)clearImagePreview(slot);});state.observer.observe(slot.closest('#main')||document.body,{childList:true});
    slot.className='image-live-preview';slot.innerHTML='<figure><div class="image-preview-frame"><span>Waiting for the first preview…</span></div><figcaption><strong>Live preview</strong><span>Low-resolution estimate · details may change</span></figcaption></figure>';
  }
  const value=frameValue(job),final=!!job.imageReady;
  if(!value&&!final){slot.hidden=false;const labels={preparing:'Preparing your image…',releasingChat:'Making room for the image model…',loadingImage:'Loading Qwen Image…',creating:'Waiting for the first real preview…',savingImage:'Saving the final image…',restoringChat:'Bringing chat back…'};slot.querySelector('.image-preview-frame>span')?.replaceChildren(document.createTextNode(labels[job.phase]||'Preparing your image…'));slot.querySelector('figcaption span').textContent=job.livePreview===false?'Live preview is off. The finished image will appear here.':'Actual low-resolution frames appear when sampling starts.';return;}
  slot.hidden=false;
  const version=final?'final':String(value.step),source=final?'/qwen-image/api/file?id='+encodeURIComponent(job.id):'/qwen-image/api/preview?id='+encodeURIComponent(job.id)+'&v='+version;
  if(state.version===version||state.requested===version||state.version==='final'||!final&&Number(version)<Number(state.version))return;
  if(state.controller){state.pending=models;return state.promise;}
  const controller=new AbortController();state.controller=controller;state.requested=version;
  state.promise=loadFrame();return state.promise;
  async function loadFrame(){
  let objectUrl;
  try{
    const response=await fetch(source,{signal:controller.signal,cache:final?'default':'no-store'});
    if(!response.ok)throw new Error('Preview unavailable');
    const blob=await response.blob();if(!final&&blob.size>1024*1024)throw new Error('Preview too large');
    objectUrl=URL.createObjectURL(blob);const picture=new Image();picture.alt=final?'Your generated image':'Live, low-resolution view of the image being generated';picture.decoding='async';picture.src=objectUrl;await picture.decode();
    if(controller.signal.aborted||frames.get(slot)!==state||state.requested!==version||!slot.isConnected||!visible())return;
    const frame=slot.querySelector('.image-preview-frame');frame.style.aspectRatio=picture.naturalWidth+'/'+picture.naturalHeight;frame.replaceChildren(picture);
    if(state.url)URL.revokeObjectURL(state.url);state.url=objectUrl;objectUrl=null;state.version=version;
    slot.querySelector('figcaption strong').textContent=final?'Your image is ready':'Live preview · step '+value.step+' of '+value.total;
    slot.querySelector('figcaption span').textContent=final?'Saved to your gallery · bringing chat back':'Low-resolution estimate · details may change';
  }catch(error){if(!controller.signal.aborted)state.requested=null;}
  finally{
    if(objectUrl)URL.revokeObjectURL(objectUrl);if(state.controller===controller)state.controller=null;
    const pending=state.pending;state.pending=null;if(pending&&frames.get(slot)===state&&slot.isConnected&&visible())await updateImagePreview(slot,pending);
  }
  }
}
