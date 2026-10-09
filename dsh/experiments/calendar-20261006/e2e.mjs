// End to end against the real mounted Work server (temporary data): JSON API, devices and the
// one-time profile link, Seek's tools, reminders to the Discord outbox, prep tasks, and CalDAV
// with an independent client (python-caldav). node --import <register-profile> e2e.mjs <python>
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ready} from './mount.mjs';
const m=await ready,base=m.base,checks=[];
const ok=(name,cond)=>{assert.ok(cond,name);checks.push(name);console.log('  ✓',name);};
const api=async(path,body)=>{const r=await fetch(base+'/work/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Object.assign(new Error(j.error),{status:r.status});return j;};
const call=(name,args)=>m.tools.get(name).execute(args,{sessionId:'none'});
try{
  const now=Date.now();
  const ev=await api('calendar/item',{action:'save',kind:'event',fields:{title:'Dentist',start:now+3*86400000,end:now+3*86400000+1800000,location:'Main St',alerts:[60]}});
  ok('UI creates an event',ev.id.startsWith('seek/')&&ev.alerts[0]===60);
  const todo=await api('calendar/item',{action:'save',kind:'todo',fields:{title:'Order the cake',due:now+86400000}});
  ok('UI creates a to-do',todo.collection==='todos');
  const range=await api(`calendar?from=${now-86400000}&to=${now+7*86400000}`);
  ok('range returns both',range.events.some(e=>e.title==='Dentist')&&range.todos.some(t=>t.title==='Order the cake')&&range.devices===0);
  await assert.rejects(api('calendar/item',{action:'save',kind:'event',fields:{title:''}}),/title/);ok('validation errors reach the UI',true);
  ok('completing a to-do',(await api('calendar/item',{action:'complete',id:todo.id})).done===true);

  // Seek's tools speak local wall-clock time.
  const added=await call('calendar_add_event',{title:'Standup',start:'2026-10-19T09:00',end:'2026-10-19T09:15',repeat:'weekdays'});
  ok('tool adds a repeating event in local time',added.added.start==='2026-10-19T09:00'&&added.added.repeat==='weekdays'&&added.added.addedBy==='Seek');
  const agenda=await call('calendar_agenda',{from:'2026-10-19',to:'2026-10-23'});
  ok('tool agenda expands repeats',agenda.events.filter(e=>e.title==='Standup').length===5);
  const t2=await call('todo_add',{title:'Take out trash',due:'2026-10-20',repeat:'weekly',priority:'high'});
  ok('tool adds an all-day repeating to-do',t2.added.due==='2026-10-20'&&t2.added.priority==='high');
  ok('tool completes and rolls forward',(await call('todo_complete',{id:t2.added.id})).todo.due==='2026-10-27');
  const bday=await call('calendar_add_event',{title:'Birthday',start:'2026-10-11',end:'2026-10-11',repeat:'yearly'});
  ok('all-day "through" end is inclusive',bday.added.allDay&&bday.added.start==='2026-10-11'&&bday.added.end==='2026-10-11');
  ok('tool search',(await call('calendar_search',{query:'dentist'})).items[0].title==='Dentist');
  ok('tool delete',(await call('calendar_delete',{id:bday.added.id})).deleted.title==='Birthday');

  // Apple device setup.
  const dev=await api('calendar/devices',{action:'create',name:'Test iPhone'});
  ok('device password and setup link',/^[a-z2-9-]{23}$/.test(dev.password)&&dev.profile.startsWith('/work/api/calendar/profile?ticket=')&&dev.server==='seek.example.test');
  const prof=await fetch(base+dev.profile);ok('profile downloads once',prof.status===200&&prof.headers.get('content-type')==='application/x-apple-aspen-config'&&(await prof.text()).includes(dev.password));
  ok('profile link is single-use',(await fetch(base+dev.profile)).status===410);
  ok('devices list',(await api('calendar/devices')).devices.length===1);

  // CalDAV from outside without the proxy's device check is refused; locally it is open (the proxy guards the public side).
  const outside=await fetch(base+'/work/dav/',{method:'PROPFIND',headers:{Host:'seek.example.test','X-Forwarded-For':'1.2.3.4',Depth:'0'}});
  ok('outside CalDAV without a device is refused',outside.status===401);
  const viaProxy=await fetch(base+'/work/dav/',{method:'PROPFIND',headers:{Host:'seek.example.test','X-Forwarded-For':'1.2.3.4','X-Seek-Dav-Device':dev.id,Depth:'0'}});
  ok('CalDAV through the proxy works',viaProxy.status===207);

  // Reminders: an alert due now fires once, to the Discord outbox; the Inbox lists it.
  await api('calendar/item',{action:'save',kind:'event',fields:{title:'Leave for pickup',start:Date.now()+5000,end:Date.now()+3605000,alerts:[0]}});
  let outbox=[];for(let i=0;i<40&&!outbox.length;i++){await new Promise(r=>setTimeout(r,1000));outbox=(await api('calendar/outbox')).items;}
  ok('alert reaches the Discord outbox',outbox.length===1&&outbox[0].title==='Leave for pickup');
  const fired=(await api(`calendar?from=${Date.now()-86400000}&to=${Date.now()+86400000}`)).reminders;
  ok('active reminder for the Inbox',fired.some(r=>r.title==='Leave for pickup'));
  const acked=await api('calendar/outbox/ack',{ids:outbox.map(x=>x.id)});const left=(await api('calendar/outbox')).items;console.log('    ack',JSON.stringify(acked),'left',JSON.stringify(left));ok('outbox acknowledged',left.length===0);
  await api('calendar/reminder',{key:fired[0].key,action:'snooze',minutes:10});
  ok('snooze clears it from the Inbox',(await api(`calendar?from=${Date.now()-86400000}&to=${Date.now()+86400000}`)).reminders.length===0);

  // Seek prepares ahead: a task is created once the lead time is reached.
  await api('calendar/item',{action:'save',kind:'event',fields:{title:'Anniversary dinner',start:Date.now()+3600000,end:Date.now()+7200000,prep:{instruction:'Find two restaurants with a table for two',leadHours:2}}});
  let prepTask=null;for(let i=0;i<30&&!prepTask;i++){await new Promise(r=>setTimeout(r,1000));prepTask=(await api('state')).tasks.find(t=>t.title?.startsWith('Prepared: Anniversary dinner'));}
  ok('prep task created',!!prepTask&&/do not buy, book, send/.test(prepTask.objective));

  // An independent CalDAV client.
  const python=process.argv[2];
  const {stdout:out}=await promisify(execFile)(python,[new URL('./interop.py',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1').replaceAll('%20',' '),base+'/work/dav/'],{encoding:'utf8',timeout:60000});
  console.log(out.split('\n').map(l=>'    '+l).join('\n'));
  ok('python-caldav interop',out.includes('INTEROP OK'));
  console.log(`\n${checks.length} checks passed; warnings: ${m.warnings.filter(w=>/calendar|caldav/i.test(w)).join(' | ')||'none'}`);
}catch(e){console.error('FAILED',e);process.exitCode=1;}
finally{m.stop();setTimeout(()=>process.exit(),500);}
