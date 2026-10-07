import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CalendarStore} from '../lib/work-calendar.js';
import {zonedToUtc,zonedParts,parseICS,readItem} from '../lib/work-ical.js';

const CT='America/Chicago';
async function store(now){const dir=await mkdtemp(join(tmpdir(),'seek-cal-'));const clock={t:now};const s=await new CalendarStore(dir,{now:()=>clock.t,zone:CT}).init();return {s,clock,done:async()=>{s.close();await rm(dir,{recursive:true,force:true});}};}
const at=(y,m,d,h=0,mi=0)=>zonedToUtc({y,m,d,h,mi},CT);
const local=ms=>{const p=zonedParts(ms,CT);return `${p.m}/${p.d} ${p.h}:${String(p.mi).padStart(2,'0')}`;};

test('CalDAV-style writes: preconditions, UID uniqueness, components per calendar, sync tokens',async()=>{
  const {s,done}=await store(at(2026,10,6,12));
  try{
    const ics=uid=>['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT',`UID:${uid}`,'DTSTART:20261007T150000Z','DTEND:20261007T160000Z','SUMMARY:Call','END:VEVENT','END:VCALENDAR',''].join('\r\n');
    const first=s.put('seek','a.ics',ics('U1'),{ifNoneMatch:'*'});assert.equal(first.created,true);
    const t0=s.token;
    assert.throws(()=>s.put('seek','a.ics',ics('U1'),{ifNoneMatch:'*'}),e=>e.status===412);
    assert.throws(()=>s.put('seek','a.ics',ics('U1'),{ifMatch:'"stale"'}),e=>e.status===412);
    assert.throws(()=>s.put('seek','b.ics',ics('U1')),e=>e.status===409);
    assert.throws(()=>s.put('todos','c.ics',ics('U2')),e=>e.status===403&&e.code==='supported-calendar-component');
    assert.throws(()=>s.put('seek','d.ics','not ical'),e=>e.status===415);
    const second=s.put('seek','a.ics',ics('U1').replace('Call','Call back'),{ifMatch:first.etag});assert.notEqual(second.etag,first.etag);
    s.put('seek','e.ics',ics('U3'));s.remove('seek','e.ics');
    const changes=s.changesSince('seek',t0);assert.deepEqual(changes.changed,['a.ics']);assert.deepEqual(changes.deleted,['e.ics']);
    assert.equal(s.changesSince('seek',s.token+5),null);
    assert.deepEqual(s.changesSince('seek',s.token).changed,[]);
    assert.ok(s.ctag('seek')>0);assert.equal(s.ctag('todos'),0);
  }finally{await done();}
});

test('the UI and Seek create, edit, repeat and complete items',async()=>{
  const {s,done}=await store(at(2026,10,6,12));
  try{
    const ev=s.save('event',{title:'Dentist',start:at(2026,10,12,15),end:at(2026,10,12,15,30),location:'Main St',alerts:[60]},{source:'seek'});
    assert.equal(ev.kind,'event');assert.equal(ev.source,'seek');assert.deepEqual(ev.alerts,[60]);assert.equal(ev.collection,'seek');
    const moved=s.save('event',{start:at(2026,10,13,9)},{id:ev.id});
    assert.equal(local(moved.start),'10/13 9:00');assert.equal(moved.end-moved.start,1800000);assert.equal(moved.title,'Dentist');
    const weekly=s.save('event',{title:'Standup',start:at(2026,10,5,9),end:at(2026,10,5,9,15),repeat:'weekdays'});
    assert.equal(weekly.repeat,'weekdays');assert.deepEqual(weekly.alerts,[15]);
    const week=s.range(at(2026,10,5),at(2026,10,12));
    assert.equal(week.events.filter(e=>e.title==='Standup').length,5);
    const allDay=s.save('event',{title:'Birthday',start:at(2026,10,11,14),allDay:true,repeat:'yearly'});
    assert.equal(local(allDay.start),'10/11 0:00');assert.equal(allDay.end-allDay.start,86400000);assert.equal(allDay.allDay,true);
    assert.throws(()=>s.save('event',{title:''}),/title/);assert.throws(()=>s.save('event',{title:'x',start:5,end:1}),/before the start/);
    assert.throws(()=>s.save('event',{title:'x',start:1,repeat:'hourly'}),/Repeat/);

    const todo=s.save('todo',{title:'Order the cake',due:at(2026,10,8,17)});
    assert.equal(todo.collection,'todos');assert.deepEqual(todo.alerts,[0]);assert.equal(todo.done,false);
    const loose=s.save('todo',{title:'Someday: learn piano'});assert.equal(loose.due,null);assert.deepEqual(loose.alerts,[]);
    const doneTodo=s.complete(todo.id);assert.equal(doneTodo.done,true);
    assert.equal(s.complete(todo.id,false).done,false);
    const trash=s.save('todo',{title:'Take out trash',due:at(2026,10,7),allDay:true,repeat:'weekly'});
    const rolled=s.complete(trash.id);assert.equal(rolled.done,false);assert.equal(local(rolled.due),'10/14 0:00');
    const list=s.range(at(2026,10,1),at(2026,11,1)).todos;assert.deepEqual(list.slice(0,2).map(t=>t.title),['Order the cake','Take out trash']);assert.ok(list.some(t=>t.title.startsWith('Someday')));
    // What Apple sees is plain iCalendar with Seek's edits applied.
    const raw=s.object('todos',trash.id.split('/')[1]).ics;assert.match(raw,/BEGIN:VTODO/);assert.match(raw,/RRULE:FREQ=WEEKLY/);assert.match(raw,/DUE;VALUE=DATE:20261014/);
    assert.equal(s.search('cake')[0].title,'Order the cake');
    s.delete(ev.id);assert.throws(()=>s.find(ev.id),e=>e.status===404);
  }finally{await done();}
});

