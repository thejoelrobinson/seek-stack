export function modelName(id){
  if(!id)return 'Qwen chat';
  return String(id).replace(/^.*\//,'').replace(/^(qwen|gemma)[-_]?(\d+(?:\.\d+)?)/i,(_m,family,version)=>family[0].toUpperCase()+family.slice(1).toLowerCase()+' '+version).replace(/[-_](\d+)b\b/i,' · $1B').replace(/[-_]/g,' ');
}

// Observe model ownership without issuing load/unload requests.
export class WorkModelStatus {
  constructor({routerUrl=process.env.SEEK_MODEL_URL||'http://127.0.0.1:18798',images=()=>null,fetchImpl=globalThis.fetch,onChange=()=>{},now=Date.now}={}){this.routerUrl=routerUrl.replace(/\/$/,'');this.images=images;this.fetchImpl=fetchImpl;this.onChange=onChange;this.now=now;this.models=[];this.state='checking';this.checkedAt=0;this.lastReady=null;this.transition=null;this.signature='';this.pending=null;}
  snapshot(){
    const images=this.images()?.snapshot()||{},job=images.job,loading=this.models.find(m=>['loading','unloading'].includes(m.status?.value)),loaded=this.models.find(m=>m.status?.value==='loaded');
    const languageId=loading?.id||loaded?.id||job?.resumeModels?.[0]||this.lastReady;
    let languageState=loading?(loading.status.value==='unloading'?'releasing':'loading'): (loaded?'ready':this.state==='offline'?'offline':this.state==='checking'?'checking':'standby');
    let imageState=images.available===false?'offline':'standby';
    if(images.active){
      if(job.phase==='preparing')imageState='waiting';
      if(job.phase==='releasingChat'){languageState='releasing';imageState='waiting';}
      if(job.phase==='loadingImage'){languageState='standby';imageState='loading';}
      if(['creating','savingImage'].includes(job.phase)){languageState='standby';imageState=job.phase==='creating'?'creating':'saving';}
      if(job.phase==='restoringChat'){languageState='loading';imageState=images.loaded?'releasing':'standby';}
    }
    if(images.recoveryRequired)languageState=images.active?'loading':'error';
    if(!images.active&&job?.phase==='complete'&&this.state==='online'&&job.finishedAt>(this.routerObservedAt||0)&&job.resumeModels?.includes(languageId))languageState='ready';
    return {language:{id:languageId||null,name:modelName(languageId),state:languageState},image:{name:'Qwen Image 2.1',state:imageState,available:images.available},active:!!images.active,job:job||null,queue:images.queue||[],recoveryRequired:!!images.recoveryRequired,transition:this.transition};
  }
  async refresh(){
    if(this.pending)return this.pending;
    this.pending=this.read().finally(()=>{this.pending=null;});return this.pending;
  }
  async read(){
    try{
      const response=await this.fetchImpl(this.routerUrl+'/v1/models',{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error('Model router unavailable.');
      const data=await response.json();this.models=data.data||[];this.state='online';this.routerObservedAt=this.now();
      const loaded=this.models.find(m=>m.status?.value==='loaded'),loading=this.models.find(m=>m.status?.value==='loading');
      if(loading&&this.transition?.to!==loading.id)this.transition={from:this.lastReady,to:loading.id,phase:'loading',startedAt:this.now()};
      if(loaded){if(this.lastReady&&this.lastReady!==loaded.id)this.transition={from:this.lastReady,to:loaded.id,phase:'complete',startedAt:this.transition?.to===loaded.id?this.transition.startedAt:this.now(),finishedAt:this.now()};else if(this.transition?.phase==='loading'&&this.transition.to===loaded.id)this.transition={...this.transition,phase:'complete',finishedAt:this.now()};this.lastReady=loaded.id;}
    }catch{this.state='offline';this.models=[];}
    const images=this.images();if(images)await images.refresh();
    this.checkedAt=this.now();this.notify();return this.snapshot();
  }
  notify(){const snapshot=this.snapshot(),signature=JSON.stringify(snapshot);if(signature!==this.signature){this.signature=signature;this.onChange(snapshot);}return snapshot;}
}
