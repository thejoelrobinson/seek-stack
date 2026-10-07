import test from 'node:test';
import assert from 'node:assert/strict';
import {parseICS,serializeICS,readItem,occurrences,alarmTimes,applyItem,advanceRepeatingTodo,zonedToUtc,zonedParts,parseDuration,formatDuration,vtimezone,prop,unfold} from '../lib/work-ical.js';

const CT='America/Chicago';
const iso=ms=>new Date(ms).toISOString();
const local=(ms,tz=CT)=>{const p=zonedParts(ms,tz);return `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')} ${String(p.h).padStart(2,'0')}:${String(p.mi).padStart(2,'0')}`;};

// What iOS Calendar PUTs for a weekly event with a 15-minute alert (trimmed, line-folded).
const APPLE_EVENT=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Apple Inc.//iPhone OS 26.0//EN','CALSCALE:GREGORIAN',
 'BEGIN:VTIMEZONE','TZID:America/Chicago','BEGIN:DAYLIGHT','TZOFFSETFROM:-0600','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','DTSTART:20070311T020000','TZNAME:CDT','TZOFFSETTO:-0500','END:DAYLIGHT',
 'BEGIN:STANDARD','TZOFFSETFROM:-0500','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','DTSTART:20071104T020000','TZNAME:CST','TZOFFSETTO:-0600','END:STANDARD','END:VTIMEZONE',
 'BEGIN:VEVENT','CREATED:20261001T120000Z','UID:9C1E-APPLE','DTEND;TZID=America/Chicago:20261005T100000','TRANSP:OPAQUE','X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
 'SUMMARY:Team sync\\, weekly','LAST-MODIFIED:20261001T120000Z','DTSTAMP:20261001T120000Z','DTSTART;TZID=America/Chicago:20261005T090000','SEQUENCE:0',
 'DESCRIPTION:Agenda:\\nRoadmap\\; budgets and a very long line that keeps going so it has to be fol','  ded by the client',
 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE','BEGIN:VALARM','X-WR-ALARMUID:A1','UID:A1','TRIGGER:-PT15M','ACTION:DISPLAY','DESCRIPTION:Reminder','END:VALARM','END:VEVENT','END:VCALENDAR',''].join('\r\n');

test('reads an Apple event: zone, escapes, folding and the alert',()=>{
  const item=readItem(parseICS(APPLE_EVENT),'UTC');
  assert.equal(item.kind,'event');assert.equal(item.uid,'9C1E-APPLE');
  assert.equal(item.title,'Team sync, weekly');
  assert.equal(item.notes,'Agenda:\nRoadmap; budgets and a very long line that keeps going so it has to be fol ded by the client');
  assert.equal(iso(item.start.ms),'2026-10-05T14:00:00.000Z');assert.equal(item.start.tz,CT);
  assert.equal(item.end.ms-item.start.ms,3600000);
  assert.equal(item.alarms.length,1);assert.equal(item.alarms[0].offset,-15*60000);
});

test('a weekly event keeps 9:00 local time across the daylight-saving change',()=>{
  const item=readItem(parseICS(APPLE_EVENT),'UTC');
  const list=occurrences(item,Date.UTC(2026,9,26),Date.UTC(2026,10,10));
  assert.deepEqual(list.map(o=>local(o.start)),['2026-10-26 09:00','2026-10-28 09:00','2026-11-02 09:00','2026-11-04 09:00','2026-11-09 09:00']);
  assert.equal(iso(list[0].start),'2026-10-26T14:00:00.000Z');assert.equal(iso(list[2].start),'2026-11-02T15:00:00.000Z');
  const alarms=alarmTimes(item,list[2]);assert.equal(local(alarms[0].at),'2026-11-02 08:45');assert.equal(alarms[0].acknowledged,false);
});

