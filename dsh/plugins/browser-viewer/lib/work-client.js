import {homeGreeting,recentWork,syncEditorial,appearanceEditor} from '/work/editorial.js';
import {md,CARET} from '/work/markdown.js';
import {request,decorateTabs} from '/work/runtime.js';
import {updateModels,modelActivity,createImage} from '/work/models.js';
import {artifactCard,libraryHTML,libraryItems,taskSummary,BUILTIN_TEMPLATES,templateForm,templateObjective,workflowInput,workflowSections,groceryItemRow,trapModal,mountVoice,artifactURL,approvalDetails,approvalAttributes,wallTimeToUTC} from '/work/product.js';
const $=s=>document.querySelector(s);
let state={settings:{name:'Seek'},tasks:[]},view='chat',selected=null,filter='all',scheduled=null,files=[],previousSignature='',recentSignature='',buddyStateSignature='',externalView='',firstPoll=true,ideasBusy=false,online=true,lookDraft=null,imageMode=false;
const subagentCache=new Map(),subagentFetched=new Map(),subagentPending=new Set();
// Settings is one destination; memory, connections and the report card are tabs inside it.
const SETTINGS_TABS=[['profile','Profile & behavior','user'],['memory','Memory','bookmark'],['connections','Connections','plug'],['alerts','Notifications','bell'],['privacy','Privacy & security','shield'],['computers','Computers','desktop'],['growth','Report card','chart']];
const SETTINGS=new Set(SETTINGS_TABS.map(x=>x[0]));
const VIEWS=['chat','tasks','files','ideas','finance','images','workflows','calendar',...SETTINGS];
const TITLES={tasks:'Tasks',files:'Library',ideas:'Ideas for you',images:'Studio',finance:'Finance',workflows:'Workflows',calendar:'Calendar'};
// Older links and saved state may name views that are now tabs or the inbox panel.
const viewFor=v=>v==='settings'?'profile':VIEWS.includes(v)?v:'chat';
const taskCache=new Map(),drafts=new Map(),featureLoads=new Map();
let uploading=false,submitting=false,submission=null,revision=0,pollTimer=null,polling=false,eventStream=null,searchQuery='',showArchive=false,syncPromise=null;
let libraryQuery='',libraryType='all',libraryDate='all',libraryHits=null,librarySearching=false,libraryTimer=0,librarySequence=0,libraryLimit=100,compared=[],activeWorkflow=null,sourceArtifact=null,workflowItems=null,workflowCpuCatalog=null,workflowBusy=false,workflowError='',workflowCpuError='',groceryRowIndex=0,searchTimer=0,searchSequence=0,panelFocusCleanup=null,menuFocusCleanup=null,panelPinned=false,lastAttention='';
try{panelPinned=localStorage.getItem('seek-panel-pinned')==='true';}catch{}
document.body.classList.toggle('panel-open',panelPinned&&matchMedia('(min-width:1200px)').matches);
try{for(const [id,text]of Object.entries(JSON.parse(sessionStorage.getItem('seek-drafts')||'{}')))drafts.set(id,text);}catch{}
try{submission=JSON.parse(sessionStorage.getItem('seek-submission')||'null');}catch{}
const draftKey=()=>selected||'new';
function saveDraft(){drafts.set(draftKey(),$('#prompt').value);try{sessionStorage.setItem('seek-drafts',JSON.stringify(Object.fromEntries(drafts)));}catch{}}
function restoreDraft(){$('#prompt').value=drafts.get(draftKey())||'';}
async function ensureFeature(name){
  if(!featureLoads.has(name)){const paths={finance:'/work/finance.js',images:'/work/images.js',dreaming:'/work/dreaming.js',growth:'/work/growth.js',calendar:'/work/calendar.js',desktop:'/work/desktop.js'},styles={finance:['/work/finance.css','/work/finance-v2.css'],images:['/work/images.css'],dreaming:['/work/dreaming.css'],growth:['/work/growth.css'],calendar:['/work/calendar.css'],desktop:['/work/desktop.css']};
    for(const href of styles[name]||[])if(!document.querySelector(`link[data-feature-style="${href}"]`)){const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.dataset.featureStyle=href;document.head.insertBefore(link,document.querySelector('link[data-system]'));}
    // A Seek restart (deploy, recovery) can briefly refuse connections. Browsers cache a failed
    // module fetch per URL, so retry with backoff under a fresh URL instead of failing until reload.
    const load=async()=>{let last;for(const [attempt,wait] of [0,1000,3000,6000,12000].entries()){if(wait)await new Promise(r=>setTimeout(r,wait));try{return await import(attempt?`${paths[name]}${paths[name].includes('?')?'&':'?'}retry=${attempt}-${Date.now()}`:paths[name]);}catch(error){last=error;}}throw new Error(`Couldn’t load ${name} after Seek restarted. Check your connection and reload the page.`,{cause:last});};
    featureLoads.set(name,load().catch(error=>{featureLoads.delete(name);throw error;}));
  }return featureLoads.get(name);
}
function renderGrowth(options){void ensureFeature('growth').then(module=>{if(view==='growth')module.renderGrowth(options);}).catch(error=>toast(error.message));}
function renderDreaming(options){void ensureFeature('dreaming').then(module=>{if(view==='memory')module.renderDreaming(options);}).catch(error=>toast(error.message));}
try { const saved=JSON.parse(localStorage.getItem('seek-work-view')||'null'); if(saved&&typeof saved.view==='string'){view=viewFor(saved.view);selected=saved.selected||null;} } catch {}
const labels={queued:'Up next',scheduled:'Scheduled',running:'Working',waiting:'Needs you',attention:'Needs attention',paused:'Paused',stopped:'Stopped',complete:'Done'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=n=>new Date(n).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const current=()=>taskCache.get(selected)||null;
const needsYou=()=>state.tasks.filter(t=>!t.archived&&(t.status==='waiting'||t.status==='attention'||t.handoff||t.approval));
// Icons come from the SVG sprite in work.html.
const icon=(n,c='')=>`<svg class="ic${c?' '+c:''}" aria-hidden="true" focusable="false"><use href="#i-${n}"/></svg>`;
const pill=t=>`<span class="status ${esc(t.status)}">${labels[t.status]||esc(t.status)}</span>`;
let toastTimer;
// Memory that is waiting for the user's OK shows in the inbox; one tap opens it. The count is
// cached so the inbox and its badge render synchronously; it refreshes at most once a minute.
let memoryReview=0,memoryReviewAt=0,memoryReviewBusy=false;
function refreshMemoryReview(force=false){
  if(memoryReviewBusy||!force&&Date.now()-memoryReviewAt<60000)return;memoryReviewBusy=true;
  void api('dreaming').then(d=>{const n=d.counts?.review||0;memoryReviewAt=Date.now();if(n!==memoryReview){memoryReview=n;apSig='';render();}}).catch(()=>{}).finally(()=>{memoryReviewBusy=false;});
}
const memoryInboxCard=()=>memoryReview?`<button type="button" class="memory-inbox" data-view="memory" data-memory-tab="review"><strong>${memoryReview} thing${memoryReview===1?'':'s'} I learned need${memoryReview===1?'s':''} your OK</strong><span>Keep what’s right, fix or forget the rest.</span></button>`:'';
document.addEventListener('click',e=>{const t=e.target.closest('[data-memory-tab]');if(t)window.seekMemoryTab=t.dataset.memoryTab;},true);
// Heads up: things Seek noticed before being asked (dates, unfinished work, pickups).
function headsUpItems(){const now=Date.now();return (state.headsUp||[]).filter(i=>i.status==='open'||(i.status==='snoozed'&&i.snoozeUntil<=now)).sort((a,b)=>(a.kind==='open')-(b.kind==='open')||a.dueAt-b.dueAt);}
function headsUpCard(i){return `<article class="headsup ${esc(i.kind)}" data-headsup-card="${esc(i.id)}"><div class="headsup-top"><span class="headsup-kind">${i.kind==='date'?'Coming up':i.kind==='mention'?'On the calendar':'Unfinished'}</span>${i.preparedTaskId?'<span class="headsup-ready">Draft ready</span>':''}</div><strong>${esc(i.title)}</strong><p>${esc(i.body)}</p><div class="headsup-actions">${(i.actions||[]).map((a,n)=>`<button type="button" class="${n===0?'primary':''}" data-headsup-do="${esc(i.id)}" data-index="${n}">${esc(a.label)}</button>`).join('')}<button type="button" data-headsup="${esc(i.id)}" data-action="snooze">Tomorrow</button><button type="button" data-headsup="${esc(i.id)}" data-action="${i.kind==='date'?'never':'dismiss'}">${i.kind==='date'?'Don’t remind me':'Dismiss'}</button></div></article>`;}
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-headsup-do],[data-headsup]');if(!b)return;
  e.preventDefault();b.disabled=true;
  try{
    const id=b.dataset.headsupDo||b.dataset.headsup,action=b.dataset.headsupDo?'do':b.dataset.action;
    const r=await api('headsup',{id,action,index:Number(b.dataset.index)||0});
    await syncState();previousSignature='';
    if(r.taskId)selectTask(r.taskId);else{render();toast(action==='snooze'?'I’ll bring it back tomorrow morning.':action==='never'?'I won’t remind you about this one again.':action==='dismiss'?'Dismissed.':'Done.');}
  }catch(err){b.disabled=false;toast(err.message);}
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-skill-flag]');if(!b)return;e.preventDefault();b.disabled=true;
  try{await api('growth/skill',{id:b.dataset.skillFlag,action:'flag',taskId:b.dataset.task||null});b.textContent='Retired';b.closest('li')?.classList.add('is-flagged');toast('Thanks — I’ve stopped using that skill.');}catch(err){b.disabled=false;toast(err.message);}
});
// Task memory receipts: "That's wrong" pauses a memory; Undo reverses what a task just learned or forgot.
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-memory-flag],[data-memory-undo]');if(!b)return;
  e.preventDefault();b.disabled=true;
  try{
    if(b.dataset.memoryFlag){await api('dreaming/memory',{id:b.dataset.memoryFlag,action:'flag',taskId:b.dataset.task||null});b.textContent='Paused';b.closest('li')?.classList.add('is-flagged');toast('Paused. It won’t be used again unless you turn it back on in Memory.');}
    else{const action=b.dataset.memoryAction,taskId=current()?.id||null;await api('dreaming/memory',{id:b.dataset.memoryUndo,action,taskId,undo:true});b.closest('[data-noted]')?.remove();toast(action==='forget'?'Undone. I won’t keep that.':'Restored. I’ll use it again.');}
  }catch(err){b.disabled=false;toast(err.message);}
});
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6000);}
window.SeekWorkToast=toast;
async function api(path,body){
  if(path==='state'){await syncState();return state;}
  return request('/work/api/'+path,body);
}
const taskSubmissions=new Map();
async function createTask(values){
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(values)))),x=>x.toString(16).padStart(2,'0')).join('');
  if(taskSubmissions.has(fingerprint))return taskSubmissions.get(fingerprint);
  const key='seek-task-request:'+fingerprint;let requestId;try{requestId=sessionStorage.getItem(key);}catch{}requestId||=crypto.randomUUID();try{sessionStorage.setItem(key,requestId);}catch{}
  const pending=api('task',{...values,requestId}).then(result=>{try{sessionStorage.removeItem(key);}catch{}return result;}).finally(()=>taskSubmissions.delete(fingerprint));taskSubmissions.set(fingerprint,pending);return pending;
}
window.SeekWork={createTask,selectTask:id=>{void syncState().then(()=>selectTask(id));}};
async function loadCurrent(force=false){
  const id=selected;if(!id)return;const summary=state.tasks.find(t=>t.id===id),cached=taskCache.get(id);if(!force&&cached?.version===summary?.version)return;
  const next=await api('task?id='+encodeURIComponent(id));
  if(cached&&cached.messageOffset<next.messageOffset){const keep=cached.messages.slice(0,next.messageOffset-cached.messageOffset);next.messages=keep.concat(next.messages);next.messageOffset=cached.messageOffset;next.nextBefore=cached.nextBefore;}
  taskCache.set(id,next);
}
function syncState(){if(syncPromise)return syncPromise;syncPromise=readState().finally(()=>{syncPromise=null;});return syncPromise;}
async function readState(){
  const next=await api('updates?since='+revision);
  if(!next.unchanged){if(next.patch){const changed=new Map(next.tasks.map(t=>[t.id,t]));state={...state,...(next.settings?{settings:next.settings,ideas:next.ideas,headsUp:next.headsUp}:{}),tasks:state.tasks.filter(t=>!next.removed.includes(t.id)).map(t=>{const value=changed.get(t.id);changed.delete(t.id);return value||t;}).concat([...changed.values()])};}else state=next;revision=next.revision;}
  state.health=next.health;await loadCurrent();return state;
}
let connectionsCache=null,connectionsAt=0,connectionsBusy=false,appSearchResults=null;
const CONNECTIONS_INTRO='Seek uses connected app tools for supported requests and opens the browser when a site needs it.';
async function renderConnections(fresh=false){
  let main=$('#settings-body');if(!main)return;
  if(!connectionsCache&&view==='connections')main.innerHTML=`${settingsIntro('connections',CONNECTIONS_INTRO)}<p class="muted" role="status">Checking connected apps…</p>`;
  if((fresh||Date.now()-connectionsAt>30000)&&!connectionsBusy){
    connectionsBusy=true;
    try{connectionsCache=await api('connections'+(fresh?'?fresh=1':''));connectionsAt=Date.now();}
    catch(e){main=$('#settings-body');if(view==='connections'&&main)main.innerHTML=`${settingsIntro('connections',CONNECTIONS_INTRO)}<p class="section-copy">${esc(e.message)}</p>`;connectionsBusy=false;return;}
    connectionsBusy=false;
  }
  main=$('#settings-body');
  if(view!=='connections'||!connectionsCache||!main)return;
  const c=connectionsCache;
  const signature=JSON.stringify([c,appSearchResults]);
  if(main.dataset.seekConnectionsSig===signature)return;
  main.dataset.seekConnectionsSig=signature;
  const card=(title,item)=>`<div class="file-card"><span class="file-icon">${icon(item.connected||item.ready?'check-circle':'plug')}</span><div><strong>${esc(title)} · ${item.connected?'Connected':item.ready?'Ready':'Setup needed'}</strong><p>${esc(item.detail||'')}</p></div></div>`;
  const others=Object.entries(c.mcp||{}).filter(([name])=>name!=='google').map(([name,item])=>card(name,{connected:true,detail:`${item.tools.length} API tools available.`})).join('');
  const pd=c.pipedream||{configured:false,connected:false,accounts:[],detail:'Set up Pipedream Connect to link more apps.'};
  const accounts=(pd.accounts||[]).map(a=>`<li><div><strong>${esc(a.name)}</strong><span>${esc(a.accountName||a.app)} · ${a.healthy?'Connected':'Needs reconnect'}</span></div><button data-app-disconnect="${esc(a.id)}" data-name="${esc(`${a.name}${a.accountName?` (${a.accountName})`:''}`)}">Disconnect</button></li>`).join('');
  const setup=!pd.configured&&c.canConfigure?`<form id="pd-config" class="connection-form"><h3>Set up Pipedream Connect</h3><p>Enter your Connect project credentials on this PC. They are encrypted for this Windows account and never shown to Seek.</p><label>Client ID<input name="clientId" autocomplete="off" required></label><label>Client secret<input name="clientSecret" type="password" autocomplete="off" required></label><label>Project ID<input name="projectId" placeholder="proj_…" autocomplete="off" required></label><select name="environment" aria-label="Connection environment"><option value="development">Development</option><option value="production">Production</option></select><button class="primary">Save connection</button></form>`:'';
  const catalog=pd.configured?`<form id="pd-search" class="connection-form"><h3>Find an app</h3><p>Search Pipedream’s catalog, then connect an account through its hosted sign-in page.</p><div class="connection-search"><input name="query" aria-label="Find an app" placeholder="Gmail, Slack, Notion, GitHub…" minlength="2" required><button>Search</button><button type="button" data-app-refresh>Refresh accounts</button></div></form>${appSearchResults?`<div class="file-cards">${appSearchResults.apps.map(a=>`<div class="file-card"><span class="file-icon">◎</span><div><strong>${esc(a.name)}</strong><p>${esc(a.description||a.slug)}</p><button data-app-connect="${esc(a.slug)}">Connect account</button></div></div>`).join('')||'<p>No matching apps with actions were found.</p>'}</div>`:''}`:'';
  main.innerHTML=`${settingsIntro('connections',CONNECTIONS_INTRO,`<button data-app-refresh>${icon('reload','ic-sm')} Check connection health</button>`)}<div class="file-cards connections-list">${card('Discord',c.discord)}${card('Pipedream app catalog',{...pd,ready:pd.configured})}${card('Built-in Google connection',c.google)}${card('Plaid Finance',c.finance)}${others}${card('Browser', {connected:c.browser.available,detail:c.browser.detail})}</div>${accounts?`<div class="account-card"><h3>Linked app accounts</h3><ul class="site-list">${accounts}</ul></div>`:''}${setup?`<details class="connection-admin"><summary>Advanced host setup</summary>${setup}</details>`:""}${catalog?`<div class="account-card">${catalog}</div>`:''}${!pd.configured?'<p class="section-copy">Create a Connect project at <a href="https://pipedream.com" target="_blank" rel="noopener noreferrer">Pipedream</a> to unlock the app catalog.</p>':''}`;
  void ensureFeature('calendar').then(()=>window.SeekCalendar?.renderConnection?.(main)).catch(()=>{});
}
document.addEventListener('submit',async e=>{
  if(!['pd-config','pd-search'].includes(e.target.id))return;e.preventDefault();
  const form=e.target,button=form.querySelector('button[type=submit],button.primary,button:not([type])');if(button)button.disabled=true;
  try{
    if(form.id==='pd-config'){
      const fields=Object.fromEntries(new FormData(form));await api('apps/configure',fields);form.reset();connectionsAt=0;await renderConnections();toast('Pipedream project connected. Search for an app to link.');
    }else{
      const query=String(new FormData(form).get('query')||'');appSearchResults=await api('apps/search?q='+encodeURIComponent(query));await renderConnections();
    }
  }catch(err){toast(err.message);}finally{if(button)button.disabled=false;}
});
document.addEventListener('click',async e=>{
  const connect=e.target.closest('[data-app-connect]'),refresh=e.target.closest('[data-app-refresh]'),drop=e.target.closest('[data-app-disconnect]');if(!connect&&!refresh&&!drop)return;
  if(refresh){connectionsAt=0;await renderConnections(true);return;}
  if(drop){
    if(!confirm(`Disconnect ${drop.dataset.name}? Seek will lose access until you connect it again.`))return;
    drop.disabled=true;
    try{const result=await api('apps/disconnect',{accountId:drop.dataset.appDisconnect,confirm:true});connectionsAt=0;await renderConnections(true);toast(`${result.disconnected} disconnected.`);}
    catch(err){drop.disabled=false;toast(err.message);}
    return;
  }
  const popup=window.open('about:blank','_blank');
  if(!popup){toast('Allow popups to connect an app.');return;}
  try{const result=await api('apps/connect-link',{app:connect.dataset.appConnect});popup.location.href=result.url;toast('Finish connecting the account in the new tab, then refresh accounts here.');}
  catch(err){popup.close();toast(err.message);}
});
function linkify(value){return esc(value).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,(_m,label,url)=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);}
function artifactUrl(t,a,preview=false){return `/work/api/artifact?task=${encodeURIComponent(t.id)}&id=${encodeURIComponent(a.id)}${preview?'&preview=1':''}`;}
function artifact(t,a){return artifactCard(t,a);}
function findArtifact(taskId,id){const task=state.tasks.find(t=>t.id===taskId)||taskCache.get(taskId);return {task,item:task?.artifacts?.find(a=>a.id===id)};}
function inspectArtifact(taskId,id){const {task,item}=findArtifact(taskId,id);if(!item)return;$('#preview-title').textContent=item.title;const dialog=$('#artifact-dialog');dialog.querySelector('.artifact-info')?.remove();const info=document.createElement('div');info.className='artifact-info';info.innerHTML=`<span>${esc(item.type||'File')}${item.version?' · Version '+esc(item.version):''}${Number.isFinite(item.bytes)?' · '+esc(item.bytes)+' bytes':''}</span><button data-select="${esc(task.id)}">${esc(task.title)}</button><a href="${artifactUrl(task,item)}" download>Download</a><button data-revise="${esc(item.id)}" data-task="${esc(task.id)}">Request a revision</button>`;dialog.querySelector('.preview-head').after(info);$('#preview-frame').src=artifactUrl(task,item,true);dialog.showModal();}
function reviseArtifact(taskId,id){const {task,item}=findArtifact(taskId,id);if(!item)return;voice?.stop();$('#artifact-dialog').close();saveDraft();selected=null;view='chat';sourceArtifact={taskId,id};renderAttachments();$('#prompt').value=`Revise “${item.title}”: `;saveDraft();previousSignature='';render();$('#prompt').focus();toast('The source file will be included with your next request. Describe the change.');}
function refreshCompare(){const button=$('#compare-files');if(button)button.disabled=compared.length!==2;const status=$('#compare-status');if(status)status.textContent=compared.length?`${compared.length} of 2 outputs selected`:'';}
function compareArtifacts(){if(compared.length!==2)return;const pairs=compared.map(x=>({...findArtifact(x.taskId,x.id),...x}));if(pairs.some(x=>!x.item))return;const dialog=$('#product-dialog');dialog.innerHTML=`<div class="preview-head"><h2>Compare outputs</h2><button data-dialog-close aria-label="Close comparison">✕</button></div><div class="artifact-comparison">${pairs.map(x=>`<section><h3>${esc(x.item.title)}</h3><p>${esc(x.task.title)}${x.item.version?' · Version '+esc(x.item.version):''}</p><iframe title="${esc(x.item.title)} preview" src="${artifactURL(x.taskId,x.id,true)}" sandbox="allow-scripts"></iframe></section>`).join('')}</div>`;dialog.className='compare-dialog';dialog.showModal();}
let workflowPromise=null,workflowCalendarZone='',workflowOpening=false;
async function loadWorkflows(){
  if(workflowBusy)return workflowPromise;if(workflowItems)return;workflowBusy=true;
  workflowPromise=Promise.allSettled([api('templates'),api('workflows')]).then(([prompts,runs])=>{
    workflowError=prompts.status==='rejected'?'Your saved prompts could not be loaded. Try again.':'';
    workflowCpuError=runs.status==='rejected'?'Ready-to-run workflows could not be loaded. Try again.':'';
    const cpu=runs.status==='fulfilled'?runs.value:{items:[]};workflowCalendarZone=cpu.calendarZone||'';
    workflowCpuCatalog=new Map((cpu.items||[]).map(x=>[x.id+'@'+x.version,{...x,state:cpu.enabled===false?'unavailable':x.state}]));
    if(cpu.enabled===false)workflowCpuError='Ready-to-run workflows are currently unavailable. You can still prepare a request in chat.';
    workflowItems=[...(prompts.status==='fulfilled'?prompts.value.items||[]:[]),...(cpu.items||[]).filter(x=>!['calendar_availability','grocery_cart_plan'].includes(x.id)).map(x=>({...x,id:'cpu-'+x.id+'-'+x.version,routine:x.id,permissions:'read',fields:Object.entries(x.input.properties).map(([name,field])=>({name,label:name.replaceAll('_',' '),type:['array','object','json'].includes(field.type)?'textarea':'text',required:(x.input.required||[]).includes(name)})),objective:''}))];
  }).finally(()=>{workflowBusy=false;if(view==='workflows')renderWorkflows();});return workflowPromise;
}
function workflowTemplates(){return [...BUILTIN_TEMPLATES,...(workflowItems||[])].map(t=>t.routine?{...t,state:workflowCpuCatalog?.get(t.routine+'@'+(t.version||1))?.state||'unavailable',version:t.version||1}:t);}
function renderWorkflows(){
  const html=`<section class="page workflows">${pageHead('Workflows','Make repeat tasks easier. Pick a workflow, fill in the details, and keep the result.',`<button data-workflow-build>${icon('plus','ic-sm')} Ask Seek to build one</button>`)}${workflowSections(workflowTemplates(),{loading:workflowItems===null,error:workflowError,cpuError:workflowCpuError})}</section>`;
  const main=$('#main');if(main.dataset.workflowsHtml!==html){main.dataset.workflowsHtml=html;main.innerHTML=html;}void loadWorkflows();
}
function workflowById(id){return workflowTemplates().find(t=>t.id===id);}
async function useWorkflow(id){
  if(workflowOpening)return;workflowOpening=true;
  try{let template=workflowById(id);if(template?.routine){await loadWorkflows();template=workflowById(id);}if(!template)return;if(template.routine&&template.state!=='enabled'){toast('This workflow is unavailable. Open Workflows to review its status.');return;}
    if(template.routine==='calendar_availability'&&!workflowCalendarZone){const calendar=await api('calendar');workflowCalendarZone=calendar.zone;}
    activeWorkflow=template;groceryRowIndex=1;const dialog=$('#product-dialog');dialog.className='workflow-dialog';dialog.setAttribute('aria-labelledby','workflow-dialog-title');dialog.innerHTML=templateForm(template,{zone:workflowCalendarZone||'UTC'});dialog.showModal();
    dialog.querySelector('input,textarea,select')?.focus({preventScroll:true});
  }catch(error){toast(error.message);}finally{workflowOpening=false;}
}
function editWorkflow(template=null,task=null){const dialog=$('#product-dialog');dialog.className='workflow-dialog';dialog.setAttribute('aria-labelledby','workflow-dialog-title');dialog.innerHTML=`<form id="workflow-edit" class="workflow-form" data-id="${esc(template?.id||'')}" data-task="${esc(task?.id||'')}"><h2 id="workflow-dialog-title">${template?'Edit prompt':'Save a prompt'}</h2><p>Keep instructions you use often. Each use opens a request in chat for you to review.</p><label>Name<input name="title" required maxlength="100" placeholder="e.g. My weekly meal plan" value="${esc(template?.title||task?.title||'')}"></label><label>What should Seek do?<textarea name="objective" required maxlength="20000" placeholder="e.g. Plan five dinners for two people, with a grocery list.">${esc(template?.objective||task?.objective||'')}</textarea></label><details><summary>Inputs and allowed work</summary><p class="muted">For a detail that changes each time, write {{topic}} or {{date}} in your instructions. Seek will ask for it when you use this prompt.</p><label>Allowed work<select name="permissions"><option value="read">Read-only</option><option value="draft">Draft or local output</option><option value="approve">External actions need review</option></select></label></details><p id="workflow-form-error" class="workflow-form-error" role="alert" tabindex="-1" hidden></p><div class="dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary">Save prompt</button></div></form>`;dialog.querySelector('[name=permissions]').value=template?.permissions||'draft';dialog.showModal();}
// ── Command palette (Ctrl/⌘ K): search everything, or jump to any place or action ──
let paletteQuery='',paletteResults=null,paletteIndex=0;
const isMac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);
function paletteCommands(){
  const go=(label,hint,ic,dest)=>({group:'Go to',label,hint,icon:ic,attrs:`data-view="${dest}"`});
  const act=(id,label,hint,ic)=>({group:'Actions',label,hint,icon:ic,attrs:`data-cmd="${id}"`});
  return [
    act('new','New chat','Start fresh',  'compose'),
    act('image','Create an image','Qwen Image 2.1 on this PC','image'),
    act('schedule','Schedule a task','Later, every day or every week','clock'),
    act('new-event','New event','On the calendar you share with Seek','calendar'),
    act('new-todo','New to-do','On the list you share with Seek','check-circle'),
    act('attach','Attach files to a request','Up to 5 files','clip'),
    act('browser','Open the browser','See or take over Seek’s browser','globe'),
    act('ideas','Refresh ideas','Fresh suggestions from your history','sparkles'),
    go('Tasks','Everything Seek is working on','tasks','tasks'),
    go('Inbox','Approvals, questions and heads-ups','bell','inbox'),
    go('Calendar','Events and to-dos, synced with Apple','calendar','calendar'),
    go('Library','Files your tasks made','folder','files'),
    go('Studio','Create and browse images','image','images'),
    go('Finance','Accounts, spending and budgets','wallet','finance'),
    go('Workflows','Reusable starting points','template','workflows'),
    go('Ideas for you','Things Seek could take off your plate','sparkles','ideas'),
    ...SETTINGS_TABS.map(([id,label,ic])=>({group:'Settings',label,hint:'Settings',icon:ic,attrs:`data-view="${id}"`})),
    {group:'Settings',label:'Developer view',hint:'The harness, in a new tab',icon:'external',attrs:'data-cmd="developer"'}
  ];
}
const paletteRow=(item,extra='')=>`<button type="button" class="palette-item${extra}" role="option" ${item.attrs}>${icon(item.icon)}<span><strong>${esc(item.label)}</strong>${item.sub?`<span>${esc(item.sub)}</span>`:''}</span>${item.hint?`<small>${esc(item.hint)}</small>`:''}</button>`;
function renderPalette(){
  const host=$('#workspace-search-results');if(!host)return;
  const q=paletteQuery.trim().toLowerCase(),words=q.split(/\s+/).filter(Boolean);
  const hit=text=>words.every(w=>text.toLowerCase().includes(w));
  const groups=[];
  if(!q){
    const recent=[...state.tasks].filter(t=>!t.archived).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,5);
    if(recent.length)groups.push(['Recent',recent.map(t=>paletteRow({label:t.title,sub:t.activity||labels[t.status]||'',icon:'chat',attrs:`data-select="${esc(t.id)}"`}))]);
  }
  const commands=paletteCommands().filter(c=>!q||hit(`${c.label} ${c.hint||''} ${c.group}`));
  for(const name of ['Actions','Go to','Settings']){const rows=commands.filter(c=>c.group===name);if(rows.length)groups.push([name,rows.slice(0,q?5:12).map(c=>paletteRow(c))]);}
  if(q.length>=2){
    const r=paletteResults&&paletteResults.query===paletteQuery.trim()?paletteResults:null;
    if(!r)groups.push(['Conversations, files and memory',['<p class="palette-empty" role="status">Searching…</p>']]);
    else if(r.error)groups.push(['Conversations, files and memory',[`<p class="palette-empty" role="status">${esc(r.error)}</p>`]]);
    else{
      if(r.tasks.length)groups.push(['Conversations',r.tasks.map(t=>paletteRow({label:t.title,sub:t.excerpt||t.activity||labels[t.status]||'Conversation',icon:'chat',attrs:`data-select="${esc(t.id)}"`},' search-hit'))]);
      if(r.artifacts.length)groups.push(['Files',r.artifacts.map(a=>paletteRow({label:a.title,sub:'From '+(a.taskTitle||'a task'),icon:'doc',attrs:`data-preview="${esc(a.id)}" data-task="${esc(a.taskId)}"`},' search-hit'))]);
      if(r.memories.length)groups.push(['Memory',r.memories.map(m=>paletteRow({label:m.text||m.title,sub:'Something Seek remembers',icon:'bookmark',attrs:'data-view="memory"'},' search-hit'))]);
      if(!r.tasks.length&&!r.artifacts.length&&!r.memories.length&&!commands.length)groups.push(['',['<p class="palette-empty">No matches. Try another word.</p>']]);
    }
  }else if(q&&!commands.length)groups.push(['',['<p class="palette-empty">Keep typing to search your chats, files and memory.</p>']]);
  host.innerHTML=groups.map(([name,rows])=>`${name?`<div class="palette-group" role="presentation">${esc(name)}</div>`:''}${rows.join('')}`).join('');
  paletteIndex=0;paletteMark();
}
function paletteMark(){const items=[...document.querySelectorAll('#workspace-search-results .palette-item')];if(!items.length)$('#workspace-query')?.removeAttribute('aria-activedescendant');items.forEach((el,i)=>{el.id='palette-option-'+i;const on=i===paletteIndex;el.classList.toggle('is-active',on);el.setAttribute('aria-selected',String(on));if(on){el.scrollIntoView({block:'nearest'});$('#workspace-query')?.setAttribute('aria-activedescendant',el.id||'');}});}
function openPalette(){setMenu(false);const dialog=$('#search-dialog');if(!dialog.open)dialog.showModal();const input=$('#workspace-query');input.value='';paletteQuery='';paletteResults=null;renderPalette();input.focus();}
async function runWorkspaceSearch(query){const sequence=++searchSequence,q=query.trim();if(q.length<2)return;try{const result=await api('search?q='+encodeURIComponent(q));if(sequence!==searchSequence)return;paletteResults={query:q,tasks:result.tasks||[],artifacts:result.artifacts||[],memories:result.memories||[]};}catch(error){if(sequence!==searchSequence)return;paletteResults={query:q,error:error.message,tasks:[],artifacts:[],memories:[]};}if($('#search-dialog').open){const keep=paletteIndex;renderPalette();paletteIndex=Math.min(keep,document.querySelectorAll('#workspace-search-results .palette-item').length-1);paletteMark();}}
function runCommand(id){
  if(id==='new')newChat();
  else if(id==='image'){newChat();setImageMode(true);}
  else if(id==='schedule'){newChat();openSchedule();}
  else if(id==='attach'){if(view!=='chat')navigate('chat');$('#file-input').click();}
  else if(id==='browser')window.SeekBrowser?.open();
  else if(id==='ideas'){if(view!=='chat'||selected)newChat();void refreshIdeas();}
  else if(id==='developer')window.open('/','_blank','noopener');
  else if(id==='new-event'||id==='new-todo'){navigate('calendar');void ensureFeature('calendar').then(()=>window.SeekCalendar?.openEditor(id==='new-todo'?'todo':'event')).catch(error=>toast(error.message));}
}
function selectTask(id){voice?.stop();setMenu(false);history.pushState({view:"chat",selected:id},"",location.pathname+"?task="+encodeURIComponent(id));saveDraft();selected=id;sourceArtifact=null;restoreDraft();view='chat';previousSignature='';scheduled=null;imageMode=false;files=[];renderAttachments();lookDraft=null;if(!panelPinned||!matchMedia("(min-width:1200px)").matches)closePanel();render();void loadCurrent(true).then(()=>{previousSignature='';render();}).catch(error=>toast(error.message));}
function navigate(next){
  // The inbox is a panel beside your work, not a page.
  if(next==='inbox'){if(document.body.classList.contains('panel-open')&&apTab==='approvals'&&!matchMedia('(min-width:1200px)').matches)closePanel();else openPanel('approvals');return;}
  next=viewFor(next);voice?.stop();setMenu(false);closeMenus();if(next!==view||next!=='chat')history.pushState({view:next,selected},"",location.pathname+(next==='chat'?(selected?'?task='+encodeURIComponent(selected):''):'?view='+encodeURIComponent(next)));view=next;imageMode=false;previousSignature='';lookDraft=null;if(!panelPinned||!matchMedia('(min-width:1200px)').matches)closePanel();render();
}
function newChat(){voice?.stop();setMenu(false);closeMenus();saveDraft();selected=null;restoreDraft();view='chat';lookDraft=null;sourceArtifact=null;imageMode=false;if(!panelPinned||!matchMedia('(min-width:1200px)').matches)closePanel();files=[];scheduled=null;renderAttachments();previousSignature='';history.pushState({view:'chat',selected:null},'',location.pathname);render();$('#prompt').focus({preventScroll:true});}
function setImageMode(on){if(selected)return;imageMode=on;scheduled=null;files=[];renderAttachments();render();$('#prompt').focus({preventScroll:true});}
function openSchedule(){if(!$('#schedule-zone').value)$('#schedule-zone').value=Intl.DateTimeFormat().resolvedOptions().timeZone;$('#schedule-dialog').showModal();}
async function refreshIdeas(){if(ideasBusy)return;ideasBusy=true;previousSignature='';render();try{await api('ideas/refresh',{});state=await api('state');}catch(err){toast(err.message);}finally{ideasBusy=false;previousSignature='';render();}}
function syncComposerChips(){
  const chip=$('#schedule-chip'),image=$('#image-chip');
  if(chip){chip.hidden=!scheduled||!!selected;if(!scheduled)$('#schedule-summary').textContent='';}
  if(image)image.hidden=!imageMode||!!selected;
}
// Pop-up menus (composer +, conversation options): one open at a time, Escape or a click outside closes.
function closeMenus(except){for(const menu of document.querySelectorAll('.menu:not([hidden])'))if(menu!==except){menu.hidden=true;menu.parentElement.querySelector('[aria-haspopup=menu]')?.setAttribute('aria-expanded','false');}}
document.addEventListener('click',e=>{
  const toggle=e.target.closest('[aria-haspopup=menu]');
  if(toggle){const menu=toggle.parentElement.querySelector('.menu');if(!menu)return;const open=menu.hidden;closeMenus(menu);menu.hidden=!open;toggle.setAttribute('aria-expanded',String(open));if(open)menu.querySelector('button:not([hidden])')?.focus({preventScroll:true});return;}
  if(!e.target.closest('.menu')||e.target.closest('.menu button'))closeMenus();
},true);
document.addEventListener('keydown',e=>{
  const menu=e.target.closest?.('.menu');
  if(menu&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){const items=[...menu.querySelectorAll('button:not([hidden])')],i=items.indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();e.preventDefault();return;}
  if(e.key==='Escape'&&document.querySelector('.menu:not([hidden])')){const open=document.querySelector('.menu:not([hidden])'),toggle=open.parentElement.querySelector('[aria-haspopup=menu]');closeMenus();toggle?.focus();e.preventDefault();e.stopPropagation();return;}
  const mod=e.metaKey||e.ctrlKey;if(!mod||e.altKey)return;const key=e.key.toLowerCase();
  if(key==='k'&&!e.shiftKey){e.preventDefault();const dialog=$('#search-dialog');if(dialog.open)dialog.close();else openPalette();}
  else if(key==='o'&&e.shiftKey){e.preventDefault();document.querySelectorAll('dialog[open]').forEach(d=>d.close());newChat();}
},true);
function setMenu(open){
  const nav=$('#workspace-nav'),small=matchMedia('(max-width:640px)').matches;open=!!open&&small;
  if(open===document.body.classList.contains('menu-open'))return;
  if(open){closePanel();document.body.classList.add('menu-open');nav.setAttribute('role','dialog');nav.setAttribute('aria-modal','true');menuFocusCleanup=trapModal(nav,{returnTo:$('#menu'),onClose:()=>setMenu(false)});$('#close-menu').focus();}
  else{document.body.classList.remove('menu-open');nav.removeAttribute('role');nav.removeAttribute('aria-modal');menuFocusCleanup?.();menuFocusCleanup=null;}
  $('#menu').setAttribute('aria-expanded',String(open));$('#mobile-more').setAttribute('aria-expanded',String(open));
}
// The agent panel is docked on wide screens; below that the buddy opens it as a sheet (like tapping Muse's avatar).
function openPanel(tab){if(tab)apTab=tab;setMenu(false);closeMenus();const opener=document.activeElement?.closest?.('[aria-controls="agent-panel"]')||$('#buddy-top');document.body.classList.add('panel-open');apSig='';renderPanel();refreshMemoryReview();const panel=$('#agent-panel');if(!matchMedia('(min-width:1200px)').matches){panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panelFocusCleanup?.();panelFocusCleanup=trapModal(panel,{returnTo:opener,onClose:closePanel});$('#ap-close').focus();}syncPanelControls(true);}
function closePanel(){document.body.classList.remove('panel-open');panelFocusCleanup?.();panelFocusCleanup=null;$('#agent-panel').removeAttribute('role');$('#agent-panel').removeAttribute('aria-modal');syncPanelControls(false);}
function syncPanelControls(open){for(const el of document.querySelectorAll('[aria-controls="agent-panel"]'))el.setAttribute('aria-expanded',String(open));}

