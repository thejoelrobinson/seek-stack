// Chat and task controls from a paired computer, carried only by its authenticated data channel.
const ACTIVE=new Set(['running','waiting','queued']);
const short=(v,n=8000)=>String(v||'').slice(0,n);
const REQUEST=/^[a-f0-9]{32}$/;
export class CompanionService {
  constructor({engine,hub,controlTask}) {
    Object.assign(this,{engine,hub,controlTask});
    this.off=hub.on(e=>{
      if(e.type==='state'&&e.previousTask&&e.state.state!=='agent'&&!hub.handovers?.delete(e.previousTask))this.release(e.id,e.previousTask);
      if(e.type==='offline')for(const t of engine.store.tasks)this.release(e.id,t.id);
    });
  }
  release(deviceId,id) {
    const t=this.engine.task(id);
    if(t?.status==='waiting'&&t.question)return;
    if(((t?.companion?.deviceId===deviceId&&t.companion.mode==='desktop'&&!t.execution?.autoRemote)||(t?.execution?.deviceId===deviceId&&t.execution.autoRemote))&&ACTIVE.has(t.status))
      void this.controlTask({id,action:'pause'}).catch(e=>this.hub.log.warn?.('Companion pause: '+e.message));
  }
  owned(deviceId,id) {
    const t=this.engine.task(id);
    if(!t||t.eval||t.proactive||!(t.companion?.deviceId===deviceId||this.hub.machineFor(id)?.id===deviceId))throw Error('This conversation is not available on this computer.');
    return t;
  }
  granted(deviceId,t) {
    if(t.companion?.mode==='desktop'&&!t.execution?.autoRemote&&this.hub.machineFor(t.id)?.id!==deviceId)throw Error('Choose Continue on this computer to let Seek work again.');
  }
  snapshot(t,history=true) {
    const messages=[];let bytes=0;
    if(history)for(const m of (t.messages||[]).slice(-24).reverse()){const entry={role:m.role==='user'?'user':'assistant',text:short(m.text)},size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>48000)break;messages.unshift(entry);bytes+=size;}
    return {id:t.id,title:short(t.title,180),mode:t.execution?.mode||t.companion?.mode||'desktop',remote:!!t.execution?.autoRemote,computer:short(t.execution?.name,60),status:t.status,activity:short(t.activity,240),
      messages,
      question:history&&t.question?{text:short(typeof t.question==='string'?t.question:t.question.text,2000),choices:(t.question.choices||[]).slice(0,12).map(c=>short(c,240))}:null,
      needsBrowser:!!t.handoff,needsFullApp:!!(t.approval||t.nativeRequest),
      artifacts:history?(t.artifacts||[]).slice(-5).map(a=>({title:short(a.title||a.name||a.path,160)})):[],error:short(t.error,500)};
  }
  async handle(deviceId,_state,{method,body={}}) {
    if(method==='list')return {name:short(this.engine.store.settings?.name||'Seek',60),look:{color:short(this.engine.store.settings?.look?.color,20),accessory:short(this.engine.store.settings?.look?.accessory,20)},computers:(await this.hub.machines()).filter(m=>m.verified&&m.remoteGrant&&m.id!==deviceId).map(m=>({id:m.id,name:m.name,online:m.online,busy:m.state==='agent'})),tasks:this.engine.store.tasks.filter(t=>!t.eval&&!t.proactive&&(t.companion?.deviceId===deviceId||this.hub.machineFor(t.id)?.id===deviceId)).slice(-20).reverse().map(t=>this.snapshot(t,false))};
    if(method==='create') {
      const {mode,text,requestId}=body;
      if(!['chat','browser','desktop'].includes(mode)||typeof text!=='string'||!text.trim()||text.length>8000||!REQUEST.test(requestId||''))throw Error('Choose where Seek should work and enter a task.');
      if(mode==='desktop'&&body.computerId&&body.computerId!==deviceId){const t=await this.createRemote({objective:text.trim(),mode:'task',requestId:'companion_'+deviceId+'_'+requestId},body.computerId,{deviceId,mode,started:true});return this.snapshot(t);}
      const t=await this.engine.operation(()=>this.engine.create({objective:text.trim(),mode:mode==='chat'?'chat':'task',requestId:'companion_'+deviceId+'_'+requestId},{paused:mode==='desktop',companion:{deviceId,mode,started:mode!=='desktop'}}));
      return this.snapshot(t);
    }
    const t=this.owned(deviceId,body.id);
    if(method==='get')return this.snapshot(t);
    if(method==='start') {
      if(t.companion?.mode!=='desktop'||t.companion.deviceId!==deviceId)throw Error('This task does not use this computer.');
      this.granted(deviceId,t);
      if(!t.companion.started){await this.controlTask({id:t.id,action:'resume'});t.companion.started=true;await this.engine.save();}
    }else if(method==='reply') {
      if(typeof body.text!=='string'||!body.text.trim()||body.text.length>8000||!REQUEST.test(body.requestId||''))throw Error('Enter a message.');
      if(t.approval||t.nativeRequest||t.handoff)throw Error('Open this task in Seek to answer this request.');
      this.granted(deviceId,t);
      await this.controlTask({id:t.id,action:'reply',answer:body.text,requestId:'companion_'+body.requestId});
    }else if(method==='pause')await this.controlTask({id:t.id,action:'pause'});
    else if(method==='resume'){this.granted(deviceId,t);await this.controlTask({id:t.id,action:'resume'});}
    else throw Error('Unknown companion action.');
    return this.snapshot(t);
  }
  async createRemote(params,id,companion) {
    const m=(await this.hub.machines()).find(m=>m.id===id);
    if(!m?.verified||!m.remoteGrant)throw Error('Remote control is not enabled on that computer.');
    const later=!!params.schedule||!!params.runAt&&Date.parse(params.runAt)>Date.now();
    if(!later&&!m.online)throw Error('That computer is offline. Open Seek Desktop there and try again.');
    if(!later&&m.state==='agent')throw Error('That computer is already running a task.');
    const t=await this.engine.operation(()=>this.engine.create(params,{companion,execution:{mode:'desktop',deviceId:id,name:m.name,autoRemote:true,granted:false}}));
    if(t.execution?.deviceId!==id)throw Error('This request was already sent to another computer.');
    return t;
  }
  close(){this.off?.();}
}
