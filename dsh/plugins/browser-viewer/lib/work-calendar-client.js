// The shared calendar page (Agenda · Week · Month + To-dos), its editor, Apple sync setup, and the
// small pieces it lends the rest of Work: Today on Home, Reminders in the Inbox, a Connections card.
import {request} from '/work/runtime.js';
import {zonedParts,zonedToUtc} from '/work/ical.js';

const $=s=>document.querySelector(s);
const DAY=86400000,HOUR_PX=48;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=(name,cls='')=>`<svg class="ic${cls?' '+cls:''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
const phone=()=>matchMedia('(max-width:640px)').matches;
const store=(k,v)=>{try{if(v===undefined)return localStorage.getItem('seek-cal-'+k);localStorage.setItem('seek-cal-'+k,v);}catch{}return null;};

let data=null,loadingKey='',lastLoad=0,lastSig='',zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
let mode=store('mode')||'week',tab='calendar',cursor=null,showDone=false,devices=null,setupResult=null,seenReminders=new Set(),firstReminders=true;

// ── Time in the calendar's zone ───────────────────────────────────────────────
const parts=ms=>zonedParts(ms,zone);
const midnight=ms=>{const p=parts(ms);return zonedToUtc({y:p.y,m:p.m,d:p.d},zone);};
const addDays=(ms,n)=>{const p=parts(ms);return zonedToUtc({y:p.y,m:p.m,d:p.d+n},zone);};
const dayKey=ms=>{const p=parts(ms);return `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;};
const fmt=(ms,o)=>new Intl.DateTimeFormat(undefined,{timeZone:zone,...o}).format(new Date(ms));
const timeText=ms=>fmt(ms,{hour:'numeric',minute:'2-digit'}).replace(':00','').replace(' ',' ');
const dayText=ms=>fmt(ms,{weekday:'short',month:'short',day:'numeric'});
const today=()=>midnight(Date.now());
const weekStart=ms=>{const m=midnight(ms),wd=(parts(m).wd+6)%7;return addDays(m,-wd);};
const relDay=ms=>{const d=Math.round((midnight(ms)-today())/DAY);return d===0?'Today':d===1?'Tomorrow':d===-1?'Yesterday':dayText(ms);};
const localInput=(ms,dateOnly)=>{const p=parts(ms),d=`${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;return dateOnly?d:`${d}T${String(p.h).padStart(2,'0')}:${String(p.mi).padStart(2,'0')}`;};
const fromInput=v=>{const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);return m?zonedToUtc({y:+m[1],m:+m[2],d:+m[3],h:+(m[4]||0),mi:+(m[5]||0)},zone):null;};

function toast(message){const el=$('#toast');if(!el)return;el.textContent=message;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>{el.hidden=true;},3600);}
const api=(path,body)=>request('/work/api/'+path,body,{timeoutMs:20000});

// ── Data ──────────────────────────────────────────────────────────────────────
function viewRange(){
  cursor??=today();
  if(mode==='month'){const first=parts(cursor),start=weekStart(zonedToUtc({y:first.y,m:first.m,d:1},zone));return [start,addDays(start,42)];}
  if(mode==='week')return [weekStart(cursor),addDays(weekStart(cursor),7)];
  return [cursor,addDays(cursor,31)];
}
async function load({force=false}={}){
  const [a,b]=viewRange(),from=Math.min(a,today()),to=Math.max(b,addDays(today(),2)),key=`${from}-${to}`;
  if(!force&&key===loadingKey&&Date.now()-lastLoad<4000)return data;
  loadingKey=key;lastLoad=Date.now();
  try{
    const next=await api(`calendar?from=${from}&to=${to}`);if(key!==loadingKey&&!force)return data;
    // Background refreshes only redraw when something changed, so open menus and scroll stay put.
    const sig=JSON.stringify([next.token,next.reminders?.map(r=>r.key),next.devices,next.settings,key,Math.floor(Date.now()/60000)]);
    if(!force&&sig===lastSig)return data;lastSig=sig;
    data=next;zone=next.zone||zone;window.SeekCalendar.reminders=next.reminders||[];announce();renderAll();
  }
  catch(e){if(isActive())toast(e.message);}
  return data;
}
function announce(){
  // A reminder that fires while Seek is open shows once as a toast; the Inbox keeps it until handled.
  for(const r of data?.reminders||[]){if(!seenReminders.has(r.key)&&!firstReminders)toast(`Reminder: ${r.title}`);seenReminders.add(r.key);}
  firstReminders=false;
  document.dispatchEvent(new CustomEvent('seek-calendar-reminders'));
}
const isActive=()=>document.body.dataset.view==='calendar';
function renderAll(){if(isActive())render();renderToday();const panel=document.getElementById('ap-body');if(panel)window.dispatchEvent(new Event('seek-inbox-refresh'));}

// ── Page ──────────────────────────────────────────────────────────────────────
function render(){
  const main=$('#main');if(!main||!isActive())return;
  if(main.querySelector('.calendar-page .menu:not([hidden])')){clearTimeout(render.later);render.later=setTimeout(render,1500);return;}
  if(phone()&&mode==='week')mode='agenda';
  const scroll=main.querySelector('.cal-scroll')?.scrollTop;
  const synced=(data?.devices||0)>0;
  const head=`<header class="page-head"><div><h1>Calendar</h1><p>Shared by you and Seek · ${synced?`${icon('check-circle','ic-xs')} Syncing with ${data.devices} Apple device${data.devices===1?'':'s'}`:'Not on your iPhone or Mac yet'}</p></div><div class="page-actions"><button data-cal-sync>${icon('sync','ic-sm')}${synced?'Apple sync':'Add to iPhone or Mac'}</button><div class="menu-wrap"><button class="primary" data-cal-new-menu aria-haspopup="menu" aria-expanded="false">${icon('plus','ic-sm')}New</button><div class="menu down cal-new-menu" role="menu" hidden><button role="menuitem" data-cal-new="event">${icon('calendar')}<span>Event<small>On the shared calendar</small></span></button><button role="menuitem" data-cal-new="todo">${icon('check-circle')}<span>To-do<small>On the shared list</small></span></button></div></div></div></header>`;
  const reminders=(data?.reminders||[]).length?`<div class="cal-reminders" role="status">${data.reminders.map(reminderRow).join('')}</div>`:'';
  const tabs=phone()?`<div class="segmented cal-tabs" role="tablist" aria-label="Calendar or to-dos"><button role="tab" aria-selected="${tab==='calendar'}" data-cal-tab="calendar">Calendar</button><button role="tab" aria-selected="${tab==='todos'}" data-cal-tab="todos">To-dos${openTodos().length?` <b>${openTodos().length}</b>`:''}</button></div>`:'';
  const showCal=!phone()||tab==='calendar',showTodos=!phone()||tab==='todos';
  main.innerHTML=`<section class="page calendar-page">${head}${reminders}${tabs}<div class="cal-layout">${showCal?`<section class="cal-main" aria-label="Calendar">${toolbar()}<div class="cal-view cal-${mode}">${data?(mode==='week'?week():mode==='month'?month():agenda()):'<p class="cal-empty">Loading…</p>'}</div></section>`:''}${showTodos?todosPanel():''}</div></section>`;
  const sc=main.querySelector('.cal-scroll');if(sc)sc.scrollTop=scroll??Math.max(0,(Math.min(new Date().getHours(),17)-1.5)*HOUR_PX);
}
function toolbar(){
  const [a,b]=viewRange();
  const label=mode==='month'?fmt(addDays(a,15),{month:'long',year:'numeric'}):mode==='week'?(parts(a).m===parts(b-1).m?`${fmt(a,{month:'long'})} ${parts(a).d}–${parts(b-1).d}, ${parts(a).y}`:`${fmt(a,{month:'short',day:'numeric'})} – ${fmt(b-1,{month:'short',day:'numeric',year:'numeric'})}`):`From ${relDay(cursor).toLowerCase()==='today'?'today':dayText(cursor)}`;
  const modes=[['agenda','Agenda'],...(phone()?[]:[['week','Week']]),['month','Month']];
  return `<div class="cal-toolbar"><div class="cal-nav"><button data-cal-today>Today</button><button class="icon-btn" data-cal-step="-1" aria-label="Previous">${icon('chevron-left')}</button><button class="icon-btn" data-cal-step="1" aria-label="Next">${icon('chevron-right')}</button><h2 class="cal-range">${esc(label)}</h2></div><div class="segmented" role="tablist" aria-label="View">${modes.map(([id,l])=>`<button role="tab" aria-selected="${mode===id}" data-cal-mode="${id}">${l}</button>`).join('')}</div></div>`;
}
const eventsOn=dayStart=>(data?.events||[]).filter(e=>e.start<addDays(dayStart,1)&&(e.end>dayStart||e.start>=dayStart&&e.start===e.end));
const sourceBadge=e=>e.source==='seek'?`<span class="cal-by" title="Added by Seek">${icon('sparkles','ic-xs')}Seek</span>`:'';
const evAttrs=e=>`data-cal-open="${esc(e.id)}" title="${esc(e.title)}${e.location?' · '+esc(e.location):''}"`;

function agenda(){
  const [a,b]=viewRange(),days=[];
  for(let d=a;d<b;d=addDays(d,1)){const list=eventsOn(d);if(list.length||d===today())days.push([d,list]);}
  if(!days.some(([,l])=>l.length))return `<div class="cal-empty"><strong>Nothing scheduled in the next month</strong><p>Add an event, or ask Seek: “put the dentist on Tuesday at 3”.</p><button data-cal-new="event">${icon('plus','ic-sm')}Add an event</button></div>`;
  return `<ol class="cal-agenda">${days.map(([d,list])=>`<li class="cal-day${d===today()?' is-today':''}"><h3><span>${esc(relDay(d))}</span>${relDay(d)===dayText(d)?'':`<small>${esc(dayText(d))}</small>`}</h3>${list.length?`<ul>${list.map(e=>`<li><button class="cal-row" ${evAttrs(e)}><span class="cal-when">${e.allDay?'All day':`${timeText(Math.max(e.start,d))}<small>${e.end>e.start?timeText(e.end):''}</small>`}</span><span class="cal-bar${e.source==='seek'?' seek':''}"></span><span class="cal-what"><strong>${esc(e.title)}</strong>${e.location?`<small>${icon('pin','ic-xs')}${esc(e.location)}</small>`:''}</span>${e.recurring?`<span class="cal-flag" title="Repeats">${icon('repeat','ic-xs')}</span>`:''}${e.prep?`<span class="cal-flag prep" title="Seek prepares ahead">${icon('sparkles','ic-xs')}</span>`:''}${sourceBadge(e)}</button></li>`).join('')}</ul>`:'<p class="cal-free">Nothing scheduled</p>'}</li>`).join('')}</ol>`;
}
function lanes(list){
  // Overlapping events share the column side by side.
  const sorted=[...list].sort((x,y)=>x.start-y.start||y.end-x.end),out=[];let cluster=[],end=-Infinity;
  const flush=()=>{const cols=[];for(const e of cluster){let i=cols.findIndex(c=>c<=e.start);if(i<0){i=cols.length;cols.push(0);}cols[i]=Math.max(e.end,e.start+20*60000);out.push({e,col:i});}for(const o of out.slice(-cluster.length))o.cols=cols.length;cluster=[];};
  for(const e of sorted){if(e.start>=end&&cluster.length)flush();cluster.push(e);end=Math.max(end,e.end,e.start+20*60000);}
  if(cluster.length)flush();return out;
}
function week(){
  const [a]=viewRange(),days=[...Array(7)].map((_,i)=>addDays(a,i)),now=Date.now();
  const head=days.map(d=>`<div class="cal-dh${d===today()?' is-today':''}"><span>${fmt(d,{weekday:'short'})}</span><b>${parts(d).d}</b></div>`).join('');
  const allDay=days.map(d=>`<div class="cal-ad">${eventsOn(d).filter(e=>e.allDay).map(e=>`<button class="cal-chip${e.source==='seek'?' seek':''}" ${evAttrs(e)}>${esc(e.title)}</button>`).join('')}</div>`).join('');
  const hours=[...Array(24)].map((_,h)=>`<div class="cal-hour"><span>${h?fmt(zonedToUtc({...parts(a),h,mi:0,s:0},zone),{hour:'numeric'}).replace(' ',' '):''}</span></div>`).join('');
  const cols=days.map(d=>{
    const timed=eventsOn(d).filter(e=>!e.allDay).map(e=>({...e,start:Math.max(e.start,d),end:Math.min(Math.max(e.end,e.start+30*60000),addDays(d,1))}));
    const blocks=lanes(timed).map(({e,col,cols})=>{const top=(e.start-d)/3600000*HOUR_PX,h=Math.max((e.end-e.start)/3600000*HOUR_PX-2,20);return `<button class="cal-ev${e.source==='seek'?' seek':''}${h<36?' short':''}" style="top:${top}px;height:${h}px;left:calc(${col/cols*100}% + 2px);width:calc(${100/cols}% - 4px)" ${evAttrs(e)}><strong>${esc(e.title)}</strong><small>${timeText(e.start)}${e.location?' · '+esc(e.location):''}</small></button>`;}).join('');
    const nowLine=d===today()?`<div class="cal-now" style="top:${(now-d)/3600000*HOUR_PX}px"></div>`:'';
    return `<div class="cal-col${d===today()?' is-today':''}" data-cal-day="${d}">${blocks}${nowLine}</div>`;
  }).join('');
  return `<div class="cal-week"><div class="cal-week-head"><div class="cal-gutter"></div>${head}</div><div class="cal-week-allday"><div class="cal-gutter"><span>All day</span></div>${allDay}</div><div class="cal-scroll"><div class="cal-grid"><div class="cal-hours">${hours}</div>${cols}</div></div></div>`;
}
function month(){
  const [a]=viewRange(),cur=parts(addDays(a,15)).m,max=phone()?2:3;
  const names=[...Array(7)].map((_,i)=>`<div class="cal-mh">${fmt(addDays(a,i),{weekday:phone()?'narrow':'short'})}</div>`).join('');
  const cells=[...Array(42)].map((_,i)=>{const d=addDays(a,i),list=eventsOn(d),p=parts(d);
    return `<div class="cal-cell${p.m!==cur?' out':''}${d===today()?' is-today':''}" data-cal-cell="${d}"><button class="cal-date" data-cal-goto="${d}" aria-label="${esc(dayText(d))}">${p.d}</button>${list.slice(0,max).map(e=>`<button class="cal-chip${e.allDay?' all':''}${e.source==='seek'?' seek':''}" ${evAttrs(e)}>${e.allDay?'':`<i>${timeText(e.start)}</i>`}${esc(e.title)}</button>`).join('')}${list.length>max?`<button class="cal-more" data-cal-goto="${d}">+${list.length-max} more</button>`:''}</div>`;}).join('');
  return `<div class="cal-month"><div class="cal-month-head">${names}</div><div class="cal-month-grid">${cells}</div></div>`;
}

// ── To-dos ────────────────────────────────────────────────────────────────────
const openTodos=()=>(data?.todos||[]).filter(t=>!t.done);
function todoRow(t){
  const overdue=t.due!=null&&!t.done&&(t.allDay?t.due<today():t.due<Date.now());
  const due=t.due==null?'':t.allDay?relDay(t.due):`${relDay(t.due)}, ${timeText(t.due)}`;
  const meta=[due?`<span class="${overdue?'late':''}">${esc(due)}</span>`:'',t.repeat!=='none'?`<span>${icon('repeat','ic-xs')}${esc(t.repeat==='custom'?'Repeats':t.repeat[0].toUpperCase()+t.repeat.slice(1))}</span>`:'',t.prep?`<span class="prep">${icon('sparkles','ic-xs')}Seek prepares</span>`:'',t.source==='seek'?`<span>Added by Seek</span>`:''].filter(Boolean).join('');
  return `<li class="todo-row${t.done?' done':''}${t.priority===1?' high':''}"><button class="todo-check" data-cal-done="${esc(t.id)}" aria-pressed="${t.done}" aria-label="${t.done?'Mark not done':'Mark done'}: ${esc(t.title)}">${icon('check')}</button><button class="todo-main" data-cal-open="${esc(t.id)}"><span class="todo-title">${t.priority===1?'<b class="todo-flag" aria-label="High priority">!</b>':''}${esc(t.title)}</span>${meta?`<span class="todo-meta">${meta}</span>`:''}</button></li>`;
}
function todosPanel(){
  const open=openTodos(),done=(data?.todos||[]).filter(t=>t.done),t0=today(),t1=addDays(t0,1);
  const groups=[['Overdue',open.filter(t=>t.due!=null&&t.due<(t.allDay?t0:Date.now()))],['Today',open.filter(t=>t.due!=null&&t.due>=(t.allDay?t0:Date.now())&&t.due<t1)],['Upcoming',open.filter(t=>t.due!=null&&t.due>=t1)],['No date',open.filter(t=>t.due==null)]].filter(([,l])=>l.length);
  return `<aside class="cal-todos" aria-label="To-dos"><header><h2>To-dos</h2><span>${open.length} open</span></header>
  <form class="todo-add" data-cal-quick><label class="sr-only" for="cal-quick-title">New to-do</label><input id="cal-quick-title" name="title" placeholder="Add a to-do" autocomplete="off" maxlength="300"><select name="due" aria-label="Due"><option value="">No date</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="week">Next week</option></select><button class="icon-btn primary">${icon('plus','ic-sm')}Add</button></form>
  ${groups.length?groups.map(([label,list])=>`<section class="todo-group"><h3${label==='Overdue'?' class="late"':''}>${label}</h3><ul>${list.map(todoRow).join('')}</ul></section>`).join(''):`<div class="cal-empty small"><strong>All clear</strong><p>Add a to-do here, in Reminders, or ask Seek.</p></div>`}
  ${done.length?`<details class="todo-done"${showDone?' open':''}><summary>Done · ${done.length}</summary><ul>${done.map(todoRow).join('')}</ul></details>`:''}</aside>`;
}

// ── Editor ────────────────────────────────────────────────────────────────────
const ALERTS=[['','None'],['0','At the time'],['5','5 minutes before'],['10','10 minutes before'],['15','15 minutes before'],['30','30 minutes before'],['60','1 hour before'],['120','2 hours before'],['1440','1 day before'],['2880','2 days before'],['10080','1 week before']];
const ALL_DAY_ALERTS=[['','None'],['0','On the day (9 AM)'],['1440','1 day before (9 AM)'],['2880','2 days before (9 AM)'],['10080','1 week before (9 AM)']];
const REPEATS=[['none','Never'],['daily','Every day'],['weekdays','Every weekday'],['weekly','Every week'],['biweekly','Every 2 weeks'],['monthly','Every month'],['yearly','Every year']];
const LEADS=[['2','2 hours before'],['24','1 day before'],['48','2 days before'],['168','1 week before']];
const toggle=(text,attrs)=>`<label class="cal-toggle"><span class="cal-toggle-text">${text}</span><span class="switch"><input type="checkbox" ${attrs}><span></span></span></label>`;
const options=(list,value)=>list.map(([v,l])=>`<option value="${v}"${String(v)===String(value)?' selected':''}>${l}</option>`).join('');
function openEditor(kind='event',item=null,preset={}){
  const dialog=$('#product-dialog');if(!dialog)return;
  const isEvent=(item?.kind||kind)==='event',allDay=item?item.allDay:!!preset.allDay;
  const start=item?.start??preset.start??(()=>{const n=Date.now()+3600000,p=parts(n);return zonedToUtc({y:p.y,m:p.m,d:p.d,h:p.h},zone);})();
  const end=item?.end??preset.end??start+3600000;
  const alert=item?(item.alerts?.[0]??''):(isEvent?(allDay?0:(data?.settings?.defaultAlert??15)):0);
  dialog.className='cal-dialog';dialog.setAttribute('aria-label',item?'Edit '+(isEvent?'event':'to-do'):'New '+(isEvent?'event':'to-do'));
  dialog.innerHTML=`<form id="cal-editor" data-kind="${isEvent?'event':'todo'}"${item?` data-id="${esc(item.id)}"`:''}>
  <header class="cal-dialog-head">${item?'':`<div class="segmented" role="tablist" aria-label="Type"><button type="button" role="tab" aria-selected="${isEvent}" data-cal-kind="event">Event</button><button type="button" role="tab" aria-selected="${!isEvent}" data-cal-kind="todo">To-do</button></div>`}<h2>${item?(isEvent?'Edit event':'Edit to-do'):isEvent?'New event':'New to-do'}</h2><button type="button" class="icon-btn" data-dialog-close aria-label="Close">${icon('x')}</button></header>
  <label class="field-block"><span class="sr-only">Title</span><input name="title" class="cal-title-input" placeholder="${isEvent?'Event title':'What needs doing?'}" value="${esc(item?.title||'')}" required maxlength="300" autocomplete="off"></label>
  ${isEvent?`<div class="cal-when-fields">${toggle('All day',`name="allDay"${allDay?' checked':''}`)}
    <div class="cal-pair"><label>Starts<input name="start" type="${allDay?'date':'datetime-local'}" value="${localInput(start,allDay)}" required></label><label>Ends<input name="end" type="${allDay?'date':'datetime-local'}" value="${localInput(allDay?Math.max(end-DAY,start):end,allDay)}" required></label></div></div>`
  :`<div class="cal-when-fields">${toggle('Due date',`name="hasDue"${item?.due!=null||preset.due!=null?' checked':''}`)}<div class="cal-pair cal-due"${item?.due!=null||preset.due!=null?'':' hidden'}><label>Day<input name="dueDate" type="date" value="${localInput(item?.due??preset.due??today(),true)}"></label><label>Time <small>(optional)</small><input name="dueTime" type="time" value="${item?.due!=null&&!item.allDay?localInput(item.due).slice(11):''}"></label></div></div>`}
  <div class="cal-pair"><label>Repeat<select name="repeat">${options(item?.repeat==='custom'?[['custom','Custom (from another app)'],...REPEATS]:REPEATS,item?.repeat||'none')}</select></label><label>Alert<select name="alert">${options(isEvent&&allDay||!isEvent?ALL_DAY_ALERTS.concat(isEvent?[]:ALERTS.slice(2)):ALERTS,alert)}</select></label></div>
  ${isEvent?`<label>Location<input name="location" value="${esc(item?.location||'')}" maxlength="500" placeholder="Add a place or address"></label>`:`<label>Priority<select name="priority">${options([['0','None'],['9','Low'],['5','Medium'],['1','High']],item?.priority||0)}</select></label>`}
  <label>Notes<textarea name="notes" rows="3" maxlength="20000" placeholder="Details, links, anything Seek should know">${esc(item?.notes||'')}</textarea></label>
  <fieldset class="cal-prep">${toggle(`${icon('sparkles','ic-sm')}Have Seek prepare ahead`,`name="prepOn"${item?.prep?' checked':''}`)}
    <div class="cal-prep-fields"${item?.prep?'':' hidden'}><label><span class="sr-only">What Seek should prepare</span><textarea name="prep" rows="2" maxlength="2000" placeholder="e.g. Find two dinner spots with a table for two, under $150">${esc(item?.prep?.instruction||'')}</textarea></label><label>Start<select name="lead">${options(LEADS,item?.prep?.leadHours??24)}</select></label><p class="muted">Seek researches and drafts on its own, then asks before buying, booking or sending anything.</p></div></fieldset>
  ${item&&item.source!=='you'?`<p class="muted cal-origin">Added by ${item.source==='seek'?'Seek':'an Apple device'}${item.recurring||item.repeat!=='none'?' · edits apply to every repeat':''}</p>`:item?.repeat&&item.repeat!=='none'?'<p class="muted cal-origin">Edits apply to every repeat</p>':''}
  <footer class="dialog-actions">${item?`<button type="button" class="danger-link" data-cal-delete="${esc(item.id)}">Delete</button>`:''}<span class="grow"></span>${item&&!isEvent?`<button type="button" data-cal-done="${esc(item.id)}" data-close>${item.done?'Mark not done':'Mark done'}</button>`:''}<button type="button" data-dialog-close>Cancel</button><button class="primary" type="submit">${item?'Save':'Add'}</button></footer></form>`;
  if(!dialog.open)dialog.showModal();
  dialog.querySelector('[name=title]').focus();
}
function editorFields(form){
  const f=new FormData(form),kind=form.dataset.kind,out={title:String(f.get('title')||'').trim(),notes:String(f.get('notes')||''),repeat:String(f.get('repeat')||'none')};
  const alert=String(f.get('alert')??'');out.alerts=alert===''?[]:[Number(alert)];
  if(kind==='event'){
    const allDay=f.get('allDay')==='on',start=fromInput(f.get('start')),end=fromInput(f.get('end'));
    if(start==null||end==null)throw new Error('Choose when it starts and ends.');
    Object.assign(out,{allDay,start,end:allDay?addDays(end,1):end,location:String(f.get('location')||'')});
    if(out.end<out.start)throw new Error('The end is before the start.');
  }else{
    out.priority=Number(f.get('priority')||0);
    if(f.get('hasDue')==='on'){const time=String(f.get('dueTime')||''),date=String(f.get('dueDate')||'');out.due=fromInput(time?`${date}T${time}`:date);out.allDay=!time;if(out.due==null)throw new Error('Choose a due date.');}
    else{out.due=null;out.allDay=false;}
  }
  out.prep=f.get('prepOn')==='on'?{instruction:String(f.get('prep')||'').trim(),leadHours:Number(f.get('lead')||24)}:null;
  if(out.prep&&!out.prep.instruction)throw new Error('Tell Seek what to prepare, or turn preparing off.');
  return out;
}

// ── Apple sync ────────────────────────────────────────────────────────────────
const appleDevice=()=>/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const defaultName=()=>/iPhone/.test(navigator.userAgent)?'iPhone':/iPad/.test(navigator.userAgent)?'iPad':/Macintosh/.test(navigator.userAgent)?'Mac':'iPhone';
async function openSync(){
  const dialog=$('#product-dialog');if(!dialog)return;
  dialog.className='cal-dialog sync';dialog.setAttribute('aria-label','Apple Calendar and Reminders');
  dialog.innerHTML=`<div class="cal-sync"><header class="cal-dialog-head"><h2>Apple Calendar &amp; Reminders</h2><button type="button" class="icon-btn" data-dialog-close aria-label="Close">${icon('x')}</button></header><p class="muted" role="status">Loading…</p></div>`;
  if(!dialog.open)dialog.showModal();
  try{devices=await api('calendar/devices');}catch(e){toast(e.message);return;}
  renderSync();
}
function copyRow(label,value,secret=false){return `<div class="copy-row"><span>${label}</span><code${secret?' class="secret"':''}>${esc(value)}</code><button type="button" class="icon-btn" data-copy="${esc(value)}" aria-label="Copy ${label}">${icon('copy','ic-sm')}</button></div>`;}
function renderSync(){
  const dialog=$('#product-dialog');if(!dialog?.open||!dialog.classList.contains('sync'))return;
  const s=data?.settings||{push:true,discord:true,defaultAlert:15},list=devices?.devices||[];
  const result=setupResult?`<section class="cal-setup-result"><h3>${icon('check-circle','ic-sm')}Ready for ${esc(setupResult.name)}</h3>
    ${appleDevice()?`<a class="button primary block" href="${esc(setupResult.profile)}" data-cal-profile>${icon('download','ic-sm')}Install on this ${esc(defaultName())}</a><ol class="cal-steps"><li>Tap <b>Allow</b> to download the profile.</li><li>${/Macintosh/.test(navigator.userAgent)?'Open <b>System Settings › Privacy &amp; Security › Profiles</b> and install “Seek Calendar &amp; To-dos”.':'Open <b>Settings</b>, tap <b>Profile Downloaded</b>, then <b>Install</b>.'}</li><li>Calendar now has <b>Seek</b>; Reminders has <b>Seek To-dos</b>.</li></ol>`
      :`<p>Open Seek on your iPhone or Mac and choose <b>Add to iPhone or Mac</b> there for one-tap setup, or add the account by hand: <b>Settings › Apps › Calendar › Calendar Accounts › Add Account › Other › Add CalDAV Account</b>.</p>`}
    <details${appleDevice()?'':' open'}><summary>Set it up by hand</summary><div class="copy-rows">${copyRow('Server',setupResult.server)}${copyRow('User name',setupResult.username)}${copyRow('Password',setupResult.password,true)}</div><p class="muted">This password works only for the calendar and is shown once. Remove the device below to revoke it.</p></details></section>`
    :`<form class="cal-setup" data-cal-setup><p>Add Seek to your iPhone, iPad or Mac. The <b>Seek</b> calendar appears in Calendar and <b>Seek To-dos</b> in Reminders, and changes sync both ways, with your alerts.</p><label>Device name<input name="name" value="${esc(defaultName())}" maxlength="60" required></label><button class="primary">${icon('plus','ic-sm')}Create setup for this device</button></form>`;
  dialog.innerHTML=`<div class="cal-sync"><header class="cal-dialog-head"><h2>Apple Calendar &amp; Reminders</h2><button type="button" class="icon-btn" data-dialog-close aria-label="Close">${icon('x')}</button></header>${result}
  <section><h3>Connected devices</h3>${list.length?`<ul class="device-list">${list.map(d=>`<li><span>${icon('check-circle','ic-sm')}<b>${esc(d.name)}</b><small>Added ${esc(dayText(d.created))}</small></span><button type="button" data-cal-revoke="${esc(d.id)}" data-name="${esc(d.name)}">Remove</button></li>`).join('')}</ul>`:'<p class="muted">None yet.</p>'}</section>
  <section class="cal-delivery"><h3>Reminders</h3><p class="muted">Alerts you set show on your Apple devices. Seek can also remind you here:</p>
    ${toggle('Seek notifications and the Inbox',`data-cal-setting="push"${s.push?' checked':''}`)}
    ${toggle('A Discord message from PAW',`data-cal-setting="discord"${s.discord?' checked':''}`)}
    <label>Default alert for new events<select data-cal-setting="defaultAlert">${options(ALERTS,s.defaultAlert??'')}</select></label></section></div>`;
}

// ── Pieces for the rest of Work ───────────────────────────────────────────────
function reminderRow(r){
  const when=r.kind==='todo'?(r.start?`Due ${relDay(r.start)}`:'To-do'):`${relDay(r.start)}, ${timeText(r.start)}`;
  return `<div class="cal-reminder">${icon(r.kind==='todo'?'check-circle':'bell','ic-sm')}<div><strong>${esc(r.title)}</strong><small>${esc(when)}</small></div><div class="cal-reminder-actions"><button data-cal-remind="${esc(r.key)}" data-action="${r.kind==='todo'?'done':'dismiss'}" class="primary">${r.kind==='todo'?'Done':'OK'}</button><button data-cal-remind="${esc(r.key)}" data-action="snooze">Snooze 10 min</button></div></div>`;
}
function remindersHtml(){return (window.SeekCalendar.reminders||[]).map(reminderRow).join('');}
function renderToday(){
  const host=document.getElementById('home-today');if(!host||!data)return;
  const t0=today(),now=Date.now(),events=eventsOn(t0).filter(e=>e.allDay||e.end>now),todos=openTodos().filter(t=>t.due!=null&&t.due<addDays(t0,1)).slice(0,4);
  if(!events.length&&!todos.length){host.hidden=true;host.innerHTML='';return;}
  host.hidden=false;
  host.innerHTML=`<div class="home-section-head"><h3>Today</h3><button class="link-btn" data-view="calendar">Calendar${icon('arrow-right')}</button></div><div class="today-card">${events.length?`<ul class="today-events">${events.slice(0,5).map(e=>`<li><button data-cal-open="${esc(e.id)}" data-cal-go><span class="cal-when">${e.allDay?'All day':timeText(e.start)}</span><span class="cal-bar${e.source==='seek'?' seek':''}"></span><span class="cal-what"><strong>${esc(e.title)}</strong>${e.location?`<small>${esc(e.location)}</small>`:''}</span></button></li>`).join('')}</ul>`:''}${todos.length?`<ul class="today-todos">${todos.map(todoRow).join('')}</ul>`:''}</div>`;
}
async function renderConnection(main){
  if(!main||main.querySelector('.cal-connection'))return;
  if(!data)await load({force:true});
  const n=data?.devices||0,host=main.querySelector('.connections-list');if(!host)return;
  host.insertAdjacentHTML('afterbegin',`<div class="file-card cal-connection"><span class="file-icon">${icon(n?'check-circle':'calendar')}</span><div><strong>Apple Calendar &amp; Reminders · ${n?'Connected':'Not set up'}</strong><p>${n?`${n} device${n===1?'':'s'} sync the shared calendar and to-dos.`:'Put the shared calendar and to-dos on your iPhone or Mac.'}</p></div><button data-cal-sync>${n?'Manage':'Set up'}</button></div>`);
}

// ── Events ────────────────────────────────────────────────────────────────────
async function act(path,body,success){try{const out=await api(path,body);await load({force:true});if(success)toast(success);return out;}catch(e){toast(e.message);throw e;}}
const findItem=id=>[...(data?.events||[]),...(data?.todos||[])].find(x=>x.id===id);
document.addEventListener('click',async e=>{
  const t=e.target.closest('button,a');if(!t)return;
  if(t.matches('[data-cal-new]')){const menu=t.closest('.menu');if(menu)menu.hidden=true;openEditor(t.dataset.calNew);return;}
  if(t.matches('[data-cal-kind]')){const title=t.closest('form').elements.namedItem('title').value;openEditor(t.dataset.calKind);$('#cal-editor [name=title]').value=title;return;}
  if(t.matches('[data-cal-open]')){const item=findItem(t.dataset.calOpen);if(item)openEditor(item.kind,item);return;}
  if(t.matches('[data-cal-done]')){const item=findItem(t.dataset.calDone),done=!item?.done;if(t.dataset.close!==undefined)$('#product-dialog')?.close();t.closest('.todo-row')?.classList.toggle('done',done);try{await act('calendar/item',{action:'complete',id:t.dataset.calDone,done},done&&item?.repeat&&item.repeat!=='none'?'Done. Moved to the next date.':done?'Done':'Reopened');}catch{}return;}
  if(t.matches('[data-cal-delete]')){const item=findItem(t.dataset.calDelete);if(!confirm(`Delete “${item?.title||'this item'}”${item?.repeat&&item.repeat!=='none'?' and every repeat':''}? It is removed from your Apple devices too.`))return;$('#product-dialog')?.close();try{await act('calendar/item',{action:'delete',id:t.dataset.calDelete},'Deleted');}catch{}return;}
  if(t.matches('[data-cal-mode]')){mode=t.dataset.calMode;store('mode',mode);render();void load();return;}
  if(t.matches('[data-cal-tab]')){tab=t.dataset.calTab;render();return;}
  if(t.matches('[data-cal-today]')){cursor=today();render();void load();return;}
  if(t.matches('[data-cal-step]')){const n=Number(t.dataset.calStep);cursor??=today();if(mode==='month'){const p=parts(cursor);cursor=zonedToUtc({y:p.y,m:p.m+n,d:1},zone);}else cursor=addDays(cursor,n*(mode==='week'?7:30));render();void load();return;}
  if(t.matches('[data-cal-goto]')){cursor=Number(t.dataset.calGoto);mode=phone()?'agenda':'week';store('mode',mode);render();void load();return;}
  if(t.matches('[data-cal-sync]')){setupResult=null;void openSync();return;}
  if(t.matches('[data-cal-revoke]')){if(!confirm(`Remove ${t.dataset.name}? It stops syncing right away; remove the account on the device too.`))return;try{await api('calendar/devices',{action:'revoke',id:t.dataset.calRevoke});devices=await api('calendar/devices');setupResult=null;renderSync();void load({force:true});toast('Device removed');}catch(err){toast(err.message);}return;}
  if(t.matches('[data-copy]')){try{await navigator.clipboard.writeText(t.dataset.copy);toast('Copied');}catch{toast('Copy failed. Select the text instead.');}return;}
  if(t.matches('[data-cal-remind]')){t.disabled=true;try{await act('calendar/reminder',{key:t.dataset.calRemind,action:t.dataset.action,minutes:10},t.dataset.action==='snooze'?'Snoozed for 10 minutes':null);}catch{t.disabled=false;}return;}
},true);
// Clicking an empty spot in the week grid starts an event at that half hour.
document.addEventListener('dblclick',e=>{const col=e.target.closest('.cal-col');if(!col||e.target.closest('.cal-ev'))return;const r=col.getBoundingClientRect(),mins=Math.floor((e.clientY-r.top)/HOUR_PX*2)*30,start=Number(col.dataset.calDay)+mins*60000;openEditor('event',null,{start,end:start+3600000});});
document.addEventListener('click',e=>{const col=e.target.closest('.cal-col');if(!col||e.target.closest('.cal-ev')||e.detail!==1)return;if(!matchMedia('(pointer:coarse)').matches)return;const r=col.getBoundingClientRect(),mins=Math.floor((e.clientY-r.top)/HOUR_PX*2)*30,start=Number(col.dataset.calDay)+mins*60000;openEditor('event',null,{start,end:start+3600000});});
document.addEventListener('change',async e=>{
  const el=e.target;
  if(el.matches('#cal-editor [name=allDay]')){const form=el.form,s=fromInput(form.start.value)??today(),en=fromInput(form.end.value)??s;form.start.type=form.end.type=el.checked?'date':'datetime-local';form.start.value=localInput(s,el.checked);form.end.value=localInput(el.checked?midnight(en):Math.max(en,s+3600000),el.checked);const alerts=el.checked?ALL_DAY_ALERTS:ALERTS;form.alert.innerHTML=options(alerts,el.checked?'0':String(data?.settings?.defaultAlert??15));return;}
  if(el.matches('#cal-editor [name=hasDue]')){el.form.querySelector('.cal-due').hidden=!el.checked;return;}
  if(el.matches('#cal-editor [name=prepOn]')){const box=el.form.querySelector('.cal-prep-fields');box.hidden=!el.checked;if(el.checked)box.querySelector('textarea').focus();return;}
  if(el.matches('#cal-editor [name=start]')&&el.form.dataset.kind==='event'){const s=fromInput(el.value),en=fromInput(el.form.end.value);if(s!=null&&(en==null||en<s))el.form.end.value=localInput(el.form.allDay.checked?s:s+3600000,el.form.allDay.checked);return;}
  if(el.matches('[data-cal-setting]')){const k=el.dataset.calSetting,v=el.type==='checkbox'?el.checked:el.value===''?null:Number(el.value);try{const s=await api('calendar/settings',{[k]:v});if(data)data.settings=s;toast('Saved');}catch(err){toast(err.message);}return;}
});
document.addEventListener('toggle',e=>{if(e.target.matches?.('.todo-done'))showDone=e.target.open;},true);
document.addEventListener('submit',async e=>{
  const form=e.target;
  if(form.id==='cal-editor'){e.preventDefault();let fields;try{fields=editorFields(form);}catch(err){toast(err.message);return;}const btn=form.querySelector('[type=submit]');btn.disabled=true;
    try{await act('calendar/item',{action:'save',kind:form.dataset.kind,id:form.dataset.id||null,fields},form.dataset.id?'Saved':form.dataset.kind==='event'?'Added to the calendar':'Added to your to-dos');$('#product-dialog')?.close();}catch{btn.disabled=false;}return;}
  if(form.matches('[data-cal-quick]')){e.preventDefault();const input=form.elements.namedItem('title'),title=input.value.trim();if(!title)return;const due=form.elements.namedItem('due').value,t0=today(),dueAt=due==='today'?t0:due==='tomorrow'?addDays(t0,1):due==='week'?addDays(weekStart(t0),7):null;
    input.value='';try{await act('calendar/item',{action:'save',kind:'todo',fields:{title,...(dueAt!=null?{due:dueAt,allDay:true}:{})}},null);document.getElementById('cal-quick-title')?.focus();}catch{input.value=title;}return;}
  if(form.matches('[data-cal-setup]')){e.preventDefault();const btn=form.querySelector('button');btn.disabled=true;try{setupResult=await api('calendar/devices',{action:'create',name:form.elements.namedItem('name').value});devices=await api('calendar/devices');renderSync();void load({force:true});}catch(err){btn.disabled=false;toast(err.message);}return;}
});
window.addEventListener('seek-poll',()=>{if(document.hidden)return;if(isActive()||document.getElementById('home-today'))void load();else if(Date.now()-lastLoad>60000)void load();});
matchMedia('(max-width:640px)').addEventListener('change',()=>{if(isActive())render();});

window.SeekCalendar={reminders:[],activate:()=>{cursor??=today();render();void load({force:true});},load,openEditor:(kind)=>{cursor??=today();openEditor(kind);},openSync,remindersHtml,renderToday,renderConnection};
void load();