test('reminders fire once, snooze, finish to-dos, skip long outages and start prep work',async()=>{
  const {s,clock,done}=await store(at(2026,10,8,16,50));
  try{
    s.scan();
    const todo=s.save('todo',{title:'Order the cake',due:at(2026,10,8,17)});
    const ev=s.save('event',{title:'Wife’s birthday dinner',start:at(2026,10,11,18),end:at(2026,10,11,20),alerts:[30],prep:{instruction:'Find two dinner options with a table for two',leadHours:48}});
    assert.equal(ev.prep.leadHours,48);
    assert.equal(s.scan().fired.length,0);
    clock.t=at(2026,10,8,17,0)+20000;
    const first=s.scan();assert.equal(first.fired.length,1);assert.equal(first.fired[0].title,'Order the cake');
    assert.equal(s.scan().fired.length,0,'fires once');
    const key=first.fired[0].key;assert.equal(s.activeReminders().length,1);
    s.actOnReminder(key,'snooze',10);assert.equal(s.activeReminders().length,0);
    clock.t+=11*60000;const again=s.scan();assert.equal(again.fired.length,1);assert.equal(again.fired[0].snoozed,true);
    s.actOnReminder(key,'done');assert.equal(s.find(todo.id)&&s.summary(s.find(todo.id)).done,true);
    // Prep starts 48 h ahead, once.
    clock.t=at(2026,10,9,18,1);const prep=s.scan().prep;assert.equal(prep.length,1);assert.match(prep[0].instruction,/dinner options/);
    s.markPrepStarted(prep[0].uid,prep[0].occurrence,'task-1');assert.equal(s.scan().prep.length,0);
    // After a two-day outage only the last six hours replay.
    const dinner=s.find(ev.id);assert.ok(dinner);
    clock.t=at(2026,10,13,12);const late=s.scan();assert.equal(late.fired.length,0,'the 17:30 alert two days ago is not replayed');
    // Outbox for Discord.
    const id=s.enqueue('discord',{text:'hi'});assert.equal(s.pending('discord')[0].text,'hi');assert.equal(s.delivered([id]),1);assert.equal(s.pending('discord').length,0);
  }finally{await done();}
});

test('an alert dismissed on the iPhone is not repeated by Seek',async()=>{
  const {s,clock,done}=await store(Date.UTC(2026,9,8,21,0));
  try{
    s.scan();
    const ics=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:ACK','DTSTART:20261008T220000Z','DTEND:20261008T230000Z','SUMMARY:Seen on phone',
      'BEGIN:VALARM','TRIGGER:-PT30M','ACTION:DISPLAY','ACKNOWLEDGED:20261008T213000Z','END:VALARM','END:VEVENT','END:VCALENDAR',''].join('\r\n');
    s.put('seek','ack.ics',ics);clock.t=Date.UTC(2026,9,8,21,31);
    assert.equal(s.scan().fired.length,0);
    assert.equal(readItem(parseICS(ics)).alarms[0].acknowledged,Date.UTC(2026,9,8,21,30));
  }finally{await done();}
});