// New replies are written out while the buddy types them.
let typing=null,typeTimer=0;const seenMsgs=new Map();
function watchMessages(t){
  if(!t)return;
  const n=t.totalMessages??t.messages.length,prev=seenMsgs.get(t.id);seenMsgs.set(t.id,n);
  if(prev!==undefined&&n>prev&&t.messages.at(-1)?.role==='assistant'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)window.SeekBuddy?.hold('type',600);
}

function captureMainView(main){
  const rect=main.getBoundingClientRect(),atBottom=main.scrollHeight-main.scrollTop-main.clientHeight<120;
  const anchorSelector='[data-msg],.plan,.ask-card,.browser-card,.file-cards,.batch-card,.subagent-progress,details';
  let anchor=null;
  if(!atBottom){
    const hit=document.elementFromPoint(rect.left+Math.min(24,rect.width/2),Math.max(rect.top+12,0));
    anchor=hit?.closest(anchorSelector);
    if(!anchor||!main.contains(anchor))anchor=[...main.querySelectorAll(anchorSelector)].find(el=>{const r=el.getBoundingClientRect();return r.bottom>rect.top&&r.top<rect.bottom;})||null;
  }
  const anchorState=anchor?anchor.dataset.msg?{kind:'msg',key:anchor.dataset.msg,offset:anchor.getBoundingClientRect().top-rect.top}:
    anchor.matches('details')?{kind:'details',index:[...main.querySelectorAll('details')].indexOf(anchor),offset:anchor.getBoundingClientRect().top-rect.top}:
    {kind:'class',key:[...anchor.classList].find(c=>['plan','ask-card','browser-card','file-cards','batch-card','subagent-progress'].includes(c)),index:[...main.querySelectorAll(`.${[...anchor.classList].find(c=>['plan','ask-card','browser-card','file-cards','batch-card','subagent-progress'].includes(c))||'__none__'}`)].indexOf(anchor),offset:anchor.getBoundingClientRect().top-rect.top}:null;
  const controls=[...main.querySelectorAll('input,textarea,select')];
  const controlState=controls.map((el,index)=>({index,id:el.id,tag:el.tagName,value:el.value,checked:'checked'in el?el.checked:undefined,selected:el.tagName==='SELECT'?[...el.selectedOptions].map(o=>o.value):undefined,start:typeof el.selectionStart==='number'?el.selectionStart:null,end:typeof el.selectionEnd==='number'?el.selectionEnd:null}));
  const focusables=[...main.querySelectorAll('button,input,textarea,select,summary,[tabindex]')],active=document.activeElement;
  return {atBottom,scrollTop:main.scrollTop,anchor:anchorState,controlState,focusIndex:focusables.indexOf(active),openDetails:[...main.querySelectorAll('details')].map(el=>el.open)};
}

