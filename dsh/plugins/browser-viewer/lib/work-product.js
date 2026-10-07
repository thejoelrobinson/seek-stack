// Product UI primitives. These never submit work or grant authority themselves.
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const esc=escapeHTML;
export const artifactURL=(taskId,id,preview=false)=>`/work/api/artifact?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(id)}${preview?'&preview=1':''}`;
export const fileKind=a=>String(a.type||a.path?.split('.').pop()||a.filename?.split('.').pop()||a.title?.split('.').pop()||'file').toLowerCase();
const bytes=n=>Number.isFinite(n)?n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB':'';
// Distinct Library icons per file family: symbol id + colored chip class.
const FILE_ICON_MAP={txt:['i-file-txt','k-txt'],md:['i-file-md','k-md'],markdown:['i-file-md','k-md'],html:['i-file-html','k-html'],htm:['i-file-html','k-html'],pdf:['i-file-pdf','k-pdf'],doc:['i-file-doc','k-doc'],docx:['i-file-doc','k-doc'],xls:['i-file-xls','k-xls'],xlsx:['i-file-xls','k-xls'],csv:['i-file-csv','k-csv'],zip:['i-file-zip','k-zip'],rar:['i-file-zip','k-zip'],'7z':['i-file-zip','k-zip'],json:['i-file-data','k-data'],yaml:['i-file-data','k-data'],yml:['i-file-data','k-data'],xml:['i-file-data','k-data'],tsv:['i-file-csv','k-csv'],js:['i-file-code','k-code'],ts:['i-file-code','k-code'],py:['i-file-code','k-code'],sh:['i-file-code','k-code'],css:['i-file-code','k-code'],sql:['i-file-code','k-code'],mp3:['i-file-audio','k-audio'],wav:['i-file-audio','k-audio'],m4a:['i-file-audio','k-audio'],mp4:['i-file-video','k-video'],mov:['i-file-video','k-video'],webm:['i-file-video','k-video'],avi:['i-file-video','k-video'],ppt:['i-file-ppt','k-ppt'],pptx:['i-file-ppt','k-ppt']};
export function fileIconHTML(kind){
  const [symbol,chip]=FILE_ICON_MAP[String(kind).toLowerCase()]||['i-doc','k-doc'];
  return `<span class="file-icon ${chip}" aria-hidden="true"><svg class="ic" aria-hidden="true" focusable="false"><use href="#${symbol}"/></svg></span>`;
}
const evidenceCheck=check=>typeof check==='string'?`<li>${esc(check)}</li>`:`<li><strong>${esc(check.label||check.name||'Check')}</strong> · ${esc(check.status||(check.ok===true?'Passed':check.ok===false?'Needs attention':'Recorded'))}${check.detail?`<p>${esc(check.detail)}</p>`:''}</li>`;
export const LIBRARY_DATES=[['all','Any time'],['today','Today'],['7','Past 7 days'],['30','Past 30 days'],['365','Past year']];
// Start of the selected range in local time; null means no date limit.
export function librarySince(range,now=Date.now()){
  if(range==='today'){const d=new Date(now);d.setHours(0,0,0,0);return d.getTime();}
  const days=Number(range);return Number.isFinite(days)&&days>0?now-days*86400000:null;
}
const contentKey=(taskId,id)=>taskId+'|'+id;
export function libraryItems(tasks,{query='',type='all',date='all',now=Date.now(),contentHits=null}={}){
  const q=query.trim().toLowerCase(),since=librarySince(date,now),hits=new Map((contentHits||[]).map(h=>[contentKey(h.taskId,h.id),h.excerpt]));
  return tasks.flatMap(t=>(t.artifacts||[]).map(a=>({...a,taskId:t.id,taskTitle:t.title,kind:fileKind(a)}))).map(a=>{const match=hits.get(contentKey(a.taskId,a.id));return match?{...a,contentMatch:match}:a;}).filter(a=>(type==='all'||a.kind.includes(type))&&(since==null||(a.at||0)>=since)&&(!q||a.contentMatch||[a.title,a.filename,a.taskTitle,a.kind].join(' ').toLowerCase().includes(q))).sort((a,b)=>(b.at||0)-(a.at||0));
}
export function artifactCard(task,a,{library=false}={}){
  const url=artifactURL(task.id,a.id),type=fileKind(a),image=/^(png|jpe?g|webp|gif|image\/)/.test(type),meta=[type.toUpperCase(),bytes(a.bytes),a.version?'Version '+a.version:''].filter(Boolean).join(' · ');
  return `<article class="file-card library-card">${image?`<button class="library-thumb" data-preview="${esc(a.id)}" data-task="${esc(task.id)}" aria-label="Inspect ${esc(a.title)}"><img src="${esc(url)}" loading="lazy" decoding="async" alt=""></button>`:fileIconHTML(type)}${library?`<label class="compare-pick"><input type="checkbox" data-compare="${esc(a.id)}" data-task="${esc(task.id)}"> Compare</label>`:''}<div><strong>${esc(a.title)}</strong><small>${esc(meta)}</small>${library&&a.contentMatch?`<p class="library-match"><span>Found in file</span>${esc(a.contentMatch)}</p>`:''}${library?`<button class="library-source" data-select="${esc(task.id)}">${esc(task.title)}</button>`:''}<div class="file-actions"><button data-preview="${esc(a.id)}" data-task="${esc(task.id)}">Preview</button><a href="${esc(url)}" download>Download</a><button data-revise="${esc(a.id)}" data-task="${esc(task.id)}">Revise</button></div></div></article>`;
}
export function libraryHTML(tasks,options={}){
  const items=libraryItems(tasks,options),byId=new Map(tasks.map(t=>[t.id,t])),limit=options.limit||100;
  const total=libraryItems(tasks,{}).length;
  return `<section class="page library"><header class="page-head"><div><h1>Library</h1><p>${total?`${total} file${total===1?'':'s'} made by your tasks`:'Every file your tasks make, in one place'}</p></div></header><div class="library-tools"><label class="field"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-search"/></svg><span class="sr-only">Find an output</span><input id="library-search" type="search" value="${esc(options.query||'')}" placeholder="Search titles, contents or the source task" autocomplete="off"></label><label><span class="sr-only">Date</span><select id="library-date" class="field-select">${LIBRARY_DATES.map(([value,label])=>`<option value="${value}" ${(options.date||'all')===value?'selected':''}>${label}</option>`).join('')}</select></label><label><span class="sr-only">File type</span><select id="library-type" class="field-select"><option value="all">All files</option>${['pdf','docx','xlsx','md','html','png','csv'].map(type=>`<option value="${type}" ${options.type===type?'selected':''}>${type.toUpperCase()}</option>`).join('')}</select></label><button id="compare-files" disabled title="Tick Compare on two files, then open them side by side">Compare two</button></div><p class="muted" id="compare-status" role="status"></p><div class="file-cards library-grid">${items.slice(0,limit).map(a=>artifactCard(byId.get(a.taskId),a,{library:true})).join('')||(options.query||options.type&&options.type!=='all'||options.date&&options.date!=='all'?'<div class="empty">No outputs match these filters.</div>':'<div class="empty">Outputs will appear here when your tasks create files.</div>')}</div>${options.searching?'<p class="muted library-searching" role="status">Searching inside files…</p>':''}${items.length>limit?'<button id="library-more">Show more outputs</button>':''}</section>`;
}
export function taskControls(t){
  if(['running','queued','scheduled','waiting'].includes(t.status))return '<button data-action="pause">Pause</button><button data-action="stop">Stop</button>';
  if(['paused','stopped','attention'].includes(t.status))return '<button data-action="resume">Resume</button>';return '';
}
export function taskSummary(t){
  const progress=t.progress||{},working=t.plan?.find(p=>p.status==='working'),done=t.plan?.filter(p=>p.status==='done').length||0,total=t.plan?.length||0;
  const current=({queued:'Waiting for available capacity',scheduled:'Waiting for its scheduled time',waiting:'Waiting for your answer',complete:'Work has finished',paused:'Paused by you',stopped:'Stopped',attention:'Needs attention'}[t.status])||progress.current||working?.title||t.activity||'Working on your request';
  const measured=Number.isInteger(progress.step)&&Number.isInteger(progress.total)&&progress.total>0&&progress.step>=0&&progress.step<=progress.total;
  const terminal=['complete','stopped'].includes(t.status),elapsedStart=progress.startedAt||t.startedAt,elapsedEnd=t.status==='complete'?t.completedAt:null;
  const showElapsed=Number.isFinite(elapsedStart)&&(!terminal||Number.isFinite(elapsedEnd));
  const count=measured?`${progress.step} of ${progress.total}`:total?`${done} of ${total} plan steps complete`:'';
  const blocker=progress.blocker||t.question?.text||t.handoff?.message||t.error;
  const evidence=t.resultEvidence,checks=evidence?.checks||[],resultLabel={verified:'Deliverable checks passed',partial:'Partial result',blocked:'Blocked',unverified:'Result needs verification','needs-verification':'Result needs verification'}[evidence?.status]||'Result needs verification';
  const deliveries=(t.deliveries||[]).slice(-3);
  const evidenceBlock=t.status==='complete'||evidence?`<details class="result-evidence"><summary>${esc(resultLabel)}</summary><p>${esc(evidence?.summary||'Review the output and evidence before relying on this result.')}</p>${checks.length?`<ul>${checks.map(evidenceCheck).join('')}</ul>`:''}${evidence?.scope?`<p class="muted">${esc(evidence.scope)}</p>`:''}</details>`:'';
  // Finished work needs no progress card: one quiet line with collapsible checks and context.
  if(terminal&&!(t.deliveries||[]).some(d=>d.status==='uncertain'))return `<div class="work-done" aria-label="Task result"><span class="work-done-label">${t.status==='complete'?'Finished':'Stopped'}</span>${showElapsed?`<span data-work-elapsed="${elapsedStart}" ${Number.isFinite(elapsedEnd)?`data-work-finished="${elapsedEnd}"`:''} aria-hidden="true"></span>`:''}${evidenceBlock}${contextHTML(t.contextUsed,{taskId:t.id,learned:t.learned})}</div>`;
  return `<section class="work-summary" aria-label="Task progress"><div class="work-summary-head"><strong>${esc(current)}</strong><div class="task-controls">${taskControls(t)}</div></div><div class="work-summary-meta">${count?`<span>${esc(count)}</span>`:''}${showElapsed?`<span data-work-elapsed="${elapsedStart}" ${Number.isFinite(elapsedEnd)?`data-work-finished="${elapsedEnd}"`:''} aria-hidden="true"></span>`:''}${t.project?`<span>${esc(t.project)}</span>`:''}</div>${measured&&!terminal?`<progress value="${progress.step}" max="${progress.total}" aria-label="Task progress"></progress>`:''}${blocker&&['waiting','attention','queued'].includes(t.status)?`<p class="work-blocker"><strong>Next:</strong> ${esc(blocker)}</p>`:''}${evidenceBlock}${deliveries.length?`<div class="steering-receipts">${deliveries.map(d=>`<span title="${d.appliedAt||d.status==='applied'?'Delivered to the active session':'Saved for delivery'}"><i aria-hidden="true">${d.appliedAt||d.status==='applied'?'✓':'↳'}</i> ${esc(d.appliedAt||d.status==='applied'?'Applied to this task':d.status==='uncertain'?'Delivery needs verification':'Received')}<small>${esc(String(d.text||'Additional instruction').slice(0,80))}</small></span>`).join('')}</div>`:''}${contextHTML(t.contextUsed,{taskId:t.id,learned:t.learned})}</section>`;
}
const MEMORY_KIND={workflow:'Habit',preference:'Preference',fact:'Fact'};
/**
 * The task's memory receipt: what it learned ("Noted", with undo) and everything memory put in
 * front of the agent ("Remembered"), each with its source and a one-tap "That's wrong".
 */
