// The shared calendar and to-do list that you and Seek both keep. Each item is stored as the
// iCalendar resource a CalDAV client sent (or Seek wrote), so Apple Calendar and Reminders see
// exactly what they saved; a global change counter gives every write a sync token.
// The reminder engine fires alarms (once each), snoozes them, and starts Seek's prep work.
import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseICS,serializeICS,readItem,occurrences,alarmTimes,applyItem,advanceRepeatingTodo,validZone,zonedParts,zonedToUtc} from './work-ical.js';

export const COLLECTIONS=[
  {id:'seek',kind:'event',name:'Seek',color:'#5B8A72FF',description:'Shared by you and Seek'},
  {id:'todos',kind:'todo',name:'Seek To-dos',color:'#C98A3EFF',description:'To-dos shared by you and Seek'}
];
const REPEATS={daily:'FREQ=DAILY',weekdays:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',weekly:'FREQ=WEEKLY',biweekly:'FREQ=WEEKLY;INTERVAL=2',monthly:'FREQ=MONTHLY',yearly:'FREQ=YEARLY'};
export function repeatLabel(rrule){if(!rrule)return 'none';const r=String(rrule).replace(/;?WKST=[A-Z]{2}/,'');for(const [k,v] of Object.entries(REPEATS))if(r===v)return k;if(/^FREQ=WEEKLY;BYDAY=[A-Z]{2}$/.test(r))return 'weekly';return 'custom';}
// A recurring rule pinned to the start's weekday, so "weekly" from the UI matches what Apple shows.
function repeatRule(repeat,current){if(repeat===undefined)return undefined;if(!repeat||repeat==='none')return null;if(repeat==='custom')return current??null;const rule=REPEATS[repeat];if(!rule)throw new Error('Repeat must be none, daily, weekdays, weekly, biweekly, monthly or yearly.');return rule;}
const etagOf=ics=>'"'+createHash('sha256').update(ics).digest('hex').slice(0,24)+'"';
const MAX_ICS=512*1024;
export class CalendarError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}