function restoreMainView(main,saved){
  for(const item of saved.controlState){
    const controls=[...main.querySelectorAll('input,textarea,select')],el=item.id?main.querySelector(`#${CSS.escape(item.id)}`):controls[item.index];
    if(!el||el.tagName!==item.tag)continue;
    if(item.tag==='SELECT'&&item.selected){for(const option of el.options)option.selected=item.selected.includes(option.value);}
    else if(item.tag==='INPUT'&&['checkbox','radio'].includes(el.type))el.checked=item.checked;
    else if(item.tag!=='INPUT'||el.type!=='file')el.value=item.value;
    if(item.start!==null&&typeof el.setSelectionRange==='function')try{el.setSelectionRange(item.start,item.end);}catch{}
  }
  [...main.querySelectorAll('details')].forEach((el,i)=>{if(saved.openDetails[i]!==undefined)el.open=saved.openDetails[i];});
  const rect=main.getBoundingClientRect();let restored=false;
  if(!saved.atBottom&&saved.anchor){
    const a=saved.anchor;let el=null;
    if(a.kind==='msg')el=[...main.querySelectorAll('[data-msg]')].find(node=>node.dataset.msg===a.key);
    else if(a.kind==='details')el=main.querySelectorAll('details')[a.index]||null;
    else if(a.kind==='class')el=main.querySelectorAll(`.${CSS.escape(a.key)}`)[a.index]||null;
    if(el){main.scrollTop+=el.getBoundingClientRect().top-rect.top-a.offset;restored=true;}
  }
  if(saved.atBottom)main.scrollTop=main.scrollHeight;else if(!restored)main.scrollTop=saved.scrollTop;
  if(saved.focusIndex>=0){const focusable=[...main.querySelectorAll('button,input,textarea,select,summary,[tabindex]')][saved.focusIndex];focusable?.focus({preventScroll:true});}
}