export function contextHTML(context,{taskId=null,learned=[]}={}){
  const items=Array.isArray(context)?context:[];
  const notes=(Array.isArray(learned)?learned:[]).map(l=>{
    const forgotten=l.action==='forgotten',review=l.status==='review';
    const label=forgotten?'Forgot':review?'Saved for your OK':'Noted';
    const undo=forgotten?`<button type="button" data-memory-undo="${esc(l.id)}" data-memory-action="accept">Undo</button>`:review?'<button type="button" data-view="memory">Review</button>':`<button type="button" data-memory-undo="${esc(l.id)}" data-memory-action="forget">Undo</button>`;
    return `<span class="memory-noted${forgotten?' is-forgotten':''}" data-noted="${esc(l.id)}"><span class="memory-noted-label">${label}</span> ${esc(l.text)} ${undo}</span>`;
  }).join('');
  if(!items.length)return notes?`<div class="memory-noted-list">${notes}</div>`:'';
  const learnedCount=items.filter(i=>typeof i==='object'&&i.kind==='learned').length,skillCount=items.filter(i=>typeof i==='object'&&i.kind==='skill').length;
  return `${notes?`<div class="memory-noted-list">${notes}</div>`:''}<details class="context-used"><summary>${[learnedCount?`Remembered ${learnedCount} thing${learnedCount===1?'':'s'}`:null,skillCount?`used ${skillCount} skill${skillCount===1?'':'s'}`:null].filter(Boolean).join(' · ')||'Context used'}${items.length>learnedCount+skillCount&&(learnedCount||skillCount)?` · ${items.length} in context`:!(learnedCount||skillCount)?` · ${items.length}`:''}</summary><ul>${items.map(item=>{
    const learnedItem=typeof item==='object'&&item.kind==='learned',skillItem=typeof item==='object'&&item.kind==='skill';
    const tag=skillItem?`<small>${esc(item.status==='active'?'Skill · proven':'Skill · on trial')}</small>`:learnedItem?`<small>${esc([MEMORY_KIND[item.memoryKind]||'Note',item.about&&item.about!=='You'?item.about:null,item.always?'always on':null].filter(Boolean).join(' · '))}</small>`:typeof item==='object'&&item.scope?`<small>${esc(item.scope)}</small>`:'';
    return `<li><strong>${esc(typeof item==='string'?item:item.text||item.label||item.name||'Saved context')}</strong>${tag}${(item.sources||[]).filter(source=>source.taskId).map(source=>`<button data-select="${esc(source.taskId)}">${esc(source.title||'Source conversation')}</button>`).join('')}${item.sourceTaskId&&!(item.sources||[]).length?`<button data-select="${esc(item.sourceTaskId)}">Source conversation</button>`:''}${learnedItem&&item.id?`<button type="button" class="memory-wrong" data-memory-flag="${esc(item.id)}" data-task="${esc(taskId||'')}">That’s wrong</button>`:''}${skillItem&&item.id?`<button type="button" class="memory-wrong" data-skill-flag="${esc(item.id)}" data-task="${esc(taskId||'')}">That’s wrong</button>`:''}</li>`;}).join('')}</ul><button data-view="memory">Review memory</button></details>`;
}
export const memoryScopeLabel=lesson=>[lesson.person?'Owner tasks':'',lesson.project?'Project: '+lesson.project:''].filter(Boolean).join(' · ')||'All tasks';
export const BUILTIN_TEMPLATES=[
 {id:'research',title:'A sourced research brief',description:'A concise report with evidence and open questions.',permissions:'read',fields:[{name:'topic',label:'Topic',type:'text',required:true},{name:'audience',label:'Who is it for?',type:'text'}],objective:'Research {{topic}} for {{audience}}. Use current primary sources where possible. Write a concise report with direct source links, distinguish findings from uncertainty, and create a downloadable Markdown report. Read-only research; do not send messages or change external accounts.'},
 {id:'plan',title:'A practical plan',description:'Options, tradeoffs and next steps.',permissions:'read',fields:[{name:'goal',label:'Outcome',type:'textarea',required:true},{name:'constraints',label:'Budget, timing and constraints',type:'textarea'}],objective:'Make an actionable plan for {{goal}}. Constraints: {{constraints}}. Compare options, state assumptions, identify the next steps and create a useful downloadable plan. Do not book, buy or contact others.'},
 {id:'calendar',title:'Read my calendar',description:'Review connected calendar events for a chosen date.',permissions:'read',fields:[{name:'date',label:'Date',type:'date',required:true}],objective:'Read my connected calendar for {{date}} and summarize events, conflicts and free time. Use a supported calendar API when available, report the date and time zone, and link the source events. Do not create, move or delete events.'},
 {id:'email-draft',title:'Draft a reply',description:'Prepare a reply you can review before sending.',permissions:'draft',fields:[{name:'recipient',label:'Recipient email',type:'email',required:true},{name:'instructions',label:'What should the reply say?',type:'textarea',required:true}],objective:'Prepare an email reply to {{recipient}} with these instructions: {{instructions}}. Read relevant connected email only as needed. Show the exact recipient, subject and body as a reviewable draft. Do not send it without explicit approval of that payload.'},
 {id:'document',title:'Create a useful document',description:'A downloadable deliverable from your brief.',permissions:'draft',fields:[{name:'brief',label:'Document brief',type:'textarea',required:true},{name:'format',label:'Preferred format',type:'text'}],objective:'Create a {{format}} document from this brief: {{brief}}. Check that the deliverable exists, can be opened and contains the requested content; provide its download link. Do not publish or share it externally.'}
];
export function templateObjective(template,values){
  for(const field of template.fields||[]){const value=String(values[field.name]||'').trim();if(field.required&&!value)throw new Error('Complete '+field.label+'.');if(value.length>6000)throw new Error('Keep '+field.label+' under 6000 characters.');if(value&&field.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw new Error('Enter a valid email address.');if(value&&field.type==='url'){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))throw new Error();}catch{throw new Error('Enter an HTTP or HTTPS URL.');}}}
  const objective=String(template.objective||'').replace(/\{\{([\w-]+)\}\}/g,(_all,key)=>String(values[key]||'not specified').trim());
  return objective+'\n\nWorkflow scope: '+({read:'Read-only. Do not change external accounts, send messages, purchase, book or publish.',draft:'Prepare a draft or local output. Do not send, publish or commit an external change without exact-action approval.',approve:'Review the exact recipient, content and material parameters before any external action; reuse existing explicit authorization only within its scope.'}[template.permissions]||'Follow the user’s stated authority and review external actions.');
}
export function financeDebtHTML({data,status,cash,date}){
  const entries=Object.entries(data.liabilities||{}).flatMap(([type,items])=>(items||[]).map(x=>{const account=(data.accounts||[]).find(a=>(a.id||a.account_id)===x.account_id);return {type,name:x.account_name||x.name||account?.name||type,mask:x.account_mask||account?.mask||'',minimum:x.minimum_payment_amount,statement:x.last_statement_balance,current:x.current_balance??account?.current,due:x.next_payment_due_date,apr:x.aprs?.find(a=>a.apr_type==='purchase_apr')?.apr_percentage};}));
  return `<section class="fin-subview"><div class="fin-section-title"><div><h2>Debt & payments</h2><p>Different amounts describe different obligations. Check your institution before making a payment.</p></div></div>${status.products?.liabilities?entries.map(x=>`<article class="fin-rec-card"><span class="fin-rec-icon" aria-hidden="true">▤</span><div><strong>${esc(x.name)}${x.mask?' ··'+esc(x.mask):''}</strong><p>${esc(x.type)}${x.apr!=null?' · '+esc(x.apr)+'% APR':''}${x.due?' · due '+esc(date(x.due)):''}</p><dl class="fin-debt-amounts">${[['Minimum due',x.minimum],['Statement balance',x.statement],['Current balance',x.current]].filter(([,value])=>Number.isFinite(value)).map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(cash(value))}</dd></div>`).join('')||'<div><dt>Balance</dt><dd>Not supplied</dd></div>'}</dl></div></article>`).join('')||'<div class="fin-empty">No liability details were returned by Plaid.</div>':'<div class="fin-empty">Detailed liabilities are not enabled for this Plaid connection. Account balances still include supported credit and loan accounts.</div>'}</section>`;
}
export const approvalAttributes=approval=>`data-proposal-id="${esc(approval?.proposalId||approval?.id||'')}" data-fingerprint="${esc(approval?.fingerprint||'')}"`;
export function approvalDetails(approval){
  const proposal=approval?.proposal||approval?.intent;if(!proposal||typeof proposal!=='object')return '';
  const secretKey=key=>/^(fingerprint|proposalId|digest|credentials?|password|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie)$/i.test(key);
  const redact=value=>Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,secretKey(key)?'[hidden credential]':redact(item)])):value;
  const values=Object.entries(proposal).filter(([key,value])=>value!==undefined&&value!==null&&!secretKey(key));
  if(!values.length)return '';
  return `<details class="approval-details" open><summary>Review exact action</summary><dl>${values.map(([key,value])=>`<div><dt>${esc(key.replaceAll('_',' '))}</dt><dd><pre>${esc(typeof value==='object'?JSON.stringify(redact(value),null,2):String(value))}</pre></dd></div>`).join('')}</dl><p class="muted">Approve only this reviewed action. A changed payload needs a fresh review.</p></details>`;
}
export function wallTimeToUTC(value,timeZone){
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);if(!match)throw new Error('Choose a start date and time.');
  const [,year,month,day,hour,minute]=match.map(Number),wanted=Date.UTC(year,month-1,day,hour,minute),format=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});let candidate=wanted;
  const wall=date=>{const fields=Object.fromEntries(format.formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));return Date.UTC(fields.year,fields.month-1,fields.day,fields.hour,fields.minute);};
  for(let i=0;i<4;i++){const difference=wanted-wall(candidate);if(!difference)return new Date(candidate).toISOString();candidate+=difference;}
  throw new Error('This local time does not exist because of a daylight saving change. Choose another time.');
}
export function templateForm(template){
  const permission={read:'Read-only. No external changes.',draft:'Prepare a draft or local file. Review before sending or publishing.',approve:'External changes require review of the exact action.'}[template.permissions]||'Review the requested actions before running.';
  return `<form id="workflow-use"><h2>${esc(template.title)}</h2><p>${esc(template.description||'Reuse a successful workflow.')}</p><p class="workflow-permission">${esc(permission)}</p>${(template.fields||[]).map(f=>`<label>${esc(f.label||f.name)}${f.type==='textarea'?`<textarea name="${esc(f.name)}" ${f.required?'required':''} maxlength="6000"></textarea>`:`<input name="${esc(f.name)}" type="${['text','email','url','date'].includes(f.type)?f.type:'text'}" ${f.required?'required':''}>`}</label>`).join('')}<details><summary>Workflow instructions</summary><pre>${esc(template.objective)}</pre></details><div class="dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary">Use in composer</button></div></form>`;
}
export function trapModal(container,{returnTo=document.activeElement,onClose}={}){
  // The scrim stays clickable so a tap outside closes the sheet or drawer.
  const external=[...document.body.children].filter(el=>el!==container&&!el.contains(container)&&!el.hasAttribute('data-scrim')&&!['SCRIPT','STYLE','DIALOG'].includes(el.tagName));
  const previous=external.map(el=>[el,el.inert]);external.forEach(el=>el.inert=true);
  const key=event=>{if(event.key==='Escape'){event.preventDefault();onClose?.();return;}if(event.key!=='Tab')return;const nodes=[...container.querySelectorAll('button,a[href],input,textarea,select,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);if(!nodes.length){event.preventDefault();container.focus();return;}const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&(document.activeElement===first||!container.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!container.contains(document.activeElement))){event.preventDefault();first.focus();}};
  container.addEventListener('keydown',key);return ()=>{container.removeEventListener('keydown',key);previous.forEach(([el,inert])=>el.inert=inert);if(returnTo?.isConnected)returnTo.focus({preventScroll:true});};
}
export function mountVoice({button,input,status}){
  const Recognition=globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition;let recognition=null,original='',committed='',active=false;
  button.hidden=false;button.setAttribute('aria-pressed','false');
  // Icon buttons keep their icon: only the (visually hidden) label and the accessible name change.
  const label=button.querySelector('[data-voice-label]'),idleName=button.getAttribute('aria-label')||'Voice';
  const setLabel=(text,name)=>{if(label){label.textContent=text;button.setAttribute('aria-label',name);button.title=name;}else button.textContent=text;};
  const finish=()=>{active=false;button.setAttribute('aria-pressed','false');setLabel('Voice',idleName);recognition=null;};
  const stop=()=>{if(!recognition)return;const previous=recognition;finish();previous.onresult=null;previous.onend=null;previous.stop();status.textContent='Voice text is ready to review. Sending is always your choice.';};
  button.addEventListener('click',()=>{
    if(active){stop();return;}
    if(!Recognition){status.textContent='Voice is unavailable in this browser. Type your request in the composer.';input.focus();return;}
    recognition=new Recognition();const instance=recognition;recognition.lang=document.documentElement.lang||navigator.language||'en-US';recognition.continuous=true;recognition.interimResults=true;original=input.value;committed='';active=true;button.setAttribute('aria-pressed','true');setLabel('Stop voice','Stop dictating');status.textContent='Listening. Your browser handles speech recognition and may use its speech provider. Review the text before sending.';
    recognition.onresult=event=>{let final='',interim='';for(let i=event.resultIndex;i<event.results.length;i++){const text=event.results[i][0]?.transcript||'';if(event.results[i].isFinal)final+=text+' ';else interim+=text;}committed+=final;input.value=[original,committed+interim].filter(Boolean).join(' ');input.dispatchEvent(new Event('input',{bubbles:true}));};
    recognition.onerror=event=>{if(recognition!==instance)return;status.textContent=event.error==='not-allowed'?'Microphone access was not allowed. You can type instead.':'Voice stopped. Your text is preserved; continue by typing.';finish();};
    recognition.onend=()=>{if(recognition!==instance)return;finish();status.textContent='Voice text is ready to review. Sending is always your choice.';};
    try{recognition.start();}catch{finish();status.textContent='Voice could not start. Continue by typing.';}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  return {stop};
}
