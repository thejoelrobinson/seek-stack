// One-shot markup patch for the AAA polish pass. Each replacement must match exactly once.
import {readFile,writeFile} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url);
async function patch(file,pairs){
 let text=await readFile(new URL(file,lib),'utf8');
 for(const [from,to] of pairs){const n=text.split(from).length-1;if(n!==1)throw new Error(`${file}: expected 1 match, found ${n}: ${from.slice(0,90)}`);text=text.replace(from,()=>to);}
 await writeFile(new URL(file,lib),text);console.log('patched',file,pairs.length);
}
const ic=(name)=>`<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
await patch('work.html',[
 ['<link rel="stylesheet" href="/work/editorial.css">','<link rel="stylesheet" href="/work/editorial.css"><link rel="stylesheet" href="/work/system.css" data-system>'],
 ['<symbol id="i-menu"','<symbol id="i-sidebar" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3.5" fill="none"/><path fill="none" d="M9.5 4.5v15"/></symbol><symbol id="i-menu"'],
 ['<strong data-agent-name>Seek</strong></a>',`<strong data-agent-name>Seek</strong></a><button class="icon-btn side-collapse" id="experience-layout" type="button" aria-pressed="false" aria-label="Collapse sidebar" title="Collapse sidebar">${ic('sidebar')}</button>`],
 ['<button data-editorial-home aria-label="Home"><svg class="ic" aria-hidden="true"><use href="#i-chat"/></svg>','<button data-editorial-home aria-label="Home"><svg class="ic" aria-hidden="true"><use href="#i-home"/></svg>'],
 ['<button id="editorial-search" aria-label="Search chats, files and memory" title="Search"><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg></button><button id="experience-layout" type="button" aria-label="Use Canvas layout">Canvas</button>',''],
]);
await patch('work-editorial.js',[
 ["function updateLayoutControl(){const button=document.getElementById('experience-layout');if(button){button.textContent=root.dataset.layout==='canvas'?'Editorial':'Canvas';button.title=root.dataset.layout==='canvas'?'Use Editorial layout':'Use Canvas layout';button.setAttribute('aria-label',button.title);}}",
  "function updateLayoutControl(){const button=document.getElementById('experience-layout');if(button){const compact=root.dataset.layout==='canvas';button.title=compact?'Expand sidebar':'Collapse sidebar';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(compact));}}"],
 ["<label>Workspace<select id=\"seek-layout\">${['editorial','canvas'].map(x=>`<option value=\"${x}\"${x===root.dataset.layout?' selected':''}>${x==='editorial'?'Editorial · room to think':'Canvas · focused workspace'}</option>`).join('')}</select></label>",
  "<label>Sidebar<select id=\"seek-layout\">${['editorial','canvas'].map(x=>`<option value=\"${x}\"${x===root.dataset.layout?' selected':''}>${x==='editorial'?'Full · labels and recent chats':'Compact · icons only'}</option>`).join('')}</select></label>"],
 ['<h3>Make yourself at home</h3><p>Your sidekick’s color sets the palette throughout Seek. Appearance and layout stay on this device.</p>','<h3>Appearance</h3><p>Your sidekick’s color sets the palette throughout Seek. These choices stay on this device.</p>'],
 ["const day=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date());","const day=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date()),hour=new Date().getHours(),part=hour<5?'evening':hour<12?'morning':hour<17?'afternoon':'evening';"],
 ['<div class="eyebrow">${esc(day)} · YOUR WORKSPACE</div><h2>What would you like<br>to get done?</h2><p>A little less on your plate. A little more possibility.</p>','<div class="eyebrow">${esc(day)}</div><h2>Good ${part}. What would you like to get done?</h2><p>Ask a question, hand off a task, or pick up where you left off.</p>'],
 ['<span class="eyebrow">YOUR RESULT</span>','<span class="eyebrow">Result</span>'],
]);
await patch('work-client.js',[
 ["for(const href of styles[name]||[])if(!document.querySelector(`link[data-feature-style=\"${href}\"]`)){const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.dataset.featureStyle=href;document.head.append(link);}",
  // Feature styles go before the design system so the shared system always has the last word.
  "for(const href of styles[name]||[])if(!document.querySelector(`link[data-feature-style=\"${href}\"]`)){const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.dataset.featureStyle=href;document.head.insertBefore(link,document.querySelector('link[data-system]'));}"],
 ['<div class="plan-title">THE PLAN</div>','<div class="plan-title">Plan</div>'],
 ['<strong>A MOMENT FOR YOU</strong>','<strong>A moment for you</strong>'],
 ['<div class="suggest-label">Tap to make it happen</div>','<div class="suggest-label">Suggested next steps</div>'],
 ['<details><summary>Activity · ${t.events.length} updates</summary>','<details class="activity-log"><summary>Activity log · ${t.events.length} ${t.events.length===1?\'update\':\'updates\'}</summary>'],
 ["return `<section class=\"page tasks\"><div class=\"task-search\">","const open=state.tasks.filter(t=>!t.archived),busy=open.filter(t=>['running','queued'].includes(t.status)).length,blocked=open.filter(t=>['waiting','attention'].includes(t.status)).length;\n  return `<section class=\"page tasks\">${pageHead('Tasks',[busy?`${busy} in progress`:'',blocked?`${blocked} need${blocked===1?'s':''} you`:'',`${open.length} total`].filter(Boolean).join(' · '))}<div class=\"task-search\">"],
 ["html=`<section class=\"page workflows\"><div class=\"page-toolbar\"><p class=\"page-intro grow\">Proven starting points. Fill in a few details, review the request in your composer, then send it.</p><button id=\"new-workflow\">${icon('plus','ic-sm')} Create a workflow</button></div>",
  "html=`<section class=\"page workflows\">${pageHead('Workflows','Proven starting points. Fill in a few details, review the request in your composer, then send it.',`<button id=\"new-workflow\">${icon('plus','ic-sm')} Create a workflow</button>`)}"],
 ["return `<section class=\"page ideas-view\"><div class=\"page-toolbar\"><p class=\"page-intro grow\">Things I could take off your plate, based on what you’ve asked me before and what you’ve told me to remember.${state.ideas?.at?` Updated ${when(state.ideas.at)}.`:''}</p><button type=\"button\" data-ideas=\"refresh\" ${ideasBusy?'disabled':''}>${icon('reload','ic-sm')} ${ideasBusy?'Thinking up ideas…':ideas.length?'Refresh ideas':'Suggest some ideas'}</button></div>",
  "return `<section class=\"page ideas-view\">${pageHead('Ideas for you',`Things I could take off your plate, based on what you’ve asked me before and what you’ve told me to remember.${state.ideas?.at?` Updated ${when(state.ideas.at)}.`:''}`,`<button type=\"button\" data-ideas=\"refresh\" ${ideasBusy?'disabled':''}>${icon('reload','ic-sm')} ${ideasBusy?'Thinking up ideas…':ideas.length?'Refresh ideas':'Suggest some ideas'}</button>`)}"],
 ["function taskBoard(){","// Every full page opens the same way: a title, one line of context, and its actions.\nfunction pageHead(title,lede='',actions=''){return `<header class=\"page-head\"><div><h1>${esc(title)}</h1>${lede?`<p>${esc(lede)}</p>`:''}</div>${actions?`<div class=\"page-actions\">${actions}</div>`:''}</header>`;}\nfunction taskBoard(){"],
]);
await patch('work-product.js',[
 ["return `<section class=\"page library\"><div class=\"library-tools\">","const total=libraryItems(tasks,{}).length;\n  return `<section class=\"page library\"><header class=\"page-head\"><div><h1>Library</h1><p>${total?`${total} file${total===1?'':'s'} made by your tasks`:'Every file your tasks make, in one place'}</p></div></header><div class=\"library-tools\">"],
]);