function render(){
  updateModels(state.health?.models);
  try { localStorage.setItem('seek-work-view',JSON.stringify({view,selected})); } catch {}
  const t=current(),waiting=needsYou().length,home=view==='chat'&&!selected,main=$('#main');
  syncEditorial({view,task:t});
  // The composer only lives inside the home page; every other view gets it back at the bottom.
  if(!home)parkComposer();
  if(view==='chat'&&t?.sessionId)void refreshSubagents(t);
  document.querySelectorAll('[data-agent-name]').forEach(e=>e.textContent=state.settings.name);document.title=`${waiting?`(${waiting}) `:''}${state.settings.name} · Work`;
  document.body.classList.toggle('has-hero',home);
  document.body.dataset.view=SETTINGS.has(view)?'settings':view;
  if(view==='chat')watchMessages(t);
  window.SeekBuddy?.setLook(lookDraft||state.settings.look);
  const buddyKey=JSON.stringify([online,state.tasks.map(t=>[t.id,t.status])]);
  if(buddyKey!==buddyStateSignature){buddyStateSignature=buddyKey;window.SeekBuddy?.update(state,{online});}
  document.querySelectorAll('nav [data-view]').forEach(b=>{const v=b.dataset.view,active=v===view||v==='settings'&&SETTINGS.has(view);b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('#active-count').textContent=state.tasks.filter(t=>['running','waiting','queued'].includes(t.status)).length||'';
  // Red counts are for things blocked on you; a quiet dot means heads-ups or memory to review.
  const soft=!waiting&&(headsUpItems().length>0||memoryReview>0||(window.SeekCalendar?.reminders?.length||0)>0);
  for(const id of ['#inbox-count','#bb-count','#ap-count','#buddy-count']){const el=$(id);if(!el)continue;el.textContent=waiting||'';if(id==='#inbox-count'||id==='#bb-count')el.toggleAttribute('data-soft',soft);}
  const recent=[...state.tasks].filter(t=>!t.archived).sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||(b.updatedAt||0)-(a.updatedAt||0)).slice(0,30),recentKey=JSON.stringify([selected,recent.map(t=>[t.id,t.title,t.status,t.pinned])]);
  if(recentKey!==recentSignature){recentSignature=recentKey;const row=t=>`<button data-select="${t.id}" class="${selected===t.id?'selected':''}" title="${esc(t.title)}">${t.status==='running'?'<i class="st run"></i>':t.status==='waiting'?'<i class="st wait"></i>':''}<span>${esc(t.title)}</span>${t.pinned?icon('star','ic-pinned'):''}</button>`,pinned=recent.filter(t=>t.pinned),rest=recent.filter(t=>!t.pinned);$('#recent').innerHTML=(pinned.length?`<div class="recent-label">Pinned</div>${pinned.map(row).join('')}`:'')+`<div class="recent-label">Recent</div>${rest.map(row).join('')||'<p class="muted" style="margin:4px 10px">Your conversations will show up here.</p>'}<button class="see-all" data-view="tasks"><span>All tasks</span>${icon('arrow-right')}</button>`;}
  $('#composer-area').hidden=view!=='chat';
  $('#page-title').textContent=view==='chat'?(t?.title||(selected?'Loading…':state.settings.name)):SETTINGS.has(view)?'Settings':TITLES[view]||'';
  $('#page-subtitle').textContent=view==='chat'&&t?(t.activity||''):'';
  $('#prompt').placeholder=t?'Add a detail, answer a question, or steer the task…':imageMode?'Describe the image you want to create…':'Tell me what you want to get done…';
  $('#mode').closest('.mode-pill').hidden=!!t||imageMode;$('#schedule').hidden=!!t||imageMode;$('#attach').hidden=imageMode;$('#image-mode').hidden=!!t||imageMode;$('#workflow-open').hidden=imageMode;
  syncComposerChips();
  $('#composer-hint').textContent=imageMode&&!t?'Image mode uses Qwen Image 2.1 on this PC. You can refine the result in Studio.':'';
  const attention=needsYou().map(x=>x.id+':'+x.status+':'+(x.approval?.at||x.question?.text||'')).join('|');if(attention&&attention!==lastAttention&&matchMedia('(min-width:1200px)').matches)openPanel('approvals');lastAttention=attention;
  renderPanel();
  // A view switch never inherits the previous view's form state or scroll position.
  const key=view+'|'+(view==='chat'?selected||'home':''),fresh=main.dataset.renderKey!==key;
  if(fresh){main.dataset.renderKey=key;delete main.dataset.workflowsHtml;if(!SETTINGS.has(view))document.querySelector('#settings-body')&&(main.innerHTML='');}
  if(SETTINGS.has(view)){externalView='';renderSettings();return;}
  if(view==='workflows'){externalView='';renderWorkflows();if(fresh){main.scrollTop=0;enterView(main);}return;}
  if(view==='finance'||view==='images'||view==='calendar'){if(externalView!==view){const next=view;externalView=next;main.innerHTML='<section class="memory" role="status">Loading…</section>';main.scrollTop=0;void ensureFeature(next).then(()=>{if(view===next)(next==='finance'?window.SeekFinance:next==='images'?window.SeekImages:window.SeekCalendar)?.activate();}).catch(error=>{externalView='';toast(error.message);});}return;}
  externalView='';
  const taskViewKey=view==='tasks'?state.tasks.map(x=>[x.id,x.title,x.status,x.archived,x.activity,x.updatedAt,x.runAt,x.repeatHours,x.question?.text,x.approval?.label,x.handoff?.message,(x.artifacts||[]).map(a=>[a.id,a.title,a.at])]):null;
  const chatKey=t?[editing?.key,t.id,t.title,t.status,t.startedAt,t.completedAt,t.archived,t.pinned,t.project,t.progress,t.contextUsed,t.learned,t.resultEvidence,t.deliveries,t.deliveryUncertain,t.messageOffset,t.nextBefore,t.activity,t.error,t.messages,t.plan,t.artifacts,t.suggestions,t.question,t.nativeRequest,t.approval,t.handoff,t.batch,t.events,t.browserAt,t.usesBrowser,subagentCache.get(t.id)||null]:[state.settings.name,state.settings.look,state.ideas,state.headsUp,ideasBusy,wideHome(),state.tasks.map(x=>[x.id,x.title,x.status,x.activity,x.updatedAt,x.archived,x.artifacts?.length])];
  const signature=JSON.stringify(view==='chat'?[view,selected,chatKey]:view==='ideas'?[view,state.ideas,ideasBusy]:view==='tasks'?[view,filter,searchQuery,showArchive,taskViewKey,Math.floor(Date.now()/60000)]:view==='files'?[view,libraryQuery,libraryType,libraryDate,libraryHits,librarySearching,libraryLimit,state.tasks.map(x=>[x.id,x.title,x.artifacts])]:[view]);
  const browserTask=view==='chat'?t:null;
  // Keep an open conversation menu steady while the task updates; it renders once the menu closes.
  if(signature===previousSignature||!fresh&&main.querySelector('.menu:not([hidden])')){window.SeekBrowser?.refresh(browserTask,state.settings.name);return;}previousSignature=signature;
  const mainView=fresh||home?null:captureMainView(main);
  if(view==='chat'){if(t)main.innerHTML=conversation(t);else if(selected)main.innerHTML='<section class="memory" role="status">Loading conversation…</section>';else renderHome(main);}
  if(view==='tasks')main.innerHTML=taskBoard();
  if(view==='ideas')main.innerHTML=ideasView();
  if(view==='files'){main.innerHTML=libraryHTML(state.tasks,{query:libraryQuery,type:libraryType,date:libraryDate,contentHits:libraryHits,searching:librarySearching,limit:libraryLimit});for(const box of main.querySelectorAll('[data-compare]'))box.checked=compared.some(x=>x.taskId===box.dataset.task&&x.id===box.dataset.compare);refreshCompare();}
  if(mainView)restoreMainView(main,mainView);else if(fresh){main.scrollTop=view==='chat'&&selected?main.scrollHeight:0;enterView(main);}
  requestAnimationFrame(()=>{for(const bar of document.querySelectorAll('.batch-bar i[data-to]'))bar.style.width=bar.dataset.to+'%';});
  window.SeekBrowser?.refresh(browserTask,state.settings.name);
  decorateTabs();
}
// New views ease in once; re-renders of the same view don't replay it.
function enterView(main){const first=main.firstElementChild;if(!first||matchMedia('(prefers-reduced-motion: reduce)').matches)return;first.classList.remove('view-enter');void first.offsetWidth;first.classList.add('view-enter');}

// ── Home: greeting, the composer (centered on wide screens), heads-ups, ideas and workflows ──
const wideHome=()=>matchMedia('(min-width:900px)').matches;
function moveComposer(target){const area=$('#composer-area'),prompt=$('#prompt'),focused=document.activeElement===prompt,start=prompt.selectionStart,end=prompt.selectionEnd;target.append(area);if(focused){prompt.focus({preventScroll:true});try{prompt.setSelectionRange(start,end);}catch{}}}
function parkComposer(){const area=$('#composer-area'),dock=document.querySelector('.workspace');if(area&&dock&&area.parentElement!==dock)moveComposer(dock);}
function placeComposer(){const slot=$('#composer-slot');if(slot&&view==='chat'&&!selected){if($('#composer-area').parentElement!==slot)moveComposer(slot);}else parkComposer();}
const DEFAULT_IDEAS=[['Research something deeply','A clear answer, with sources','search','Research a topic for me and create a concise, sourced report. Ask me what topic I have in mind.'],['Make a plan I can use','Turn an idea into next steps','sparkles','Help me plan a trip, compare options and make an itinerary. Ask me for my destination, dates and budget.'],['Make sense of my files','Find the details that matter','folder','Analyze the files I attach and create a useful summary with the key findings. Ask for the files if none are attached.']];
function homeCards(){
  const items=headsUpItems(),ideas=(state.ideas?.items||[]).slice(0,3);
  const cards=ideas.length?ideas.map(i=>`<button class="idea" data-idea="${esc(i.request)}"><i>${icon('sparkles')}</i>${esc(i.title)}<small>${esc(i.why)}</small></button>`).join(''):DEFAULT_IDEAS.map(([title,why,ic,request])=>`<button class="idea" data-idea="${esc(request)}"><i>${icon(ic)}</i>${esc(title)}<small>${esc(why)}</small></button>`).join('');
  const headsUp=items.length?`<section class="home-section"><div class="home-section-head"><h3>Heads up</h3>${items.length>2?`<button class="link-btn" data-view="inbox">All ${items.length} in your inbox${icon('arrow-right')}</button>`:''}</div><div class="headsup-list">${items.slice(0,2).map(headsUpCard).join('')}</div></section>`:'';
  return `<section class="home-section home-today" id="home-today" hidden></section>${headsUp}${recentWork(state.tasks)}<section class="home-section"><div class="home-section-head"><h3>Ideas for you</h3><div><button class="link-btn" data-ideas="refresh" ${ideasBusy?'disabled':''}>${icon('reload')}${ideasBusy?'Thinking…':'Refresh'}</button><button class="link-btn" data-view="ideas">See all${icon('arrow-right')}</button></div></div><div class="ideas">${cards}</div></section><section class="home-section"><div class="home-section-head"><h3>Start from a workflow</h3><button class="link-btn" data-view="workflows">All workflows${icon('arrow-right')}</button></div><div class="workflow-chips">${BUILTIN_TEMPLATES.map(w=>`<button data-workflow="${esc(w.id)}">${icon('template')}${esc(w.title)}</button>`).join('')}</div></section>`;
}
function renderHome(main){
  let home=main.querySelector(':scope>.welcome');
  if(!home){parkComposer();main.innerHTML=`<section class="welcome">${homeGreeting()}<div class="composer-slot" id="composer-slot"></div><div class="home-cards"></div></section>`;home=main.querySelector('.welcome');}
  home.querySelector('.home-cards').innerHTML=homeCards();window.SeekCalendar?.renderToday?.();
  placeComposer();
}

// The thread runs in the order things happened: requests and replies, the browser where
// it was used, files where they were made. Live status and next steps stay at the end.
const seenItems=new Map();
const BROWSER_EVENT=/browser|a page|the page|form|option|human check|sign in|approval/i,FILE_EVENT=/creating a file|updating a file/i;
// Task-local file links in replies resolve only to this task's recorded artifacts (latest version).
const resolvers=new Map();
const normalPath=value=>String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/+/g,'/').toLowerCase();
function fileResolver(t){
  const cacheKey=JSON.stringify([t.id,t.cwd,(t.artifacts||[]).map(a=>[a.id,a.path,a.at])]);if(resolvers.has(cacheKey))return resolvers.get(cacheKey);if(resolvers.size>50)resolvers.clear();
  const exact=new Map(),base=new Map(),root=normalPath(t.cwd).replace(/\/$/,'');
  for(const a of [...(t.artifacts||[])].sort((x,y)=>(x.at||0)-(y.at||0))){const file={url:artifactURL(t.id,a.id),preview:artifactURL(t.id,a.id,true)};for(const key of [a.path,a.originalPath].filter(Boolean)){exact.set(normalPath(key),file);base.set(normalPath(key).split('/').pop(),file);}if(a.title)base.set(normalPath(a.title),file);}
  const resolve=target=>{let key=normalPath(decodeURI(String(target).split(/[?#]/)[0]));if(root&&key.startsWith(root+'/'))key=key.slice(root.length+1);if(/^[a-z][a-z0-9+.-]*:/.test(key)||key.startsWith('/')||key.split('/').includes('..'))return null;return exact.get(key)||(!key.includes('/')?base.get(key):null)||null;};
  const safe=target=>{try{return resolve(target);}catch{return null;}};
  resolvers.set(cacheKey,safe);return safe;
}
function bubble(t,m,i){
  const key=t.id+':'+i,live=typing?.key===key,mine=m.role==='user';
  const files={resolveFile:fileResolver(t)},text=mine?linkify(m.text):live?md(m.text.slice(0,typing.shown)+CARET,files).replace(CARET,'<span class="caret"></span>'):md(m.text,files);
  if(mine)return `<div class="bubble user" data-msg="${key}">${editing?.key===key?editor(i):`<div class="msg-text">${text}</div><div class="msg-actions"><button data-edit-message="${i}" aria-label="Edit this request in a new branch" title="Edit in a new branch">${icon('edit')}Edit</button><button data-retry-message="${i}" aria-label="Retry from this request in a new branch" title="Retry from here in a new branch">${icon('reload')}Retry</button></div>`}</div>`;
  return `<div class="bubble assistant" data-msg="${key}"><div class="speaker"><span class="buddy" data-buddy="face"></span>${esc(state.settings.name)}</div><div class="msg-text md">${text}</div><div class="msg-tools"><button class="copy-answer" data-copy-message="${i}" aria-label="Copy answer">${icon('copy')}Copy</button></div></div>`;
}
// Edit/Retry branch into a new conversation; the original stays exactly as it was.
let editing=null;
function editor(i){return `<form class="msg-edit" data-edit-form="${i}"><textarea id="msg-edit-${i}" rows="3" maxlength="20000" aria-label="Edit your request">${esc(editing.text)}</textarea><p class="muted">Sends as a new conversation that continues from just before this request. This conversation is kept as it is.</p><div class="msg-edit-actions"><button type="button" data-edit-cancel>Cancel</button><button class="primary" type="submit">Send as new branch</button></div></form>`;}
function branchBanner(t){if(!t.branchFrom)return '';const b=t.branchFrom;return `<div class="branch-note">${b.edited?'Edited':'Retried'} from <button data-select="${esc(b.taskId)}">${esc(b.title||'an earlier conversation')}</button> · continues from just before that request</div>`;}
async function branchFrom(t,index,text){const objective=String(text||'').trim();if(!objective){toast('Write a request first.');return;}const source=t.messages[index-(t.messageOffset||0)];const next=await createTask({objective,mode:t.mode==='chat'?'chat':'task',branchFrom:{taskId:t.id,messageIndex:index},...(t.project?{project:t.project}:{})});editing=null;state=await api('state');selectTask(next.id);toast(source&&source.text.trim()===objective?'Retrying in a new branch.':'Sent as a new branch.');}
function thread(t){
  const events=t.events||[],asked=t.messages.findLast(m=>m.role==='user')?.time||t.createdAt||0;
  // Older tasks have no timestamps for the browser or files, so read them off the activity log.
  const browserEvents=events.filter(e=>BROWSER_EVENT.test(e.text)),fileEvent=events.findLast(e=>FILE_EVENT.test(e.text));
  const items=t.messages.map((m,i)=>({key:'m'+(i+(t.messageOffset||0)),at:m.time||0,rank:0,role:m.role,html:bubble(t,m,i+(t.messageOffset||0))}));
  if(t.plan?.length)items.push({key:'plan',at:asked,rank:1,html:`<div class="plan"><div class="plan-title">Plan</div><ol>${t.plan.map(p=>`<li class="${esc(p.status)}"><span>${icon(p.status==='done'?'check-circle':p.status==='working'?'circle-dot':'circle-dash')}</span>${esc(p.title)}</li>`).join('')}</ol></div>`});
  const card=window.SeekBrowser?.card(t);
  if(card)items.push({key:'browser',at:t.approval?.at||t.handoff?.at||t.browserAt||(browserEvents.find(e=>e.time>=asked)||browserEvents.at(-1))?.time||asked,rank:2,html:card});
  for(const a of t.artifacts||[])items.push({key:'f'+a.id,at:a.at||fileEvent?.time||asked,rank:3,html:`<div class="file-cards">${artifact(t,a)}</div>`});
  // Items that arrive while you watch ease in; what was already on screen doesn't replay on re-render.
  const seen=seenItems.get(t.id);seenItems.set(t.id,new Set(items.map(x=>x.key)));
  // Consecutive replies read as one turn: only the first shows the speaker.
  const ordered=items.sort((a,b)=>a.at-b.at||a.rank-b.rank);ordered.forEach((x,i)=>{if(x.role==='assistant'&&ordered[i-1]?.role==='assistant')x.html=x.html.replace('class="bubble assistant"','class="bubble assistant cont"');});
  return (t.nextBefore?'<button data-older>Load earlier messages</button>':'')+ordered.map(x=>seen&&!seen.has(x.key)?`<div class="enter">${x.html}</div>`:x.html).join('');
}
// A fast-lane batch (many pages in parallel tabs): progress bar, counts, time left, latest items.
const barMemo=new Map();
const etaText=ms=>ms<60000?`${Math.max(1,Math.ceil(ms/1000))} s`:`${Math.round(ms/60000)} min`;
function batchRow(t,b){
  const pct=b.total?Math.round(b.done/b.total*100):0,from=barMemo.get(b.id)??0;barMemo.set(b.id,pct);
  const noun=b.kind==='receipts'?'verified':b.kind==='links'?'found':'read';
  return `<div class="typing-row"><span class="buddy" data-buddy="inline" data-task="${t.id}"></span><div class="batch-card"><div class="batch-head"><strong>${esc(b.label)}</strong><span>${b.kind==='links'?`page ${b.done}`:`${b.done} of ${b.total}`}</span></div>${b.kind==='links'?'':`<div class="batch-bar"><i style="width:${from}%" data-to="${pct}"></i></div>`}<div class="batch-meta"><span>${icon('pulse','ic-sm')}${b.tabs} tab${b.tabs===1?'':'s'}${b.tabs>1?' in parallel':''}</span>${b.ok?`<span class="ok">${b.ok} ${noun}</span>`:''}${b.review?`<span class="warn">${b.review} to review</span>`:''}${b.failed?`<span class="bad">${b.failed} failed</span>`:''}${b.etaMs&&b.kind!=='links'?`<span>about ${etaText(b.etaMs)} left</span>`:''}</div>${b.recent?.length?`<div class="batch-recent">${b.recent.slice(-5).map(r=>`<span class="st-${esc(r.status)}">${esc(r.label)}</span>`).join('')}</div>`:''}</div></div>`;
}
function conversation(t){
  const suggestions=t.suggestions?.length&&t.status!=='running'?`<div class="suggest"><div class="suggest-label">Suggested next steps</div>${t.suggestions.map((s,i)=>`<button data-suggest="${i}">${esc(s.label)}</button>`).join('')}</div>`:'';
  const ask=t.question&&!['handoff','approval'].includes(t.question.kind)?`<div class="ask-card"><div class="ask-head"><span class="buddy" data-buddy="mini" data-task="${t.id}"></span><strong>A moment for you</strong></div><div class="md">${md(t.question.text)}</div>${t.nativeRequest?.type==='question/requested'?nativeQuestions(t):''}<div class="choices">${(t.question.choices||[]).map(c=>`<button data-answer="${esc(c)}">${esc(c)}</button>`).join('')}</div><p class="muted">Reply below${t.status==='waiting'?' when you’re ready. The task is paused.':'.'}</p></div>`:'';
  const status=t.status==='running'&&t.batch?batchRow(t,t.batch):t.status==='running'?`<div class="typing-row"><span class="buddy" data-buddy="inline" data-task="${t.id}"></span><div class="typing-bubble"><span>${esc(t.activity||'Working on it')}</span><span class="tdots"><i></i><i></i><i></i></span></div></div>`
    :t.status==='queued'?`<div class="typing-row quiet"><span class="buddy" data-buddy="inline" data-task="${t.id}"></span><div class="typing-bubble">I’ll start when the current task is finished.</div></div>`
    :t.status==='scheduled'?`<div class="activity">Starts ${when(t.runAt)}${t.repeatHours?` · repeats every ${t.repeatHours} hours`:''}</div>`:'';
  // Everyday controls stay in view (status, pin); the rest live in one options menu.
  const options=`<div class="menu-wrap"><button class="icon-btn" data-conv-menu aria-haspopup="menu" aria-expanded="false" aria-label="Conversation options" title="Options">${icon('more')}</button><div class="menu down" role="menu" hidden><button role="menuitem" data-task-rename>${icon('edit')}Rename</button><button role="menuitem" data-task-project>${icon('folder')}${t.project?'Change project':'Add to a project'}</button>${t.status==='complete'?`<button role="menuitem" data-save-workflow>${icon('template')}Save as a workflow</button>`:''}${t.deliveryUncertain?`<button role="menuitem" data-action="retry-delivery">${icon('reload')}Retry message</button>`:''}${['complete','stopped','paused','attention'].includes(t.status)?`<hr><button role="menuitem" data-action="${t.archived?'unarchive':'archive'}">${icon('archive')}${t.archived?'Restore from archive':'Archive'}</button>`:''}</div></div>`;
  // Finished work gets one header row (result line, pin, options) instead of a pill plus a status line.
  const summary=taskSummary(t),settled=summary.startsWith('<div class="work-done"');
  return `<section class="conversation"><h2 class="conv-title">${esc(t.title)}</h2><div class="conv-head task-meta${settled?' settled':''}">${settled?summary:pill(t)}${t.project?`<span class="conv-project" title="Project">${esc(t.project)}</span>`:''}${t.archived?'<span class="conv-project">Archived</span>':''}<span class="grow"></span><button class="icon-btn" data-task-pin aria-pressed="${!!t.pinned}" aria-label="${t.pinned?'Unpin this conversation':'Pin this conversation'}" title="${t.pinned?'Unpin':'Pin to the top'}">${icon('star')}</button>${options}</div>${branchBanner(t)}${settled?'':summary}${thread(t)}${ask}${t.error?`<p class="error-line">${esc(t.error)}</p>`:''}${status}${subagentProgress(t)}${suggestions}${t.events?.length?`<details class="activity-log"><summary>Activity log · ${t.events.length} ${t.events.length===1?'update':'updates'}</summary><ul>${t.events.slice(-30).map(e=>`<li>${when(e.time)} · ${esc(e.text)}</li>`).join('')}</ul></details>`:''}</section>`;
}
async function refreshSubagents(t){
  if(subagentPending.has(t.id)||Date.now()-(subagentFetched.get(t.id)||0)<6000)return;
  subagentPending.add(t.id);subagentFetched.set(t.id,Date.now());
  try{
    const next=await api(`subagents?task=${encodeURIComponent(t.id)}`),old=JSON.stringify(subagentCache.get(t.id)||null);
    subagentCache.set(t.id,next);
    if(old!==JSON.stringify(next)&&view==='chat'&&selected===t.id){previousSignature='';render();}
  }catch{const old=JSON.stringify(subagentCache.get(t.id)||null);subagentCache.set(t.id,{taskId:t.id,error:true,children:[]});if(old!==JSON.stringify(subagentCache.get(t.id))&&view==='chat'&&selected===t.id){previousSignature='';render();}}
  finally{subagentPending.delete(t.id);}
}
function subagentProgress(t){
  const snapshot=subagentCache.get(t.id);if(!snapshot)return t.status==='running'?'<div class="subagent-progress muted">Checking delegated work…</div>':'';
  if(snapshot.error)return '<div class="subagent-progress muted">Delegated work status is unavailable.</div>';
  if(!snapshot.children?.length)return '';
  const label=x=>x.status==='running'?'Running':x.status==='idle'?'Waiting':x.status==='starting'?'Starting':x.status==='unavailable'?'Unavailable':'Stored';
  return `<section class="subagent-progress"><div class="section-copy"><strong>Delegated work · ${snapshot.children.length}</strong></div><div class="ap-list">${snapshot.children.map(x=>`<div class="ap-item"><strong>${esc(x.label||'Background task')}</strong><p>${label(x)}${x.activity?` · ${esc(x.activity)}`:''}</p></div>`).join('')}</div></section>`;
}
function nativeQuestions(t){return `<form id="native-form">${t.nativeRequest.questions.map((q,i)=>`<label class="native-question">${esc(q.question)}${q.options?.length?`<select id="nq-select-${i}" ${q.multiSelect?'multiple':''}><option value="">Write an answer below</option>${q.options.map(o=>`<option value="${esc(o.label)}">${esc(o.label)}</option>`).join('')}</select>`:''}<input id="nq-text-${i}" type="text" placeholder="Your answer"></label>`).join('')}<button type="submit" class="primary">Send answers</button></form>`;}
// When something happened, at a glance: 'just now', '12 min ago', '4:37 PM', 'Yesterday', 'Mon', 'Oct 5'.
function relTime(n){if(!Number.isFinite(n))return '';const now=new Date(),d=new Date(n),diff=Date.now()-n;if(Math.abs(diff)<60000)return 'just now';if(diff>0&&diff<3600000)return Math.round(diff/60000)+' min ago';const day=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime(),days=Math.round((day(now)-day(d))/86400000);if(days===0)return d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});if(days===1)return 'Yesterday';if(days>1&&days<7)return d.toLocaleDateString(undefined,{weekday:'short'});return d.toLocaleDateString(undefined,{month:'short',day:'numeric',...(d.getFullYear()!==now.getFullYear()?{year:'numeric'}:{})});}
// A task row's second line, unless it would only repeat the status pill.
function taskLine(t){const line=t.status==='scheduled'&&t.runAt?'Starts '+when(t.runAt)+(t.repeatHours?' · repeats':''):t.activity||'';return line&&!['finished','stopped','done',String(labels[t.status]||'').toLowerCase()].includes(line.trim().toLowerCase())?`<p>${esc(line)}</p>`:'';}
// Every full page opens the same way: a title, one line of context, and its actions.
function pageHead(title,lede='',actions=''){return `<header class="page-head"><div><h1>${esc(title)}</h1>${lede?`<p>${esc(lede)}</p>`:''}</div>${actions?`<div class="page-actions">${actions}</div>`:''}</header>`;}
function taskBoard(){const categories={all:'All',running:'In progress',waiting:'Needs you',scheduled:'Scheduled',complete:'Done'};const query=searchQuery.trim().toLowerCase(),tasks=[...state.tasks].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).filter(t=>!!t.archived===showArchive&&(!query||`${t.title} ${t.activity||''}`.toLowerCase().includes(query))).filter(t=>showArchive||filter==='all'||filter==='running'&&['running','queued'].includes(t.status)||filter==='waiting'&&['waiting','attention','paused'].includes(t.status)||t.status===filter);const open=state.tasks.filter(t=>!t.archived),busy=open.filter(t=>['running','queued'].includes(t.status)).length,blocked=open.filter(t=>['waiting','attention'].includes(t.status)).length;
  return `<section class="page tasks">${pageHead('Tasks',[busy?`${busy} in progress`:'',blocked?`${blocked} need${blocked===1?'s':''} you`:'',`${open.length} total`].filter(Boolean).join(' · '))}<div class="task-search"><label class="field">${icon('search')}<span class="sr-only">Search titles and activity</span><input id="task-search" type="search" value="${esc(searchQuery)}" placeholder="Search tasks" autocomplete="off"></label></div><div class="filters" role="toolbar" aria-label="Show tasks">${Object.entries(categories).map(([key,label])=>`<button data-filter="${key}" class="${!showArchive&&filter===key?'selected':''}" aria-pressed="${!showArchive&&filter===key}">${label}</button>`).join('')}<button data-archive-view class="${showArchive?'selected':''}" aria-pressed="${showArchive}">Archived</button></div><div class="task-grid">${tasks.map(t=>`<button class="task-card" data-select="${t.id}">${pill(t)}<div><h3>${esc(t.title)}</h3>${taskLine(t)}</div><time datetime="${new Date(t.updatedAt||0).toISOString()}" title="${esc(when(t.updatedAt))}">${esc(relTime(t.updatedAt))}</time></button>`).join('')||`<div class="empty">${showArchive?'Nothing archived yet.':query?'No tasks match that search.':'No tasks here yet.'}</div>`}</div></section>`;}

// ── ideas (proactive suggestions from the local model) ──────────────────────
function ideasView(){
  const ideas=state.ideas?.items||[];
  return `<section class="page ideas-view">${pageHead('Ideas for you',`Things I could take off your plate, based on what you’ve asked me before and what you’ve told me to remember.${state.ideas?.at?` Updated ${when(state.ideas.at)}.`:''}`,`<button type="button" data-ideas="refresh" ${ideasBusy?'disabled':''}>${icon('reload','ic-sm')} ${ideasBusy?'Thinking up ideas…':ideas.length?'Refresh ideas':'Suggest some ideas'}</button>`)}<div class="idea-grid">${ideas.map((i,n)=>`<div class="idea-card"><h3>${esc(i.title)}</h3><p>${esc(i.why)}</p><button class="primary" data-idea-run="${n}">Do it</button></div>`).join('')||`<div class="empty">${ideasBusy?'Looking at what you’ve asked me before…':'No ideas yet. Tap “Suggest some ideas”.'}</div>`}</div></section>`;
}

// ── agent panel: Approvals · Activity · Upcoming · Identity (like Muse) ─────
function approvalsHtml(){
  const list=needsYou();
  if(!list.length)return '<p class="ap-empty">Nothing needs you right now.</p>';
  return list.map(t=>{
    const head=`<button class="ap-task" data-select="${t.id}">${esc(t.title)}</button>`;
    // Card payments: one tap, never reusable.
    if(t.approval&&t.approval.intent?.kind==='browser.card')return `<div class="ap-item approve pay">${head}<p><strong>${esc(t.approval.label)}?</strong></p>${t.approval.reason?`<p class="pay-reason">${esc(t.approval.reason)}</p>`:''}<p class="muted">Your card details are filled straight from your vault. ${esc(state.settings.name)} never sees the number. Check the merchant and amount.</p><div class="ap-actions" ${approvalAttributes(t.approval)}><button class="primary" data-pa="approve" data-scope="once" data-task="${t.id}">Pay now</button><button data-pa="reject" data-task="${t.id}">Reject</button></div></div>`;
    if(t.approval)return `<div class="ap-item approve">${head}<p>${esc(t.question?.text||`Press “${t.approval.label}” on ${t.approval.host}?`)}</p>${approvalDetails(t.approval)}<div class="ap-actions" ${approvalAttributes(t.approval)}><button class="primary" data-pa="approve" data-scope="once" data-task="${t.id}">Approve once</button><details class="approval-scopes"><summary>More approval options</summary><button data-pa="approve" data-scope="task" data-task="${t.id}">For this task</button><button data-pa="approve" data-scope="always" data-task="${t.id}">Always this action</button><p>This exact action can be reused. Changed content or recipients require a new review.</p></details><button data-pa="reject" data-task="${t.id}">Reject</button></div></div>`;
    if(t.handoff)return `<div class="ap-item turn">${head}<p>${esc(t.handoff.message)}</p><div class="ap-actions"><button class="primary" data-pa="control" data-task="${t.id}">Take control</button><button data-pa="handback" data-task="${t.id}">I’m done</button></div></div>`;
    const choices=(t.question?.choices||[]).map(c=>`<button data-pa="answer" data-reply="${esc(c)}" data-task="${t.id}">${esc(c)}</button>`).join('');
    return `<div class="ap-item">${head}<p>${esc(t.question?.text||'Needs your attention.')}</p><div class="ap-actions">${choices}${t.status==='attention'?`<button data-pa="resume" data-task="${t.id}">Resume</button>`:''}<button data-select="${t.id}">Open</button></div></div>`;
  }).join('');
}
function upcomingHtml(){
  const list=state.tasks.filter(t=>t.status==='scheduled').sort((a,b)=>a.runAt-b.runAt);
  if(!list.length)return '<p class="ap-empty">Nothing scheduled. Ask me to do something later, or every day or week.</p>';
  const every=h=>h===24?'every day':h===168?'every week':`every ${h} hours`;
  return list.map(t=>`<div class="ap-item"><button class="ap-task" data-select="${t.id}">${esc(t.title)}</button><p>${when(t.runAt)}${t.repeatHours?` · ${every(t.repeatHours)}`:''}</p><div class="ap-actions"><button data-pa="cancel" data-task="${t.id}">Cancel</button></div></div>`).join('');
}
function activityHtml(limit=40){
  const items=state.tasks.flatMap(t=>(t.events||[]).map(e=>({...e,t}))).sort((a,b)=>b.time-a.time).slice(0,limit);
  if(!items.length)return '<p class="ap-empty">Activity shows up here as I work.</p>';
  return `<ul class="ap-activity">${items.map(i=>`<li><button data-select="${i.t.id}"><time>${when(i.time)}</time><strong>${esc(i.t.title)}</strong><span>${esc(i.text)}</span></button></li>`).join('')}</ul>`;
}
// The inbox's first tab gathers everything that wants you: blocked tasks, memory to review, heads-ups.
function forYouHtml(){
  const blocked=needsYou(),items=headsUpItems(),memory=memoryInboxCard(),reminders=window.SeekCalendar?.remindersHtml?.()||'';
  if(!blocked.length&&!items.length&&!memory&&!reminders)return '<p class="ap-empty">Nothing needs you right now.</p>';
  return `${reminders?`<div class="ap-section-label">Reminders</div><div class="ap-list">${reminders}</div>`:''}${blocked.length?`<div class="ap-section-label">Waiting on you</div><div class="ap-list">${approvalsHtml()}</div>`:''}${memory?`<div class="ap-section-label">Memory</div>${memory}`:''}${items.length?`<div class="ap-section-label">Heads up</div><div class="headsup-list">${items.map(headsUpCard).join('')}</div>`:''}`;
}
let apTab='approvals',apSig='';
function renderPanel(){
  const panel=$('#agent-panel');
  if(!panel||getComputedStyle(panel).display==='none')return;
  $('#ap-pin').setAttribute('aria-pressed',String(panelPinned));$('#ap-pin').title=panelPinned?'Stop keeping the inbox open':'Keep the inbox open beside your work';
  const running=state.tasks.find(t=>t.status==='running'),waiting=needsYou().length;
  $('#ap-status').textContent=modelActivity(state.health?.models)||(running?`Working: ${running.title}`:waiting?`${waiting} waiting on you`:'Ready to help');
  if(apTab==='identity')apTab='approvals';
  document.querySelectorAll('[data-ap]').forEach(b=>b.classList.toggle('active',b.dataset.ap===apTab));
  decorateTabs();
  const html=apTab==='approvals'?forYouHtml():apTab==='upcoming'?`<div class="ap-list">${upcomingHtml()}</div>`:activityHtml();
  if(apTab+html!==apSig){apSig=apTab+html;$('#ap-body').innerHTML=html;}
}

// ── Settings: one page, a tab per area (profile, memory, connections, notifications, privacy, report card) ──
const settingsIntro=(tab,text,actions='')=>`<div class="settings-intro${actions?' has-actions':''}"><div><h2>${esc(SETTINGS_TABS.find(x=>x[0]===tab)?.[1]||'Settings')}</h2>${text?`<p>${text}</p>`:''}</div>${actions?`<div class="settings-intro-actions">${actions}</div>`:''}</div>`;
function settingsShell(){
  const main=$('#main');let body=$('#settings-body');
  if(!body){main.innerHTML=`<section class="settings"><nav class="settings-nav" aria-label="Settings">${SETTINGS_TABS.map(([id,label,ic])=>`<button data-view="${id}">${icon(ic)}<span>${esc(label)}</span></button>`).join('')}<hr><a href="/" target="_blank" rel="noopener">${icon('external')}<span>Developer view</span></a></nav><div class="settings-body" id="settings-body"></div></section>`;body=$('#settings-body');main.scrollTop=0;enterView(main);}
  for(const b of document.querySelectorAll('.settings-nav [data-view]')){const on=b.dataset.view===view;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  if(body.dataset.tab!==view){body.dataset.tab=view;body.innerHTML='';delete body.dataset.seekConnectionsSig;main.scrollTop=0;}
  return body;
}
function renderSettings(){
  const body=settingsShell();
  if(view==='profile')renderProfile(body);
  else if(view==='memory')renderDreaming({api,toast});
  else if(view==='connections')void renderConnections();
  else if(view==='alerts')renderAlerts(body);
  else if(view==='privacy')renderPrivacy(body);
  else if(view==='growth')renderGrowth({api,toast});
  else if(view==='computers'){if(!body.querySelector('.dk,[data-dk-loading]')){body.innerHTML='<p class="muted" data-dk-loading>Loading…</p>';void ensureFeature('desktop').then(m=>{if(view==='computers')m.activate(body,{settingsIntro});}).catch(error=>toast(error.message));}}
}
// The settings route replaces the whole record, so every save sends the full current settings.
async function saveSettings(patch){const s=state.settings;await api('settings',{name:s.name,memory:s.memory||'',notifications:!!s.notifications,look:s.look,autonomy:s.autonomy,...patch});state=await api('state');}
function renderProfile(body){
  if(body.querySelector('#memory-form'))return;const name=esc(state.settings.name);
  body.innerHTML=`${settingsIntro('profile',`How ${name} looks, what it keeps in mind, and how independently it works.`)}${appearanceEditor()}<section class="memory"><form id="memory-form"><label for="agent-name">Your agent’s name</label><input id="agent-name" type="text" maxlength="40" value="${name}" required><label>How ${name} looks</label>${lookEditor()}<label for="memory-text">What should I remember about you?</label><textarea id="memory-text" maxlength="20000" placeholder="Your preferences, writing style, usual constraints, or things you want me to know…">${esc(state.settings.memory||'')}</textarea><p class="muted">Avoid passwords and API keys; sign in directly in the browser instead. Notes ${name} learns on its own are in <button type="button" class="link-btn" data-view="memory">Memory</button>.</p>${autonomyEditor()}<div class="settings-actions"><button type="submit" class="primary">Save changes</button></div></form><p class="muted">Work continues when you close this page, while this computer and the harness stay running. Scheduled tasks that fall due while the harness is offline run when it returns.</p></section>`;
}
function renderAlerts(body){
  if(body.querySelector('#alerts-panel'))return;const name=esc(state.settings.name),ask='Notification' in window&&Notification.permission==='default';
  body.innerHTML=`${settingsIntro('alerts',`How ${name} gets your attention when a task finishes or needs you.`)}<section id="alerts-panel"><div class="acct" data-acct-mode="alerts"><div class="account-card"><h3>Notifications on this device</h3><p class="muted">Checking this device…</p></div></div><div class="account-card"><div class="toggle-row"><div><h3>While Seek is open</h3><p>Show a message here when a task finishes or needs your input.</p></div><label class="switch"><input type="checkbox" id="notifications" ${state.settings.notifications?'checked':''} aria-label="Show a message when a task finishes or needs you"><span></span></label></div>${ask?'<div class="acct-actions" style="margin-top:12px"><button type="button" id="enable-alerts">Allow browser alerts</button></div>':''}</div></section>`;
  renderAccount(body.querySelector('.acct'));
}
function renderPrivacy(body){
  if(body.querySelector('.acct'))return;
  body.innerHTML=`${settingsIntro('privacy',`${esc(state.settings.name)} never sees your passwords. Saved logins are filled only after you approve each one.`)}<div class="acct" data-acct-mode="privacy"><p class="muted" role="status">Checking your vault, sign-ins and devices…</p></div>`;
  renderAccount(body.querySelector('.acct'));
}

let installEvent=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e;refreshAccounts();});
const swReady=('serviceWorker' in navigator)?navigator.serviceWorker.register('/work/sw.js',{scope:'/work/'}).catch(()=>null):Promise.resolve(null);
const b64ToBytes=s=>{const b=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));return Uint8Array.from(b,c=>c.charCodeAt(0));};
async function pushHtml(){
  const install=installEvent?'<button type="button" data-acct="install">Install Seek as an app</button>':'';
  if(!('serviceWorker' in navigator)||!('PushManager' in window))return `<p class="muted">This browser can’t receive notifications here. On iPhone, add Seek to your Home Screen first (Share → Add to Home Screen) and open it from there.</p>${install}`;
  const reg=await swReady,sub=reg?await reg.pushManager.getSubscription().catch(()=>null):null;
  return sub?`<p><span class="vault-dot on"></span>On for this device. You’ll hear from me when a task finishes or needs you, even with Seek closed.</p><div class="acct-actions"><button type="button" data-acct="push-test">Send a test</button><button type="button" data-acct="push-off">Turn off here</button>${install}</div>`
    :`<p>Get a notification on this device when a task finishes or needs you, even when Seek is closed.</p><div class="acct-actions"><button type="button" class="primary" data-acct="push-on">Turn on notifications</button>${install}</div>`;
}
async function renderAccount(el,fresh=false){
  if(!el)return;
  if(el.dataset.acctMode==='alerts'){const html=await pushHtml();if(el.isConnected)el.innerHTML=`<div class="account-card"><h3>Notifications on this device</h3>${html}</div>`;return;}
  let a;try{a=await api(fresh?'account?fresh=1':'account');}catch(e){el.textContent=e.message;return;}
  const v=a.vault,name=esc(state.settings.name),until=n=>new Date(n).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  const vault=v.state==='unlocked'?`<p><span class="vault-dot on"></span>Unlocked until ${until(v.until)} · ${v.logins} saved logins available. Each sign-in still asks for your approval.</p>${v.cards?.length?`<p class="vault-cards">Cards for checkout: ${v.cards.map(c=>`<span>${esc(c.brand||'Card')} ••${esc(c.last4)}${c.expMonth&&c.expYear?` · exp ${esc(c.expMonth)}/${esc(String(c.expYear).slice(-2))}`:''}</span>`).join('')}</p><p class="muted">Each payment asks for one tap with the merchant and amount. Card numbers go from the vault into the checkout form and are never shown to ${name}.</p>`:`<p class="muted">To let ${name} pay at checkout, add a Card item in your vault (vault.joelcrobinson.com), then lock and unlock here.</p>`}<button type="button" data-acct="lock">Lock now</button>`
    :v.state==='locked'?(v.canUnlock?`<p>Connected and locked. Unlock it so ${name} can offer to sign in for you. Your master password is used once, on this PC, to unlock Bitwarden. It isn’t stored or shown to the agent.</p><form data-acct-form="unlock" class="vault-unlock"><input type="password" name="password" autocomplete="current-password" placeholder="Bitwarden master password" aria-label="Bitwarden master password" required><select name="minutes" aria-label="Keep unlocked"><option value="15">for 15 minutes</option><option value="60" selected>for 1 hour</option><option value="480">for 8 hours</option><option value="720">for 12 hours</option></select><button class="primary">Unlock</button></form>`:`<p>Locked. For safety, unlock it from Seek on your PC, so your master password never crosses the internet.</p>`)
    :v.state==='unauthenticated'?`<p>Connect Bitwarden once: open a terminal on this PC, run <code>bw login</code>, then refresh.</p><button type="button" data-acct="refresh">Refresh</button>`
    :`<p>${v.state==='missing'?'The Bitwarden CLI isn’t installed on this PC.':'Couldn’t read the Bitwarden CLI status.'}</p><button type="button" data-acct="refresh">Refresh</button>`;
  const sites=a.sites.length?`<ul class="site-list">${a.sites.map(s=>`<li><div><strong>${esc(s.site)}</strong><span>${s.via==='vault'?'Signed in with your vault':'Signed in by you'} · ${when(s.at)}${s.cookies===0?' · session ended':''}</span></div><button type="button" data-signout="${esc(s.site)}">Sign out</button></li>`).join('')}</ul>`:'<p class="muted">None yet. Sites appear here after you sign in during a task.</p>';
  const always=a.always?.length?`<ul class="site-list">${a.always.map(x=>`<li><div><strong>${esc(x.label)}</strong><span>${esc(x.host)} · allowed ${when(x.at)}</span></div><button type="button" data-pa="unallow" data-host="${esc(x.host)}" data-label="${esc(x.label)}" data-fingerprint="${esc(x.fingerprint||'')}">Remove</button></li>`).join('')}</ul>`:'<p class="muted">None. Actions you approve with “Always this action” show up here, and you can take them back.</p>';
  const directLocal=['127.0.0.1','localhost'].includes(location.hostname)&&location.port==='3080';
  const familyUrl=directLocal?'http://127.0.0.1:18799/family':'/family';
  el.innerHTML=`<div class="account-card"><h3>Partner access</h3><p>A second login can open this same workspace. Chats, tasks, files, memory, finance and connected apps are shared.</p><a href="${familyUrl}" target="_blank" rel="noopener noreferrer">Manage partner login →</a>${directLocal?'':'<p><a href="/logout">Sign out of this browser</a></p>'}</div><div class="account-card"><h3>Password vault (Bitwarden)</h3>${vault}</div><div class="account-card"><h3>Signed-in sites</h3><p class="muted">Where ${name}’s browser is signed in. Signing out clears that site’s cookies and storage in the agent’s browser only.</p>${sites}<button type="button" data-acct="signout-all">Sign out of all sites</button></div><div class="account-card"><h3>Always-allowed actions</h3>${always}</div>`;
  void renderWorkspaceSafety(el);
}
// Recent sign-ins, device and permission changes, vault and export activity (never secrets).
function securityActivity(data){
  if(!data)return '<div class="account-card security-activity"><h3>Security activity</h3><p class="muted">Security activity is unavailable right now.</p></div>';
  const where=e=>[e.identity,e.device,e.channel,e.ip&&e.source==='proxy'?e.ip:'' ].filter(Boolean).map(esc).join(' · ');
  const detail=e=>[e.decision?(e.decision==='approve'?'Approved':'Declined')+(e.scope&&e.scope!=='once'?' · '+e.scope:''):'',e.host,e.site,e.where,Number.isFinite(e.count)?e.count+' signed out':'',Number.isFinite(e.amount)?'$'+e.amount.toFixed(2):'',e.last4?(e.brand||'Card')+' ••'+e.last4:'',Number.isFinite(e.attempts)&&e.type!=='login.success'?'attempt '+e.attempts:''].filter(Boolean).map(esc).join(' · ');
  const warn=e=>['login.failed','login.rate_limited','login.csrf_rejected','secret.sent_anyway'].includes(e.type);
  const rows=data.events.map(e=>`<li class="${warn(e)?'warn':''}"><div><strong>${esc(e.label)}</strong><span>${[detail(e),where(e)].filter(Boolean).join(' · ')}</span></div><time datetime="${new Date(e.at).toISOString()}">${esc(when(e.at))}</time></li>`).join('');
  return `<div class="account-card security-activity"><h3>Security activity</h3><p>${data.failedSignIns24h?`<strong class="security-alert">${data.failedSignIns24h} failed sign-in${data.failedSignIns24h===1?'':'s'} in the last 24 hours.</strong> `:''}Sign-ins, devices, permissions, vault and export activity. Passwords and message text are never recorded.</p>${rows?`<ul class="site-list">${rows}</ul>`:'<p class="muted">No security activity recorded yet.</p>'}</div>`;
}
// How much the agent does on its own. Autonomous is the default (Muse-style): the request is the approval.
function autonomyEditor(){
  const a={mode:'autonomous',spendLimit:250,...(state.settings.autonomy||{})},auto=a.mode!=='careful';
  return `<fieldset class="autonomy"><legend>How independently ${esc(state.settings.name)} works</legend>
  <label class="autonomy-option"><input type="radio" name="autonomy" value="autonomous" ${auto?'checked':''}><span><strong>Autonomous</strong><small>Just does what you ask: fills forms, picks dates and options, and completes orders, bookings and messages your request asks for. Still asks before deleting anything or spending more than the limit below. Sign-in, CAPTCHAs and payment details always come to you.</small></span></label>
  <label class="autonomy-option"><input type="radio" name="autonomy" value="careful" ${auto?'':'checked'}><span><strong>Careful</strong><small>Asks before purchases, messages and unfamiliar form buttons unless your request names exactly what to do.</small></span></label>
  <label for="spend-limit" class="autonomy-limit">Ask before spending more than <span>$<input id="spend-limit" type="number" min="0" max="100000" step="1" value="${esc(a.spendLimit)}"></span></label></fieldset>`;
}
async function renderWorkspaceSafety(el){
  let host=el.querySelector('.workspace-safety');if(!host){host=document.createElement('section');host.className='workspace-safety';el.append(host);}host.innerHTML='<p role="status">Checking saved work and devices…</p>';
  const [backup,sessions,activity]=await Promise.allSettled([api('backups'),request('/auth/api/sessions'),api('security-events?limit=40')]);if(!host.isConnected)return;
  const b=backup.status==='fulfilled'?backup.value:null,s=sessions.status==='fulfilled'?sessions.value:null;host.__sessions=s;
  host.innerHTML=`<div class="account-card"><h3>Saved work & recovery</h3><p>${b?.lastAt?'Last encrypted backup: '+esc(when(b.lastAt)):b?.error?esc(b.error):'No backup has been recorded yet.'}</p>${b?.files?`<p class="muted">${b.files} files in the last backup.</p>`:''}<div class="acct-actions"><button data-security="backup" ${b?.error&&!b?.encrypted?'disabled':''}>Create encrypted backup</button><button data-security="export">Export conversations & preferences</button>${b?.canConfigure?'<button data-security="recovery-key">Download recovery key</button>':''}<button data-security="refresh">Check status</button></div><p class="muted">Exports include task history and memory. Connected account credentials need reauthorization on another Windows account. Recovery keys are managed directly on the host PC.</p></div>${s?`<div class="account-card"><h3>Signed-in devices</h3><p>Remove access for a browser you no longer use.</p><ul class="site-list">${s.sessions.map(device=>`<li><div><strong>${esc(device.label||'Browser session')}${device.current?' · This device':''}</strong><span>${esc(device.identity)} · Last seen ${esc(when(device.lastSeenAt))}</span></div><button data-security="revoke" data-session="${esc(device.id)}">${device.current?'Sign out here':'Remove access'}</button></li>`).join('')}</ul>${s.sessions.some(d=>!d.current)?'<button data-security="revoke-others">Sign out other devices</button>':''}</div>`:'<div class="account-card"><h3>Signed-in devices</h3><p>Device access is managed by the workspace owner through the protected sign-in service.</p></div>'}`;
  host.insertAdjacentHTML('beforeend',securityActivity(activity.status==='fulfilled'?activity.value:null));
}
document.addEventListener('click',async event=>{const button=event.target.closest('[data-security]');if(!button)return;const action=button.dataset.security,host=button.closest('.workspace-safety'),account=host?.closest('.acct');button.disabled=true;try{
  if(action==='refresh'){await renderWorkspaceSafety(account);return;}
  if(action==='backup'){button.textContent='Creating backup…';await request('/work/api/backups/create',{}, {timeoutMs:180000});toast('Encrypted backup saved.');await renderWorkspaceSafety(account);return;}
  if(action==='export'){const data=await api('export',{}),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='seek-work-export-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Workspace export prepared.');return;}
  if(action==='recovery-key'){const data=await api('backups/recovery-key',{}),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='seek-recovery-key-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Recovery key download prepared. Store it safely away from this PC.');return;}
  if(action==='revoke'||action==='revoke-others'){const data=host.__sessions;if(!data)throw new Error('Refresh devices before changing access.');const current=data.sessions.find(d=>d.id===button.dataset.session)?.current;await request('/auth/api/sessions/revoke',{csrf:data.csrf,...action==='revoke-others'?{others:true}:{id:button.dataset.session}});if(current){location.href='/work';return;}toast('Device access removed.');await renderWorkspaceSafety(account);}
 }catch(error){toast(error.message);}finally{if(button.isConnected){button.disabled=false;if(action==='backup')button.textContent='Create encrypted backup';}}});