test('round-trips without losing properties Apple wrote',()=>{
  const cal=parseICS(APPLE_EVENT),out=serializeICS(cal);
  assert.match(out,/X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\n/);assert.match(out,/BEGIN:VTIMEZONE/);
  for(const line of out.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75,line);
  const again=readItem(parseICS(out),'UTC');assert.equal(again.notes,readItem(cal,'UTC').notes);
  // Editing the title through Seek keeps everything else.
  const edited=serializeICS(applyItem(parseICS(out),'event',{title:'Team sync (moved)'},{tz:CT,now:Date.UTC(2026,9,6)}));
  assert.match(edited,/X-APPLE-TRAVEL-ADVISORY-BEHAVIOR/);assert.match(edited,/RRULE:FREQ=WEEKLY;BYDAY=MO,WE/);assert.match(edited,/TRIGGER:-PT15M/);
  assert.equal(readItem(parseICS(edited),'UTC').title,'Team sync (moved)');assert.match(edited,/SEQUENCE:1/);
});

test('daylight-saving gaps move forward and repeated hours take the first',()=>{
  assert.equal(iso(zonedToUtc({y:2026,m:3,d:8,h:2,mi:30},CT)),'2026-03-08T08:30:00.000Z');
  assert.equal(iso(zonedToUtc({y:2026,m:11,d:1,h:1,mi:30},CT)),'2026-11-01T06:30:00.000Z');
  assert.equal(iso(zonedToUtc({y:2026,m:7,d:4,h:12},CT)),'2026-07-04T17:00:00.000Z');
});

const cal=lines=>parseICS(['BEGIN:VCALENDAR','VERSION:2.0',...lines,'END:VCALENDAR'].join('\r\n'));
test('monthly rules: second Tuesday, last Friday, the 31st only where it exists',()=>{
  const second=readItem(cal(['BEGIN:VEVENT','UID:a','DTSTART;TZID=America/Chicago:20261013T180000','DTEND;TZID=America/Chicago:20261013T190000','RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=4','END:VEVENT']));
  assert.deepEqual(occurrences(second,Date.UTC(2026,0,1),Date.UTC(2028,0,1)).map(o=>local(o.start)),['2026-10-13 18:00','2026-11-10 18:00','2026-12-08 18:00','2027-01-12 18:00']);
  const last=readItem(cal(['BEGIN:VEVENT','UID:b','DTSTART;TZID=America/Chicago:20261030T120000','DURATION:PT30M','RRULE:FREQ=MONTHLY;BYDAY=-1FR','END:VEVENT']));
  assert.deepEqual(occurrences(last,Date.UTC(2026,9,1),Date.UTC(2027,1,1)).map(o=>local(o.start).slice(0,10)),['2026-10-30','2026-11-27','2026-12-25','2027-01-29']);
  const day31=readItem(cal(['BEGIN:VEVENT','UID:c','DTSTART:20261031T150000Z','RRULE:FREQ=MONTHLY','END:VEVENT']));
  assert.deepEqual(occurrences(day31,Date.UTC(2026,9,1),Date.UTC(2027,3,1)).map(o=>iso(o.start).slice(0,10)),['2026-10-31','2026-12-31','2027-01-31','2027-03-31']);
});

test('yearly all-day birthday, UNTIL, EXDATE and a moved occurrence',()=>{
  const bday=readItem(cal(['BEGIN:VEVENT','UID:d','DTSTART;VALUE=DATE:20261011','DTEND;VALUE=DATE:20261012','RRULE:FREQ=YEARLY','SUMMARY:Birthday','END:VEVENT']),CT);
  const years=occurrences(bday,Date.UTC(2026,0,1),Date.UTC(2029,0,1));
  assert.deepEqual(years.map(o=>local(o.start)),['2026-10-11 00:00','2027-10-11 00:00','2028-10-11 00:00']);assert.ok(years.every(o=>o.allDay));
  const series=readItem(cal(['BEGIN:VEVENT','UID:e','DTSTART;TZID=America/Chicago:20261005T090000','DTEND;TZID=America/Chicago:20261005T093000','RRULE:FREQ=DAILY;UNTIL=20261009T140000Z','EXDATE;TZID=America/Chicago:20261007T090000','END:VEVENT',
    'BEGIN:VEVENT','UID:e','RECURRENCE-ID;TZID=America/Chicago:20261008T090000','DTSTART;TZID=America/Chicago:20261008T160000','DTEND;TZID=America/Chicago:20261008T163000','SUMMARY:Moved','END:VEVENT']));
  const days=occurrences(series,Date.UTC(2026,9,1),Date.UTC(2026,9,20));
  assert.deepEqual(days.map(o=>local(o.start)),['2026-10-05 09:00','2026-10-06 09:00','2026-10-08 16:00','2026-10-09 09:00']);
  assert.equal(days[2].override.title,'Moved');
});

