import {refreshProductPalette} from '/work/theme.js';
import {artifactURL} from '/work/product.js';
import {getModels,modelRibbon} from '/work/models.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const root=document.documentElement;
function preference(name,fallback,allowed){try{const value=localStorage.getItem('seek-'+name);return allowed.includes(value)?value:fallback;}catch{return fallback;}}
root.dataset.experience='editorial';
root.dataset.layout=preference('layout','editorial',['editorial','canvas']);
root.dataset.appearance=preference('appearance','system',['system','light','dark']);
refreshProductPalette();
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',refreshProductPalette);
function savePreference(name,value){root.dataset[name]=value;try{localStorage.setItem('seek-'+name,value);}catch{}refreshProductPalette();updateLayoutControl();}
function updateLayoutControl(){const button=document.getElementById('experience-layout');if(button){const compact=root.dataset.layout==='canvas';button.title=compact?'Expand sidebar':'Collapse sidebar';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(compact));}}
updateLayoutControl();
export function appearanceEditor(){return `<section class="appearance-editor"><div class="section-copy"><h3>Appearance</h3><p>Your sidekick’s color sets the palette throughout Seek. These choices stay on this device.</p></div><div class="appearance-fields"><label>Appearance<select id="seek-appearance">${['system','light','dark'].map(x=>`<option value="${x}"${x===root.dataset.appearance?' selected':''}>${x==='system'?'Follow device':x==='light'?'Light':'Dark'}</option>`).join('')}</select></label><label>Sidebar<select id="seek-layout">${['editorial','canvas'].map(x=>`<option value="${x}"${x===root.dataset.layout?' selected':''}>${x==='editorial'?'Full · labels and recent chats':'Compact · icons only'}</option>`).join('')}</select></label></div><details class="editorial-health"><summary>Model activity</summary><div id="editorial-model-status">${modelRibbon(getModels())}</div></details></section>`;}
export function homeGreeting(){const day=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date());return `<div class="home-greet"><button class="buddy-stage hero" data-stage="hero" data-view="inbox" aria-label="Check in with your sidekick"><span class="buddy" data-buddy="hero" data-track></span><span class="buddy-say" role="status"></span></button><div class="home-greet-copy"><div class="eyebrow">${esc(day)}</div><h2>What would you like to get done?</h2><p>Ask a question, hand off a task, or pick up where you left off.</p></div></div>`;}
export function recentWork(tasks){
 const recent=tasks.filter(t=>!t.archived).sort((a,b)=>(b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0)).slice(0,5);
 const labels={complete:'Complete',running:'In progress',waiting:'Needs you',attention:'Needs attention',queued:'Queued',scheduled:'Scheduled',paused:'Paused',stopped:'Stopped'};
 return `<section class="home-section recent-work"><div class="home-section-head"><h3>Recent work</h3><button class="link-btn" data-view="tasks">All tasks${icon('arrow-right')}</button></div>${recent.length?`<div class="editorial-rows">${recent.map(t=>`<button data-select="${esc(t.id)}" class="editorial-row"><span class="row-mark">${icon((t.artifacts||[]).length?'doc':'chat')}</span><span class="row-title">${esc(t.title)}<small>${esc(t.activity||t.objective||'Conversation')}</small></span><span class="row-state ${esc(t.status)}">${esc(labels[t.status]||'Saved')}</span>${icon('forward')}</button>`).join('')}</div>`:'<p class="editorial-empty">Your work will collect here. Start with an outcome, a question, or a file.</p>'}</section>`;
}
let resultKey='',activeTask=null,selectedFiles=new Map();
export function syncEditorial({view,task}){
 document.body.classList.toggle('in-conversation',view==='chat'&&!!task);
 const home=document.querySelector('[data-editorial-home]');if(home){const active=view==='chat'&&!task;home.classList.toggle('active',active);if(active)home.setAttribute('aria-current','page');else home.removeAttribute('aria-current');}
 for(const id of ['new-task','search-work']){const button=document.getElementById(id);if(button&&!button.getAttribute('aria-label'))button.setAttribute('aria-label',button.querySelector('span')?.textContent||'');}
 document.querySelectorAll('.side-nav [data-view]').forEach(button=>{if(!button.hasAttribute('aria-label'))button.setAttribute('aria-label',button.textContent.trim());});
 let pane=document.getElementById('result-pane');if(!pane){pane=document.createElement('aside');pane.id='result-pane';pane.className='result-pane';pane.setAttribute('aria-label','Result workspace');document.querySelector('.workspace').append(pane);}
 const files=view==='chat'?task?.artifacts||[]:[];document.body.classList.toggle('has-result',files.length>0);
 if(!files.length){pane.hidden=true;pane.replaceChildren();resultKey='';activeTask=null;return;}
 activeTask=task;pane.hidden=false;
 const selected=files.find(a=>a.id===selectedFiles.get(task.id))||files.at(-1),key=JSON.stringify([task.id,files.map(a=>[a.id,a.title,a.type,a.version,a.at]),selected.id]);
 if(key===resultKey)return;resultKey=key;selectedFiles.set(task.id,selected.id);
 pane.innerHTML=`<header class="result-head"><div><span class="eyebrow">Result</span><h2>${esc(selected.title||'Untitled file')}</h2></div><button class="icon-btn" data-preview="${esc(selected.id)}" data-task="${esc(task.id)}" aria-label="Expand file preview" title="Expand preview">${icon('external')}</button></header><div class="result-files" role="group" aria-label="Task files">${files.map(a=>`<button data-result-select="${esc(a.id)}" aria-pressed="${a.id===selected.id}">${icon('doc')}<span>${esc(a.title||'Untitled file')}</span>${a.version?`<small>v${esc(a.version)}</small>`:''}</button>`).join('')}</div><div class="result-preview"><iframe title="${esc(selected.title||'File')} result preview" sandbox="allow-scripts" loading="lazy" src="${artifactURL(task.id,selected.id,true)}"></iframe></div><footer class="result-footer"><span>Saved with this conversation</span><a href="${artifactURL(task.id,selected.id)}" download>${icon('doc')}Download</a></footer>`;
}
document.addEventListener('click',event=>{
 if(event.target.closest('[data-editorial-home]')){document.getElementById('new-task')?.click();return;}
 const layout=event.target.closest('#experience-layout');if(layout){savePreference('layout',root.dataset.layout==='canvas'?'editorial':'canvas');return;}
 const search=event.target.closest('#editorial-search');if(search){document.getElementById('search-work')?.click();return;}
 const result=event.target.closest('[data-result-select]');if(result&&activeTask){selectedFiles.set(activeTask.id,result.dataset.resultSelect);syncEditorial({view:'chat',task:activeTask});}
});
document.addEventListener('change',event=>{if(event.target.id==='seek-appearance')savePreference('appearance',event.target.value);if(event.target.id==='seek-layout')savePreference('layout',event.target.value);});
if(typeof document!=='undefined'){
 const observer=new MutationObserver(()=>{const section=document.querySelector('#model-status');if(section)document.body.classList.toggle('model-attention',!!section.querySelector('.is-active,.state-error,.state-offline'));});
 const status=document.getElementById('model-status');if(status)observer.observe(status,{subtree:true,childList:true});
}

window.addEventListener('seek-model-state',event=>{const host=document.getElementById('editorial-model-status');if(host)host.innerHTML=modelRibbon(event.detail);});