function refreshAccounts(fresh=false){document.querySelectorAll('.acct').forEach(el=>renderAccount(el,fresh));}
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-acct],[data-signout]');if(!b)return;
  b.disabled=true;
  try{
    const act=b.dataset.acct;
    if(act==='lock'){await api('vault/lock',{});toast('Vault locked.');}
    else if(b.dataset.signout){const r=await api('sites/signout',{site:b.dataset.signout});toast(`Signed out of ${b.dataset.signout}${r.cleared?'':' (no active session)'}.`);}
    else if(act==='signout-all'){if(!confirm('Sign the agent’s browser out of every site?'))return;await api('sites/signout',{all:true});toast('Signed out of all sites.');}
    else if(act==='push-on'){
      const reg=await swReady;if(!reg)throw new Error('Notifications need Seek opened over https or on this PC.');
      if(await Notification.requestPermission()!=='granted')throw new Error('Notifications were not allowed for Seek.');
      const {publicKey}=await api('push/key');
      const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToBytes(publicKey)});
      await api('push/subscribe',{subscription:sub.toJSON()});toast('Notifications are on for this device.');
    }
    else if(act==='push-off'){const reg=await swReady,sub=await reg?.pushManager.getSubscription();if(sub){await api('push/unsubscribe',{endpoint:sub.endpoint});await sub.unsubscribe();}toast('Notifications are off for this device.');}
    else if(act==='push-test'){await api('push/test',{});toast('Test sent. It should arrive in a few seconds.');}
    else if(act==='install'&&installEvent){installEvent.prompt();installEvent=null;}
    refreshAccounts(act==='refresh');
  }catch(err){toast(err.message);}finally{b.disabled=false;}
});
document.addEventListener('submit',async e=>{
  if(e.target.dataset.acctForm!=='unlock')return;e.preventDefault();
  const field=e.target.elements.password,password=field.value;field.value='';
  try{const s=await api('vault/unlock',{password,minutes:Number(e.target.elements.minutes.value)});toast(`Vault unlocked · ${s.logins} saved logins available.`);refreshAccounts();}catch(err){toast(err.message);}
});