test('weekly rules that start on a Sunday include that Sunday',()=>{
  const item=readItem(cal(['BEGIN:VEVENT','UID:f','DTSTART;TZID=America/Chicago:20261004T100000','DURATION:PT1H','RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE;COUNT=4','END:VEVENT']));
  assert.deepEqual(occurrences(item,Date.UTC(2026,9,1),Date.UTC(2026,11,1)).map(o=>local(o.start).slice(0,10)),['2026-10-04','2026-10-14','2026-10-18','2026-10-28']);
});

test('to-dos: due dates, absolute alarms, completion and repeating ones roll forward',()=>{
  const todo=cal(['BEGIN:VTODO','UID:t1','SUMMARY:Order the cake','DUE;VALUE=DATE:20261009','STATUS:NEEDS-ACTION','RRULE:FREQ=WEEKLY',
    'BEGIN:VALARM','TRIGGER;VALUE=DATE-TIME:20261009T140000Z','ACTION:DISPLAY','END:VALARM','END:VTODO']);
  const item=readItem(todo,CT);assert.equal(item.kind,'todo');assert.equal(item.done,false);assert.ok(item.due.allDay);
  const occ=occurrences(item,Date.UTC(2026,9,1),Date.UTC(2026,9,12));assert.equal(occ.length,1);assert.equal(local(occ[0].start),'2026-10-09 00:00');
  assert.equal(iso(alarmTimes(item,occ[0])[0].at),'2026-10-09T14:00:00.000Z');
  assert.ok(advanceRepeatingTodo(todo,{zone:CT,now:Date.UTC(2026,9,9)}));
  const next=readItem(todo,CT);assert.equal(local(next.due.ms),'2026-10-16 00:00');assert.equal(next.done,false);
  const done=readItem(applyItem(parseICS(serializeICS(todo)),'todo',{done:true},{tz:CT,now:Date.UTC(2026,9,9,15)}),CT);
  assert.equal(done.done,true);assert.equal(iso(done.completed),'2026-10-09T15:00:00.000Z');
});

test('Seek-created events carry a correct VTIMEZONE and alarm',()=>{
  const start=zonedToUtc({y:2026,m:10,d:12,h:15},CT);
  const out=serializeICS(applyItem(null,'event',{uid:'seek-1',title:'Dentist',start,end:start+1800000,alarms:[{offset:-3600000}],location:'Main St, Suite 4'},{tz:CT,now:Date.UTC(2026,9,6)}));
  assert.match(out,/DTSTART;TZID=America\/Chicago:20261012T150000/);assert.match(out,/LOCATION:Main St\\, Suite 4/);
  assert.match(out,/BEGIN:DAYLIGHT[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/);assert.match(out,/BEGIN:STANDARD[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU/);
  assert.match(out,/TRIGGER:-PT1H/);
  const back=readItem(parseICS(out),'UTC');assert.equal(back.start.ms,start);assert.equal(back.alarms[0].offset,-3600000);
  const utcZone=vtimezone('UTC');assert.equal(utcZone.children.length,1);
});

test('durations and line handling',()=>{
  assert.equal(parseDuration('-PT15M'),-900000);assert.equal(parseDuration('P1DT2H'),93600000);assert.equal(parseDuration('P2W'),1209600000);
  assert.equal(formatDuration(-900000),'-PT15M');assert.equal(formatDuration(86400000),'P1D');assert.equal(formatDuration(604800000),'P1W');
  assert.equal(unfold('A:b\r\n c\r\n\td'),'A:bcd');
  const long=serializeICS(applyItem(null,'todo',{uid:'u',title:'Ünïcödé '.repeat(20)},{now:0}));
  for(const line of long.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
  assert.equal(readItem(parseICS(long)).title,'Ünïcödé '.repeat(20));
  assert.throws(()=>parseICS('hello'),/VCALENDAR/);
  assert.equal(prop(parseICS(long).children[0],'STATUS').value,'NEEDS-ACTION');
});
