import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,20);
const version=t=>t.__trackedRevision?String(t.revision||0):digest(t);
export function taskSummary(t) {
  return {id:t.id,title:t.title,objective:t.objective,status:t.status,mode:t.mode,activity:t.activity,createdAt:t.createdAt,updatedAt:t.updatedAt,startedAt:t.startedAt,completedAt:t.completedAt,runAt:t.runAt,repeatHours:t.repeatHours,schedule:t.schedule,pinned:!!t.pinned,project:t.project,progress:t.progress,workflow:t.workflow,contextUsed:t.contextUsed,resultEvidence:t.resultEvidence,deliveries:t.deliveries,archived:!!t.archived,sessionId:t.sessionId,question:t.question,approval:t.approval,handoff:t.handoff,artifacts:t.artifacts||[],events:(t.events||[]).slice(-3),version:version(t)};
}
export function taskPage(t,{before,limit=40}={}) {
  const count=t.messages?.length||0,end=before===undefined?count:Number(before);limit=Number(limit);
  if(!Number.isInteger(end)||end<0||end>count||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid conversation page.');
  const start=Math.max(0,end-limit);
  const {outbox,initialDelivery,requestFingerprint,...detail}=t;
  return {...detail,messages:t.messages.slice(start,end),messageOffset:start,totalMessages:count,nextBefore:start||null,version:version(t),deliveryUncertain:[...(outbox||[]),...(initialDelivery?[initialDelivery]:[])].some(x=>['uncertain','sending'].includes(x.state))};
}
export class WorkUpdates {
  constructor(engine,{health=()=>({})}={}){this.engine=engine;this.health=health;this.revision=0;this.versions=new Map();this.history=new Map();this.current=null;this.listeners=new Set();this.refresh();}
  refresh(){
    if(this.current&&this.engine.savedPayload!==undefined&&this.lastPayload===this.engine.savedPayload)return;
    this.lastPayload=this.engine.savedPayload;
    const store=this.engine.store,tasks=store.tasks.filter(t=>!t.eval),headsUp=(store.headsUp||[]).filter(i=>i.status==='open'||i.status==='snoozed'),global=digest([store.settings,store.ideas,store.sites,headsUp]);let changed=global!==this.global||this.versions.size!==tasks.length;
    const summaries=tasks.map(task=>{const summary=taskSummary(task);if(this.versions.get(task.id)!==summary.version)changed=true;return summary;});
    if(!changed)return;
    this.global=global;this.revision++;this.versions=new Map(summaries.map(t=>[t.id,t.version]));
    this.current={version:store.version,settings:store.settings,ideas:store.ideas,headsUp,tasks:summaries,revision:this.revision,globalVersion:global};
    this.history.set(this.revision,{versions:new Map(this.versions),global});if(this.history.size>64)this.history.delete(this.history.keys().next().value);
    for(const listener of this.listeners)listener(this.revision);
  }
  snapshot(){this.refresh();return {...this.current,health:this.health()};}
  changed(since){this.refresh();if(Number(since)===this.revision)return {unchanged:true,revision:this.revision,health:this.health()};const prior=this.history.get(Number(since));if(!prior)return this.snapshot();return {patch:true,revision:this.revision,tasks:this.current.tasks.filter(t=>prior.versions.get(t.id)!==t.version),removed:[...prior.versions.keys()].filter(id=>!this.versions.has(id)),...(prior.global!==this.global?{settings:this.current.settings,ideas:this.current.ideas,headsUp:this.current.headsUp}:{}),health:this.health()};}
  subscribe(listener){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  notifyHealth(){for(const listener of this.listeners)listener(this.revision);}
}