async function poll(){
  if(document.hidden||polling)return;polling=true;clearTimeout(pollTimer);
  try{const before=new Map(state.tasks.map(t=>[t.id,t.status]));await syncState();
    const model=state.health?.model;$('#connection').textContent=state.health?.requests==='reconnecting'?'Request updates reconnecting':modelActivity(state.health?.models)||(model==='busy'?'Agent busy':model==='ready'?'Ready to help':model==='loading'?'Model loading':model==='offline'?'Model offline':'Connected');
    $('#connection').title='Updated '+when(Date.now());$('#seek-sign-in')?.remove();document.querySelector('.online-dot').style.background='#5f9c80';
    if(!firstPoll&&state.settings.notifications)for(const task of state.tasks)if(before.has(task.id)&&before.get(task.id)!==task.status&&['complete','waiting','attention'].includes(task.status))toast(`${task.status==='complete'?'Finished':'Needs you'}: ${task.title}`);
    if(firstPoll)void ensureFeature('calendar').catch(()=>{});
    firstPoll=false;online=true;render();window.dispatchEvent(new Event('seek-poll'));
  }catch(error){$('#connection').textContent=error.code==='auth'?'Sign in again':error.code==='timeout'?'Connection timed out':'Reconnecting…';$('#connection').title='Last update '+(state.health?.lastUpdatedAt?when(state.health.lastUpdatedAt):'unavailable');if(error.code==='auth'&&!$('#seek-sign-in')){const link=document.createElement('a');link.id='seek-sign-in';link.href='/work';link.textContent='Sign in';$('#connection').after(link);}document.querySelector('.online-dot').style.background='#bf9e62';online=false;window.SeekBuddy?.update(state,{online:false});}
  finally{polling=false;if(!document.hidden)pollTimer=setTimeout(poll,eventStream?.readyState===1?30000:state.health?.models?.active?1000:state.health?.model==='loading'||state.tasks.some(t=>['running','queued'].includes(t.status))?2000:15000);}
}
function connectEvents(){if(document.hidden||eventStream||!('EventSource'in window))return;eventStream=new EventSource('/work/api/events');eventStream.addEventListener('revision',()=>void poll());eventStream.onerror=()=>{clearTimeout(pollTimer);pollTimer=setTimeout(poll,2000);};}
// The calendar changed something the Inbox or its badge shows.
window.addEventListener('seek-inbox-refresh',()=>{apSig='';render();});
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);if(document.hidden){eventStream?.close();eventStream=null;}else{connectEvents();void poll();}});

