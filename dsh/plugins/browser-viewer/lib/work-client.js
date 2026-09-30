import {md,CARET} from '/work/markdown.js';
import {renderDreaming} from '/work/dreaming.js';
const $=s=>document.querySelector(s);
let state={settings:{name:'Seek'},tasks:[]},view='chat',selected=null,filter='all',scheduled=null,files=[],previousSignature='',firstPoll=true,ideasBusy=false,online=true,lookDraft=null,imageMode=false;
const VIEWS=['chat','tasks','files','memory','ideas','inbox','finance','connections','images'];
try { const saved=JSON.parse(localStorage.getItem('seek-work-view')||'null'); if(saved&&VIEWS.includes(saved.view)){view=saved.view;selected=saved.selected||null;} } catch {}
const labels={queued:'Up next',scheduled:'Scheduled',running:'Working',waiting:'Needs you',attention:'Needs attention',paused:'Paused',stopped:'Stopped',complete:'Done'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=n=>new Date(n).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const current=()=>state.tasks.find(t=>t.id===selected);
const needsYou=()=>state.tasks.filter(t=>t.status==='waiting'||t.status==='attention'||t.handoff||t.approval);
// Icons come from the SVG sprite in work.html.
const icon=(n,c='')=>`<svg class="ic${c?' '+c:''}" aria-hidden="true" focusable="false"><use href="#i-${n}"/></svg>`;
const pill=t=>`<span class="status ${esc(t.status)}">${labels[t.status]||esc(t.status)}</span>`;
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6000);}
async function api(path,body){
  const res=await fetch('/work/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await res.json();
  if(!res.ok){const err=new Error(data.error||'Unable to reach your agent.');err.code=data.code;throw err;}
  return data;
}
let connectionsCache=null,connectionsAt=0,connectionsBusy=false,appSearchResults=null;
async function renderConnections(fresh=false){
  const main=$('#main');
  if(!connectionsCache&&view==='connections')main.innerHTML='<section class="memory"><h2 class="section-heading">Connections</h2><p class="section-copy">Checking connected apps…</p></section>';
  if((fresh||Date.now()-connectionsAt>30000)&&!connectionsBusy){
    connectionsBusy=true;
    try{connectionsCache=await api('connections'+(fresh?'?fresh=1':''));connectionsAt=Date.now();}
    catch(e){if(view==='connections')main.innerHTML=`<section class="memory"><h2 class="section-heading">Connections</h2><p class="section-copy">${esc(e.message)}</p></section>`;connectionsBusy=false;return;}
    connectionsBusy=false;
  }
  if(view!=='connections'||!connectionsCache)return;
  const c=connectionsCache;
  const signature=JSON.stringify([c,appSearchResults]);
  if(main.dataset.seekConnectionsSig===signature)return;
  main.dataset.seekConnectionsSig=signature;
  const card=(title,item)=>`<div class="file-card"><span class="file-icon">${icon(item.connected||item.ready?'check-circle':'plug')}</span><div><strong>${esc(title)} · ${item.connected?'Connected':item.ready?'Ready':'Setup needed'}</strong><p>${esc(item.detail||'')}</p></div></div>`;
  const others=Object.entries(c.mcp||{}).filter(([name])=>name!=='google').map(([name,item])=>card(name,{connected:true,detail:`${item.tools.length} API tools available.`})).join('');
  const pd=c.pipedream||{configured:false,connected:false,accounts:[],detail:'Set up Pipedream Connect to link more apps.'};
  const accounts=(pd.accounts||[]).map(a=>`<li><strong>${esc(a.name)}</strong> · ${esc(a.accountName||a.app)} · ${a.healthy?'Connected':'Needs reconnect'}</li>`).join('');
  const setup=!pd.configured&&c.canConfigure?`<form id="pd-config" class="connection-form"><h3>Set up Pipedream Connect</h3><p>Enter your Connect project credentials on this PC. They are encrypted for this Windows account and never shown to Seek.</p><input name="clientId" placeholder="Client ID" autocomplete="off" required><input name="clientSecret" type="password" placeholder="Client secret" autocomplete="off" required><input name="projectId" placeholder="Project ID (proj_…)" autocomplete="off" required><select name="environment"><option value="development">Development</option><option value="production">Production</option></select><button class="primary">Save connection</button></form>`:'';
  const catalog=pd.configured?`<form id="pd-search" class="connection-form"><h3>Find an app</h3><p>Search Pipedream’s catalog, then connect an account through its hosted sign-in page.</p><div class="connection-search"><input name="query" placeholder="Gmail, Slack, Notion, GitHub…" minlength="2" required><button>Search</button><button type="button" data-app-refresh>Refresh accounts</button></div></form>${appSearchResults?`<div class="file-cards">${appSearchResults.apps.map(a=>`<div class="file-card"><span class="file-icon">◎</span><div><strong>${esc(a.name)}</strong><p>${esc(a.description||a.slug)}</p><button data-app-connect="${esc(a.slug)}">Connect account</button></div></div>`).join('')||'<p>No matching apps with actions were found.</p>'}</div>`:''}`:'';
  main.innerHTML=`<section class="memory"><h2 class="section-heading">Connections</h2><p class="section-copy">Seek uses connected app tools for supported requests and opens the browser when a site needs it.</p><div class="file-cards">${card('Discord',c.discord)}${card('Pipedream app catalog',{...pd,ready:pd.configured})}${card('Built-in Google connection',c.google)}${card('Plaid Finance',c.finance)}${others}${card('Browser', {connected:c.browser.available,detail:c.browser.detail})}</div>${accounts?`<h3>Linked app accounts</h3><ul class="site-list">${accounts}</ul>`:''}${setup}${catalog}${!pd.configured?'<p class="section-copy">Create a Connect project at <a href="https://pipedream.com" target="_blank" rel="noopener noreferrer">Pipedream</a> to unlock the app catalog.</p>':''}</section>`;
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
  const connect=e.target.closest('[data-app-connect]'),refresh=e.target.closest('[data-app-refresh]');if(!connect&&!refresh)return;
  if(refresh){connectionsAt=0;await renderConnections(true);return;}
  const popup=window.open('about:blank','_blank');
  if(!popup){toast('Allow popups to connect an app.');return;}
  try{const result=await api('apps/connect-link',{app:connect.dataset.appConnect});popup.location.href=result.url;toast('Finish connecting the account in the new tab, then refresh accounts here.');}
  catch(err){popup.close();toast(err.message);}
});
function linkify(value){return esc(value).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,(_m,label,url)=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);}
function artifactUrl(t,a,preview=false){return `/work/api/artifact?task=${encodeURIComponent(t.id)}&id=${encodeURIComponent(a.id)}${preview?'&preview=1':''}`;}
function artifact(t,a){return `<div class="file-card"><span class="file-icon">${icon('doc')}</span><div><strong>${esc(a.title)}</strong><a href="${artifactUrl(t,a)}" download>Download</a><button data-preview="${a.id}" data-task="${t.id}">Preview</button></div></div>`;}
function selectTask(id){selected=id;view='chat';previousSignature='';$('#prompt').value='';scheduled=null;files=[];lookDraft=null;closePanel();render();document.body.classList.remove('menu-open');}
function navigate(next){view=next;imageMode=false;previousSignature='';lookDraft=null;closePanel();render();$('#main').scrollTop=0;document.body.classList.remove('menu-open');}
// The agent panel is docked on wide screens; below that the buddy opens it as a sheet (like tapping Muse's avatar).
function openPanel(){if(matchMedia('(min-width:1200px)').matches)return;document.body.classList.add('panel-open');apSig='';renderPanel();}
function closePanel(){document.body.classList.remove('panel-open');}

