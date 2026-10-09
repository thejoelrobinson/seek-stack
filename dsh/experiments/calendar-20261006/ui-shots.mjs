// Screens of the calendar UI on the real mounted Work server with sample data.
// node --import <register-profile> ui-shots.mjs <outdir> [phone] [dark]
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {ready} from './mount.mjs';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const outDir=new URL((process.argv[2]||'ui')+'/',import.meta.url),phone=process.argv.includes('phone'),dark=process.argv.includes('dark');await mkdir(outDir,{recursive:true});
const m=await ready,base=m.base;
const api=async(path,body)=>{const r=await fetch(base+'/work/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error);return j;};
const call=(n,a)=>m.tools.get(n).execute(a,{});
const day=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toLocaleDateString('en-CA');};
// A believable week.
await call('calendar_add_event',{title:'Team standup',start:`${day(-1)}T09:00`,end:`${day(-1)}T09:15`,repeat:'weekdays'});
await call('calendar_add_event',{title:'Lunch with Madison',start:`${day(0)}T12:00`,end:`${day(0)}T13:00`,location:'Onyx Coffee Lab'});
await api('calendar/item',{action:'save',kind:'event',fields:{title:'Design review: River Valley Ads',start:Date.now()+2*3600000,end:Date.now()+3*3600000}});
await call('calendar_add_event',{title:'Dentist',start:`${day(1)}T15:00`,end:`${day(1)}T15:30`,location:'Main St Dental, Suite 4',alertMinutesBefore:[60]});
await call('calendar_add_event',{title:'Client call',start:`${day(2)}T10:00`,end:`${day(2)}T11:00`});
await call('calendar_add_event',{title:'Budget sync',start:`${day(2)}T10:30`,end:`${day(2)}T11:30`});
await call('calendar_add_event',{title:'Pick up chocolate cake',start:`${day(3)}T16:30`,end:`${day(3)}T17:00`,location:'Rick’s Bakery'});
await call('calendar_add_event',{title:'Wife’s birthday',start:day(5),end:day(5),repeat:'yearly',prepare:'Plan a birthday dinner: two restaurant options with a table for two, and a gift idea under $100',prepareHoursBefore:48});
await call('calendar_add_event',{title:'Razorbacks vs. Tulsa',start:`${day(4)}T18:00`,end:`${day(4)}T21:00`,location:'Razorback Stadium'});
await call('todo_add',{title:'Renew car registration',due:day(-2),priority:'high'});
await call('todo_add',{title:'Order the cake',due:`${day(0)}T17:00`});
await call('todo_add',{title:'Take out trash',due:day(1),repeat:'weekly'});
await call('todo_add',{title:'Book flights for Thanksgiving',due:day(9)});
await call('todo_add',{title:'Learn the new Lightroom shortcuts'});
const done=await call('todo_add',{title:'Email Lance the ad draft'});await call('todo_complete',{id:done.added.id});
await api('calendar/item',{action:'save',kind:'event',fields:{title:'Call the plumber back',start:Date.now()+3000,end:Date.now()+1803000,alerts:[0]}});
await new Promise(r=>setTimeout(r,23000));
const browser=await chromium.launch({channel:'chrome',headless:true});
const ctx=await browser.newContext(phone?{viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,colorScheme:dark?'dark':'light',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}:{viewport:{width:1440,height:900},colorScheme:dark?'dark':'light'});
const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',x=>{if(x.type()==='error')errors.push(x.text());});
const p=phone?'p':'d',sfx=dark?'-dark':'';
const shot=async n=>{await page.waitForTimeout(600);await page.screenshot({path:decodeURIComponent(new URL(`${p}-${n}${sfx}.png`,outDir).pathname).replace(/^\/([A-Z]:)/i,'$1')});console.log('shot',n);};
try{
  if(dark)await page.addInitScript(()=>{try{localStorage.setItem('seek-appearance','dark');}catch{}});
  await page.goto(base+'/work');await page.waitForSelector('#composer');await page.waitForTimeout(3500);
  await shot('01-home');
  await page.evaluate(()=>[...document.querySelectorAll('[data-view="calendar"]')].find(e=>e.offsetParent)?.click());await page.waitForTimeout(1500);
  await shot('10-calendar');
  if(!phone){await page.click('[data-cal-mode="month"]');await shot('11-month');await page.click('[data-cal-mode="agenda"]');await shot('12-agenda');await page.click('[data-cal-mode="week"]');}
  else{await page.click('[data-cal-mode="month"]');await shot('11-month');await page.click('[data-cal-mode="agenda"]');await page.click('[data-cal-tab="todos"]');await shot('13-todos');await page.click('[data-cal-tab="calendar"]');}
  await page.click('[data-cal-open]');await shot('20-edit-event');await page.keyboard.press('Escape');
  await page.click('[data-cal-new-menu]');await shot('21-new-menu');await page.click('[data-cal-new="todo"]');await page.fill('#cal-editor [name=title]','Call the vet');await page.check('#cal-editor [name=hasDue]');await page.check('#cal-editor [name=prepOn]');await shot('22-new-todo');await page.keyboard.press('Escape');
  await page.click('[data-cal-sync]');await page.waitForTimeout(800);await shot('30-sync');await page.click('[data-cal-setup] button');await page.waitForTimeout(1200);await shot('31-sync-ready');await page.keyboard.press('Escape');
  await page.evaluate(()=>[...document.querySelectorAll('[data-view="inbox"]')].find(e=>e.offsetParent)?.click());await page.waitForTimeout(900);await shot('40-inbox');
  console.log('overflow-ok',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}catch(e){console.error('FAILED',e.message);await shot('99-failure');}
finally{console.log('errors',JSON.stringify([...new Set(errors)]));await browser.close();m.stop();setTimeout(()=>process.exit(),300);}
