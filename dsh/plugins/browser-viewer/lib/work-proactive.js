// Acting before being asked. A cheap, deterministic scan of what Seek already knows — yearly dates
// in memory (birthdays, anniversaries), tasks left unfinished, and upcoming dates mentioned in
// recent requests ("pickup 10/9") — becomes "Heads up" cards with one-tap actions. Overnight, an
// upcoming date can get a prepared draft: a normal task that may research and write, but whose
// spending and sending are locked (careful mode, no saved card), so a person always decides.
import {randomUUID} from 'node:crypto';

const DAY=86400000;
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const KEYWORDS=[[/pick ?-?up/i,'Pickup'],[/deliver/i,'Delivery'],[/appointment|appt/i,'Appointment'],[/reserv/i,'Reservation'],[/deadline|\bdue\b/i,'Due'],[/party/i,'Party'],[/flight/i,'Flight'],[/\btrip\b/i,'Trip'],[/check-?in/i,'Check-in'],[/meeting/i,'Meeting'],[/birthday/i,'Birthday'],[/anniversary/i,'Anniversary'],[/concert|show|game/i,'Event'],[/dinner/i,'Dinner']];
const isReal=t=>!t.eval&&!t.proactive;
const startOfDay=(ms)=>{const d=new Date(ms);d.setHours(0,0,0,0);return d.getTime();};
export const dayLabel=(ms,now=Date.now())=>{const n=Math.round((startOfDay(ms)-startOfDay(now))/DAY),d=new Date(ms).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});return `${d}${n===0?' (today)':n===1?' (tomorrow)':n>1?` (in ${n} days)`:''}`;};
/** Next occurrence of a yearly MM-DD date, at local midnight. */
export function nextYearly(mmdd,now=Date.now()){
  const [m,d]=String(mmdd).split('-').map(Number);if(!m||!d)return null;
  const today=startOfDay(now),y=new Date(now).getFullYear();
  let at=new Date(y,m-1,d).getTime();if(at<today)at=new Date(y+1,m-1,d).getTime();return at;
}
/** Dates mentioned next to an event word ("pickup 10/9", "flight on Oct 12th"), relative to when it was said. */
export function mentionedDates(text,said=Date.now()){
  const out=[],s=String(text||'');
  const add=(index,month,day,year)=>{
    if(month<1||month>12||day<1||day>31)return;
    const window=s.slice(Math.max(0,index-60),index+60),kw=KEYWORDS.find(([re])=>re.test(window));if(!kw)return;
    const base=new Date(said);let y=year?(year<100?2000+year:year):base.getFullYear();
    let at=new Date(y,month-1,day).getTime();
    if(!year&&at<startOfDay(said))at=new Date(y+1,month-1,day).getTime();
    if(at-startOfDay(said)>200*DAY||at<startOfDay(said))return;
    out.push({at,label:kw[1]});
  };
  for(const m of s.matchAll(/\b(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/(\d{4}|\d{2}))?\b/g))add(m.index,Number(m[1]),Number(m[2]),m[3]?Number(m[3]):null);
  for(const m of s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gi))add(m.index,MONTHS.indexOf(m[1].toLowerCase().slice(0,3))+1,Number(m[2]),m[3]?Number(m[3]):null);
  return out;
}