// New replies are written out while the buddy types them.
let typing=null,typeTimer=0;const seenMsgs=new Map();
function watchMessages(t){
  if(!t)return;
  const n=t.messages.length,prev=seenMsgs.get(t.id);seenMsgs.set(t.id,n);
  if(prev===undefined||n<=prev||typing||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const m=t.messages[n-1];if(m.role!=='assistant'||!m.text)return;
  const full=m.text,step=Math.max(2,Math.ceil(full.length/150)),key=t.id+':'+(n-1);
  typing={key,shown:0};window.SeekBuddy?.hold('type',Math.min(3200,Math.ceil(full.length/step)*16+500));
  typeTimer=setInterval(()=>{
    typing.shown=Math.min(full.length,typing.shown+step);
    const el=document.querySelector(`[data-msg="${key}"] .msg-text`);
    if(el){el.innerHTML=md(full.slice(0,typing.shown)+(typing.shown<full.length?CARET:'')).replace(CARET,'<span class="caret"></span>');const main=$('#main');if(main.scrollHeight-main.scrollTop-main.clientHeight<160)main.scrollTo({top:main.scrollHeight,behavior:'instant'});}
    if(typing.shown>=full.length){clearInterval(typeTimer);typing=null;previousSignature='';render();}
  },16);
}

function render(){
  try { localStorage.setItem('seek-work-view',JSON.stringify({view,selected})); } catch {}
  const t=current(),waiting=needsYou().length;
  document.querySelectorAll('[data-agent-name]').forEach(e=>e.textContent=state.settings.name);document.title=`${waiting?`(${waiting}) `:''}${state.settings.name} · Work`;
  document.body.classList.toggle('has-hero',view==='chat'&&!t);
  if(view==='chat')watchMessages(t);
  window.SeekBuddy?.setLook(lookDraft||state.settings.look);window.SeekBuddy?.update(state,{online});
  document.querySelectorAll('nav [data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#active-count').textContent=state.tasks.filter(t=>['running','waiting','queued'].includes(t.status)).length||'';
  for(const id of ['#inbox-count','#bb-count','#ap-count'])$(id).textContent=waiting||'';
  $('#recent').innerHTML=[...state.tasks].reverse().slice(0,30).map(t=>`<button data-select="${t.id}" class="${selected===t.id?'selected':''}" title="${esc(t.title)}">${t.status==='running'?'<i class="st run"></i>':t.status==='waiting'?'<i class="st wait"></i>':''}${esc(t.title)}</button>`).join('');
  $('#composer-area').hidden=view!=='chat';
  $('#page-title').textContent=view==='chat'?(t?.title.slice(0,48)||'Conversations'):{tasks:'Your tasks',files:'Made for you',memory:'Memory & preferences',ideas:'Ideas',inbox:'Needs you',images:'Images',finance:'Finance',connections:'Connections'}[view];
  $('#page-subtitle').textContent=t&&view==='chat'?(t.activity||'A conversation with your agent'):'A little less to do. A little more room to think.';
  $('#prompt').placeholder=t?'Add a detail, answer a question, or steer the task…':imageMode?'Describe the image you want to create…':'Tell me what you want to get done…';
  $('#mode').hidden=!!t||imageMode;$('#schedule').hidden=!!t||imageMode;$('#attach').hidden=!!t||imageMode;$('#image-mode').hidden=!!t;$('#image-mode').classList.toggle('active',imageMode);
  $('#composer-hint').textContent=t?'You can add details while I work. Pause or stop whenever you need.':imageMode?'Image mode uses Qwen Image 2.1 locally. You can refine the result in Images.':'I’ll work through the steps and bring back the result. You can leave this page.';
  renderPanel();
  if(view!=='connections')delete $('#main').dataset.seekConnectionsSig;
  if(view==='memory'){renderMemory();renderDreaming({api,toast});return;}
  if(view==='connections'){void renderConnections();return;}
  if(view==='finance'){window.SeekFinance?.render();return;}
  if(view==='images'){window.SeekImages?.render();return;}
  const signature=JSON.stringify([view,selected,filter,view==='chat'?t||[state.settings,state.ideas]:view==='ideas'?[state.ideas,ideasBusy]:state.tasks]);
  const browserTask=view==='chat'?t:null;
  if(signature===previousSignature){window.SeekBrowser?.refresh(browserTask,state.settings.name);return;}previousSignature=signature;
  const main=$('#main'),nearBottom=main.scrollHeight-main.scrollTop-main.clientHeight<120,oldScroll=main.scrollTop;
  if(view==='chat')main.innerHTML=t?conversation(t):welcome();
  if(view==='tasks')main.innerHTML=taskBoard();
  if(view==='ideas')main.innerHTML=ideasView();
  if(view==='inbox')main.innerHTML=`<section class="inbox"><h2 class="section-heading">Needs you</h2><div class="ap-list">${approvalsHtml()}</div><h3 class="inbox-sub">Upcoming</h3><div class="ap-list">${upcomingHtml()}</div><h3 class="inbox-sub">Recent activity</h3>${activityHtml(15)}</section>`;
  if(view==='files')main.innerHTML=`<h2 class="section-heading">Made for you</h2><p class="section-copy">Finished work, ready to open and use.</p><div class="file-cards">${state.tasks.flatMap(t=>(t.artifacts||[]).map(a=>artifact(t,a))).join('')||'<div class="empty">Reports, documents and other deliverables will appear here.</div>'}</div>`;
  if(view==='chat'&&t&&nearBottom)main.scrollTop=main.scrollHeight;else main.scrollTop=oldScroll;
  requestAnimationFrame(()=>{for(const bar of document.querySelectorAll('.batch-bar i[data-to]'))bar.style.width=bar.dataset.to+'%';});
  window.SeekBrowser?.refresh(browserTask,state.settings.name);
}

function welcome(){
  const ideas=(state.ideas?.items||[]).slice(0,3);
  const cards=ideas.length?ideas.map(i=>`<button class="idea" data-idea="${esc(i.request)}"><i>${icon('sparkles')}</i>${esc(i.title)}<small>${esc(i.why)}</small></button>`).join('')
    :`<button class="idea" data-idea="Research a topic for me and create a concise, sourced report. Ask me what topic I have in mind."><i>${icon('search')}</i>Research something deeply<small>A clear answer, with sources</small></button><button class="idea" data-idea="Help me plan a trip, compare options and make an itinerary. Ask me for my destination, dates and budget."><i>${icon('sparkles')}</i>Make a plan I can use<small>Turn an idea into next steps</small></button><button class="idea" data-idea="Analyze the files I attach and create a useful summary with the key findings. Ask for the files if none are attached."><i>${icon('folder')}</i>Make sense of my files<small>Find the details that matter</small></button>`;
  return `<section class="welcome"><div class="buddy-stage hero" data-stage="hero"><span class="buddy" data-buddy="hero" data-track></span><span class="buddy-say" role="status"></span></div><div class="eyebrow">A little help, all the way through</div><h2>What can I take off<br>your plate?</h2><p>Give me the outcome you want. I’ll work out the steps, get started, and keep you in the loop.</p><div class="ideas">${cards}</div></section>`;
}

// The thread runs in the order things happened: requests and replies, the browser where
// it was used, files where they were made. Live status and next steps stay at the end.
const seenItems=new Map();
const BROWSER_EVENT=/browser|a page|the page|form|option|human check|sign in|approval/i,FILE_EVENT=/creating a file|updating a file/i;
function bubble(t,m,i){
  const key=t.id+':'+i,live=typing?.key===key,mine=m.role==='user';
  const text=mine?linkify(m.text):live?md(m.text.slice(0,typing.shown)+CARET).replace(CARET,'<span class="caret"></span>'):md(m.text);
  return `<div class="bubble ${m.role}" data-msg="${key}"><div class="speaker">${mine?'YOU':`<span class="buddy" data-buddy="face"></span>${esc(state.settings.name.toUpperCase())}`}</div><div class="msg-text${mine?'':' md'}">${text}</div></div>`;
}
function thread(t){
  const events=t.events||[],asked=t.messages.findLast(m=>m.role==='user')?.time||t.createdAt||0;
  // Older tasks have no timestamps for the browser or files, so read them off the activity log.
  const browserEvents=events.filter(e=>BROWSER_EVENT.test(e.text)),fileEvent=events.findLast(e=>FILE_EVENT.test(e.text));
  const items=t.messages.map((m,i)=>({key:'m'+i,at:m.time||0,rank:0,html:bubble(t,m,i)}));
  if(t.plan?.length)items.push({key:'plan',at:asked,rank:1,html:`<div class="plan"><div class="plan-title">THE PLAN</div><ol>${t.plan.map(p=>`<li class="${esc(p.status)}"><span>${icon(p.status==='done'?'check-circle':p.status==='working'?'circle-dot':'circle-dash')}</span>${esc(p.title)}</li>`).join('')}</ol></div>`});
  const card=window.SeekBrowser?.card(t);
  if(card)items.push({key:'browser',at:t.approval?.at||t.handoff?.at||t.browserAt||(browserEvents.find(e=>e.time>=asked)||browserEvents.at(-1))?.time||asked,rank:2,html:card});
  for(const a of t.artifacts||[])items.push({key:'f'+a.id,at:a.at||fileEvent?.time||asked,rank:3,html:`<div class="file-cards">${artifact(t,a)}</div>`});
  // Items that arrive while you watch ease in; what was already on screen doesn't replay on re-render.
  const seen=seenItems.get(t.id);seenItems.set(t.id,new Set(items.map(x=>x.key)));
  return items.sort((a,b)=>a.at-b.at||a.rank-b.rank).map(x=>seen&&!seen.has(x.key)?`<div class="enter">${x.html}</div>`:x.html).join('');
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
  const controls=['running','queued','scheduled','waiting','attention'].includes(t.status)?'<button data-action="pause">Pause</button><button data-action="stop">Stop</button>':['paused','stopped','attention'].includes(t.status)?'<button data-action="resume">Resume</button>':'';
  const suggestions=t.suggestions?.length&&t.status!=='running'?`<div class="suggest"><div class="suggest-label">Tap to make it happen</div>${t.suggestions.map((s,i)=>`<button data-suggest="${i}">${esc(s.label)}</button>`).join('')}</div>`:'';
  const ask=t.question&&!['handoff','approval'].includes(t.question.kind)?`<div class="ask-card"><div class="ask-head"><span class="buddy" data-buddy="mini" data-task="${t.id}"></span><strong>A MOMENT FOR YOU</strong></div><div class="md">${md(t.question.text)}</div>${t.nativeRequest?.type==='question/requested'?nativeQuestions(t):''}<div class="choices">${(t.question.choices||[]).map(c=>`<button data-answer="${esc(c)}">${esc(c)}</button>`).join('')}</div><p class="muted">Reply below${t.status==='waiting'?' when you’re ready. The task is paused.':'.'}</p></div>`:'';
  const status=t.status==='running'&&t.batch?batchRow(t,t.batch):t.status==='running'?`<div class="typing-row"><span class="buddy" data-buddy="inline" data-task="${t.id}"></span><div class="typing-bubble"><span>${esc(t.activity||'Working on it')}</span><span class="tdots"><i></i><i></i><i></i></span></div></div>`
    :t.status==='queued'?`<div class="typing-row quiet"><span class="buddy" data-buddy="inline" data-task="${t.id}"></span><div class="typing-bubble">I’ll start when the current task is finished.</div></div>`
    :t.status==='scheduled'?`<div class="activity">Starts ${when(t.runAt)}${t.repeatHours?` · repeats every ${t.repeatHours} hours`:''}</div>`:'';
  return `<section class="conversation"><h2 class="conv-title">${esc(t.title)}</h2><div class="task-meta">${pill(t)}<div class="task-controls">${t.status==='attention'?'<button data-action="resume">Try again</button>':''}${controls}</div></div>${thread(t)}${ask}${t.error?`<p class="error-line">${esc(t.error)}</p>`:''}${status}${suggestions}${t.events?.length?`<details><summary>Activity · ${t.events.length} updates</summary><ul>${t.events.slice(-30).map(e=>`<li>${when(e.time)} · ${esc(e.text)}</li>`).join('')}</ul></details>`:''}</section>`;
}
function nativeQuestions(t){return `<form id="native-form">${t.nativeRequest.questions.map((q,i)=>`<label class="native-question">${esc(q.question)}${q.options?.length?`<select id="nq-select-${i}" ${q.multiSelect?'multiple':''}><option value="">Write an answer below</option>${q.options.map(o=>`<option value="${esc(o.label)}">${esc(o.label)}</option>`).join('')}</select>`:''}<input id="nq-text-${i}" type="text" placeholder="Your answer"></label>`).join('')}<button type="submit" class="primary">Send answers</button></form>`;}
function taskBoard(){const categories={all:'Everything',running:'In progress',waiting:'Needs you',scheduled:'Scheduled',complete:'Finished'};const tasks=[...state.tasks].reverse().filter(t=>filter==='all'||filter==='running'&&['running','queued'].includes(t.status)||filter==='waiting'&&['waiting','attention','paused'].includes(t.status)||t.status===filter);return `<h2 class="section-heading">I’m on it.</h2><p class="section-copy">A place for everything you’ve handed over. Tasks run one at a time so they can use the browser without getting in each other’s way.</p><div class="filters">${Object.entries(categories).map(([key,label])=>`<button data-filter="${key}" class="${filter===key?'selected':''}">${label}</button>`).join('')}</div><div class="task-grid">${tasks.map(t=>`<button class="task-card" data-select="${t.id}">${pill(t)}<h3>${esc(t.title)}</h3><p>${esc(t.activity||'Ready when you are')}</p><time>${when(t.updatedAt)}</time></button>`).join('')||'<div class="empty">Nothing here yet. Start a conversation and give me a task.</div>'}</div>`;}

// ── ideas (proactive suggestions from the local model) ──────────────────────
function ideasView(){
  const ideas=state.ideas?.items||[];
  return `<section class="ideas-view"><h2 class="section-heading">Ideas for you</h2><p class="section-copy">Things I could take off your plate, based on what you’ve asked me before and what you’ve told me to remember.${state.ideas?.at?` Updated ${when(state.ideas.at)}.`:''}</p><button type="button" data-ideas="refresh" ${ideasBusy?'disabled':''}>${ideasBusy?'Thinking up ideas…':ideas.length?'Refresh ideas':'Suggest some ideas'}</button><div class="idea-grid">${ideas.map((i,n)=>`<div class="idea-card"><h3>${esc(i.title)}</h3><p>${esc(i.why)}</p><button class="primary" data-idea-run="${n}">Do it</button></div>`).join('')||`<div class="empty">${ideasBusy?'Looking at what you’ve asked me before…':'No ideas yet. Tap “Suggest some ideas”.'}</div>`}</div></section>`;
}

// ── agent panel: Approvals · Activity · Upcoming · Identity (like Muse) ─────
function approvalsHtml(){
  const list=needsYou();
  if(!list.length)return '<p class="ap-empty">Nothing needs you right now.</p>';
  return list.map(t=>{
    const head=`<button class="ap-task" data-select="${t.id}">${esc(t.title)}</button>`;
    if(t.approval)return `<div class="ap-item approve">${head}<p>${esc(t.question?.text||`Press “${t.approval.label}” on ${t.approval.host}?`)}</p><div class="ap-actions"><button class="primary" data-pa="approve" data-scope="once" data-task="${t.id}">Approve once</button><button data-pa="approve" data-scope="task" data-task="${t.id}">For this task</button><button data-pa="approve" data-scope="always" data-task="${t.id}">Always on this site</button><button data-pa="reject" data-task="${t.id}">Reject</button></div></div>`;
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
let apTab='approvals',apSig='';
function renderPanel(){
  const panel=$('#agent-panel');
  if(!panel||getComputedStyle(panel).display==='none')return;
  const running=state.tasks.find(t=>t.status==='running'),waiting=needsYou().length;
  $('#ap-status').textContent=running?`Working: ${running.title}`:waiting?`${waiting} waiting on you`:'Ready to help';
  document.querySelectorAll('[data-ap]').forEach(b=>b.classList.toggle('active',b.dataset.ap===apTab));
  if(apTab==='identity'){const sig='identity:'+state.settings.name;if(apSig!==sig){apSig=sig;$('#ap-body').innerHTML=`<div class="id-card"><span class="buddy" data-buddy="id"></span><div><strong>${esc(state.settings.name)}</strong><span class="id-sub">Your personal agent</span><button data-view="memory" data-look="1">Edit name & look</button></div></div><div class="acct compact">Loading…</div>`;renderAccount($('#ap-body .acct'));}return;}
  const html=apTab==='approvals'?`<div class="ap-list">${approvalsHtml()}</div>`:apTab==='upcoming'?`<div class="ap-list">${upcomingHtml()}</div>`:activityHtml();
  if(apTab+html!==apSig){apSig=apTab+html;$('#ap-body').innerHTML=html;}
}

// ── memory & identity (vault, signed-in sites, always-allowed, notifications) ──
function renderMemory(){if($('#memory-form'))return;$('#main').innerHTML=`<section class="memory"><h2 class="section-heading">Make this your own.</h2><p class="section-copy">These are the things I’ll keep in mind when starting new tasks. You decide what belongs here.</p><form id="memory-form"><label for="agent-name">Your agent’s name</label><input id="agent-name" type="text" maxlength="40" value="${esc(state.settings.name)}" required><label>How ${esc(state.settings.name)} looks</label>${lookEditor()}<label for="memory-text">What should I remember about you?</label><textarea id="memory-text" maxlength="20000" placeholder="Your preferences, writing style, usual constraints, or things you want me to know…">${esc(state.settings.memory||'')}</textarea><p class="muted">Avoid passwords and API keys. Sign in directly in the browser instead.</p><label class="check"><input type="checkbox" id="notifications" ${state.settings.notifications?'checked':''}>Show alerts for completed tasks and requests for input</label><button type="button" id="enable-alerts">Enable browser alerts</button><button type="submit" class="primary">Save preferences</button></form><p class="section-copy">Work continues when you close this page, while this computer and the harness stay running. Scheduled tasks that fall due while the harness is offline run when it returns.</p></section><section class="memory account"><h2 class="section-heading">Passwords, sign-ins & notifications</h2><p class="section-copy">${esc(state.settings.name)} never sees your passwords. Saved logins are filled only after you approve each one.</p><div class="acct">Loading…</div></section>`;renderAccount($('#main .acct'));}

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
  let a;try{a=await api(fresh?'account?fresh=1':'account');}catch(e){el.textContent=e.message;return;}
  const v=a.vault,name=esc(state.settings.name),until=n=>new Date(n).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  const vault=v.state==='unlocked'?`<p><span class="vault-dot on"></span>Unlocked until ${until(v.until)} · ${v.logins} saved logins available. Each sign-in still asks for your approval.</p><button type="button" data-acct="lock">Lock now</button>`
    :v.state==='locked'?(v.canUnlock?`<p>Connected and locked. Unlock it so ${name} can offer to sign in for you. Your master password is used once, on this PC, to unlock Bitwarden. It isn’t stored or shown to the agent.</p><form data-acct-form="unlock" class="vault-unlock"><input type="password" name="password" autocomplete="current-password" placeholder="Bitwarden master password" aria-label="Bitwarden master password" required><select name="minutes" aria-label="Keep unlocked"><option value="15">for 15 minutes</option><option value="60" selected>for 1 hour</option><option value="480">for 8 hours</option></select><button class="primary">Unlock</button></form>`:`<p>Locked. For safety, unlock it from Seek on your PC, so your master password never crosses the internet.</p>`)
    :v.state==='unauthenticated'?`<p>Connect Bitwarden once: open a terminal on this PC, run <code>bw login</code>, then refresh.</p><button type="button" data-acct="refresh">Refresh</button>`
    :`<p>${v.state==='missing'?'The Bitwarden CLI isn’t installed on this PC.':'Couldn’t read the Bitwarden CLI status.'}</p><button type="button" data-acct="refresh">Refresh</button>`;
  const sites=a.sites.length?`<ul class="site-list">${a.sites.map(s=>`<li><div><strong>${esc(s.site)}</strong><span>${s.via==='vault'?'Signed in with your vault':'Signed in by you'} · ${when(s.at)}${s.cookies===0?' · session ended':''}</span></div><button type="button" data-signout="${esc(s.site)}">Sign out</button></li>`).join('')}</ul>`:'<p class="muted">None yet. Sites appear here after you sign in during a task.</p>';
  const always=a.always?.length?`<ul class="site-list">${a.always.map(x=>`<li><div><strong>${esc(x.label)}</strong><span>${esc(x.host)} · allowed ${when(x.at)}</span></div><button type="button" data-pa="unallow" data-host="${esc(x.host)}" data-label="${esc(x.label)}">Remove</button></li>`).join('')}</ul>`:'<p class="muted">None. Actions you approve with “Always on this site” show up here, and you can take them back.</p>';
  const directLocal=['127.0.0.1','localhost'].includes(location.hostname)&&location.port==='3080';
  const familyUrl=directLocal?'http://127.0.0.1:18799/family':'/family';
  el.innerHTML=`<div class="account-card"><h3>Partner access</h3><p>A second login can open this same workspace. Chats, tasks, files, memory, finance and connected apps are shared.</p><a href="${familyUrl}" target="_blank" rel="noopener noreferrer">Manage partner login →</a>${directLocal?'':'<p><a href="/logout">Sign out of this browser</a></p>'}</div><div class="account-card"><h3>Password vault (Bitwarden)</h3>${vault}</div><div class="account-card"><h3>Signed-in sites</h3><p class="muted">Where ${name}’s browser is signed in. Signing out clears that site’s cookies and storage in the agent’s browser only.</p>${sites}<button type="button" data-acct="signout-all">Sign out of all sites</button></div><div class="account-card"><h3>Always-allowed actions</h3>${always}</div><div class="account-card"><h3>Notifications on this device</h3>${await pushHtml()}</div>`;
}
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

async function poll(){try{const next=await api('state');$('#connection').textContent='Ready to help';document.querySelector('.online-dot').style.background='#5f9c80';if(!firstPoll&&next.settings.notifications){for(const t of next.tasks){const before=state.tasks.find(x=>x.id===t.id);if(before&&before.status!==t.status&&['complete','waiting','attention'].includes(t.status)){toast(`${t.status==='complete'?'Finished':'Needs you'}: ${t.title}`);if(document.hidden&&'Notification'in window&&Notification.permission==='granted')new Notification(`${next.settings.name}: ${labels[t.status]}`,{body:t.title,tag:t.id});}}}firstPoll=false;state=next;online=true;render();}catch(e){$('#connection').textContent='Reconnecting…';document.querySelector('.online-dot').style.background='#bf9e62';online=false;window.SeekBuddy?.update(state,{online:false});}finally{setTimeout(poll,2000);}}

document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.select){selectTask(b.dataset.select);return;}
  if(b.dataset.view){navigate(b.dataset.view);if(b.dataset.look)setTimeout(()=>$('#look-editor')?.scrollIntoView({block:'center'}),60);return;}
  if(b.id==='buddy-top'){openPanel();return;}
  if(b.id==='ap-close'){closePanel();return;}
  if(b.dataset.ap){apTab=b.dataset.ap;apSig='';renderPanel();return;}
  if(b.dataset.filter){filter=b.dataset.filter;render();return;}
  if(b.dataset.idea){$('#prompt').value=b.dataset.idea;$('#prompt').focus();return;}
  if(b.dataset.preview){const t=state.tasks.find(t=>t.id===b.dataset.task),a=t.artifacts.find(a=>a.id===b.dataset.preview);$('#preview-title').textContent=a.title;$('#preview-frame').src=artifactUrl(t,a,true);$('#artifact-dialog').showModal();return;}
  if(b.dataset.suggest!==undefined){b.disabled=true;try{await api('suggestion',{id:selected,index:Number(b.dataset.suggest)});state=await api('state');previousSignature='';render();}catch(err){toast(err.message);}finally{b.disabled=false;}return;}
  if(b.dataset.ideas==='refresh'){ideasBusy=true;render();try{await api('ideas/refresh',{});state=await api('state');}catch(err){toast(err.message);}finally{ideasBusy=false;previousSignature='';render();}return;}
  if(b.dataset.ideaRun!==undefined){const idea=state.ideas?.items?.[Number(b.dataset.ideaRun)];if(!idea)return;b.disabled=true;try{const t=await api('task',{objective:idea.request,mode:'task'});state=await api('state');selectTask(t.id);}catch(err){toast(err.message);}finally{b.disabled=false;}return;}
  if(b.dataset.pa){
    const id=b.dataset.task,act=b.dataset.pa;b.disabled=true;
    try{
      if(act==='approve'||act==='reject')await api('control',{id,action:act,scope:b.dataset.scope});
      else if(act==='handback')await api('control',{id,action:'handback'});
      else if(act==='control'){selectTask(id);setTimeout(()=>window.SeekBrowser?.open({control:true}),150);}
      else if(act==='answer')await api('control',{id,action:'reply',answer:b.dataset.reply});
      else if(act==='resume')await api('control',{id,action:'resume'});
      else if(act==='cancel')await api('control',{id,action:'stop'});
      else if(act==='unallow'){await api('always/remove',{host:b.dataset.host,label:b.dataset.label});refreshAccounts();}
      state=await api('state');previousSignature='';apSig='';render();
    }catch(err){toast(err.message);}finally{b.disabled=false;}
    return;
  }
  if(b.dataset.action||b.dataset.answer){b.disabled=true;try{await api('control',{id:selected,action:b.dataset.action||'reply',answer:b.dataset.answer});state=await api('state');render();}catch(err){toast(err.message);}finally{b.disabled=false;}return;}
  if(b.id==='enable-alerts'){if('Notification'in window){const permission=await Notification.requestPermission();toast(permission==='granted'?'Browser alerts enabled.':'Alerts were not enabled. Task updates remain here.');}else toast('This browser does not support notifications.');}
});
$('#new-task').onclick=()=>{selected=null;view='chat';lookDraft=null;closePanel();files=[];scheduled=null;$('#schedule-summary').textContent='';renderAttachments();previousSignature='';render();$('#prompt').focus();document.body.classList.remove('menu-open');};
$('#image-mode').onclick=()=>{if(selected)return;imageMode=!imageMode;scheduled=null;files=[];renderAttachments();$('#schedule-summary').textContent='';render();$('#prompt').focus();};
$('#menu').onclick=()=>document.body.classList.toggle('menu-open');
$('#watch-browser').onclick=()=>window.SeekBrowser?.open();
// Deep links (Discord, notifications): /work?task=<id>&browser=1|control
{const q=new URLSearchParams(location.search);if(q.get('task')){view='chat';selected=q.get('task');}if(q.get('browser'))setTimeout(()=>window.SeekBrowser?.open({control:q.get('browser')==='control'}),300);if(q.toString())history.replaceState(null,'',location.pathname);}
$('#close-preview').onclick=()=>{$('#artifact-dialog').close();$('#preview-frame').src='about:blank';};
$('#schedule').onclick=()=>$('#schedule-dialog').showModal();
$('#schedule-dialog').addEventListener('close',()=>{if($('#schedule-dialog').returnValue==='save'){const raw=$('#run-at').value;scheduled=raw?{runAt:new Date(raw).toISOString(),...$('#repeat').value?{repeatHours:Number($('#repeat').value)}:{}}:null;$('#schedule-summary').textContent=scheduled?when(Date.parse(scheduled.runAt)):'';}});
function renderAttachments(){$('#attachments').innerHTML=files.map((f,i)=>`<span class="attachment-chip">${esc(f.name)}<button type="button" data-remove="${i}" aria-label="Remove ${esc(f.name)}">${icon('x','ic-sm')}</button></span>`).join('');}
$('#attach').onclick=()=>$('#file-input').click();
$('#attachments').onclick=e=>{const b=e.target.closest('[data-remove]');if(b){files.splice(Number(b.dataset.remove),1);renderAttachments();}};
$('#file-input').onchange=async()=>{try{for(const f of $('#file-input').files){if(files.length>=5||f.size>8*1024*1024)throw new Error('Attach up to 5 files, each under 8 MB.');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(f);});files.push({name:f.name,data});}renderAttachments();}catch(e){toast(e.message);}$('#file-input').value='';};
$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}});
$('#composer').onsubmit=async e=>{
  e.preventDefault();const input=$('#prompt').value.trim();if(!input)return;$('#send').disabled=true;
  const send=allowSecret=>selected?api('control',{id:selected,action:'reply',answer:input,allowSecret}):imageMode?fetch('/qwen-image/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:input,ratio:'square',steps:30})}).then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Image request failed.');return data;}):api('task',{objective:input,mode:$('#mode').value,...scheduled||{},files,allowSecret});
  try{
    let r;
    // Passwords typed in chat would reach the agent; the server refuses unless you insist.
    try{r=await send(false);}catch(err){if(err.code!=='secret'||!confirm(err.message+'\n\nSend it anyway?'))throw err;r=await send(true);}
    if(imageMode){imageMode=false;view='images';window.SeekImages?.refresh();toast('Image request started.');}else if(!selected)selected=r.id;
    $('#prompt').value='';files=[];scheduled=null;renderAttachments();$('#schedule-summary').textContent='';state=await api('state');previousSignature='';render();$('#main').scrollTop=$('#main').scrollHeight;
  }catch(err){toast(err.message);}finally{$('#send').disabled=false;}
};
document.addEventListener('submit',async e=>{if(e.target.id!=='memory-form')return;e.preventDefault();try{await api('settings',{name:$('#agent-name').value,memory:$('#memory-text').value,notifications:$('#notifications').checked,look:lookDraft||state.settings.look});state=await api('state');lookDraft=null;toast('Preferences saved.');render();}catch(err){toast(err.message);}});
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
$('#panel-scrim').onclick=closePanel;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('panel-open'))closePanel();});
window.addEventListener('resize',()=>{apSig='';renderPanel();});
poll();
