// Report card: how Seek is getting better — task-test results over time, skills it has learned,
// changes the improvement loop tried (and why they shipped or not), and the night-shift journal.
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=n=>n?new Date(n).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not yet';
const STEP={tests:'Task tests',skills:'Learning skills',improve:'Trying improvements',prepare:'Preparing drafts'};
const SKILL={testing:'Being tested',trial:'On trial',active:'Proven',retired:'Retired'};
const CHANGE={shipped:'Shipped',rejected:'Not shipped',reverted:'Reverted',interrupted:'Paused — will retry','needs-developer':'Needs a developer'};
let api,toast,data=null,tab='tests',timer=null,fetching=false;

export function renderGrowth(options){
  ({api,toast}=options);
  let host=document.querySelector('#growth');
  if(!host){
    document.querySelector('#main').innerHTML=`<section id="growth" class="growth" aria-labelledby="growth-title"><div class="growth-head"><div><span class="growth-eyebrow">GETTING BETTER EVERY NIGHT</span><h2 id="growth-title">Report card</h2></div></div><p class="section-copy">Every night Seek tests itself on real kinds of work, turns finished tasks into skills, and tries one or two improvements — keeping only what makes the tests better. Nothing here touches your accounts or money.</p><div id="growth-status" role="status">Loading…</div><div class="growth-tabs" role="tablist"></div><div id="growth-body"></div></section>`;
    host=document.querySelector('#growth');
  }
  if(data)paint();
  refresh();
  clearInterval(timer);timer=setInterval(()=>{if(!document.querySelector('#growth')){clearInterval(timer);return;}if(data?.running)refresh();},5000);
}
async function refresh(){if(fetching)return;fetching=true;try{data=await api('growth');paint();}catch(e){const s=document.querySelector('#growth-status');if(s)s.textContent=e.message;}finally{fetching=false;}}
function paint(){
  const host=document.querySelector('#growth');if(!host||!data)return;
  const b=data.baseline,last=data.history[1],delta=b&&last?b.passed-last.passed:0;
  const shipped=data.improvements.filter(i=>i.status==='shipped').length,proven=data.skills.filter(s=>s.status==='active').length;
  host.querySelector('#growth-status').innerHTML=`<div class="growth-score"><div class="growth-big">${b?`${b.passed}<small>/${b.total}</small>`:'—'}</div><div><strong>${b?`Task tests passed${delta?` · ${delta>0?'+':''}${delta} since the run before`:''}`:'No test run yet'}</strong><p>${b?`Last run ${when(b.startedAt)}`:'Run the tests once to get a baseline.'} · ${proven} proven skill${proven===1?'':'s'} · ${shipped} improvement${shipped===1?'':'s'} in use</p></div><div class="growth-run">${data.running?`<span class="growth-working">${esc(STEP[data.running]||'Night shift')}…</span><button type="button" data-growth-stop>Stop</button>`:`<button type="button" class="primary" data-growth-run="tests">Run tests now</button><button type="button" data-growth-run="all">Run the whole night shift</button>`}</div></div>`;
  const counts={tests:data.cases.length,skills:data.skills.filter(s=>s.status!=='retired').length,improvements:data.improvements.length};
  host.querySelector('.growth-tabs').innerHTML=[['tests','Task tests'],['skills','Skills'],['improvements','Improvements'],['shift','Night shift']].map(([k,l])=>`<button type="button" role="tab" data-growth-tab="${k}" aria-selected="${tab===k}">${l}${counts[k]?` <span>${counts[k]}</span>`:''}</button>`).join('');
  const body=host.querySelector('#growth-body');
  if(body.querySelector('form:focus-within'))return;
  body.innerHTML=tab==='tests'?testsHTML():tab==='skills'?skillsHTML():tab==='improvements'?improvementsHTML():shiftHTML();
}
function testsHTML(){
  const runs=[...data.history].reverse(),max=Math.max(1,...runs.map(r=>r.total));
  const trend=runs.length?`<div class="growth-trend-wrap"><div><div class="growth-trend" aria-label="Pass rate over the last ${runs.length} runs">${runs.map(r=>`<span title="${esc(when(r.at))}: ${r.passed}/${r.total}" style="height:${Math.max(6,Math.round(r.passed/max*56))}px"></span>`).join('')}</div><small>Tests passed</small></div><div><div class="growth-trend steps" aria-label="Steps per test over the last ${runs.length} runs">${runs.map(r=>{const per=r.total?r.steps/r.total:0,top=Math.max(1,...runs.map(x=>x.total?x.steps/x.total:0));return `<span title="${esc(when(r.at))}: ${per.toFixed(1)} steps per test · ${Math.round(r.seconds/60)} min total" style="height:${Math.max(6,Math.round(per/top*56))}px"></span>`;}).join('')}</div><small>Steps per test (lower is faster) · last run ${(runs.at(-1).steps/Math.max(1,runs.at(-1).total)).toFixed(1)} steps, ${Math.round(runs.at(-1).seconds/60)} min</small></div></div>`:'';
  const latest=new Map((data.baseline?.results||[]).map(r=>[r.caseId,r])),live=data.live&&!data.live.run?.overlay?data.live:null;
  if(live)for(const r of live.results)latest.set(r.caseId,{...r,fresh:true});
  return `${trend}<div class="growth-cases">${data.cases.map(c=>{const r=latest.get(c.id),dots=[...c.history].reverse().map(h=>`<i class="${h.passed?'ok':'bad'}" title="${esc(when(h.at))}"></i>`).join('');
    const running=live?.caseId===c.id;
    return `<article class="growth-case ${running?'running':r?r.passed?'ok':'bad':''}"><div class="growth-case-top"><span class="growth-mark">${r?r.passed?'✓':'✗':'·'}</span><strong>${esc(c.title)}</strong><span class="growth-chip">${esc(c.category)}</span></div><p class="growth-meta">${running?`Running now… ${Math.round((Date.now()-live.startedAt)/1000)}s`:r?`${r.fresh?'This run · ':''}${r.seconds??'—'}s · ${r.steps??0} steps · ${esc(r.detail?.reason||r.status)}`:'Not run yet'}</p><div class="growth-dots">${dots}</div>${r?.taskId?`<button type="button" class="growth-link" data-select="${esc(r.taskId)}">Open the test run</button>`:''}</article>`;}).join('')}</div>`;
}
function skillsHTML(){
  if(!data.skills.length)return '<div class="growth-empty"><strong>No skills yet.</strong><p>After a task goes well, the night shift turns it into a step-by-step skill and tests it before it is trusted.</p></div>';
  return data.skills.map(s=>{const b=s.body||{},test=s.tests?.at(-1);
    return `<article class="growth-skill ${esc(s.status)}"><div class="growth-case-top"><span class="growth-badge ${esc(s.status)}">${esc(SKILL[s.status]||s.status)}</span><strong>${esc(s.name)}</strong><span class="growth-chip">${esc(s.category)}</span></div><p>${esc(b.when||s.description)}</p><p class="growth-meta">v${s.version} · used ${s.uses} time${s.uses===1?'':'s'}${s.uses?` · ${s.successes} went well, ${s.failures} didn’t`:''}${test?.exercised?` · tested on ${test.cases.length} task test${test.cases.length===1?'':'s'}: ${test.passed}/${test.total} passed, ${test.steps} steps vs ${test.baselineSteps} before${test.regressed?.length?`, broke ${test.regressed.join(', ')}`:''}`:' · not covered by a task test yet'}</p><details><summary>Steps</summary><ol>${(b.steps||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ol>${(b.pitfalls||[]).length?`<p class="growth-sub">Pitfalls</p><ul>${b.pitfalls.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${(b.checks||[]).length?`<p class="growth-sub">Checks</p><ul>${b.checks.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}<p class="growth-meta">Used for requests like: ${esc((s.triggers||[]).join(', '))}</p></details>${(s.sources||[]).length?`<p class="growth-meta">Learned from ${s.sources.map(x=>`<button type="button" class="growth-link" data-select="${esc(x.taskId)}">${esc(x.title)}</button>`).join(', ')}</p>`:''}<div class="growth-actions">${s.status==='retired'?`<button type="button" data-growth-skill="${esc(s.id)}" data-action="restore">Use again</button>`:`<button type="button" data-growth-skill="${esc(s.id)}" data-action="retire">Retire</button>`}</div></article>`;}).join('');
}
function improvementsHTML(){
  const notes=data.notes.filter(n=>n.status==='active');
  const notesBlock=`<div class="growth-notes"><h3>Working notes in use</h3>${notes.length?`<ul>${notes.map(n=>`<li><span>${esc(n.text)}</span><button type="button" data-growth-note="${esc(n.id)}" data-action="retire">Retire</button></li>`).join('')}</ul>`:'<p class="growth-meta">None yet. A note is added only after it fixes a failing test without breaking others.</p>'}</div>`;
  const log=data.improvements.length?data.improvements.map(i=>{const t=i.candidate?.target,r=i.candidate?.regressions;
    return `<article class="growth-change ${esc(i.status)}"><div class="growth-case-top"><span class="growth-badge ${esc(i.status)}">${esc(CHANGE[i.status]||i.status)}</span><strong>${esc(i.title)}</strong><time>${esc(when(i.at))}</time></div>${i.rationale?`<p>${esc(i.rationale)}</p>`:''}<p class="growth-meta">${esc(i.detail?.why||i.detail?.details||'')}${t?` · failing test: ${t.passed}/${t.of} passed`:''}${r?` · side effects checked on ${r.checked.length} tests${r.failed.length?`, broke ${r.failed.join(', ')}`:', none found'}`:''}</p><p class="growth-meta">Triggered by: ${esc(signalText(i.signal))}</p>${i.status==='shipped'?`<div class="growth-actions"><button type="button" data-growth-revert="${esc(i.id)}">Revert</button></div>`:''}</article>`;}).join(''):'<div class="growth-empty"><strong>No changes tried yet.</strong><p>When a task test fails or a task goes wrong, the night shift proposes one fix and tests it.</p></div>';
  return notesBlock+log;
}
function signalText(s={}){return s.kind==='slow'?`the “${s.title}” test taking ${s.steps} steps (target ${s.budget})`:s.kind==='eval'?`the “${s.title}” test failing (${s.what||''})`:s.kind==='tool-error'?`${s.tool} errors (${s.count}×)`:s.kind==='churn'?`${s.tool} called ${s.count} times in “${s.title}”`:s.kind==='task'?`“${s.title}” ending as ${s.status}`:'a review';}
function shiftHTML(){
  const s=data.settings,st=data.state?.steps||{};
  return `<form id="growth-settings" class="growth-settings"><label class="check"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}>Run the night shift after the nightly reflection</label>${Object.entries(STEP).map(([k,l])=>`<label class="check"><input type="checkbox" name="${k}" ${s[k]?'checked':''}>${l}</label>`).join('')}<div class="growth-times"><label>Stop by<input type="time" name="until" value="${esc(s.until)}"></label><label>Morning summary at<input type="time" name="digest" value="${esc(s.digest)}"></label><button type="submit">Save</button></div><p class="growth-meta">It only runs while you are not using Seek, and stops the moment you start a task. Drafts it prepares can research and write, never buy or send.</p></form>
  <div class="growth-steps">${Object.entries(STEP).map(([k,l])=>`<div class="growth-step"><strong>${l}</strong><span class="growth-meta">${esc(st[k]?.status||'not run today')}${st[k]?.at?' · '+esc(when(st[k].at)):''}</span><button type="button" data-growth-run="${k}" ${data.running?'disabled':''}>Run now</button></div>`).join('')}</div>
  <h3 class="growth-h3">Journal</h3><ul class="growth-journal">${data.journal.map(j=>`<li><time>${esc(when(j.at))}</time><strong>${esc(STEP[j.step]||(j.step==='all'?'Whole night shift':j.step==='spot'?'Spot check':j.step))}</strong> ${esc(j.status)}${j.detail?` <span>${esc(summary(j.detail))}</span>`:''}</li>`).join('')||'<li class="growth-meta">Nothing yet.</li>'}</ul>`;
}
function summary(d){if(d.error)return d.error;if(d.total!==undefined)return `${d.passed}/${d.total} passed${d.reverted?`, ${d.reverted} change reverted`:''}`;if(d.skills)return d.skills.map(x=>`${x.name} (${x.status})`).join(', ')||'no new skills';if(d.changes)return d.changes.map(x=>`${x.title} — ${x.status}`).join('; ')||'nothing to try';if(d.prepared)return d.prepared.map(x=>x.title).join('; ')||'nothing to prepare';return '';}

document.addEventListener('click',async e=>{
  const t=e.target.closest('[data-growth-tab]');if(t){tab=t.dataset.growthTab;paint();return;}
  const b=e.target.closest('[data-growth-run],[data-growth-stop],[data-growth-skill],[data-growth-note],[data-growth-revert]');if(!b)return;
  b.disabled=true;
  try{
    if(b.dataset.growthRun){await api('growth/run',{step:b.dataset.growthRun});toast(`${STEP[b.dataset.growthRun]||'The night shift'} started. Your own tasks always come first.`);}
    else if(b.hasAttribute('data-growth-stop')){await api('growth/stop',{});toast('Stopping.');}
    else if(b.dataset.growthSkill){await api('growth/skill',{id:b.dataset.growthSkill,action:b.dataset.action});toast(b.dataset.action==='retire'?'Skill retired.':'Skill back on trial.');}
    else if(b.dataset.growthNote){await api('growth/note',{id:b.dataset.growthNote,action:b.dataset.action});toast('Note retired.');}
    else if(b.dataset.growthRevert){if(!confirm('Revert this change? It stops being used right away.')){b.disabled=false;return;}await api('growth/improvement',{id:b.dataset.growthRevert,action:'revert'});toast('Reverted.');}
    await refresh();
  }catch(err){toast(err.message);b.disabled=false;}
});
document.addEventListener('submit',async e=>{
  if(e.target.id!=='growth-settings')return;e.preventDefault();const f=e.target.elements;
  try{await api('growth/settings',{enabled:f.enabled.checked,...Object.fromEntries(Object.keys(STEP).map(k=>[k,f[k].checked])),until:f.until.value,digest:f.digest.value});toast('Night shift saved.');await refresh();}catch(err){toast(err.message);}
});
