import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CalendarStore} from '../lib/work-calendar.js';
import {CalDAV,parseXML} from '../lib/work-caldav.js';

const D='DAV:',C='urn:ietf:params:xml:ns:caldav';
async function setup(){const dir=await mkdtemp(join(tmpdir(),'seek-dav-'));const store=await new CalendarStore(dir,{zone:'America/Chicago',now:()=>Date.UTC(2026,9,6,18)}).init();const dav=new CalDAV(store,{owner:'Joel',email:'joel@example.com'});return {store,dav,done:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};}
const find=(el,name)=>{const out=[];const walk=e=>{if(e.name===name)out.push(e);e.children.forEach(walk);};walk(el);return out;};
const text=(el,name)=>find(el,name)[0]?.text.trim();
const responses=body=>find(parseXML(body),'response').map(r=>({href:text(r,'href'),status:find(r,'status').map(s=>s.text.trim()),r}));
const EVENT=(uid,summary='Lunch')=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Apple Inc.//iPhone OS 26.0//EN','BEGIN:VEVENT',`UID:${uid}`,'DTSTART;TZID=America/Chicago:20261009T120000','DTEND;TZID=America/Chicago:20261009T130000',`SUMMARY:${summary}`,'DTSTAMP:20261006T180000Z','END:VEVENT','END:VCALENDAR',''].join('\r\n');

test('discovery: the account setup iOS performs',async()=>{
  const {dav,done}=await setup();
  try{
    const opt=await dav.handle('OPTIONS','/work/dav/',{});assert.equal(opt.status,200);assert.match(opt.headers.DAV,/calendar-access/);
    const who=await dav.handle('PROPFIND','/work/dav/',{depth:'0'},`<?xml version="1.0"?><A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/><A:principal-URL/><A:resourcetype/></A:prop></A:propfind>`);
    assert.equal(who.status,207);assert.match(who.body,/<D:current-user-principal><D:href>\/work\/dav\/principal\/<\/D:href>/);
    const home=await dav.handle('PROPFIND','/work/dav/principal/',{depth:'0'},`<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav" xmlns:E="http://apple.com/ns/ical/"><A:prop><B:calendar-home-set/><B:calendar-user-address-set/><A:displayname/><B:schedule-inbox-URL/><E:calendar-color/></A:prop></A:propfind>`);
    const r=responses(home.body)[0];assert.equal(text(r.r,'href'),'/work/dav/principal/');
    assert.match(home.body,/calendar-home-set><D:href>\/work\/dav\/cal\/<\/D:href>/);assert.match(home.body,/mailto:joel@example.com/);
    assert.match(home.body,/404 Not Found/,'unknown props are reported as missing');
    const list=await dav.handle('PROPFIND','/work/dav/cal/',{depth:'1'},`<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav" xmlns:C="http://calendarserver.org/ns/" xmlns:E="http://apple.com/ns/ical/"><A:prop><A:resourcetype/><A:displayname/><B:supported-calendar-component-set/><C:getctag/><A:sync-token/><E:calendar-color/><A:current-user-privilege-set/></A:prop></A:propfind>`);
    const rows=responses(list.body);assert.deepEqual(rows.map(x=>x.href),['/work/dav/cal/','/work/dav/cal/seek/','/work/dav/cal/todos/']);
    assert.match(list.body,/<D:displayname>Seek To-dos<\/D:displayname>/);assert.match(list.body,/<C:comp name="VTODO"\/>/);assert.match(list.body,/<C:comp name="VEVENT"\/>/);
    assert.match(list.body,/<D:collection\/><C:calendar\/>/);assert.match(list.body,/<D:write\/>/);
  }finally{await done();}
});

