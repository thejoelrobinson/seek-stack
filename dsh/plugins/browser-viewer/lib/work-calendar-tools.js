// Seek's tools for the shared calendar and to-do list. Times are read and written as local
// wall-clock strings in the calendar's zone ("2026-10-12T15:00", or "2026-10-12" for all-day),
// so the model never does time-zone arithmetic.
import {zonedParts,zonedToUtc} from './work-ical.js';

const pad=n=>String(n).padStart(2,'0');
/** "2026-10-12T15:00" (zone-less) → ms in `zone`; "2026-10-12" → local midnight + allDay. */
export function parseWhen(value,zone){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value==='number')return {ms:value,dateOnly:false};
  const s=String(value).trim(),m=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(m)return {ms:zonedToUtc({y:+m[1],m:+m[2],d:+m[3],h:m[4]?+m[4]:0,mi:m[5]?+m[5]:0,s:m[6]?+m[6]:0},zone),dateOnly:!m[4]};
  const ms=Date.parse(s);if(!Number.isFinite(ms))throw new Error(`"${s}" is not a date. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM in local time.`);
  return {ms,dateOnly:false};
}
export function localText(ms,zone,{dateOnly=false}={}){
  if(ms==null)return null;const p=zonedParts(ms,zone);
  return dateOnly?`${p.y}-${pad(p.m)}-${pad(p.d)}`:`${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
const weekday=(ms,zone)=>new Intl.DateTimeFormat('en-US',{weekday:'short',timeZone:zone}).format(new Date(ms));
/** What the model sees for one item: local times, nothing it has to convert. */
export function present(item,zone){
  const day=item.allDay;
  const out={id:item.id,kind:item.kind,title:item.title};
  if(item.kind==='event'){out.start=localText(item.start,zone,{dateOnly:day});out.end=localText(day?item.end-86400000:item.end,zone,{dateOnly:day});out.day=weekday(item.start,zone);if(day)out.allDay=true;}
  else{out.due=localText(item.due,zone,{dateOnly:day});if(item.due!=null)out.day=weekday(item.due,zone);out.done=item.done;if(item.priority)out.priority=item.priority===1?'high':item.priority===5?'medium':'low';}
  if(item.location)out.location=item.location;if(item.notes)out.notes=item.notes.slice(0,500);
  if(item.repeat&&item.repeat!=='none')out.repeat=item.repeat;if(item.alerts?.length)out.alertMinutesBefore=item.alerts;
  if(item.prep)out.seekPrepares={instruction:item.prep.instruction,leadHours:item.prep.leadHours};
  out.addedBy=item.source==='seek'?'Seek':item.source==='apple'?'an Apple device':'the user';
  return out;
}
const fieldsFrom=(a,zone,kind)=>{
  const f={};
  for(const k of ['title','notes','location','repeat'])if(a[k]!==undefined)f[k]=a[k];
  if(a.alertMinutesBefore!==undefined)f.alerts=Array.isArray(a.alertMinutesBefore)?a.alertMinutesBefore:[a.alertMinutesBefore];
  if(kind==='event'){
    const s=a.start!==undefined?parseWhen(a.start,zone):null,e=a.end!==undefined?parseWhen(a.end,zone):null;
    if(s){f.start=s.ms;f.allDay=a.allDay??s.dateOnly;}else if(a.allDay!==undefined)f.allDay=!!a.allDay;
    // All-day ends are inclusive for people ("through Sunday"); iCalendar stores the day after.
    if(e)f.end=(a.allDay??s?.dateOnly??e.dateOnly)&&e.dateOnly?e.ms+86400000:e.ms;
  }else{
    if(a.due!==undefined){const d=parseWhen(a.due,zone);f.due=d?.ms??null;f.allDay=d?d.dateOnly:false;}
    if(a.priority!==undefined)f.priority={high:1,medium:5,low:9,none:0}[String(a.priority).toLowerCase()]??0;
  }
  if(a.prepare!==undefined)f.prep=a.prepare?{instruction:a.prepare,leadHours:a.prepareHoursBefore??24}:null;
  return f;
};

export function calendarTools(calendar,register,{forAgent=()=>null}={}){
  const str=(description,required=false)=>({type:'string',description,...(required?{required:true}:{})});
  const zone=()=>calendar.zone;
  const guide=`The shared calendar ("Seek") and to-do list ("Seek To-dos") belong to the user and you; they sync both ways with the user's Apple Calendar and Reminders. Times are local (${'${zone}'}) wall-clock strings: YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all-day. Check for conflicts with calendar_agenda before adding events. Only add, change or remove items when the user asked or clearly agreed; say exactly what you changed.`;
  const desc=text=>`${text} ${guide.replace('${zone}',zone())}`;
  const common={title:str('Short title.'),notes:str('Optional notes.'),location:str('Optional place or address (events).'),repeat:str('Optional: none, daily, weekdays, weekly, biweekly, monthly or yearly.'),
    alertMinutesBefore:{type:'array',items:{type:'number'},description:'Optional alerts, minutes before (0 = at the time; for all-day items, before 9:00 that day). Omit for the default.'},
    prepare:str('Optional: work Seek should do ahead of time (e.g. "find two gift ideas under $50"). Seek starts it automatically and still asks before buying, booking or sending.'),
    prepareHoursBefore:{type:'number',description:'How many hours ahead Seek starts the prep work (default 24).'}};
  const mark=e=>{try{forAgent(e);}catch{}};
  return [
    register('calendar_agenda',desc('List events (each repeat expanded) and open to-dos between two local dates. Defaults to today through the next 7 days. Overdue to-dos are always included.'),
      {from:str('Start date, YYYY-MM-DD (default today).'),to:str('End date, YYYY-MM-DD, inclusive (default 7 days on).'),includeDone:{type:'boolean',description:'Include to-dos finished in the last two weeks.'}},
      async(a,e)=>{mark(e);const z=zone(),now=Date.now(),today=calendar.midnight(now);
        const from=a.from?parseWhen(a.from,z).ms:today,to=(a.to?parseWhen(a.to,z).ms:today+7*86400000)+86400000;
        if(to-from>366*86400000)throw new Error('Ask for at most a year at a time.');
        const r=calendar.range(from,to);
        const todos=r.todos.filter(t=>(a.includeDone||!t.done)&&(t.due==null||t.due<to));
        return {zone:z,now:localText(now,z),from:localText(from,z,{dateOnly:true}),to:localText(to-86400000,z,{dateOnly:true}),events:r.events.map(x=>({...present(x,z),...(x.recurring?{occurrenceOf:x.id}:{})})),todos:todos.map(x=>present(x,z)),reminders:calendar.activeReminders().map(x=>({title:x.title,kind:x.kind,firedAt:localText(x.fired,z)}))};}),
    register('calendar_search',desc('Find events and to-dos by words in the title, notes or place.'),{query:str('Words to find.',true)},
      async(a,e)=>{mark(e);return {items:calendar.search(a.query).map(x=>present(x,zone()))};}),
    register('calendar_add_event',desc('Add an event to the shared calendar.'),{...common,title:str('Short title.',true),start:str('Start, YYYY-MM-DDTHH:MM (or YYYY-MM-DD for all-day).',true),end:str('End (default 1 hour after the start; for all-day, the last day).'),allDay:{type:'boolean',description:'All-day event.'}},
      async(a,e)=>{mark(e);return {added:present(calendar.save('event',fieldsFrom(a,zone(),'event'),{source:'seek'}),zone())};}),
    register('calendar_update_event',desc('Change an event. Pass only what changes. Editing a repeating event changes the whole series.'),{...common,id:str('Event id from calendar_agenda or calendar_search.',true),start:str('New start.'),end:str('New end.'),allDay:{type:'boolean',description:'All-day event.'}},
      async(a,e)=>{mark(e);return {updated:present(calendar.save('event',fieldsFrom(a,zone(),'event'),{id:a.id,source:'seek'}),zone())};}),
    register('todo_add',desc('Add a to-do to the shared list (it appears in the user\'s Reminders).'),{...common,title:str('What to do.',true),due:str('Optional due date or date-time.'),priority:str('Optional: high, medium, low.')},
      async(a,e)=>{mark(e);return {added:present(calendar.save('todo',fieldsFrom(a,zone(),'todo'),{source:'seek'}),zone())};}),
    register('todo_update',desc('Change a to-do. Pass only what changes; due:"" removes the due date.'),{...common,id:str('To-do id.',true),due:str('New due date or date-time.'),priority:str('high, medium, low or none.')},
      async(a,e)=>{mark(e);return {updated:present(calendar.save('todo',fieldsFrom(a,zone(),'todo'),{id:a.id,source:'seek'}),zone())};}),
    register('todo_complete',desc('Tick off a to-do (repeating ones move to their next date), or reopen it with done:false.'),{id:str('To-do id.',true),done:{type:'boolean',description:'false to reopen.'}},
      async(a,e)=>{mark(e);return {todo:present(calendar.complete(a.id,a.done!==false,{source:'seek'}),zone())};}),
    register('calendar_delete',desc('Delete an event (the whole series if it repeats) or a to-do. Only when the user asked.'),{id:str('Event or to-do id.',true)},
      async(a,e)=>{mark(e);const item=present(calendar.summary(calendar.find(a.id)),zone());calendar.delete(a.id,{source:'seek'});return {deleted:item};})
  ];
}