export class CalendarStore{
  constructor(root,{now=()=>Date.now(),zone}={}){this.path=join(root,'calendar.sqlite');this.root=root;this.now=now;this.defaultZone=zone;this.listeners=new Set();}
  async init(){
    await mkdir(this.root,{recursive:true});this.db=new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(collection TEXT NOT NULL,name TEXT NOT NULL,uid TEXT NOT NULL,kind TEXT NOT NULL,ics TEXT NOT NULL,etag TEXT NOT NULL,modified INTEGER NOT NULL,token INTEGER NOT NULL,source TEXT NOT NULL DEFAULT 'you',PRIMARY KEY(collection,name));
      CREATE UNIQUE INDEX IF NOT EXISTS objects_uid ON objects(collection,uid);
      CREATE TABLE IF NOT EXISTS tombstones(collection TEXT NOT NULL,name TEXT NOT NULL,token INTEGER NOT NULL,PRIMARY KEY(collection,name));
      CREATE TABLE IF NOT EXISTS extras(uid TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders(key TEXT PRIMARY KEY,uid TEXT NOT NULL,collection TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,occurrence INTEGER NOT NULL,due INTEGER NOT NULL,fired INTEGER NOT NULL,state TEXT NOT NULL,snooze_until INTEGER,acted INTEGER);
      CREATE INDEX IF NOT EXISTS reminders_state ON reminders(state,snooze_until);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,channel TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,delivered INTEGER);`);
    if(!this.meta('token'))this.setMeta('token',0);
    return this;
  }
  close(){this.db?.close();this.db=null;}
  meta(key,fallback=null){const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  setMeta(key,value){this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  get zone(){return validZone(this.meta('zone'))||validZone(this.defaultZone)||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}
  get token(){return this.meta('token',0);}
  settings(){return {zone:this.zone,push:true,discord:true,inbox:true,defaultAlert:15,...this.meta('settings',{})};}
  configure(patch={}){
    const next={...this.settings()};
    for(const k of ['push','discord','inbox'])if(k in patch)next[k]=!!patch[k];
    if('defaultAlert' in patch){const v=patch.defaultAlert===null?null:Number(patch.defaultAlert);if(v!==null&&!(v>=0&&v<=10080))throw new CalendarError(400,'Default alert must be 0–10080 minutes before, or none.');next.defaultAlert=v;}
    if('zone' in patch){const z=validZone(patch.zone);if(!z)throw new CalendarError(400,'Unknown time zone.');this.setMeta('zone',z);}
    const {zone,...rest}=next;this.setMeta('settings',rest);return this.settings();
  }
  onChange(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  changed(detail){for(const fn of this.listeners)try{fn(detail);}catch{}}
  bump(){const t=this.token+1;this.setMeta('token',t);return t;}
  collection(id){return COLLECTIONS.find(c=>c.id===id)||null;}
  ctag(id){return this.db.prepare('SELECT MAX(token) AS t FROM (SELECT token FROM objects WHERE collection=? UNION ALL SELECT token FROM tombstones WHERE collection=?)').get(id,id)?.t||0;}

  // ── Resources (what CalDAV reads and writes) ──
  objects(collection){return this.db.prepare('SELECT collection,name,uid,kind,ics,etag,modified,token,source FROM objects WHERE collection=? ORDER BY name').all(collection);}
  object(collection,name){return this.db.prepare('SELECT collection,name,uid,kind,ics,etag,modified,token,source FROM objects WHERE collection=? AND name=?').get(collection,name)||null;}
  byUid(uid){return this.db.prepare('SELECT collection,name,uid,kind,ics,etag,modified,token,source FROM objects WHERE uid=?').get(uid)||null;}
  /** Stores a resource from a client. Enforces If-Match / If-None-Match like a CalDAV server. */
  put(collection,name,ics,{ifMatch=null,ifNoneMatch=null,source='you'}={}){
    const col=this.collection(collection);if(!col)throw new CalendarError(404,'No such calendar.');
    if(!/^[A-Za-z0-9._@%+-]{1,200}$/.test(name))throw new CalendarError(400,'Unsupported resource name.');
    if(Buffer.byteLength(ics)>MAX_ICS)throw new CalendarError(413,'Calendar object is too large.','max-resource-size');
    let cal,item;try{cal=parseICS(ics);item=readItem(cal,this.zone);}catch(e){throw new CalendarError(415,e.message,'valid-calendar-data');}
    if(item.kind!==col.kind)throw new CalendarError(403,col.kind==='todo'?'This list only holds to-dos.':'This calendar only holds events.','supported-calendar-component');
    if(!item.uid)throw new CalendarError(400,'Calendar object has no UID.','valid-calendar-object-resource');
    const existing=this.object(collection,name);
    if(ifNoneMatch==='*'&&existing)throw new CalendarError(412,'Already exists.');
    if(ifMatch&&ifMatch!=='*'&&(!existing||existing.etag!==ifMatch))throw new CalendarError(412,'Changed since you last loaded it.');
    if(ifMatch==='*'&&!existing)throw new CalendarError(412,'Does not exist.');
    const clash=this.db.prepare('SELECT name FROM objects WHERE collection=? AND uid=?').get(collection,item.uid);
    if(clash&&clash.name!==name)throw new CalendarError(409,'Another resource already uses this UID.','no-uid-conflict');
    const text=ics.includes('\r\n')?ics:serializeICS(cal),etag=etagOf(text),token=this.bump(),now=this.now();
    this.db.prepare('INSERT INTO objects(collection,name,uid,kind,ics,etag,modified,token,source) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(collection,name) DO UPDATE SET uid=excluded.uid,kind=excluded.kind,ics=excluded.ics,etag=excluded.etag,modified=excluded.modified,token=excluded.token,source=excluded.source').run(collection,name,item.uid,item.kind,text,etag,now,token,source);
    this.db.prepare('DELETE FROM tombstones WHERE collection=? AND name=?').run(collection,name);
    this.changed({collection,name,uid:item.uid,source});
    return {etag,created:!existing,token};
  }
  remove(collection,name,{ifMatch=null,source='you'}={}){
    const existing=this.object(collection,name);if(!existing)throw new CalendarError(404,'Not found.');
    if(ifMatch&&ifMatch!=='*'&&existing.etag!==ifMatch)throw new CalendarError(412,'Changed since you last loaded it.');
    const token=this.bump();
    this.db.prepare('DELETE FROM objects WHERE collection=? AND name=?').run(collection,name);
    this.db.prepare('INSERT INTO tombstones(collection,name,token) VALUES(?,?,?) ON CONFLICT(collection,name) DO UPDATE SET token=excluded.token').run(collection,name,token);
    this.db.prepare("UPDATE reminders SET state='done' WHERE collection=? AND name=? AND state!='done'").run(collection,name);
    this.changed({collection,name,uid:existing.uid,source,deleted:true});
    return {token};
  }
  /** Changes since a sync token: names changed and names deleted. Null when the token is unknown. */
  changesSince(collection,since){
    const current=this.ctag(collection);
    if(since===null||since===undefined)return {token:this.token,changed:this.objects(collection).map(o=>o.name),deleted:[]};
    if(!Number.isInteger(since)||since<0||since>this.token)return null;
    return {token:this.token,changed:this.db.prepare('SELECT name FROM objects WHERE collection=? AND token>?').all(collection,since).map(r=>r.name),deleted:this.db.prepare('SELECT name FROM tombstones WHERE collection=? AND token>?').all(collection,since).map(r=>r.name),current};
  }

  // ── Items (what the UI and Seek use) ──
  extras(uid){const row=this.db.prepare('SELECT data FROM extras WHERE uid=?').get(uid);return row?JSON.parse(row.data):{};}
  setExtras(uid,patch){const next={...this.extras(uid),...patch};for(const k of Object.keys(next))if(next[k]===null)delete next[k];this.db.prepare('INSERT INTO extras(uid,data) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET data=excluded.data').run(uid,JSON.stringify(next));return next;}
  read(row){const item=readItem(parseICS(row.ics),this.zone);return {row,item};}
  summary(row,item=this.read(row).item){
    const extra=this.extras(item.uid),anchor=item.kind==='todo'?item.due:item.start;
    return {id:`${row.collection}/${row.name}`,uid:item.uid,kind:item.kind,collection:row.collection,title:item.title||'(No title)',notes:item.notes,location:item.location,url:item.url,
      start:item.start?.ms??null,end:item.end?.ms??null,due:item.due?.ms??null,allDay:!!anchor?.allDay,done:!!item.done,completed:item.completed||null,priority:item.priority||0,
      repeat:repeatLabel(item.rrule),rrule:item.rrule,alerts:item.alarms.filter(a=>a.offset!==null).map(a=>Math.round(((anchor?.allDay?9*3600000:0)-a.offset)/60000)||0),absoluteAlerts:item.alarms.filter(a=>a.absolute!==null).map(a=>a.absolute),
      prep:extra.prep||null,source:row.source,modified:row.modified,etag:row.etag};
  }
  /** Events as occurrences in [from, to) plus every to-do (open ones, and recently finished ones). */
  range(from,to){
    const events=[],todos=[];
    for(const row of this.db.prepare("SELECT * FROM objects WHERE kind='event'").all()){
      let read;try{read=this.read(row);}catch{continue;}
      const base=this.summary(row,read.item);
      for(const o of occurrences(read.item,from,to,{limit:400}))events.push({...base,...(o.override?{title:o.override.title||base.title,location:o.override.location||base.location,notes:o.override.notes||base.notes}:{}),start:o.start,end:o.end,occurrence:o.recurrenceId,recurring:!!read.item.rrule});
    }
    const cutoff=this.now()-14*86400000;
    for(const row of this.db.prepare("SELECT * FROM objects WHERE kind='todo'").all()){
      let read;try{read=this.read(row);}catch{continue;}
      const s=this.summary(row,read.item);if(s.done&&(s.completed||row.modified)<cutoff)continue;todos.push(s);
    }
    events.sort((a,b)=>a.start-b.start||a.title.localeCompare(b.title));
    todos.sort((a,b)=>Number(a.done)-Number(b.done)||(a.due??Infinity)-(b.due??Infinity)||(b.priority&&a.priority?a.priority-b.priority:0)||a.title.localeCompare(b.title));
    return {events,todos,zone:this.zone,token:this.token,settings:this.settings()};
  }
  find(id){
    const [collection,name]=String(id||'').split('/');const row=collection&&name?this.object(collection,name):this.byUid(String(id||''));
    if(!row)throw new CalendarError(404,'That calendar item no longer exists.');return row;
  }
  /** Creates or edits an event/to-do from plain fields (ms timestamps, alerts as minutes before). */
  save(kind,input={},{id=null,source='you'}={}){
    if(!['event','todo'].includes(kind))throw new CalendarError(400,'Choose event or to-do.');
    const row=id?this.find(id):null;if(row&&row.kind!==kind)throw new CalendarError(400,'That item is a '+row.kind+'.');
    const has=k=>Object.prototype.hasOwnProperty.call(input,k);
    const current=row?this.read(row).item:null;
    const fields={};
    if(!row||has('title')){const title=String(input.title??'').trim();if(!title)throw new CalendarError(400,'Give it a title.');if(title.length>300)throw new CalendarError(400,'Keep the title under 300 characters.');fields.title=title;}
    for(const k of ['notes','location'])if(has(k)){const v=String(input[k]??'');if(v.length>20000)throw new CalendarError(400,`The ${k} are too long.`);fields[k]=v;}
    const time=(v,label)=>{if(v===null||v===undefined||v==='')return null;const ms=typeof v==='number'?v:Date.parse(v);if(!Number.isFinite(ms))throw new CalendarError(400,`${label} is not a valid date.`);return ms;};
    const allDay=has('allDay')?!!input.allDay:(current?((kind==='todo'?current.due:current.start)?.allDay??false):false);
    if(kind==='event'){
      if(!row||has('start')||has('end')||has('allDay')){
        let start=has('start')?time(input.start,'Start'):current?.start?.ms??null;if(start===null)throw new CalendarError(400,'An event needs a start.');
        let end=has('end')?time(input.end,'End'):(current?.end&&current.start?start+(current.end.ms-current.start.ms):null);
        if(allDay){start=this.midnight(start);end=end===null?start+86400000:Math.max(this.midnight(end),start+86400000);}
        if(end!==null&&end<start)throw new CalendarError(400,'The end is before the start.');
        Object.assign(fields,{start,end,allDay});
      }
    }else if(has('due')||has('allDay')){const due=has('due')?time(input.due,'Due date'):current?.due?.ms??null;Object.assign(fields,{due:due===null?null:allDay?this.midnight(due):due,allDay});}
    if(kind==='todo'){if(has('priority'))fields.priority=[0,1,5,9].includes(Number(input.priority))?Number(input.priority):0;if(has('done'))fields.done=!!input.done;}
    if(has('repeat'))fields.rrule=repeatRule(input.repeat,current?.rrule);
    if(has('alerts')||!row){
      const anchorSet=kind==='event'||fields.due!=null||current?.due;
      // New items get the default alert: at the time for to-dos and all-day items (9:00), N minutes before for timed events.
      let alerts=has('alerts')?input.alerts:(this.settings().defaultAlert==null||!anchorSet?[]:[kind==='todo'||allDay?0:this.settings().defaultAlert]);
      if(!Array.isArray(alerts))alerts=[alerts];
      alerts=[...new Set(alerts.map(Number).filter(n=>Number.isFinite(n)&&n>=0&&n<=40320))].slice(0,4);
      // All-day items alert at 9:00 on the day (Apple's default) minus the chosen lead.
      const keep=(current?.alarms||[]).filter(a=>a.absolute!==null);
      fields.alarms=anchorSet?[...keep,...alerts.map(min=>({offset:allDay?9*3600000-min*60000:-min*60000}))]:keep;
    }
    const uid=current?.uid||randomUUID().toUpperCase();if(!row)fields.uid=uid;
    const cal=applyItem(row?parseICS(row.ics):null,kind,fields,{tz:this.zone,now:this.now()});
    const collection=row?.collection||(kind==='todo'?'todos':'seek'),name=row?.name||`${uid}.ics`;
    const result=this.put(collection,name,serializeICS(cal),{ifMatch:row?.etag||null,ifNoneMatch:row?null:'*',source});
    if(has('prep'))this.setPrep(uid,input.prep);
    return {...this.summary(this.object(collection,name)),created:result.created};
  }
  setPrep(uid,prep){
    if(!prep)return this.setExtras(uid,{prep:null});
    const instruction=String(prep.instruction||'').trim(),lead=Number(prep.leadHours??24);
    if(!instruction)throw new CalendarError(400,'Tell Seek what to prepare.');if(instruction.length>2000)throw new CalendarError(400,'Keep the prep request under 2000 characters.');
    if(!(lead>=0&&lead<=24*30))throw new CalendarError(400,'Prep lead time must be 0–720 hours.');
    return this.setExtras(uid,{prep:{instruction,leadHours:lead,startedFor:this.extras(uid).prep?.startedFor||null,taskId:this.extras(uid).prep?.taskId||null}});
  }
  /** Ticks off a to-do. Repeating ones move to their next date, like Reminders. */
  complete(id,done=true,{source='you'}={}){
    const row=this.find(id);if(row.kind!=='todo')throw new CalendarError(400,'Only to-dos can be completed.');
    const cal=parseICS(row.ics),item=readItem(cal,this.zone);
    if(done&&item.rrule&&advanceRepeatingTodo(cal,{now:this.now(),zone:this.zone})){this.put(row.collection,row.name,serializeICS(cal),{ifMatch:row.etag,source});}
    else this.put(row.collection,row.name,serializeICS(applyItem(cal,'todo',{done},{tz:this.zone,now:this.now()})),{ifMatch:row.etag,source});
    this.db.prepare("UPDATE reminders SET state='done' WHERE collection=? AND name=? AND state!='done'").run(row.collection,row.name);
    return this.summary(this.object(row.collection,row.name));
  }
  delete(id,{source='you'}={}){const row=this.find(id);this.remove(row.collection,row.name,{ifMatch:row.etag,source});this.db.prepare('DELETE FROM extras WHERE uid=?').run(row.uid);return {deleted:true,id};}
  midnight(ms){const p=zonedParts(ms,this.zone);return zonedToUtc({y:p.y,m:p.m,d:p.d},this.zone);}
  search(query,{limit=20}={}){
    const q=String(query||'').toLowerCase().trim();const out=[];
    for(const row of this.db.prepare('SELECT * FROM objects ORDER BY modified DESC').all()){let s;try{s=this.summary(row);}catch{continue;}if(!q||`${s.title} ${s.notes} ${s.location}`.toLowerCase().includes(q))out.push(s);if(out.length>=limit)break;}
    return out;
  }

  // ── Reminders ──
  /**
   * Fires alarms that came due since the last scan (at most `catchUpMs` back, so a long outage
   * doesn't replay a week of alerts), refires snoozed ones, and returns what fired plus the
   * prep work that is due. Each alarm fires once: keyed by item, occurrence and alarm time.
   */
  scan({catchUpMs=6*3600000}={}){
    const now=this.now(),last=Math.max(this.meta('scannedAt',now-60000),now-catchUpMs),fired=[],prep=[];
    for(const row of this.db.prepare('SELECT * FROM objects').all()){
      let item;try{item=this.read(row).item;}catch{continue;}
      if(item.kind==='todo'&&item.done)continue;
      const extra=this.extras(item.uid);
      for(const occ of occurrences(item,last-14*86400000,now+31*86400000,{limit:200})){
        for(const a of alarmTimes(item,occ)){
          if(a.at<=last||a.at>now||a.acknowledged)continue;
          const key=`${item.uid}|${occ.recurrenceId}|${a.at}`;
          if(this.db.prepare('SELECT 1 FROM reminders WHERE key=?').get(key))continue;
          const title=(occ.override?.title||item.title||'(No title)').slice(0,300);
          this.db.prepare("INSERT INTO reminders(key,uid,collection,name,kind,title,occurrence,due,fired,state) VALUES(?,?,?,?,?,?,?,?,?,'active')").run(key,item.uid,row.collection,row.name,item.kind,title,occ.start,a.at,now);
          fired.push(this.reminder(key));
        }
        // Seek's prep work starts `leadHours` before the occurrence, once per occurrence.
        if(extra.prep&&occ.start>now&&occ.start-extra.prep.leadHours*3600000<=now&&extra.prep.startedFor!==occ.recurrenceId)
          prep.push({id:`${row.collection}/${row.name}`,uid:item.uid,kind:item.kind,title:occ.override?.title||item.title,start:occ.start,allDay:occ.allDay,occurrence:occ.recurrenceId,location:item.location,notes:item.notes,instruction:extra.prep.instruction});
      }
    }
    for(const r of this.db.prepare("SELECT key FROM reminders WHERE state='snoozed' AND snooze_until<=?").all(now)){this.db.prepare("UPDATE reminders SET state='active',fired=?,snooze_until=NULL WHERE key=?").run(now,r.key);fired.push({...this.reminder(r.key),snoozed:true});}
    this.setMeta('scannedAt',now);
    return {fired,prep};
  }
  markPrepStarted(uid,occurrence,taskId){const extra=this.extras(uid);if(extra.prep)this.setExtras(uid,{prep:{...extra.prep,startedFor:occurrence,taskId}});}
  reminder(key){const r=this.db.prepare('SELECT * FROM reminders WHERE key=?').get(key);if(!r)return null;return {key:r.key,id:`${r.collection}/${r.name}`,uid:r.uid,kind:r.kind,title:r.title,start:r.occurrence,due:r.due,fired:r.fired,state:r.state,snoozeUntil:r.snooze_until};}
  activeReminders(){return this.db.prepare("SELECT key FROM reminders WHERE state='active' ORDER BY fired DESC LIMIT 50").all().map(r=>this.reminder(r.key));}
  /** done | dismiss | snooze (minutes). Done on a to-do completes it. */
  actOnReminder(key,action,minutes=10){
    const r=this.reminder(key);if(!r)throw new CalendarError(404,'That reminder is gone.');
    if(action==='snooze'){const m=Math.min(Math.max(Number(minutes)||10,1),24*60);this.db.prepare("UPDATE reminders SET state='snoozed',snooze_until=?,acted=? WHERE key=?").run(this.now()+m*60000,this.now(),key);return this.reminder(key);}
    if(action==='done'&&r.kind==='todo'){try{this.complete(r.id,true);}catch(e){if(e.status!==404)throw e;}}
    else if(!['done','dismiss'].includes(action))throw new CalendarError(400,'Choose done, dismiss or snooze.');
    this.db.prepare("UPDATE reminders SET state='done',acted=? WHERE key=?").run(this.now(),key);return this.reminder(key);
  }
  // Messages for other channels (PAW on Discord) that pick them up and acknowledge delivery.
  enqueue(channel,data){const id=randomUUID();this.db.prepare('INSERT INTO outbox(id,channel,data,created) VALUES(?,?,?,?)').run(id,channel,JSON.stringify(data),this.now());return id;}
  pending(channel){return this.db.prepare('SELECT id,data,created FROM outbox WHERE channel=? AND delivered IS NULL AND created>? ORDER BY created LIMIT 20').all(channel,this.now()-86400000).map(r=>({...JSON.parse(r.data),id:r.id,created:r.created}));}
  delivered(ids){const stmt=this.db.prepare('UPDATE outbox SET delivered=? WHERE id=? AND delivered IS NULL');let n=0;for(const id of ids||[])n+=stmt.run(this.now(),String(id)).changes;this.db.prepare('DELETE FROM outbox WHERE created<?').run(this.now()-7*86400000);return n;}
}
