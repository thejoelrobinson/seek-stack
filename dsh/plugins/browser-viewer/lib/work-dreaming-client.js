const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=n=>n?new Date(n).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not yet';
let api,toast,data,fetching=false,fetchedAt=0;
export function renderDreaming(options) {
  ({api,toast}=options);
  let host=document.querySelector('#dreaming');
  if(!host) {
    const main=document.querySelector('#main');
    main.insertAdjacentHTML('afterbegin',`<section id="dreaming" class="memory dream-panel" aria-labelledby="dream-title"><div class="dream-heading"><div><span class="dream-eyebrow">A LITTLE WISER EACH DAY</span><h2 id="dream-title">Dreaming</h2></div><span class="dream-moon" aria-hidden="true">☾</span></div><p class="section-copy">A quiet nightly reflection on your conversations. Seek learns useful working habits, revisits past lessons, and carries the relevant ones into your next task.</p><div id="dream-status" role="status">Loading your learning journal…</div><form id="dream-settings" hidden><label class="check"><input name="enabled" type="checkbox">Learn from conversations each night</label><div class="dream-schedule"><label>Nightly time<input name="time" type="time" required></label><label>Time zone<input name="timezone" type="text" placeholder="America/Chicago" required></label><button type="submit">Save schedule</button><button type="button" class="primary" data-dream-run>Dream now</button></div><p class="muted">Runs while this PC and Seek are on, and waits when you’re working. A missed night catches up when Seek returns. Learning and memory are shared with your partner.</p></form><div class="dream-tabs"><h3>What I’ve learned</h3><span id="dream-count"></span></div><div id="dream-lessons"></div><details class="dream-journal"><summary>Reflection journal</summary><div id="dream-runs"></div></details><p class="muted dream-footnote">Working habits with strong evidence can be used automatically. Personal preferences and conflicting lessons wait for your review. Editing or forgetting a lesson takes effect in future context; existing chat messages stay in their conversation history.</p></section>`);
    host=document.querySelector('#dreaming');
    if(data)paint(host,true);
  }
  if(!fetching&&Date.now()-fetchedAt>5000) {
    fetching=true;
    void api('dreaming').then(value=>{data=value;fetchedAt=Date.now();const current=document.querySelector('#dreaming');if(current)paint(current);}).catch(e=>{const status=document.querySelector('#dream-status');if(status)status.textContent=e.message;}).finally(()=>{fetching=false;});
  }
}
function paint(host,force=false) {
  const form=host.querySelector('#dream-settings');
  if(!form.dataset.loaded||force) {
    form.elements.enabled.checked=data.settings.enabled;form.elements.time.value=data.settings.time;form.elements.timezone.value=data.settings.timezone;form.hidden=false;form.dataset.loaded='1';
  }
  const last=data.runs.find(r=>r.status==='complete'),latest=data.runs[0];
  host.querySelector('#dream-status').innerHTML=`<div class="dream-status ${data.running?'is-running':''}"><span class="dream-spark" aria-hidden="true">${data.running?'✧':'◇'}</span><div><strong>${data.running?'Reflecting now':latest?.status==='error'?'Reflection will retry':data.settings.enabled?'Nightly learning is on':'Nightly learning is paused'}</strong><p>${esc(data.running?data.stage||'Starting reflection…':`Last reflection: ${date(last?.finishedAt)} · ${data.pending} new conversation excerpts`)}</p></div></div>`;
  host.querySelector('[data-dream-run]').disabled=data.running;
  host.querySelector('#dream-count').textContent=`${data.counts.active} active · ${data.counts.review} to review`;
  const list=host.querySelector('#dream-lessons'),signature=JSON.stringify(data.lessons);
  if(list.dataset.signature!==signature&&!list.querySelector('form')) {
    list.dataset.signature=signature;
    list.innerHTML=data.lessons.length?[...data.lessons].sort((a,b)=>(b.status==='review')-(a.status==='review')||b.updatedAt-a.updatedAt).map(l=>`<article class="dream-lesson" data-lesson="${esc(l.id)}"><div class="dream-lesson-top"><span class="dream-badge ${esc(l.status)}">${l.status==='review'?'Review together':l.status==='paused'?'Paused':'In memory'}</span><span>${esc(l.kind==='workflow'?'Working habit':'Preference')} · ${esc(l.scope)}</span></div><p class="dream-note">${esc(l.text)}</p>${l.replaces?.length?'<p class="muted">This may replace an earlier lesson. Review the change before accepting it.</p>':''}<details><summary>${l.sources.length} supporting message${l.sources.length===1?'':'s'} · ${date(l.updatedAt)}</summary>${l.sources.map(s=>`<blockquote>${esc(s.quote)}<footer><button type="button" data-select="${esc(s.taskId)}">${esc(s.title)}</button></footer></blockquote>`).join('')||'<p class="muted">The original conversation is no longer available.</p>'}</details><div class="dream-actions">${l.status!=='active'?`<button type="button" data-dream-action="accept" data-id="${esc(l.id)}">${l.status==='paused'?'Use again':'Keep this'}</button>`:`<button type="button" data-dream-action="pause" data-id="${esc(l.id)}">Pause</button>`}<button type="button" data-dream-action="edit" data-id="${esc(l.id)}">Edit</button><button type="button" data-dream-action="forget" data-id="${esc(l.id)}">Forget</button></div></article>`).join(''):'<div class="dream-empty"><strong>Room for what matters.</strong><p>After your first reflection, useful lessons appear here with the conversations they came from. You can edit or forget any of them.</p></div>';
  }
  host.querySelector('#dream-runs').innerHTML=data.runs.length?data.runs.map(r=>`<div class="dream-run"><strong>${esc({complete:'Reflection complete',running:'Reflecting',interrupted:'Reflection paused',error:'Couldn’t finish'}[r.status]||r.status)}</strong><time>${date(r.startedAt)}</time><p>${esc((r.summary||'Reading recent conversations and checking lessons…')+(r.error?' '+r.error:''))}</p></div>`).join(''):'<p class="muted">Your first reflection will appear here.</p>';
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-dream-run],[data-dream-action]');if(!b)return;
  const {dreamAction:action,id}=b.dataset;
  if(action==='edit') {
    const lesson=data.lessons.find(l=>l.id===id),article=b.closest('.dream-lesson');if(!lesson)return;
    article.innerHTML=`<form data-dream-edit="${esc(id)}"><label>Edit this memory<textarea name="text" maxlength="400" required>${esc(lesson.text)}</textarea></label><div class="dream-actions"><button type="submit" class="primary">Save memory</button><button type="button" data-dream-action="cancel">Cancel</button></div></form>`;
    article.querySelector('textarea').focus();return;
  }
  if(action==='cancel'){b.closest('form').remove();document.querySelector('#dream-lessons').dataset.signature='';paint(document.querySelector('#dreaming'));return;}
  b.disabled=true;
  try {
    data=await api(b.hasAttribute('data-dream-run')?'dreaming/run':'dreaming/memory',b.hasAttribute('data-dream-run')?{}:{id,action});
    fetchedAt=Date.now();const host=document.querySelector('#dreaming');if(host)paint(host);
    toast(action==='forget'?'Memory forgotten.':action==='pause'?'Memory paused.':action==='accept'?'Memory saved.':'Reflection started. You can keep using Seek.');
  }catch(err){toast(err.message);}finally{if(b.isConnected)b.disabled=false;}
});
document.addEventListener('submit',async e=>{
  const form=e.target;if(form.id!=='dream-settings'&&!form.dataset.dreamEdit)return;
  e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
  try {
    const editing=!!form.dataset.dreamEdit;
    data=await api(editing?'dreaming/memory':'dreaming/settings',editing?{id:form.dataset.dreamEdit,action:'edit',text:form.elements.text.value}:{enabled:form.elements.enabled.checked,time:form.elements.time.value,timezone:form.elements.timezone.value.trim()});
    if(editing){form.remove();const list=document.querySelector('#dream-lessons');if(list)list.dataset.signature='';}
    const host=document.querySelector('#dreaming');if(host)paint(host);toast(editing?'Memory updated.':'Nightly schedule saved.');
  }catch(err){toast(err.message);}finally{button.disabled=false;}
});