export class Proactive {
  constructor({engine,memory,log=console}){this.engine=engine;this.memory=memory;this.log=log;}
  get store(){const s=this.engine.store;s.headsUp??=[];s.headsUpMuted??=[];return s;}
  items(now=Date.now()){return this.store.headsUp.filter(i=>i.status==='open'||(i.status==='snoozed'&&i.snoozeUntil<=now));}
  /** Recomputes cards from current data; keeps user decisions (done, snoozed, dismissed). Returns true when anything changed. */
  scan(now=Date.now()){
    const store=this.store,found=new Map(),muted=new Set(store.headsUpMuted),memory=this.memory?.();
    const tasks=store.tasks.filter(isReal);
    // Yearly dates the user mentioned (birthdays, anniversaries), two weeks ahead.
    for(const l of memory?.data?.lessons||[]){
      if(!l.eventDate||!['active','review'].includes(l.status))continue;
      const at=nextYearly(l.eventDate,now);if(at===null||at-startOfDay(now)>14*DAY)continue;
      const entity=l.entity&&memory.entities?.get(l.entity),relation=entity&&entity.id!=='self'?entity.id.replace(/-/g,' '):null;
      // "my wife", or "Alex (my wife)" once the user has named the dossier.
      const who=relation?(entity.name.toLowerCase()===relation?`my ${relation}`:`${entity.name} (my ${relation})`):null,label=l.eventLabel||(relation?`${entity.name}'s date`:'An important date');
      const aliases=entity?[entity.name,...(entity.aliases||[])].map(a=>a.toLowerCase()):[];
      const topic=label.toLowerCase().match(/birthday|anniversary|wedding|graduation|retirement/)?.[0];
      const about=t=>(t.title+' '+t.objective+' '+(t.messages||[]).filter(m=>m.role==='user').slice(0,5).map(m=>m.text).join(' ')).toLowerCase();
      const related=tasks.filter(t=>(t.createdAt||0)>now-45*DAY&&topic&&about(t).includes(topic)&&(!aliases.length||aliases.some(a=>about(t).includes(a)))).sort((a,b)=>b.createdAt-a.createdAt)[0];
      const said=l.sources?.[0]?.quote;
      const when=dayLabel(at,now),artifact=related?.artifacts?.filter(a=>/\.(md|txt|html)$/i.test(a.path||'')).at(-1);
      found.set(`date:${l.id}:${new Date(at).getFullYear()}`,{kind:'date',mute:`date:${l.id}`,title:`${label} — ${when}`,body:`${said?`You told me: “${said.slice(0,140)}”`:l.text}${l.status==='review'?' (not confirmed in Memory yet)':''}${related?` You started “${related.title}” on ${new Date(related.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}.`:''}`,dueAt:at,source:{lessonId:l.id,taskId:related?.id||null},
        actions:related?[{type:'open',taskId:related.id,label:'Open the plan'},{type:'task',label:'Plan something new',objective:`Help me plan for ${label} on ${new Date(at).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}. Use what you know${who?` about ${who}`:''}; ask me only what you truly need.`}]:[{type:'task',label:'Plan it',objective:`Help me plan for ${label} on ${new Date(at).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}. Use what you know${who?` about ${who}`:''}; ask me only what you truly need.`}],
        prepare:at-startOfDay(now)<=10*DAY?{objective:`Prepare ahead for ${label} on ${new Date(at).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}${related?`, building on the earlier conversation “${related.title}”${artifact?' (its plan is attached)':''}`:''}. Using what you know${who?` about ${who}`:''}, draft 2–3 concrete options with times, costs and exactly what would need booking or buying, and save them to plan.md.`,sourceArtifact:artifact?{taskId:related.id,id:artifact.id}:null,label}:null});
    }
    for(const t of tasks){
      if(t.archived)continue;
      // Work left unfinished in the last week.
      const stale=t.status==='waiting'&&now-(t.updatedAt||0)>12*3600000;
      if((['stopped','attention','paused'].includes(t.status)||stale)&&now-(t.updatedAt||0)<7*DAY&&(t.taskToolCalls||0)>=2&&String(t.objective||'').length>=15)
        found.set(`open:${t.id}:${t.status}`,{kind:'open',mute:`open:${t.id}`,title:`Still open: ${t.title}`,body:`${t.question?.text||t.activity||'Stopped before finishing.'} · ${new Date(t.updatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`,dueAt:t.updatedAt,source:{taskId:t.id},actions:[{type:'resume',taskId:t.id,label:'Finish it'},{type:'archive',taskId:t.id,label:'It’s done'}],prepare:null});
      // Dates the user mentioned in recent requests.
      if((t.createdAt||0)<now-21*DAY)continue;
      for(const m of (t.messages||[]).filter(m=>m.role==='user'))for(const d of mentionedDates(m.text,m.time||t.createdAt)){
        if(d.at<startOfDay(now)||d.at-startOfDay(now)>10*DAY)continue;
        found.set(`mention:${t.id}:${new Date(d.at).toISOString().slice(0,10)}`,{kind:'mention',mute:`mention:${t.id}`,title:`${d.label}: ${t.title} — ${dayLabel(d.at,now)}`,body:`You mentioned it on ${new Date(m.time||t.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}: “${String(m.text).slice(0,140)}”`,dueAt:d.at,source:{taskId:t.id},actions:[{type:'open',taskId:t.id,label:'Open'}],prepare:null});
      }
    }
    let changed=false;
    for(const [key,card] of found){
      if(muted.has(card.mute))continue;
      const prior=store.headsUp.find(i=>i.key===key);
      if(!prior){store.headsUp.push({id:randomUUID(),key,...card,status:'open',createdAt:now,snoozeUntil:null,preparedTaskId:null});changed=true;continue;}
      // Refresh wording (the countdown) without undoing the user's decision.
      const fresh={title:card.title,body:prior.preparedTaskId?prior.body:card.body,dueAt:card.dueAt,actions:prior.preparedTaskId?prior.actions:card.actions,prepare:prior.preparedTaskId?prior.prepare:card.prepare};
      if(JSON.stringify(fresh)!==JSON.stringify({title:prior.title,body:prior.body,dueAt:prior.dueAt,actions:prior.actions,prepare:prior.prepare})){Object.assign(prior,fresh);changed=true;}
    }
    for(const i of store.headsUp)if(['open','snoozed'].includes(i.status)&&!found.has(i.key)){i.status='expired';i.closedAt=now;changed=true;}
    const before=store.headsUp.length;store.headsUp=store.headsUp.filter(i=>!(['expired','done','dismissed'].includes(i.status)&&now-(i.closedAt||i.createdAt)>30*DAY));
    return changed||before!==store.headsUp.length;
  }
  async act(id,{action,index=0,now=Date.now()}){
    const item=this.store.headsUp.find(i=>i.id===id);if(!item)throw new Error('This card is no longer here.');
    const close=status=>{item.status=status;item.closedAt=now;};
    if(action==='snooze'){const t=new Date(now);t.setDate(t.getDate()+1);t.setHours(8,0,0,0);item.status='snoozed';item.snoozeUntil=t.getTime();}
    else if(action==='dismiss')close('dismissed');
    else if(action==='never'){this.store.headsUpMuted=[...new Set([...this.store.headsUpMuted,item.mute])].slice(-200);close('dismissed');}
    else if(action==='do'){
      const a=item.actions?.[index];if(!a)throw new Error('Choose an action.');
      if(a.type==='task'){const t=await this.engine.create({objective:a.objective,mode:'task'});close('done');await this.engine.save();return {item,taskId:t.id};}
      if(a.type==='resume'){await this.engine.control(a.taskId,'resume');close('done');}
      else if(a.type==='archive'){await this.engine.control(a.taskId,'archive');close('done');}
      else if(a.type==='open')return {item,taskId:a.taskId};
    }else throw new Error('Choose snooze, dismiss, never or an action.');
    await this.engine.save();return {item};
  }
  prepareCandidates(now=Date.now()){return this.items(now).filter(i=>i.prepare&&!i.preparedTaskId&&!(i.prepareAttempts>=2)&&i.dueAt-now<=10*DAY);}
  /** Prepares one draft as a locked-down task; returns when it ends (or the signal aborts). */
  async prepare(item,{signal,timeoutMs=15*60000,pollMs=2000}={}){
    const engine=this.engine;item.prepareAttempts=(item.prepareAttempts||0)+1;
    let t;try{t=await engine.operation(async()=>{const task=await engine.create({objective:item.prepare.objective,mode:'task',...(item.prepare.sourceArtifact?{sourceArtifact:item.prepare.sourceArtifact}:{})});task.proactive={itemId:item.id};task.title=`Prepared: ${item.prepare.label||item.title}`.slice(0,90);await engine.save();return task;});}
    catch(e){if(!item.prepare.sourceArtifact)throw e;item.prepare.sourceArtifact=null;return this.prepare(item,{signal,timeoutMs,pollMs});}
    const deadline=Date.now()+timeoutMs;
    while(!['complete','stopped','attention','waiting','paused'].includes(t.status)&&Date.now()<deadline){
      if(signal?.aborted){await engine.operation(()=>engine.control(t.id,'stop')).catch(()=>{});throw signal.reason||new Error('aborted');}
      await new Promise(r=>setTimeout(r,pollMs));
    }
    if(t.status==='complete'){
      item.preparedTaskId=t.id;item.preparedAt=Date.now();item.body=`${item.body} I prepared a draft ahead of time — nothing was booked or bought.`;
      item.actions=[{type:'open',taskId:t.id,label:'See the draft'},...(item.actions||[]).filter(a=>a.type!=='open')];
    }else if(['waiting','attention','paused'].includes(t.status))await engine.operation(()=>engine.control(t.id,'stop')).catch(()=>{});
    await engine.save();return t;
  }
  /** One morning summary of what matters today and this week. */
  digest(now=Date.now()){
    const items=this.items(now).filter(i=>i.dueAt-now<=7*DAY).sort((a,b)=>(a.kind==='open')-(b.kind==='open')||a.dueAt-b.dueAt);
    if(!items.length)return null;
    const ready=items.filter(i=>i.preparedTaskId).length;
    return {title:ready?`Good morning — ${ready} draft${ready===1?'':'s'} ready`:'Good morning — heads up',body:items.slice(0,3).map(i=>i.title).join(' · ').slice(0,220),tag:'digest-'+new Date(now).toISOString().slice(0,10)};
  }
}
