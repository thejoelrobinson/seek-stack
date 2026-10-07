// iCalendar (RFC 5545) for the shared calendar: parse and write VEVENT/VTODO resources without
// losing what other clients stored, resolve times in IANA zones through Intl, expand the
// repeat rules Apple Calendar and Reminders write, and work out when each alarm fires.
// Everything here is pure: no storage, no clock, so it is tested directly.

const CRLF='\r\n';
const pad=(n,w=2)=>String(n).padStart(w,'0');

// ── Text format ────────────────────────────────────────────────────────────────
export function unfold(text){return String(text||'').replace(/\r\n|\r/g,'\n').replace(/\n[ \t]/g,'');}
function splitParams(head){
  const out=[];let cur='',quoted=false;
  for(const ch of head){if(ch==='"')quoted=!quoted;if(ch===';'&&!quoted){out.push(cur);cur='';continue;}cur+=ch;}
  out.push(cur);return out;
}
export function parseLine(line){
  let quoted=false,colon=-1;
  for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"')quoted=!quoted;else if(ch===':'&&!quoted){colon=i;break;}}
  if(colon<0)return null;
  const [name,...params]=splitParams(line.slice(0,colon));
  const out={name:name.toUpperCase(),params:{},value:line.slice(colon+1)};
  for(const p of params){const eq=p.indexOf('=');if(eq<0)continue;out.params[p.slice(0,eq).toUpperCase()]=p.slice(eq+1).replace(/^"|"$/g,'');}
  return out;
}
/** Parses one iCalendar object into {name, props:[{name,params,value}], children:[...]}. */
export function parseICS(text){
  const root={name:'ROOT',props:[],children:[]},stack=[root];
  for(const raw of unfold(text).split('\n')){
    if(!raw.trim())continue;
    const line=parseLine(raw);if(!line)continue;
    if(line.name==='BEGIN'){const comp={name:line.value.toUpperCase().trim(),props:[],children:[]};stack.at(-1).children.push(comp);stack.push(comp);continue;}
    if(line.name==='END'){if(stack.length>1)stack.pop();continue;}
    stack.at(-1).props.push(line);
  }
  const cal=root.children.find(c=>c.name==='VCALENDAR');
  if(!cal)throw new Error('Not an iCalendar object (no VCALENDAR).');
  return cal;
}
const paramValue=v=>/[;:,"]/.test(v)?`"${String(v).replace(/"/g,'')}"`:v;
function fold(line){
  // Fold at 75 octets without splitting a UTF-8 sequence.
  const bytes=Buffer.from(line,'utf8');if(bytes.length<=75)return line;
  const parts=[];let start=0,limit=75;
  while(start<bytes.length){let end=Math.min(start+limit,bytes.length);while(end<bytes.length&&(bytes[end]&0xC0)===0x80)end--;parts.push(bytes.subarray(start,end).toString('utf8'));start=end;limit=74;}
  return parts.join(CRLF+' ');
}
export function serializeICS(comp){
  const lines=[];
  const walk=c=>{lines.push('BEGIN:'+c.name);for(const p of c.props)lines.push(fold(p.name+Object.entries(p.params||{}).map(([k,v])=>`;${k}=${paramValue(v)}`).join('')+':'+p.value));for(const child of c.children)walk(child);lines.push('END:'+c.name);};
  walk(comp);return lines.join(CRLF)+CRLF;
}
export const escapeText=s=>String(s??'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
export const unescapeText=s=>String(s??'').replace(/\\([\\;,nN])/g,(_,c)=>c==='n'||c==='N'?'\n':c);
export const prop=(comp,name)=>comp?.props.find(p=>p.name===name);
export const props=(comp,name)=>comp?.props.filter(p=>p.name===name)||[];
export function setProp(comp,name,value,params={}){
  const at=comp.props.findIndex(p=>p.name===name);comp.props=comp.props.filter(p=>p.name!==name);
  if(value===null||value===undefined||value==='')return;
  const line={name,params,value:String(value)};
  if(at<0)comp.props.push(line);else comp.props.splice(Math.min(at,comp.props.length),0,line);
}
export const removeProps=(comp,...names)=>{comp.props=comp.props.filter(p=>!names.includes(p.name));};

// ── Time zones ─────────────────────────────────────────────────────────────────
const WINDOWS_ZONES={'central standard time':'America/Chicago','eastern standard time':'America/New_York','mountain standard time':'America/Denver','pacific standard time':'America/Los_Angeles','us mountain standard time':'America/Phoenix','alaskan standard time':'America/Anchorage','hawaiian standard time':'Pacific/Honolulu','gmt standard time':'Europe/London','w. europe standard time':'Europe/Berlin','utc':'UTC','coordinated universal time':'UTC'};
const formatters=new Map();
function formatter(tz){let f=formatters.get(tz);if(!f){f=new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short'});formatters.set(tz,f);}return f;}
export function validZone(tz){if(!tz)return null;const t=String(tz).trim();try{formatter(t).format(0);return t;}catch{}const w=WINDOWS_ZONES[t.toLowerCase()];if(w)return w;const tail=t.match(/[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/)?.[0];if(tail){try{formatter(tail).format(0);return tail;}catch{}}return null;}
const WEEKDAYS={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ms,tz){
  const o={};for(const p of formatter(tz).formatToParts(new Date(ms)))o[p.type]=p.value;
  return {y:+o.year,m:+o.month,d:+o.day,h:+o.hour,mi:+o.minute,s:+o.second,wd:WEEKDAYS[o.weekday]};
}
const offsetAt=(ms,tz)=>{const p=zonedParts(ms,tz);return Date.UTC(p.y,p.m-1,p.d,p.h,p.mi,p.s)-Math.floor(ms/1000)*1000;};
/** The instant a wall-clock time in a zone denotes. Times skipped by DST move forward, like Apple does. */
export function zonedToUtc({y,m,d,h=0,mi=0,s=0},tz){
  const guess=Date.UTC(y,m-1,d,h,mi,s),t1=guess-offsetAt(guess,tz),t2=guess-offsetAt(t1,tz);
  const fits=t=>{const p=zonedParts(t,tz);return p.y===y&&p.m===m&&p.d===d&&p.h===h&&p.mi===mi;};
  const exact=[t1,t2].filter(fits);
  // An ambiguous time (clocks fall back) means the first one; a skipped time moves forward.
  return exact.length?Math.min(...exact):Math.max(t1,t2);
}

// ── Date values ────────────────────────────────────────────────────────────────
const DATE_RE=/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;
export function parseWall(value){const m=String(value).trim().match(DATE_RE);if(!m)return null;return {y:+m[1],m:+m[2],d:+m[3],h:m[4]===undefined?null:+m[4],mi:m[5]===undefined?0:+m[5],s:m[6]===undefined?0:+m[6],utc:!!m[7]};}
/**
 * A DTSTART/DTEND/DUE/RECURRENCE-ID/EXDATE value as {ms, allDay, tz, wall}.
 * All-day dates keep their calendar date (ms = local midnight in `tz`); floating times use `tz`.
 */
export function parseDate(line,defaultZone='UTC',valueOverride){
  if(!line)return null;
  const wall=parseWall(valueOverride??line.value);if(!wall)return null;
  const allDay=line.params?.VALUE==='DATE'||wall.h===null;
  const tz=wall.utc?'UTC':validZone(line.params?.TZID)||defaultZone;
  const ms=wall.utc?Date.UTC(wall.y,wall.m-1,wall.d,wall.h||0,wall.mi,wall.s):zonedToUtc({...wall,h:wall.h||0},tz);
  return {ms,allDay,tz,wall:{y:wall.y,m:wall.m,d:wall.d,h:wall.h||0,mi:wall.mi,s:wall.s},floating:!wall.utc&&!line.params?.TZID};
}
export const ymd=({y,m,d})=>`${y}${pad(m)}${pad(d)}`;
export const wallString=w=>`${ymd(w)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`;
export function utcString(ms){const d=new Date(ms);return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;}
/** Writes a date property: all-day as VALUE=DATE, timed in its zone (TZID) or UTC. */
export function dateProp(name,{ms,allDay,tz}){
  if(allDay){const p=zonedParts(ms,tz||'UTC');return {name,params:{VALUE:'DATE'},value:ymd(p)};}
  if(!tz||tz==='UTC')return {name,params:{},value:utcString(ms)};
  return {name,params:{TZID:tz},value:wallString(zonedParts(ms,tz))};
}

// ── Durations ──────────────────────────────────────────────────────────────────
export function parseDuration(value){
  const m=String(value||'').trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if(!m)return null;
  const ms=((+m[2]||0)*7*86400+(+m[3]||0)*86400+(+m[4]||0)*3600+(+m[5]||0)*60+(+m[6]||0))*1000;
  return m[1]==='-'?-ms:ms;
}
export function formatDuration(ms){
  const sign=ms<0?'-':'';let s=Math.round(Math.abs(ms)/1000);if(!s)return 'PT0S';
  const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const mi=Math.floor(s/60);s%=60;
  if(d&&!h&&!mi&&!s)return d%7===0?`${sign}P${d/7}W`:`${sign}P${d}D`;
  return `${sign}P${d?d+'D':''}T${h?h+'H':''}${mi?mi+'M':''}${s?s+'S':''}`;
}

// ── Repeat rules ───────────────────────────────────────────────────────────────
const DAY_CODES=['SU','MO','TU','WE','TH','FR','SA'];
export function parseRRule(value){
  if(!value)return null;const r={};
  for(const part of String(value).split(';')){const [k,v]=part.split('=');if(!k||v===undefined)continue;r[k.toUpperCase()]=v;}
  if(!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(r.FREQ))return null;
  return {freq:r.FREQ,interval:Math.max(1,+r.INTERVAL||1),count:r.COUNT?+r.COUNT:null,until:r.UNTIL||null,
    byday:r.BYDAY?r.BYDAY.split(',').map(x=>{const m=x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);return m?{n:m[1]?+m[1]:0,wd:DAY_CODES.indexOf(m[2])}:null;}).filter(Boolean):null,
    bymonthday:r.BYMONTHDAY?r.BYMONTHDAY.split(',').map(Number):null,bymonth:r.BYMONTH?r.BYMONTH.split(',').map(Number):null,
    bysetpos:r.BYSETPOS?r.BYSETPOS.split(',').map(Number):null};
}
const daysIn=(y,m)=>new Date(Date.UTC(y,m,0)).getUTCDate();
const weekdayOf=(y,m,d)=>new Date(Date.UTC(y,m-1,d)).getUTCDay();
const addDays=(w,n)=>{const t=new Date(Date.UTC(w.y,w.m-1,w.d+n));return {...w,y:t.getUTCFullYear(),m:t.getUTCMonth()+1,d:t.getUTCDate()};};
const wallKey=w=>Date.UTC(w.y,w.m-1,w.d,w.h,w.mi,w.s);
function nthWeekdays(y,m,{n,wd}){
  const all=[];for(let d=1;d<=daysIn(y,m);d++)if(weekdayOf(y,m,d)===wd)all.push(d);
  if(!n)return all;const pick=n>0?all[n-1]:all[all.length+n];return pick?[pick]:[];
}
/** Candidate wall times within one period of the rule, in order. */
function periodCandidates(rule,start,period){
  const {h,mi,s}=start;let days=[];
  if(rule.freq==='DAILY'){const w=period;days=[[w.y,w.m,w.d]];if(rule.bymonth&&!rule.bymonth.includes(w.m))days=[];if(rule.byday&&!rule.byday.some(b=>b.wd===weekdayOf(w.y,w.m,w.d)))days=[];if(rule.bymonthday&&!rule.bymonthday.some(md=>(md>0?md:daysIn(w.y,w.m)+md+1)===w.d))days=[];}
  else if(rule.freq==='WEEKLY'){
    const wds=rule.byday?rule.byday.map(b=>b.wd):[weekdayOf(start.y,start.m,start.d)];
    // Weeks start on Monday (Apple's default WKST), so Sunday is the last day of its week.
    const monday=addDays(period,-((weekdayOf(period.y,period.m,period.d)+6)%7));
    for(const wd of [...new Set(wds)].sort((a,b)=>((a+6)%7)-((b+6)%7))){const w=addDays(monday,(wd+6)%7);if(!rule.bymonth||rule.bymonth.includes(w.m))days.push([w.y,w.m,w.d]);}
  }
  else if(rule.freq==='MONTHLY'){
    const {y,m}=period;if(rule.bymonth&&!rule.bymonth.includes(m))return [];
    let list=[];
    if(rule.byday)for(const b of rule.byday)list.push(...nthWeekdays(y,m,b));
    if(rule.bymonthday){const md=rule.bymonthday.map(x=>x>0?x:daysIn(y,m)+x+1).filter(x=>x>=1&&x<=daysIn(y,m));list=rule.byday?list.filter(d=>md.includes(d)):md;}
    if(!rule.byday&&!rule.bymonthday&&start.d<=daysIn(y,m))list=[start.d];
    list=[...new Set(list)].sort((a,b)=>a-b);
    if(rule.bysetpos)list=rule.bysetpos.map(p=>p>0?list[p-1]:list[list.length+p]).filter(Boolean).sort((a,b)=>a-b);
    days=list.map(d=>[y,m,d]);
  }
  else if(rule.freq==='YEARLY'){
    const {y}=period;const months=rule.bymonth||[start.m];
    for(const m of months){
      let list=[];
      if(rule.byday)for(const b of rule.byday)list.push(...nthWeekdays(y,m,b));
      if(rule.bymonthday){const md=rule.bymonthday.map(x=>x>0?x:daysIn(y,m)+x+1);list=rule.byday?list.filter(d=>md.includes(d)):md.filter(x=>x>=1&&x<=daysIn(y,m));}
      if(!rule.byday&&!rule.bymonthday&&start.d<=daysIn(y,m))list=[start.d];
      days.push(...[...new Set(list)].sort((a,b)=>a-b).map(d=>[y,m,d]));
    }
  }
  return days.map(([y,m,d])=>({y,m,d,h,mi,s}));
}
function nextPeriod(rule,p){
  if(rule.freq==='DAILY')return addDays(p,rule.interval);
  if(rule.freq==='WEEKLY')return addDays(p,7*rule.interval);
  if(rule.freq==='MONTHLY'){const t=p.m-1+rule.interval;return {...p,y:p.y+Math.floor(t/12),m:t%12+1,d:1};}
  return {...p,y:p.y+rule.interval,d:1};
}
/**
 * Wall times of a repeating item, starting with DTSTART itself, between `fromKey` and `toKey`
 * (wall-clock keys from wallKey). Stops at COUNT/UNTIL; at most `limit` results.
 */
export function expandRule(rule,start,{toMs,untilMs=null,limit=1000}={}){
  const out=[];let count=0,period={...start,d:rule.freq==='MONTHLY'||rule.freq==='YEARLY'?1:start.d},guard=0;
  const startKey=wallKey(start);
  while(guard++<20000){
    for(const w of periodCandidates(rule,start,period)){
      const key=wallKey(w);if(key<startKey)continue;
      if(untilMs!==null&&key>untilMs)return out;
      if(rule.count!==null&&count>=rule.count)return out;
      count++;out.push(w);
      if(out.length>=limit||key>toMs)return out;
    }
    period=nextPeriod(rule,period);
    if(wallKey({...period,h:0,mi:0,s:0})>toMs+86400000*7)return out;
  }
  return out;
}

// ── Items ──────────────────────────────────────────────────────────────────────
const MAIN=new Set(['VEVENT','VTODO']);
function readAlarms(comp){
  return comp.children.filter(c=>c.name==='VALARM').map(a=>{
    const trig=prop(a,'TRIGGER');if(!trig)return null;
    const abs=trig.params.VALUE==='DATE-TIME'||/^\d{8}T/.test(trig.value);
    return {absolute:abs?parseDate(trig,'UTC')?.ms??null:null,offset:abs?null:parseDuration(trig.value),related:trig.params.RELATED==='END'?'END':'START',
      action:prop(a,'ACTION')?.value||'DISPLAY',acknowledged:prop(a,'ACKNOWLEDGED')?parseDate(prop(a,'ACKNOWLEDGED'),'UTC')?.ms??null:null,uid:prop(a,'X-WR-ALARMUID')?.value||prop(a,'UID')?.value||null};
  }).filter(a=>a&&(a.absolute!==null||a.offset!==null));
}
function readComponent(comp,zone){
  const text=n=>{const p=prop(comp,n);return p?unescapeText(p.value):'';};
  const start=parseDate(prop(comp,'DTSTART'),zone),due=parseDate(prop(comp,'DUE'),zone);
  let end=parseDate(prop(comp,'DTEND'),zone);
  if(!end&&start){const dur=parseDuration(prop(comp,'DURATION')?.value);end={...start,ms:start.ms+(dur??(start.allDay?86400000:0))};}
  const exdates=props(comp,'EXDATE').flatMap(p=>p.value.split(',').map(v=>parseDate(p,zone,v)?.ms)).filter(Number.isFinite);
  return {uid:prop(comp,'UID')?.value||'',title:text('SUMMARY'),notes:text('DESCRIPTION'),location:text('LOCATION'),url:prop(comp,'URL')?.value||'',
    start,end,due,status:prop(comp,'STATUS')?.value||'',completed:prop(comp,'COMPLETED')?parseDate(prop(comp,'COMPLETED'),'UTC')?.ms:null,
    percent:+(prop(comp,'PERCENT-COMPLETE')?.value||0),priority:+(prop(comp,'PRIORITY')?.value||0),rrule:prop(comp,'RRULE')?.value||null,exdates,
    recurrenceId:prop(comp,'RECURRENCE-ID')?parseDate(prop(comp,'RECURRENCE-ID'),zone)?.ms:null,alarms:readAlarms(comp),
    sequence:+(prop(comp,'SEQUENCE')?.value||0),lastModified:prop(comp,'LAST-MODIFIED')?parseDate(prop(comp,'LAST-MODIFIED'),'UTC')?.ms:null,
    relatedTo:prop(comp,'RELATED-TO')?.value||null};
}
/** Reads a stored resource: its main VEVENT/VTODO plus any overridden occurrences. */
export function readItem(cal,zone='UTC'){
  const comps=cal.children.filter(c=>MAIN.has(c.name));if(!comps.length)throw new Error('The calendar object has no event or to-do.');
  const kind=comps[0].name==='VTODO'?'todo':'event';
  const master=comps.find(c=>!prop(c,'RECURRENCE-ID'))||comps[0];
  const item={kind,...readComponent(master,zone),overrides:comps.filter(c=>c!==master&&prop(c,'RECURRENCE-ID')).map(c=>readComponent(c,zone))};
  item.done=kind==='todo'&&(item.status==='COMPLETED'||!!item.completed);
  return item;
}
/**
 * Occurrences of an item overlapping [from, to): {start, end, recurrenceId, overridden}.
 * To-dos occur at DUE (or DTSTART); undated to-dos have none.
 */
export function occurrences(item,from,to,{limit=500}={}){
  const anchor=item.kind==='todo'?(item.due||item.start):item.start;if(!anchor)return [];
  const length=item.kind==='event'&&item.end?item.end.ms-item.start.ms:0;
  const tz=anchor.tz||'UTC',rule=parseRRule(item.rrule);
  const make=(ms,override)=>{const o=override;const s=o?(item.kind==='todo'?(o.due||o.start):o.start)?.ms??ms:ms;const e=o&&item.kind==='event'&&o.end?o.end.ms:s+length;return {start:s,end:e,recurrenceId:ms,override:o||null,allDay:anchor.allDay};};
  const overrides=new Map(item.overrides.map(o=>[o.recurrenceId,o]));
  const out=[];
  if(!rule){const o=make(anchor.ms,null);if(o.end>=from&&o.start<to||o.start===o.end&&o.start>=from&&o.start<to)out.push(o);return out;}
  const toWall=to+86400000*2,until=rule.until?parseDate({name:'UNTIL',params:{},value:rule.until},tz):null;
  const untilWall=until?(()=>{const p=until.allDay?{...until.wall,h:23,mi:59,s:59}:zonedParts(until.ms,tz);return wallKey(p);})():null;
  const fromWall=from-length-86400000*2;
  for(const w of expandRule(rule,anchor.wall,{toMs:toWall,untilMs:untilWall,limit:20000})){
    if(wallKey(w)<fromWall)continue;
    const ms=anchor.allDay?zonedToUtc({...w,h:0,mi:0,s:0},tz):zonedToUtc(w,tz);
    if(item.exdates.includes(ms))continue;
    const o=make(ms,overrides.get(ms));
    if((o.end>from||o.start>=from)&&o.start<to)out.push(o);
    if(out.length>=limit||o.start>=to)break;
  }
  // Overrides moved into the window from outside their original slot.
  for(const ov of item.overrides){const o=make(ov.recurrenceId,ov);if(o.start<to&&o.end>from&&!out.some(x=>x.recurrenceId===ov.recurrenceId))out.push(o);}
  return out.sort((a,b)=>a.start-b.start);
}
/** Absolute times every alarm of an occurrence fires, skipping alarms acknowledged on a device. */
export function alarmTimes(item,occurrence){
  const alarms=occurrence.override?.alarms?.length?occurrence.override.alarms:item.alarms;
  return alarms.map(a=>{
    const base=a.related==='END'?occurrence.end:occurrence.start;
    const at=a.absolute??(base+a.offset);
    return {at,alarm:a,acknowledged:a.acknowledged!==null&&a.acknowledged>=at};
  });
}

// ── Writing ────────────────────────────────────────────────────────────────────
/** VTIMEZONE for a zone, with yearly rules derived from this year's transitions. */
export function vtimezone(tz,year=new Date().getUTCFullYear()){
  const comp={name:'VTIMEZONE',props:[{name:'TZID',params:{},value:tz}],children:[]};
  const off=ms=>Math.round(offsetAt(ms,tz)/60000);
  const fmt=min=>`${min<0?'-':'+'}${pad(Math.floor(Math.abs(min)/60))}${pad(Math.abs(min)%60)}`;
  const jan=off(Date.UTC(year,0,1)),jul=off(Date.UTC(year,6,1));
  if(jan===jul){comp.children.push({name:'STANDARD',props:[{name:'DTSTART',params:{},value:'19700101T000000'},{name:'TZOFFSETFROM',params:{},value:fmt(jan)},{name:'TZOFFSETTO',params:{},value:fmt(jan)}],children:[]});return comp;}
  const transitions=[];let prev=off(Date.UTC(year,0,1));
  for(let h=0;h<366*24;h++){const t=Date.UTC(year,0,1)+h*3600000,o=off(t);if(o!==prev){let lo=t-3600000,hi=t;while(hi-lo>60000){const mid=lo+Math.floor((hi-lo)/2);if(off(mid)===prev)lo=mid;else hi=mid;}transitions.push({at:hi,from:prev,to:o});prev=o;}}
  for(const tr of transitions){
    const local=zonedParts(tr.at-60000,tz);const wall={...local,mi:local.mi+1};if(wall.mi===60){wall.mi=0;wall.h++;}
    const n=Math.ceil(local.d/7),last=local.d+7>daysIn(local.y,local.m);
    const byday=`${last&&n>=4?-1:n}${DAY_CODES[local.wd]}`;
    let d1970=1;const matches=nthWeekdays(1970,local.m,{n:last&&n>=4?-1:n,wd:local.wd});if(matches.length)d1970=matches[0];
    comp.children.push({name:tr.to>tr.from?'DAYLIGHT':'STANDARD',props:[{name:'DTSTART',params:{},value:`1970${pad(local.m)}${pad(d1970)}T${pad(wall.h)}${pad(wall.mi)}00`},{name:'RRULE',params:{},value:`FREQ=YEARLY;BYMONTH=${local.m};BYDAY=${byday}`},{name:'TZOFFSETFROM',params:{},value:fmt(tr.from)},{name:'TZOFFSETTO',params:{},value:fmt(tr.to)}],children:[]});
  }
  return comp;
}
export function newCalendar(){return {name:'VCALENDAR',props:[{name:'VERSION',params:{},value:'2.0'},{name:'PRODID',params:{},value:'-//Seek//Shared Calendar//EN'},{name:'CALSCALE',params:{},value:'GREGORIAN'}],children:[]};}
const ALARM_UID=()=>globalThis.crypto.randomUUID().toUpperCase();
function writeAlarms(comp,alarms,title){
  comp.children=comp.children.filter(c=>c.name!=='VALARM');
  for(const a of alarms||[]){
    const trigger=a.absolute!=null?{name:'TRIGGER',params:{VALUE:'DATE-TIME'},value:utcString(a.absolute)}:{name:'TRIGGER',params:a.related==='END'?{RELATED:'END'}:{},value:formatDuration(a.offset??0)};
    const uid=a.uid||ALARM_UID();
    comp.children.push({name:'VALARM',props:[{name:'X-WR-ALARMUID',params:{},value:uid},{name:'UID',params:{},value:uid},{name:'ACTION',params:{},value:'DISPLAY'},{name:'DESCRIPTION',params:{},value:escapeText(title||'Reminder')},trigger],children:[]});
  }
}
/**
 * Applies a plain description of an item onto a calendar object (new or stored), keeping every
 * property another client wrote that this change does not touch. Returns the calendar tree.
 * `fields` uses ms timestamps; `allDay` dates are local midnights in `tz`.
 */
export function applyItem(cal,kind,fields,{tz='UTC',now=Date.now()}={}){
  cal=cal||newCalendar();
  const name=kind==='todo'?'VTODO':'VEVENT';
  let comp=cal.children.find(c=>c.name===name&&!prop(c,'RECURRENCE-ID'));
  if(!comp){comp={name,props:[{name:'UID',params:{},value:fields.uid}],children:[]};cal.children.push(comp);}
  const has=k=>Object.prototype.hasOwnProperty.call(fields,k);
  const zones=new Set();
  const date=(propName,ms,allDay)=>{removeProps(comp,propName);if(ms==null)return;const line=dateProp(propName,{ms,allDay,tz});if(line.params.TZID)zones.add(line.params.TZID);comp.props.push(line);};
  setProp(comp,'DTSTAMP',utcString(now));
  if(!prop(comp,'CREATED'))setProp(comp,'CREATED',utcString(now));
  setProp(comp,'LAST-MODIFIED',utcString(now));
  setProp(comp,'SEQUENCE',String((+(prop(comp,'SEQUENCE')?.value||0))+(prop(comp,'SEQUENCE')?1:0)));
  if(has('title'))setProp(comp,'SUMMARY',escapeText(fields.title));
  if(has('notes'))setProp(comp,'DESCRIPTION',fields.notes?escapeText(fields.notes):null);
  if(has('location'))setProp(comp,'LOCATION',fields.location?escapeText(fields.location):null);
  if(kind==='event'){
    if(has('start')){date('DTSTART',fields.start,!!fields.allDay);removeProps(comp,'DURATION');date('DTEND',fields.end??(fields.allDay?fields.start+86400000:fields.start+3600000),!!fields.allDay);}
  }else{
    if(has('due')){date('DUE',fields.due,!!fields.allDay);if(fields.due==null)removeProps(comp,'DTSTART');else if(prop(comp,'DTSTART'))date('DTSTART',fields.due,!!fields.allDay);}
    if(has('priority'))setProp(comp,'PRIORITY',fields.priority?String(fields.priority):null);
    if(has('done')){
      if(fields.done){setProp(comp,'STATUS','COMPLETED');setProp(comp,'COMPLETED',utcString(now));setProp(comp,'PERCENT-COMPLETE','100');}
      else{setProp(comp,'STATUS','NEEDS-ACTION');removeProps(comp,'COMPLETED','PERCENT-COMPLETE');}
    }else if(!prop(comp,'STATUS'))setProp(comp,'STATUS','NEEDS-ACTION');
  }
  if(has('rrule'))setProp(comp,'RRULE',fields.rrule||null);
  if(has('alarms'))writeAlarms(comp,fields.alarms,fields.title||unescapeText(prop(comp,'SUMMARY')?.value||''));
  // Every TZID used needs its VTIMEZONE.
  for(const p of comp.props)if(p.params?.TZID)zones.add(p.params.TZID);
  for(const zone of zones)if(!cal.children.some(c=>c.name==='VTIMEZONE'&&prop(c,'TZID')?.value===zone)&&validZone(zone))cal.children.unshift(vtimezone(zone));
  return cal;
}
/** Moves a repeating to-do to its next due date (what Reminders does when you tick one off). */
export function advanceRepeatingTodo(cal,{now=Date.now(),zone='UTC'}={}){
  const comp=cal.children.find(c=>c.name==='VTODO'&&!prop(c,'RECURRENCE-ID'));if(!comp)return false;
  const item=readItem(cal,zone),anchor=item.due||item.start;if(!item.rrule||!anchor)return false;
  const next=occurrences(item,anchor.ms+1000,anchor.ms+86400000*366*5,{limit:1})[0];
  if(!next){return false;}
  const shift=next.start-anchor.ms;
  for(const name of ['DUE','DTSTART']){const p=prop(comp,name);if(!p)continue;const d=parseDate(p,zone);const line=dateProp(name,{ms:d.ms+shift,allDay:d.allDay,tz:d.floating?zone:d.tz});removeProps(comp,name);comp.props.push(line);}
  setProp(comp,'STATUS','NEEDS-ACTION');removeProps(comp,'COMPLETED','PERCENT-COMPLETE');
  for(const alarm of comp.children.filter(c=>c.name==='VALARM'))removeProps(alarm,'ACKNOWLEDGED');
  setProp(comp,'LAST-MODIFIED',utcString(now));setProp(comp,'DTSTAMP',utcString(now));
  return true;
}
