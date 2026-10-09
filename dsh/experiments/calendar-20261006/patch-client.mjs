// Hooks the calendar feature into the Work shell: nav, view routing, Home, Inbox, palette, Connections.
import {readFile,writeFile} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url);
async function patch(name,pairs){
  const f=new URL(name,lib);let t=await readFile(f,'utf8');
  for(const [a,b] of pairs){const n=t.split(a).length-1;if(n!==1)throw new Error(`${name}: expected 1 match, found ${n}: ${a.slice(0,90)}`);t=t.replace(a,()=>b);}
  await writeFile(f,t);console.log('patched',name,pairs.length);
}
const ic=name=>`<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

await patch('work-assets.js',[[`'/work/system.css':'work-system.css'});`,`'/work/system.css':'work-system.css'});
Object.assign(WORK_FILES,{'/work/calendar.js':'work-calendar-client.js','/work/calendar.css':'work-calendar.css','/work/ical.js':'work-ical.js'});`]]);

await patch('work.html',[
  // Icons the calendar uses.
  ['<symbol id="i-sidebar"',`<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="3" style="fill:var(--ic-fill,currentColor);fill-opacity:var(--ic-duo,.14)"/><rect x="3.5" y="5" width="17" height="15.5" rx="3" fill="none"/><path fill="none" d="M3.5 10h17M8 3v4M16 3v4"/></symbol><symbol id="i-check" viewBox="0 0 24 24"><path fill="none" d="m5 12.5 4.5 4.5L19 7.5"/></symbol><symbol id="i-repeat" viewBox="0 0 24 24"><path fill="none" d="M17 3.5 20 6.5l-3 3M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20M7 20.5 4 17.5l3-3M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/></symbol><symbol id="i-chevron-left" viewBox="0 0 24 24"><path fill="none" d="m14.5 6-6 6 6 6"/></symbol><symbol id="i-chevron-right" viewBox="0 0 24 24"><path fill="none" d="m9.5 6 6 6-6 6"/></symbol><symbol id="i-sync" viewBox="0 0 24 24"><path fill="none" d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1M17.5 3.5v3.4h-3.4M6.5 20.5v-3.4h3.4"/></symbol><symbol id="i-download" viewBox="0 0 24 24"><path fill="none" d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/></symbol><symbol id="i-sidebar"`],
  // Calendar sits after Inbox in the sidebar; on phones it takes Library's tab (Library stays under More).
  ['<span>Inbox</span><b id="inbox-count" class="count-alert"></b></button>',`<span>Inbox</span><b id="inbox-count" class="count-alert"></b></button><button data-view="calendar">${ic('calendar')}<span>Calendar</span></button>`],
  [`<button data-view="files">${ic('folder')}<span>Library</span></button><button id="mobile-more"`,`<button data-view="calendar">${ic('calendar')}<span>Calendar</span></button><button id="mobile-more"`],
]);

await patch('work-client.js',[
  [`const VIEWS=['chat','tasks','files','ideas','finance','images','workflows',...SETTINGS];`,`const VIEWS=['chat','tasks','files','ideas','finance','images','workflows','calendar',...SETTINGS];`],
  [`const TITLES={tasks:'Tasks',files:'Library',ideas:'Ideas for you',images:'Studio',finance:'Finance',workflows:'Workflows'};`,`const TITLES={tasks:'Tasks',files:'Library',ideas:'Ideas for you',images:'Studio',finance:'Finance',workflows:'Workflows',calendar:'Calendar'};`],
  [`const paths={finance:'/work/finance.js',images:'/work/images.js',dreaming:'/work/dreaming.js',growth:'/work/growth.js'},styles={finance:['/work/finance.css','/work/finance-v2.css'],images:['/work/images.css'],dreaming:['/work/dreaming.css'],growth:['/work/growth.css']};`,
   `const paths={finance:'/work/finance.js',images:'/work/images.js',dreaming:'/work/dreaming.js',growth:'/work/growth.js',calendar:'/work/calendar.js'},styles={finance:['/work/finance.css','/work/finance-v2.css'],images:['/work/images.css'],dreaming:['/work/dreaming.css'],growth:['/work/growth.css'],calendar:['/work/calendar.css']};`],
  [`if(view==='finance'||view==='images'){if(externalView!==view){const next=view;externalView=next;main.innerHTML='<section class="memory" role="status">Loading…</section>';main.scrollTop=0;void ensureFeature(next).then(()=>{if(view===next)(next==='finance'?window.SeekFinance:window.SeekImages)?.activate();})`,
   `if(view==='finance'||view==='images'||view==='calendar'){if(externalView!==view){const next=view;externalView=next;main.innerHTML='<section class="memory" role="status">Loading…</section>';main.scrollTop=0;void ensureFeature(next).then(()=>{if(view===next)(next==='finance'?window.SeekFinance:next==='images'?window.SeekImages:window.SeekCalendar)?.activate();})`],
  // Every poll tells the calendar it may have changed; the first one loads it for Home and the Inbox.
  [`    firstPoll=false;online=true;render();`,`    if(firstPoll)void ensureFeature('calendar').catch(()=>{});
    firstPoll=false;online=true;render();window.dispatchEvent(new Event('seek-poll'));`],
  [`const soft=!waiting&&(headsUpItems().length>0||memoryReview>0);`,`const soft=!waiting&&(headsUpItems().length>0||memoryReview>0||(window.SeekCalendar?.reminders?.length||0)>0);`],
  [`  const blocked=needsYou(),items=headsUpItems(),memory=memoryInboxCard();
  if(!blocked.length&&!items.length&&!memory)return '<p class="ap-empty">Nothing needs you right now.</p>';
  return \``,`  const blocked=needsYou(),items=headsUpItems(),memory=memoryInboxCard(),reminders=window.SeekCalendar?.remindersHtml?.()||'';
  if(!blocked.length&&!items.length&&!memory&&!reminders)return '<p class="ap-empty">Nothing needs you right now.</p>';
  return \`\${reminders?\`<div class="ap-section-label">Reminders</div><div class="ap-list">\${reminders}</div>\`:''}`],
  [`  return \`\${headsUp}\${recentWork(state.tasks)}`,`  return \`<section class="home-section home-today" id="home-today" hidden></section>\${headsUp}\${recentWork(state.tasks)}`],
  [`  home.querySelector('.home-cards').innerHTML=homeCards();`,`  home.querySelector('.home-cards').innerHTML=homeCards();window.SeekCalendar?.renderToday?.();`],
  [`    act('schedule','Schedule a task','Later, every day or every week','clock'),`,`    act('schedule','Schedule a task','Later, every day or every week','clock'),
    act('new-event','New event','On the calendar you share with Seek','calendar'),
    act('new-todo','New to-do','On the list you share with Seek','check-circle'),`],
  [`    go('Inbox','Approvals, questions and heads-ups','bell','inbox'),`,`    go('Inbox','Approvals, questions and heads-ups','bell','inbox'),
    go('Calendar','Events and to-dos, synced with Apple','calendar','calendar'),`],
  [`  else if(id==='developer')window.open('/','_blank','noopener');`,`  else if(id==='developer')window.open('/','_blank','noopener');
  else if(id==='new-event'||id==='new-todo'){navigate('calendar');void ensureFeature('calendar').then(()=>window.SeekCalendar?.openEditor(id==='new-todo'?'todo':'event')).catch(error=>toast(error.message));}`],
  [`document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);`,`// The calendar changed something the Inbox or its badge shows.
window.addEventListener('seek-inbox-refresh',()=>{apSig='';render();});
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);`],
]);
// Connections: the calendar adds its own card after the list renders.
{
  const f=new URL('work-client.js',lib);let t=await readFile(f,'utf8');
  const start=t.indexOf("  main.innerHTML=`${settingsIntro('connections',CONNECTIONS_INTRO,");if(start<0)throw new Error('connections anchor');
  const end=t.indexOf('\n',start);
  t=t.slice(0,end)+"\n  void ensureFeature('calendar').then(()=>window.SeekCalendar?.renderConnection?.(main)).catch(()=>{});"+t.slice(end);
  await writeFile(f,t);console.log('patched connections hook');
}