test('two-way sync: create, sync-collection, multiget, edit with ETag, delete',async()=>{
  const {store,dav,done}=await setup();
  try{
    const sync=async token=>dav.handle('REPORT','/work/dav/cal/seek/',{depth:'1'},`<?xml version="1.0"?><A:sync-collection xmlns:A="DAV:"><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`);
    const initial=await sync('');assert.equal(initial.status,207);const token0=text(parseXML(initial.body),'sync-token');assert.match(token0,/^http:\/\/seek.local\/ns\/sync\/\d+$/);
    // The phone creates an event.
    const put=await dav.handle('PUT','/work/dav/cal/seek/E1.ics',{'content-type':'text/calendar; charset=utf-8','if-none-match':'*'},EVENT('E1'));
    assert.equal(put.status,201);assert.ok(put.headers.ETag);
    assert.equal((await dav.handle('PUT','/work/dav/cal/seek/E1.ics',{'if-none-match':'*'},EVENT('E1'))).status,412);
    // Seek adds one from the web UI; the phone's next sync sees both.
    const seeks=store.save('event',{title:'Dentist',start:Date.UTC(2026,9,12,20),end:Date.UTC(2026,9,12,20,30)},{source:'seek'});
    const next=await sync(token0);const changed=responses(next.body);
    assert.deepEqual(changed.map(x=>x.href).sort(),['/work/dav/cal/seek/E1.ics',`/work/dav/cal/seek/${seeks.id.split('/')[1]}`].sort());
    const token1=text(parseXML(next.body),'sync-token');
    const multi=await dav.handle('REPORT','/work/dav/cal/seek/',{depth:'1'},`<?xml version="1.0"?><B:calendar-multiget xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav"><A:prop><A:getetag/><B:calendar-data/></A:prop><A:href>/work/dav/cal/seek/${seeks.id.split('/')[1]}</A:href><A:href>https://seek.example.com/work/dav/cal/seek/missing.ics</A:href></B:calendar-multiget>`);
    const got=responses(multi.body);assert.match(text(got[0].r,'calendar-data'),/SUMMARY:Dentist/);assert.match(got[1].status[0],/404/);
    // The phone edits with a stale ETag, then the right one.
    const stale=await dav.handle('PUT','/work/dav/cal/seek/E1.ics',{'if-match':'"nope"'},EVENT('E1','Lunch moved'));assert.equal(stale.status,412);
    const edit=await dav.handle('PUT','/work/dav/cal/seek/E1.ics',{'if-match':put.headers.ETag},EVENT('E1','Lunch moved'));assert.equal(edit.status,204);
    const get=await dav.handle('GET','/work/dav/cal/seek/E1.ics',{});assert.equal(get.headers.ETag,edit.headers.ETag);assert.match(get.body,/Lunch moved/);
    // The phone deletes it; the next sync reports it gone.
    assert.equal((await dav.handle('DELETE','/work/dav/cal/seek/E1.ics',{'if-match':edit.headers.ETag})).status,204);
    const after=responses((await sync(token1)).body);assert.deepEqual(after.map(x=>[x.href,x.status[0]]),[['/work/dav/cal/seek/E1.ics','HTTP/1.1 404 Not Found']]);
    assert.equal((await sync('http://seek.local/ns/sync/999999')).status,403);
    assert.equal((await dav.handle('GET','/work/dav/cal/seek/E1.ics',{})).status,404);
  }finally{await done();}
});

test('Reminders: to-dos go to the to-do list only; queries filter by component and time',async()=>{
  const {store,dav,done}=await setup();
  try{
    const todo=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VTODO','UID:T1','SUMMARY:Buy candles','DUE;VALUE=DATE:20261010','STATUS:NEEDS-ACTION','END:VTODO','END:VCALENDAR',''].join('\r\n');
    const wrong=await dav.handle('PUT','/work/dav/cal/seek/T1.ics',{'content-type':'text/calendar'},todo);assert.equal(wrong.status,403);assert.match(wrong.body,/supported-calendar-component/);
    assert.equal((await dav.handle('PUT','/work/dav/cal/todos/T1.ics',{'content-type':'text/calendar'},todo)).status,201);
    assert.equal(store.range(0,Date.UTC(2027,0,1)).todos[0].title,'Buy candles');
    await dav.handle('PUT','/work/dav/cal/seek/A.ics',{},EVENT('A'));
    const q=range=>dav.handle('REPORT','/work/dav/cal/seek/',{depth:'1'},`<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">${range}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
    assert.equal(responses((await q('<C:time-range start="20261001T000000Z" end="20261101T000000Z"/>')).body).length,1);
    assert.equal(responses((await q('<C:time-range start="20261101T000000Z" end="20261201T000000Z"/>')).body).length,0);
    assert.equal(responses((await q('')).body).length,1);
    const bad=await dav.handle('PUT','/work/dav/cal/seek/bad.ics',{'content-type':'text/calendar'},'BEGIN:VEVENT\r\nEND:VEVENT');assert.equal(bad.status,403);assert.match(bad.body,/valid-calendar-data/);
    assert.equal((await dav.handle('MKCALENDAR','/work/dav/cal/new/',{})).status,403);
    assert.equal((await dav.handle('PROPFIND','/work/dav/elsewhere/',{depth:'0'},'')).status,404);
    const feed=await dav.handle('GET','/work/dav/cal/seek/',{});assert.match(feed.body,/X-WR-CALNAME:Seek/);assert.equal((feed.body.match(/BEGIN:VCALENDAR/g)||[]).length,1);
  }finally{await done();}
});

test('the XML reader handles namespaces, entities and refuses DOCTYPE',()=>{
  const doc=parseXML(`<?xml version="1.0"?><!-- hi --><propfind xmlns="DAV:"><prop><displayname>A &amp; B</displayname><x:color xmlns:x="urn:x"/></prop></propfind>`);
  assert.equal(doc.ns,D);assert.equal(doc.children[0].children[0].text,'A & B');assert.equal(doc.children[0].children[1].ns,'urn:x');
  assert.throws(()=>parseXML('<!DOCTYPE x [<!ENTITY a "b">]><x/>'),/DOCTYPE/);
  assert.throws(()=>parseXML('<a><b></a>'),/Mismatched/);void C;
});
