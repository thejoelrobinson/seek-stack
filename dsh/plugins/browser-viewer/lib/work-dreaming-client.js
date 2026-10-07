import {memoryScopeLabel} from '/work/product.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=n=>n?new Date(n).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not yet';
const day=n=>new Date(n).toLocaleDateString(undefined,{month:'short',day:'numeric'});
const KIND={workflow:'Working habit',preference:'Preference',fact:'Fact'};
const VERB={learned:'Learned',added:'You added',confirmed:'You kept',edited:'You edited',used:'Used in a task',flagged:'You flagged as wrong',paused:'Paused',forgotten:'Forgot a note',reinforced:'Heard again',replaced:'Replaced by a newer note',renamed:'Renamed',imported:'Moved into the memory database'};
const TABS=[['review','To review'],['about','About you & yours'],['habits','How I work'],['prefs','Preferences'],['paused','Paused'],['history','History']];
let api,toast,data,fetching=false,fetchedAt=0,tab=null,query='',matches=null,showUses=false;

export function renderDreaming(options) {
  ({api,toast}=options);
  if(window.seekMemoryTab){tab=window.seekMemoryTab;window.seekMemoryTab=null;}
  let host=document.querySelector('#dreaming');
  if(!host) {
    // Settings hosts this page in its tab body; fall back to the whole main area.
    const main=document.querySelector('#settings-body')||document.querySelector('#main');
    main.insertAdjacentHTML('afterbegin',`<section id="dreaming" class="memory dream-panel" aria-labelledby="dream-title"><div class="dream-heading"><div><span class="dream-eyebrow">A LITTLE WISER EACH DAY</span><h2 id="dream-title">What I’ve learned</h2></div><span class="dream-moon" aria-hidden="true">☾</span></div><p class="section-copy">Everything Seek remembers about you, the people you mention, and how you like work done — each note shows the words it came from. Nothing about you is used until you keep it.</p><div id="dream-status" role="status">Loading your memory…</div><div class="memory-toolbar"><input id="memory-search" type="search" placeholder="Search memory — a person, a store, a habit…" aria-label="Search memory"><a class="memory-export" href="/work/api/memory/export" download>Export as Markdown</a></div><div class="memory-tabs" role="tablist" aria-label="Memory"></div><div id="dream-lessons"></div><details class="memory-teach"><summary>Teach me something</summary><form id="memory-add"><label>What should I remember?<textarea name="text" maxlength="400" required placeholder="The user prefers pickup over delivery."></textarea></label><div class="dream-schedule"><label>Kind<select name="kind"><option value="preference">Preference</option><option value="fact">Fact</option><option value="workflow">Working habit</option></select></label><label>About<input name="about" type="text" maxlength="60" placeholder="you, or a name like “wife”"></label><button type="submit" class="primary">Remember this</button></div></form></details><details class="dream-journal"><summary>Nightly reflection</summary><form id="dream-settings" hidden><label class="check"><input name="enabled" type="checkbox">Learn from conversations each night</label><div class="dream-schedule"><label>Nightly time<input name="time" type="time" required></label><label>Time zone<input name="timezone" type="text" placeholder="America/Chicago" required></label><button type="submit">Save schedule</button><button type="button" class="primary" data-dream-run>Dream now</button></div><p class="muted">Runs while this PC and Seek are on, and waits when you’re working. Finished tasks are also reviewed right away. Learning and memory are shared with your partner.</p></form><div id="dream-runs"></div></details><p class="muted dream-footnote">Working habits with strong evidence are used automatically; facts and preferences wait for you. “Always on” notes go into every task; others are used when a task mentions them. Editing or forgetting a note takes effect in future tasks.</p></section>`);
    host=document.querySelector('#dreaming');
    if(data)paint(host,true);
  }
  if(!fetching&&Date.now()-fetchedAt>5000)refresh();
}
function refresh(){
  fetching=true;
  void api('dreaming').then(value=>{data=value;fetchedAt=Date.now();const current=document.querySelector('#dreaming');if(current)paint(current);}).catch(e=>{const status=document.querySelector('#dream-status');if(status)status.textContent=e.message;}).finally(()=>{fetching=false;});
}
const now=()=>Date.now();
const expired=l=>l.status==='active'&&l.expiresAt&&l.expiresAt<now();
const entityOf=l=>l.entity||(l.kind==='workflow'?null:'self');
function groups(){
  const lessons=data.lessons||[];
  return {
    review:lessons.filter(l=>l.status==='review'),
    about:lessons.filter(l=>(l.status==='active'||l.status==='review')&&l.kind!=='workflow'&&!(entityOf(l)==='self'&&l.kind==='preference')),
    habits:lessons.filter(l=>l.status==='active'&&l.kind==='workflow'),
    prefs:lessons.filter(l=>l.status==='active'&&l.kind==='preference'&&entityOf(l)==='self'),
    paused:lessons.filter(l=>l.status==='paused'||expired(l)),
    history:data.events||[]
  };
}
function paint(host,force=false) {
  const form=host.querySelector('#dream-settings');
  if(!form.dataset.loaded||force) {
    form.elements.enabled.checked=data.settings.enabled;form.elements.time.value=data.settings.time;form.elements.timezone.value=data.settings.timezone;form.hidden=false;form.dataset.loaded='1';
  }
  const last=data.runs.find(r=>r.status==='complete'),latest=data.runs[0],c=data.counts||{};
  host.querySelector('#dream-status').innerHTML=`<div class="dream-status ${data.running?'is-running':''}"><span class="dream-spark" aria-hidden="true">${data.running?'✧':'◇'}</span><div><strong>${data.running?'Reflecting now':`${c.active||0} in use · ${c.review||0} to review`}</strong><p>${esc(data.running?data.stage||'Starting reflection…':`${latest?.status==='error'?'Last reflection will retry':data.settings.enabled?'Nightly learning is on':'Nightly learning is paused'} · last ${date(last?.finishedAt)} · ${data.pending} conversation${data.pending===1?'':'s'} waiting`)}</p></div></div>`;
  host.querySelector('[data-dream-run]').disabled=data.running;
  const g=groups();
  if(!tab||!g[tab])tab=g.review.length?'review':['about','habits','prefs'].find(k=>g[k].length)||'about';
  host.querySelector('.memory-tabs').innerHTML=(matches?[['search','Search results']]:[]).concat(TABS).map(([key,label])=>{const n=key==='search'?matches.length:key==='history'?null:g[key].length;return `<button type="button" role="tab" data-memory-tab-select="${key}" aria-selected="${(matches?'search':tab)===key}">${esc(label)}${n?` <span>${n}</span>`:''}</button>`;}).join('');
  const list=host.querySelector('#dream-lessons'),signature=JSON.stringify([tab,matches,showUses,data.lessons,data.entities,data.events?.[0]?.seq]);
  if(list.dataset.signature===signature||list.querySelector('form'))return;
  list.dataset.signature=signature;
  const view=matches?'search':tab;
  list.innerHTML=view==='history'?historyHTML(g.history):view==='about'?aboutHTML(g.about):lessonsHTML(view==='search'?(data.lessons||[]).filter(l=>matches.includes(l.id)):g[view],view);
  host.querySelector('#dream-runs').innerHTML=data.runs.length?data.runs.map(r=>`<div class="dream-run"><strong>${esc({complete:'Reflection complete',running:'Reflecting',interrupted:'Reflection paused',error:'Couldn’t finish'}[r.status]||r.status)}</strong><time>${date(r.startedAt)}</time><p>${esc((r.summary||'Reading recent conversations and checking lessons…')+(r.error?' '+r.error:''))}</p></div>`).join(''):'<p class="muted">Your first reflection will appear here.</p>';
}
const EMPTY={review:['All caught up.','New things I learn about you wait here for your OK.'],habits:['No habits yet.','When you correct how I work — “stop”, “verify that”, “not like that” — I turn it into a habit here.'],prefs:['No preferences yet.','Defaults you mention, like pickup over delivery, show up here.'],paused:['Nothing paused.','Notes you pause, flag as wrong, or that expire rest here until you turn them back on.'],search:['No matches.','Try a person, a store or a word from the note.'],history:['No history yet.','Each time I learn, use, change or forget a note, it is logged here.'],about:['Room for what matters.','Facts about you and the people you mention collect here as dossiers, each with the words they came from.']};
function empty(view){const [title,copy]=EMPTY[view]||EMPTY.about;return `<div class="dream-empty"><strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`;}
function lessonsHTML(lessons,view){
  if(!lessons.length)return empty(view);
  return [...lessons].sort((a,b)=>b.updatedAt-a.updatedAt).map(lessonHTML).join('');
}
function aboutHTML(lessons){
  if(!lessons.length)return empty('about');
  const entities=new Map((data.entities||[]).map(e=>[e.id,e]));
  const byEntity=new Map();for(const l of lessons){const id=entityOf(l)||'self';if(!byEntity.has(id))byEntity.set(id,[]);byEntity.get(id).push(l);}
  return [...byEntity.entries()].sort(([a],[b])=>(a==='self'?-1:b==='self'?1:0)||String(entities.get(a)?.name||a).localeCompare(String(entities.get(b)?.name||b))).map(([id,items])=>{
    const e=entities.get(id)||{id,name:id==='self'?'You':id,kind:'other',aliases:[]};
    return `<article class="dossier" data-entity="${esc(id)}"><header><div><h3>${esc(e.name)}</h3>${id!=='self'?`<p class="muted">Recalled when a task mentions ${esc([e.name,...(e.aliases||[])].filter((v,i,a)=>a.findIndex(x=>x.toLowerCase()===v.toLowerCase())===i).slice(0,6).join(', '))}</p>`:'<p class="muted">Always on: used in every task</p>'}</div>${id!=='self'?`<button type="button" data-entity-edit="${esc(id)}">Edit names</button>`:''}</header>${items.sort((a,b)=>a.createdAt-b.createdAt).map(lessonHTML).join('')}</article>`;
  }).join('');
}
function lessonHTML(l){
  const core=(data.core||[]).includes(l.id),entity=(data.entities||[]).find(e=>e.id===entityOf(l));
  const usage=l.useCount?`Used in ${l.useCount} task${l.useCount===1?'':'s'} · last ${date(l.lastUsedAt)}`:'Not used yet';
  const badge=l.status==='review'?'Review together':l.status==='paused'?'Paused':expired(l)?'Expired':core?'Always on':'In memory';
  const history=(data.events||[]).filter(e=>e.lessonId===l.id&&e.action!=='used'&&e.action!=='imported');
  return `<article class="dream-lesson" data-lesson="${esc(l.id)}"><div class="dream-lesson-top"><span class="dream-badge ${esc(expired(l)?'paused':l.status)}${core?' core':''}">${badge}</span><span>${esc([KIND[l.kind]||'Preference',entity&&entity.id!=='self'?entity.name:null,l.scope||null,memoryScopeLabel(l)].filter(Boolean).join(' · '))}</span></div><p class="dream-note">${esc(l.text)}</p><p class="memory-meta">${esc(usage)}${l.expiresAt?` · ${expired(l)?'expired':'until'} ${day(l.expiresAt)}`:''}${l.origin==='told'?' · you asked me to remember':l.origin==='manual'?' · you added this':''}</p>${l.replaces?.length?'<p class="muted">This may replace an earlier note. Review the change before accepting it.</p>':''}<details><summary>${l.sources.length} supporting message${l.sources.length===1?'':'s'} · ${date(l.updatedAt)}</summary>${l.sources.map(s=>`<blockquote>${esc(s.quote||'')}<footer><button type="button" data-select="${esc(s.taskId)}">${esc(s.title)}</button></footer></blockquote>`).join('')||'<p class="muted">You added this directly.</p>'}</details>${l.revisions?.length?`<details><summary>Previous corrections · ${l.revisions.length}</summary>${[...l.revisions].reverse().map(r=>`<blockquote>${esc(r.text)}<footer>${esc(memoryScopeLabel(r))} · ${date(r.updatedAt)}</footer></blockquote>`).join('' )}</details>`:''}${history.length?`<details><summary>History · ${history.length}</summary><ul class="memory-history">${history.map(eventHTML).join('')}</ul></details>`:''}<div class="dream-actions">${l.status!=='active'||expired(l)?`<button type="button" data-dream-action="accept" data-id="${esc(l.id)}">${l.status==='review'?'Keep this':'Use again'}</button>`:`<button type="button" data-dream-action="pause" data-id="${esc(l.id)}">Pause</button>`}<button type="button" data-dream-action="edit" data-id="${esc(l.id)}">Edit</button><button type="button" data-dream-action="forget" data-id="${esc(l.id)}">Forget</button></div></article>`;
}
function eventHTML(e){
  const task=e.taskId?`<button type="button" data-select="${esc(e.taskId)}">open task</button>`:'';
  return `<li><time>${date(e.at)}</time><strong>${esc(VERB[e.action]||e.action)}</strong>${e.text?` <span>${esc(e.text)}</span>`:''} ${task}</li>`;
}
function historyHTML(events){
  const meaningful=events.filter(e=>e.action!=='imported'),shown=meaningful.filter(e=>showUses||e.action!=='used'),uses=meaningful.length-meaningful.filter(e=>e.action!=='used').length;
  return `<label class="check memory-uses"><input type="checkbox" data-memory-uses ${showUses?'checked':''}>Show each time a note was used${uses?` (${uses} recent)`:''}</label>${shown.length?`<ul class="memory-history">${shown.map(eventHTML).join('')}</ul>`:empty('history')}`;
}
function repaint(){const host=document.querySelector('#dreaming');if(host){host.querySelector('#dream-lessons').dataset.signature='';paint(host);}}
let searchTimer;
document.addEventListener('input',e=>{
  if(e.target.id!=='memory-search')return;
  clearTimeout(searchTimer);const value=e.target.value.trim();
  searchTimer=setTimeout(async()=>{query=value;if(!query){matches=null;repaint();return;}try{const r=await api('memory/search?q='+encodeURIComponent(query));if(query===value){matches=r.ids;repaint();}}catch(err){toast(err.message);}},200);
});
document.addEventListener('change',e=>{if(e.target.matches('[data-memory-uses]')){showUses=e.target.checked;repaint();}});
document.addEventListener('click',async e=>{
  const select=e.target.closest('[data-memory-tab-select]');
  if(select){const key=select.dataset.memoryTabSelect;if(key!=='search'){matches=null;const input=document.querySelector('#memory-search');if(input)input.value='';tab=key;}repaint();return;}
  const entityEdit=e.target.closest('[data-entity-edit]');
  if(entityEdit){
    const id=entityEdit.dataset.entityEdit,entity=(data.entities||[]).find(x=>x.id===id),card=entityEdit.closest('.dossier');if(!entity)return;
    card.querySelector('header').insertAdjacentHTML('afterend',`<form data-entity-form="${esc(id)}" class="entity-form"><label>Name<input name="name" maxlength="60" value="${esc(entity.name)}" required></label><label>Also recall when a task says<input name="aliases" maxlength="600" value="${esc((entity.aliases||[]).join(', '))}" placeholder="wife, spouse, date night"></label><div class="dream-actions"><button type="submit" class="primary">Save</button><button type="button" data-dream-action="cancel">Cancel</button></div></form>`);
    entityEdit.hidden=true;return;
  }
  const b=e.target.closest('[data-dream-run],[data-dream-action]');if(!b)return;
  const {dreamAction:action,id}=b.dataset;
  if(action==='edit') {
    const lesson=data.lessons.find(l=>l.id===id),article=b.closest('.dream-lesson');if(!lesson)return;
    const entity=(data.entities||[]).find(x=>x.id===entityOf(lesson));
    article.innerHTML=`<form data-dream-edit="${esc(id)}"><label>Edit this memory<textarea name="text" maxlength="400" required>${esc(lesson.text)}</textarea></label><div class="dream-schedule"><label>Kind<select name="kind">${Object.entries(KIND).map(([k,v])=>`<option value="${k}" ${lesson.kind===k?'selected':''}>${v}</option>`).join('')}</select></label><label>About<input name="about" type="text" maxlength="60" value="${esc(entity&&entity.id!=='self'?entity.name:'')}" placeholder="you"></label></div><div class="memory-scope-fields"><label>Use for project<input name="project" type="text" maxlength="80" value="${esc(lesson.project||'')}" placeholder="All projects"></label><label class="check"><input name="owner" type="checkbox" ${lesson.person?'checked':''}>Use only for owner tasks</label><p>Leave both blank to use this memory for all tasks. Project names must match the task’s project. Scopes limit future recall; records remain visible in this shared workspace.</p></div><div class="dream-actions"><button type="submit" class="primary">Save correction</button><button type="button" data-dream-action="cancel">Cancel</button></div></form>`;
    article.querySelector('textarea').focus();return;
  }
  if(action==='cancel'){b.closest('form').remove();repaint();return;}
  if(action==='forget'&&!confirm('Forget this note? Its words are removed from memory and history.'))return;
  b.disabled=true;
  try {
    data=await api(b.hasAttribute('data-dream-run')?'dreaming/run':'dreaming/memory',b.hasAttribute('data-dream-run')?{}:{id,action});
    fetchedAt=Date.now();const host=document.querySelector('#dreaming');if(host)paint(host);
    toast(action==='forget'?'Memory forgotten.':action==='pause'?'Memory paused.':action==='accept'?'Memory saved.':'Reflection started. You can keep using Seek.');
  }catch(err){toast(err.message);}finally{if(b.isConnected)b.disabled=false;}
});
document.addEventListener('submit',async e=>{
  const form=e.target;if(form.id!=='dream-settings'&&form.id!=='memory-add'&&!form.dataset.dreamEdit&&!form.dataset.entityForm)return;
  e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
  try {
    const f=form.elements;let message;
    if(form.dataset.dreamEdit){data=await api('dreaming/memory',{id:form.dataset.dreamEdit,action:'edit',text:f.text.value,project:f.project.value.trim()||null,person:f.owner.checked?'owner':null,...(f.kind?{kind:f.kind.value,about:f.about.value.trim()||'self'}:{})});form.remove();message='Memory updated.';}
    else if(form.dataset.entityForm){data=await api('dreaming/memory',{id:form.dataset.entityForm,action:'alias',name:f.name.value,aliases:f.aliases.value.split(',').map(s=>s.trim()).filter(Boolean)});form.remove();message='Names saved.';}
    else if(form.id==='memory-add'){data=await api('dreaming/memory',{action:'add',text:f.text.value,kind:f.kind.value,about:f.about.value.trim()||'self'});form.reset();form.closest('details').open=false;message='I’ll remember that.';}
    else {data=await api('dreaming/settings',{enabled:f.enabled.checked,time:f.time.value,timezone:f.timezone.value.trim()});message='Nightly schedule saved.';}
    fetchedAt=Date.now();repaint();toast(message);
  }catch(err){toast(err.message);}finally{button.disabled=false;}
});
