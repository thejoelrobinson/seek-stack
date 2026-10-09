import {readFile,writeFile} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url);
async function patch(name,pairs){const f=new URL(name,lib);let t=await readFile(f,'utf8');for(const [a,b] of pairs){const n=t.split(a).length-1;if(n!==1)throw new Error(`${name}: ${n} matches for ${a.slice(0,80)}`);t=t.replace(a,()=>b);}await writeFile(f,t);console.log('patched',name);}
await patch('work-calendar-client.js',[
  // Toggles use the shared .switch control inside a labelled row.
  [`const options=(list,value)=>`,`const toggle=(text,attrs)=>\`<label class="cal-toggle"><span class="cal-toggle-text">\${text}</span><span class="switch"><input type="checkbox" \${attrs}><span></span></span></label>\`;
const options=(list,value)=>`],
  [`<label class="switch"><input type="checkbox" name="allDay"\${allDay?' checked':''}><span>All day</span></label>`,`\${toggle('All day',\`name="allDay"\${allDay?' checked':''}\`)}`],
  [`<label class="switch"><input type="checkbox" name="hasDue"\${item?.due!=null||preset.due!=null?' checked':''}><span>Due date</span></label>`,`\${toggle('Due date',\`name="hasDue"\${item?.due!=null||preset.due!=null?' checked':''}\`)}`],
  [`<label class="switch"><input type="checkbox" name="prepOn"\${item?.prep?' checked':''}><span>\${icon('sparkles','ic-sm')}Have Seek prepare ahead</span></label>`,`\${toggle(\`\${icon('sparkles','ic-sm')}Have Seek prepare ahead\`,\`name="prepOn"\${item?.prep?' checked':''}\`)}`],
  [`<label class="switch"><input type="checkbox" data-cal-setting="push"\${s.push?' checked':''}><span>Seek notifications and the Inbox</span></label>`,`\${toggle('Seek notifications and the Inbox',\`data-cal-setting="push"\${s.push?' checked':''}\`)}`],
  [`<label class="switch"><input type="checkbox" data-cal-setting="discord"\${s.discord?' checked':''}><span>A Discord message from PAW</span></label>`,`\${toggle('A Discord message from PAW',\`data-cal-setting="discord"\${s.discord?' checked':''}\`)}`],
  // Load right away so Home's Today and the Inbox have data before the next poll.
  [`window.SeekCalendar={reminders:[],`,`window.SeekCalendar={reminders:[],`],
]);
{
  const f=new URL('work-calendar-client.js',lib);let t=await readFile(f,'utf8');
  t=t.trimEnd()+"\nvoid load();\n";await writeFile(f,t);console.log('initial load added');
}
await patch('work-calendar.css',[
  [`.cal-dialog .switch{flex-direction:row;align-items:center;gap:var(--sp-2);font:var(--type-label);font-size:var(--t-sm);color:var(--ink);cursor:pointer}
.cal-dialog .switch .ic{color:var(--accent-ink)}
.cal-dialog .switch span{display:inline-flex;align-items:center;gap:6px}`,`.cal-dialog label{margin:0}
.cal-dialog .cal-toggle{flex-direction:row;align-items:center;justify-content:space-between;gap:var(--sp-3);cursor:pointer;min-height:32px}
.cal-toggle-text{display:inline-flex;align-items:center;gap:6px;font:var(--type-label);font-size:var(--t-sm);color:var(--ink)}
.cal-toggle-text .ic{color:var(--accent-ink)}`],
  [`.todo-add{display:flex;gap:var(--sp-2);align-items:center}
.todo-add input{flex:1;min-width:0;height:var(--h-md);padding:0 12px}
.todo-add select{height:var(--h-md);padding:0 26px 0 10px;font-size:var(--t-sm);width:auto;max-width:108px}
.todo-add .icon-btn.primary{width:var(--h-md);height:var(--h-md);border-radius:var(--r);flex:none;background:var(--accent);color:var(--accent-text)}
.todo-add .icon-btn.primary:hover{background:var(--accent-hover);color:var(--accent-text)}`,`.todo-add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--sp-2);align-items:center}
.todo-add input{grid-column:1/-1;min-width:0;height:var(--h-md);padding:0 12px}
.todo-add select{height:var(--h-sm);padding:0 26px 0 10px;font-size:var(--t-sm);width:auto;justify-self:start;border-color:var(--line)}
[data-experience] .todo-add .icon-btn.primary{width:auto;height:var(--h-sm);padding:0 12px;border-radius:var(--r);flex:none;background:var(--accent);color:var(--accent-text);display:inline-flex;gap:4px;font:var(--type-button)}
[data-experience] .todo-add .icon-btn.primary:hover{background:var(--accent-hover);color:var(--accent-text)}`],
  [`.cal-delivery label:not(.switch){max-width:280px}`,`.cal-delivery label:not(.cal-toggle){max-width:280px}
.cal-sync .cal-toggle{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:var(--sp-3);margin:0}
.calendar-page .page-actions button,.calendar-page .page-actions .menu-wrap>button{display:inline-flex;align-items:center;gap:6px}`],
  [`  .todo-add input,.todo-add select{height:44px;font-size:16px}
  .todo-add .icon-btn.primary{width:44px;height:44px}`,`  .todo-add input{height:44px;font-size:16px}
  .todo-add select{height:36px;font-size:16px}
  [data-experience] .todo-add .icon-btn.primary{height:36px}`],
]);
await patch('work-calendar-client.js',[[`<button class="icon-btn primary" aria-label="Add to-do">\${icon('plus')}</button>`,`<button class="icon-btn primary">\${icon('plus','ic-sm')}Add</button>`]]);