document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-dialog-close')){b.closest('dialog')?.close();return;}
  if(b.dataset.cmd){document.querySelectorAll('dialog[open]').forEach(d=>d.close());runCommand(b.dataset.cmd);return;}
  if(b.id==='mobile-more'){$('#menu').click();return;}
  if(b.id==='search-work'){openPalette();return;}
  if(b.id==='image-clear'){setImageMode(false);return;}
  if(b.id==='schedule-clear'){scheduled=null;syncComposerChips();toast('Schedule removed. This request will start right away.');return;}
  if(b.id==='workflow-open'){navigate('workflows');return;}
  if(b.hasAttribute('data-workflow-build')){newChat();$('#prompt').value='Help me make a reusable workflow for a task I repeat. The task is: ';saveDraft();$('#prompt').focus();return;}
  if(b.hasAttribute('data-workflow-retry')){workflowItems=null;await loadWorkflows();return;}
  if(b.hasAttribute('data-grocery-add')){const list=b.closest('form').querySelector('[data-grocery-items]');if(list.children.length>=500){toast('Use at most 500 items.');return;}list.insertAdjacentHTML('beforeend',groceryItemRow(groceryRowIndex++));list.lastElementChild.querySelector('input').focus();return;}
  if(b.hasAttribute('data-grocery-remove')){const item=b.closest('[data-grocery-item]'),list=item.parentElement,next=item.nextElementSibling||item.previousElementSibling;item.remove();if(!list.children.length)list.innerHTML=groceryItemRow(groceryRowIndex++);(next||list.firstElementChild).querySelector('input').focus();return;}
  if(b.hasAttribute('data-grocery-example')){const list=b.closest('form').querySelector('[data-grocery-items]'),first=list.firstElementChild;if(list.children.length===1&&!first.querySelector('[data-grocery-field=name]').value&&!first.querySelector('[data-grocery-field=price]').value)list.innerHTML='';for(const example of [{name:'Milk',quantity:2,price:'3.99'},{name:'Eggs',quantity:1,price:'4.49'}])list.insertAdjacentHTML('beforeend',groceryItemRow(groceryRowIndex++,example));list.lastElementChild.querySelector('input').focus();return;}
  if(b.dataset.workflow){useWorkflow(b.dataset.workflow);return;}
  if(b.id==='new-workflow'){editWorkflow();return;}
  if(b.hasAttribute('data-save-workflow')){editWorkflow(null,current());return;}
  if(b.dataset.workflowEdit){editWorkflow(workflowById(b.dataset.workflowEdit));return;}
  if(b.dataset.cpuState){b.disabled=true;try{await api('workflows/state',{id:b.dataset.cpuState,version:Number(b.dataset.version),state:b.dataset.state});workflowItems=null;await loadWorkflows();}catch(e){toast(e.message);b.disabled=false;}return;}
  if(b.dataset.workflowDelete){if(!confirm('Remove this reusable workflow? Your conversations and files remain.'))return;b.disabled=true;try{await api('templates',{action:'remove',id:b.dataset.workflowDelete});workflowItems=null;await loadWorkflows();}catch(error){toast(error.message);}return;}
  if(b.dataset.editMessage!==undefined){const t=current(),i=Number(b.dataset.editMessage),m=t?.messages[i-(t.messageOffset||0)];if(!m)return;editing={key:t.id+':'+i,text:m.text};previousSignature='';render();const area=$('#msg-edit-'+i);area?.focus();area?.setSelectionRange(area.value.length,area.value.length);return;}
  if(b.dataset.editCancel!==undefined){editing=null;previousSignature='';render();return;}
  if(b.dataset.retryMessage!==undefined){const t=current(),i=Number(b.dataset.retryMessage),m=t?.messages[i-(t.messageOffset||0)];if(!m)return;b.disabled=true;try{await branchFrom(t,i,m.text);}catch(err){toast(err.message);b.disabled=false;}return;}
  if(b.hasAttribute('data-copy-message')){const t=current(),m=t?.messages[Number(b.dataset.copyMessage)-(t.messageOffset||0)];if(m)try{await navigator.clipboard.writeText(m.text);toast('Answer copied.');}catch{toast('Copy is unavailable. Select the answer text to copy it.');}return;}
  if(b.hasAttribute('data-task-pin')||b.hasAttribute('data-task-rename')||b.hasAttribute('data-task-project')){const t=current();if(!t)return;let fields={id:t.id};if(b.hasAttribute('data-task-pin'))fields.pinned=!t.pinned;else{const field=b.hasAttribute('data-task-rename')?'title':'project',value=prompt(field==='title'?'Conversation name':'Project (leave empty to remove)',t[field]||'');if(value===null)return;if(field==='title'&&!value.trim())return;fields[field]=value.trim();}b.disabled=true;try{const task=await api('task/update',fields);taskCache.set(task.id,task);await syncState();previousSignature='';render();}catch(error){toast(error.message);b.disabled=false;}return;}
  if(b.id==='ap-pin'){panelPinned=!panelPinned;try{localStorage.setItem('seek-panel-pinned',String(panelPinned));}catch{}b.setAttribute('aria-pressed',String(panelPinned));toast(panelPinned?'The inbox stays open beside your work on wide screens.':'The inbox closes when you move on.');if(panelPinned)openPanel();return;}
  if(b.id==='compare-files'){compareArtifacts();return;}
  if(b.id==='library-more'){libraryLimit+=100;previousSignature='';render();return;}
  if(b.dataset.revise){reviseArtifact(b.dataset.task,b.dataset.revise);return;}
  if(b.hasAttribute('data-model-restore')){b.disabled=true;try{await request('/qwen-image/api/restore',{}, {timeoutMs:660000});await syncState();render();toast('Your chat model is ready again.');}catch(error){toast(error.message);b.disabled=false;}return;}
  if(b.hasAttribute('data-archive-view')){showArchive=!showArchive;previousSignature='';render();return;}
  if(b.hasAttribute('data-older')){const task=current();if(!task?.nextBefore)return;b.disabled=true;try{const page=await api(`task?id=${encodeURIComponent(task.id)}&before=${task.nextBefore}`);task.messages=page.messages.concat(task.messages);task.messageOffset=page.messageOffset;task.nextBefore=page.nextBefore;previousSignature='';render();}catch(error){toast(error.message);b.disabled=false;}return;}
  if(b.dataset.select){document.querySelectorAll('dialog[open]').forEach(d=>d.close());selectTask(b.dataset.select);return;}
  if(b.dataset.view){document.querySelectorAll('dialog[open]').forEach(d=>d.close());navigate(b.dataset.view);if(b.dataset.look)setTimeout(()=>$('#look-editor')?.scrollIntoView({block:'center'}),60);return;}
  if(b.id==='buddy-top'){if(document.body.classList.contains('panel-open'))closePanel();else openPanel();return;}
  if(b.id==='ap-close'){panelPinned=false;try{localStorage.setItem('seek-panel-pinned','false');}catch{}closePanel();return;}
  if(b.dataset.ap){apTab=b.dataset.ap;apSig='';renderPanel();return;}
  if(b.dataset.filter){filter=b.dataset.filter;showArchive=false;previousSignature='';render();return;}
  if(b.dataset.idea){$('#prompt').value=b.dataset.idea;$('#prompt').focus();return;}
  if(b.dataset.preview){$('#search-dialog').close();inspectArtifact(b.dataset.task,b.dataset.preview);return;}
  if(b.dataset.suggest!==undefined){b.disabled=true;try{await api('suggestion',{id:selected,index:Number(b.dataset.suggest)});state=await api('state');previousSignature='';render();}catch(err){toast(err.message);}finally{b.disabled=false;}return;}
  if(b.dataset.ideas==='refresh'){void refreshIdeas();return;}
  if(b.dataset.ideaRun!==undefined){const idea=state.ideas?.items?.[Number(b.dataset.ideaRun)];if(!idea)return;b.disabled=true;try{const t=await createTask({objective:idea.request,mode:'task'});state=await api('state');selectTask(t.id);}catch(err){toast(err.message);}finally{b.disabled=false;}return;}
  if(b.dataset.pa){
    const id=b.dataset.task,act=b.dataset.pa;b.disabled=true;
    try{
      if(act==='approve'||act==='reject'){const review=b.closest('[data-proposal-id]');await api('control',{id,action:act,scope:b.dataset.scope,proposalId:review?.dataset.proposalId||undefined,fingerprint:review?.dataset.fingerprint||undefined});}
      else if(act==='handback')await api('control',{id,action:'handback'});
      else if(act==='control'){selectTask(id);setTimeout(()=>window.SeekBrowser?.open({control:true}),150);}
      else if(act==='answer')await api('control',{id,action:'reply',answer:b.dataset.reply});
      else if(act==='resume')await api('control',{id,action:'resume'});
      else if(act==='cancel')await api('control',{id,action:'stop'});
      else if(act==='unallow'){await api('always/remove',{host:b.dataset.host,label:b.dataset.label,...(b.dataset.fingerprint?{fingerprint:b.dataset.fingerprint}:{})});refreshAccounts();}
      state=await api('state');previousSignature='';apSig='';render();
    }catch(err){toast(err.message);}finally{b.disabled=false;}
    return;
  }
  if(b.dataset.action||b.dataset.answer){b.disabled=true;try{await api('control',{id:selected,action:b.dataset.action||'reply',answer:b.dataset.answer});state=await api('state');render();}catch(err){toast(err.message);}finally{b.disabled=false;}return;}
  if(b.id==='enable-alerts'){if('Notification'in window){const permission=await Notification.requestPermission();toast(permission==='granted'?'Browser alerts enabled.':'Alerts were not enabled. Task updates remain here.');}else toast('This browser does not support notifications.');}
});
$('#new-task').onclick=newChat;
$('#brand-home').onclick=e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();newChat();};
$('#image-mode').onclick=()=>setImageMode(!imageMode);
$('#menu').onclick=()=>setMenu(!document.body.classList.contains('menu-open'));
$('#close-menu').onclick=()=>setMenu(false);
$('#watch-browser').onclick=()=>window.SeekBrowser?.open();
// Deep links (Discord, notifications): /work?task=<id>&browser=1|control
{const q=new URLSearchParams(location.search);if(q.get('task')){view='chat';selected=q.get('task');}else if(q.has('view')){view=viewFor(q.get('view'));selected=null;}if(q.get('browser'))setTimeout(()=>window.SeekBrowser?.open({control:q.get('browser')==='control'}),300);history.replaceState({view,selected},'',location.href);}
$('#close-preview').onclick=()=>{$('#artifact-dialog').close();$('#preview-frame').src='about:blank';};
$('#schedule').onclick=openSchedule;
$('#schedule-dialog').addEventListener('close',()=>{if($('#schedule-dialog').returnValue==='save'){const raw=$('#run-at').value;if(!raw)return;const repeat=$('#repeat').value,timeZone=$('#schedule-zone').value.trim();try{new Intl.DateTimeFormat(undefined,{timeZone}).format();}catch{toast('Enter a valid time zone such as America/Chicago.');return;}let runAt;try{runAt=wallTimeToUTC(raw,timeZone);}catch(error){toast(error.message);return;}scheduled={runAt,...(repeat?{schedule:{kind:'calendar',frequency:repeat==='168'?'weekly':'daily',time:raw.slice(11,16),timeZone,weekdays:repeat==='168'?[new Date(raw+'Z').getUTCDay()]:[],missedRun:$('#schedule-missed').value}}:{})};$('#schedule-summary').textContent=repeat?`${repeat==='168'?'Weekly':'Daily'} · ${raw.slice(11,16)} · ${timeZone}`:when(Date.parse(scheduled.runAt));syncComposerChips();}});
function renderAttachments(){$('#attachments').innerHTML=(sourceArtifact?`<span class="attachment-chip">Revision source: ${esc(findArtifact(sourceArtifact.taskId,sourceArtifact.id).item?.title||'Selected file')}<button type="button" id="remove-source" aria-label="Remove revision source">${icon('x','ic-sm')}</button></span>`:'')+files.map((f,i)=>`<span class="attachment-chip">${esc(f.name)}<button type="button" data-remove="${i}" aria-label="Remove ${esc(f.name)}">${icon('x','ic-sm')}</button></span>`).join('');}
$('#attach').onclick=()=>$('#file-input').click();
$('#attachments').onclick=e=>{if(e.target.closest('#remove-source')){sourceArtifact=null;renderAttachments();return;}const b=e.target.closest('[data-remove]');if(b){files.splice(Number(b.dataset.remove),1);renderAttachments();}};
$('#file-input').onchange=async()=>{const chosen=[...$('#file-input').files];if(!chosen.length)return;uploading=true;$('#send').disabled=true;try{if(files.length+chosen.length>5||chosen.some(f=>f.size>8*1024*1024))throw new Error('Attach up to 5 files, each under 8 MB.');for(const f of chosen){$('#voice-status').textContent='Preparing attachment: '+f.name;const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(new Error('Could not read '+f.name));r.readAsDataURL(f);});files.push({name:f.name,data});renderAttachments();}$('#voice-status').textContent='Attachments ready. They will be sent with your request.';}catch(e){renderAttachments();toast(e.message);}finally{uploading=false;$('#send').disabled=submitting;$('#file-input').value='';}};
$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}});
$('#composer').onsubmit=async e=>{
  e.preventDefault();if(submitting||uploading)return;const input=$('#prompt').value.trim();if(!input)return;submitting=true;$('#send').disabled=true;
  voice?.stop();const target=selected,key=draftKey(),image=imageMode,attachments=files.slice(),schedule=scheduled,selection=$('#mode').value,desktopDeviceId=selection.startsWith('desktop:')?selection.slice(8):undefined,executionMode=selection==='browser'?'browser':undefined,mode=selection==='chat'?'chat':'task',source=sourceArtifact;saveDraft();$('#voice-status').textContent='Sending…';
  try{
    const bytes=new TextEncoder().encode(JSON.stringify([target,input,image,mode,desktopDeviceId,executionMode,schedule,attachments,source])),fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    if(submission?.fingerprint!==fingerprint)submission={fingerprint,id:crypto.randomUUID()};try{sessionStorage.setItem('seek-submission',JSON.stringify(submission));}catch{}
    const requestId=submission.id;
    const send=allowSecret=>target?api('control',{id:target,action:'reply',answer:input,files:attachments,allowSecret,requestId}):image?createImage({prompt:input,ratio:'square',steps:30},{onAccepted:()=>{imageMode=false;view='images';externalView='';previousSignature='';render();}}):api('task',{objective:input,mode,desktopDeviceId,executionMode,...schedule||{},files:attachments,sourceArtifact:source,allowSecret,requestId});
    let r;
    // Passwords typed in chat would reach the agent; the server refuses unless you insist.
    try{r=await send(false);}catch(err){if(err.code!=='secret'||!confirm(err.message+'\n\nSend it anyway?'))throw err;r=await send(true);}
    $('#voice-status').textContent='Received. '+(target?'Added instructions will appear in task progress.':'Your task is saved.');if(sourceArtifact===source)sourceArtifact=null;
    submission=null;try{sessionStorage.removeItem('seek-submission');}catch{}
    if(draftKey()===key){if($('#prompt').value.trim()===input)$('#prompt').value='';saveDraft();if(image){imageMode=false;view='images';externalView='';toast(r.warning||'Image saved to your gallery.');}else if(!target){const remaining=$('#prompt').value;selected=r.id;drafts.set(selected,remaining);drafts.delete('new');restoreDraft();saveDraft();}files=files.filter(file=>!attachments.includes(file));if(scheduled===schedule)scheduled=null;renderAttachments();$('#schedule-summary').textContent='';}
    await syncState();previousSignature='';render();
  }catch(err){$('#voice-status').textContent='Request not confirmed. Your draft is preserved.';toast(err.message);}finally{submitting=false;$('#send').disabled=false;}
};
document.addEventListener('submit',async event=>{
  const form=event.target;if(!['workflow-use','workflow-edit'].includes(form.id))return;event.preventDefault();const button=form.querySelector('.primary');if(button.disabled)return;button.disabled=true;
  const errorBox=form.querySelector('#workflow-form-error');if(errorBox)errorBox.hidden=true;form.querySelectorAll('[aria-invalid]').forEach(el=>{el.removeAttribute('aria-invalid');el.removeAttribute('aria-describedby');});
  try{const values=Object.fromEntries(new FormData(form));if(form.id==='workflow-use'&&activeWorkflow.routine){
      if(activeWorkflow.routine==='grocery_cart_plan')values.products=[...form.querySelectorAll('[data-grocery-item]')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-grocery-field]')].map(el=>[el.dataset.groceryField,el.value])));
      const input=workflowInput(activeWorkflow,values);
      const serialized=JSON.stringify(input);if(form.dataset.requestInput!==serialized){form.dataset.requestId=crypto.randomUUID();form.dataset.requestInput=serialized;}
      const task=await api('workflows/run',{id:activeWorkflow.routine,version:activeWorkflow.version||1,input,requestId:form.dataset.requestId});
      voice?.stop();$('#product-dialog').close();await syncState();selectTask(task.id);return;
    }if(form.id==='workflow-use'){const objective=templateObjective(activeWorkflow,values);voice?.stop();$('#product-dialog').close();saveDraft();selected=null;view='chat';imageMode=false;sourceArtifact=null;previousSignature='';$('#prompt').value=objective;saveDraft();render();$('#prompt').focus();}else{const fields=[...new Set([...values.objective.matchAll(/\{\{([\w-]+)\}\}/g)].map(x=>x[1]))].slice(0,10).map(name=>({name,label:name.replaceAll('-',' '),type:name==='date'?'date':name==='email'?'email':'text',required:true}));await api('templates',{action:form.dataset.id?'update':'save',id:form.dataset.id||undefined,taskId:form.dataset.task||undefined,...values,fields});workflowItems=null;$('#product-dialog').close();await loadWorkflows();toast('Workflow saved.');}}
  catch(error){if(errorBox){errorBox.textContent=error.message;errorBox.hidden=false;const product=/^product-(\d+)-(\w+)$/.exec(error.field||'');const field=product?form.querySelectorAll('[data-grocery-item]')[Number(product[1])]?.querySelector(`[data-grocery-field="${product[2]}"]`):error.field?[...form.elements].find(el=>el.name===error.field):null;if(field){field.closest('details')?.setAttribute('open','');field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby','workflow-form-error');field.focus();}else errorBox.focus();}else toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
});
document.addEventListener('submit',async e=>{if(e.target.id!=='memory-form')return;e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{await saveSettings({name:$('#agent-name').value,memory:$('#memory-text').value,look:lookDraft||state.settings.look,autonomy:{mode:document.querySelector('[name=autonomy]:checked')?.value||'autonomous',spendLimit:Number($('#spend-limit')?.value||250)}});lookDraft=null;toast('Changes saved.');render();}catch(err){toast(err.message);}finally{button.disabled=false;}});
document.addEventListener('change',async e=>{if(e.target.id!=='notifications')return;const on=e.target.checked;e.target.disabled=true;try{await saveSettings({notifications:on});toast(on?'You’ll see a message here when a task finishes or needs you.':'Messages in this tab are off.');}catch(err){e.target.checked=!on;toast(err.message);}finally{e.target.disabled=false;}});
document.addEventListener('submit',async e=>{const form=e.target.closest('[data-edit-form]');if(!form)return;e.preventDefault();const t=current(),button=form.querySelector('[type=submit]');if(!t)return;button.disabled=true;try{await branchFrom(t,Number(form.dataset.editForm),form.querySelector('textarea').value);}catch(err){toast(err.message);button.disabled=false;}});
document.addEventListener('input',e=>{if(editing&&e.target.closest?.('.msg-edit'))editing.text=e.target.value;});
document.addEventListener('submit',async e=>{if(e.target.id!=='native-form')return;e.preventDefault();const t=current();const answers=t.nativeRequest.questions.map((q,i)=>{const custom=$('#nq-text-'+i).value.trim();const selected=Array.from($('#nq-select-'+i)?.selectedOptions||[]).map(o=>o.value).filter(Boolean);return {id:q.id,selected:custom&&!q.multiSelect?[]:selected,...custom?{custom}:{}};});if(answers.some(a=>!a.custom&&!a.selected.length)){toast('Please answer each question.');return;}try{await api('respond',{id:t.id,answers});state=await api('state');render();}catch(err){toast(err.message);}});
// ── how the agent looks (work-buddy.js draws it) ────────────────────────────
function lookEditor(){
  const B=window.SeekBuddy;if(!B)return '';
  const look=lookDraft||state.settings.look||{},color=B.PALETTES[look.color]?look.color:'lavender',acc=B.ACCESSORIES[look.accessory]?look.accessory:'none';
  return `<div class="look-editor" id="look-editor"><div class="look-preview"><span class="buddy" data-buddy="preview"></span><span class="look-pose" data-pose-label></span></div><div><div class="look-label">COLOR</div><div class="look-row" role="radiogroup" aria-label="Color">${Object.entries(B.PALETTES).map(([k,p])=>`<label class="swatch" title="${esc(p.label)}"><input type="radio" name="look-color" value="${k}" ${k===color?'checked':''} aria-label="${esc(p.label)}"><span style="--sw-hi:${p.hi};--sw-mid:${p.mid};--sw-deep:${p.deep}"></span></label>`).join('')}</div><div class="look-label">WEARING</div><div class="look-row" role="radiogroup" aria-label="Accessory">${Object.entries(B.ACCESSORIES).map(([k,l])=>`<label class="chip"><input type="radio" name="look-acc" value="${k}" ${k===acc?'checked':''}><span>${esc(l)}</span></label>`).join('')}</div></div></div>`;
}
document.addEventListener('change',e=>{
  if(e.target.name!=='look-color'&&e.target.name!=='look-acc')return;
  const f=$('#memory-form');lookDraft={color:f.querySelector('[name=look-color]:checked').value,accessory:f.querySelector('[name=look-acc]:checked').value};
  window.SeekBuddy?.setLook(lookDraft);window.SeekBuddy?.cheer(document.querySelector('.look-preview .buddy'));
});
// The phone drawer shares the scrim; tapping it closes whichever is open.
$('#panel-scrim').onclick=()=>{setMenu(false);closePanel();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('panel-open'))closePanel();});
window.addEventListener('resize',()=>{apSig='';if(view==='chat'&&!selected)placeComposer();if(!matchMedia('(max-width:640px)').matches)setMenu(false);const wide=matchMedia('(min-width:1200px)').matches;if(document.body.classList.contains('panel-open')){if(wide){panelFocusCleanup?.();panelFocusCleanup=null;$('#agent-panel').removeAttribute('role');$('#agent-panel').removeAttribute('aria-modal');}else if(!panelFocusCleanup)openPanel();}else if(wide&&panelPinned)openPanel();renderPanel();});
$('#prompt').addEventListener('input',saveDraft);
document.addEventListener('input',event=>{if(event.target.id==='task-search'){searchQuery=event.target.value;previousSignature='';render();}});
document.addEventListener('input',event=>{if(event.target.id==='library-search'){libraryQuery=event.target.value;libraryLimit=100;libraryHits=null;clearTimeout(libraryTimer);const query=libraryQuery.trim(),sequence=++librarySequence;librarySearching=query.length>=2;if(librarySearching)libraryTimer=setTimeout(async()=>{try{const result=await api('library/search?q='+encodeURIComponent(query));if(sequence===librarySequence)libraryHits=result.hits||[];}catch{if(sequence===librarySequence)libraryHits=[];}finally{if(sequence===librarySequence){librarySearching=false;previousSignature='';render();}}},250);previousSignature='';render();}if(event.target.id==='workspace-query'){paletteQuery=event.target.value;renderPalette();clearTimeout(searchTimer);if(paletteQuery.trim().length>=2)searchTimer=setTimeout(()=>void runWorkspaceSearch(paletteQuery),160);}});
// Palette keys: arrows move, Enter opens, Home/End jump.
$('#workspace-query').addEventListener('keydown',e=>{const items=[...document.querySelectorAll('#workspace-search-results .palette-item')];if(!items.length)return;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();paletteIndex=(paletteIndex+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;paletteMark();}else if(e.key==='Home'&&e.ctrlKey||e.key==='End'&&e.ctrlKey){e.preventDefault();paletteIndex=e.key==='Home'?0:items.length-1;paletteMark();}else if(e.key==='Enter'&&!e.isComposing){e.preventDefault();items[paletteIndex]?.click();}});
$('#workspace-search-results').addEventListener('pointermove',e=>{const item=e.target.closest('.palette-item');if(!item)return;const items=[...document.querySelectorAll('#workspace-search-results .palette-item')],i=items.indexOf(item);if(i>=0&&i!==paletteIndex){paletteIndex=i;paletteMark();}});
document.addEventListener('change',event=>{if(event.target.id==='library-type'){libraryType=event.target.value;libraryLimit=100;previousSignature='';render();}if(event.target.id==='library-date'){libraryDate=event.target.value;libraryLimit=100;previousSignature='';render();}if(event.target.matches('[data-compare]')){const entry={taskId:event.target.dataset.task,id:event.target.dataset.compare};if(event.target.checked){if(compared.length>=2){event.target.checked=false;toast('Choose two outputs to compare.');return;}compared.push(entry);}else compared=compared.filter(x=>x.id!==entry.id||x.taskId!==entry.taskId);refreshCompare();}});
window.addEventListener('focus',()=>{if(view==='connections'){connectionsAt=0;void renderConnections(true);}});
window.addEventListener('popstate',event=>{saveDraft();const target=event.state||{view:'chat',selected:new URLSearchParams(location.search).get('task')};if(target.view==='inbox'){openPanel('approvals');return;}view=viewFor(target.view);selected=target.selected||null;sourceArtifact=null;closeMenus();restoreDraft();previousSignature='';externalView='';render();void loadCurrent(true).then(()=>{previousSignature='';render();}).catch(error=>toast(error.message));});
setInterval(()=>{if(document.hidden)return;for(const item of document.querySelectorAll('[data-work-elapsed]')){const seconds=Math.max(0,Math.floor(((Number(item.dataset.workFinished)||Date.now())-Number(item.dataset.workElapsed))/1000));item.textContent=seconds<60?seconds+'s elapsed':seconds<3600?Math.floor(seconds/60)+'m '+seconds%60+'s elapsed':seconds<86400?Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m elapsed':Math.floor(seconds/86400)+'d '+Math.floor(seconds%86400/3600)+'h elapsed';}},1000);
const voice=mountVoice({button:$('#voice-input'),input:$('#prompt'),status:$('#voice-status')});
for(const el of document.querySelectorAll('[data-kbd]'))el.textContent=el.dataset.kbd==='search'?(isMac?'⌘K':'Ctrl K'):(isMac?'⇧⌘O':'Ctrl ⇧ O');
restoreDraft();decorateTabs();connectEvents();refreshMemoryReview(true);poll();

// Choose a paired computer from any device. Its saved remote-control preference is the standing permission.
async function refreshComputerTargets(){const select=document.querySelector("#mode");if(!select||document.hidden)return;try{const d=await api("desktop"),selected=select.value;let group=select.querySelector("optgroup");if(!group){group=document.createElement("optgroup");group.label="Your computers";select.append(group);}group.replaceChildren(...d.computers.filter(m=>m.verified&&m.remoteGrant).map(m=>{const o=new Option(m.name+(m.online?"":" · offline"),"desktop:"+m.id);o.disabled=!m.online||m.state==="agent";return o;}));if([...select.options].some(o=>o.value===selected))select.value=selected;}catch{}}
void refreshComputerTargets();setInterval(refreshComputerTargets,15000);document.querySelector("#mode").addEventListener("focus",()=>void refreshComputerTargets());
