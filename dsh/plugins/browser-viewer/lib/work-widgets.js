// Shared, bounded data contract for model-authored views. No HTML, scripts,
// arbitrary styles or tool callbacks are accepted. Works in Node and browsers.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error('Invalid chat view: ' + message); };
function text(value, label, {required=false, limit=4000}={}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > limit || required && !value.trim()) fail(label + ' must be text of 1–' + limit + ' characters.');
  return value.trim();
}
function scalar(value, label) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return value;
  return text(value, label, {limit:2000});
}
function array(value, label, limit, required=true) {
  if (value == null && !required) return [];
  if (!Array.isArray(value) || value.length > limit || required && !value.length) fail(label + ' must contain 1–' + limit + ' items.');
  return value;
}
export function safeWidgetURL(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\u0000-\u001f\u007f\\]/.test(value) || !/^https?:\/\//i.test(value)) return null;
  try { const url = new URL(value); return url.username || url.password || !url.hostname ? null : url.href; } catch { return null; }
}
function actions(value) {
  return array(value, 'actions', 4, false).map(a => {
    if (!object(a)) fail('an action must be an object.');
    const label = text(a.label, 'action label', {required:true,limit:80});
    if (a.request != null && a.href != null) fail('an action uses either request or href.');
    if (a.request != null) return {label,request:text(a.request,'action request',{required:true,limit:2000})};
    const href = safeWidgetURL(a.href); if (!href) fail('action links must be HTTP(S) URLs without credentials.');
    return {label,href};
  });
}
function badge(value) {
  if (value == null) return null;
  if (typeof value === 'string') return {label:text(value,'badge',{limit:80}),tone:'neutral'};
  if (!object(value)) fail('badge must be text or {label,tone}.');
  return {label:text(value.label,'badge label',{required:true,limit:80}),tone:['neutral','success','warning','info'].includes(value.tone)?value.tone:'neutral'};
}

/** Normalize onto a whitelist. Also bounds the total payload and nesting cost. */
export function normalizeWidgets(value) {
  let bytes; try { bytes = JSON.stringify(value)?.length; } catch { fail('view must be JSON.'); }
  if (!bytes || bytes > 65536) fail('view must fit in 64 KB.');
  if (object(value) && value.version != null && value.version !== 1) fail('unsupported version.');
  const input = Array.isArray(value)?value:object(value) && value.widgets != null?value.widgets:[value];
  let nodes = 0;
  const normalize = (w, depth=0) => {
    if (!object(w) || ++nodes > 80 || depth > 3) fail('view is too deeply nested or large.');
    if (w.version != null && w.version !== 1) fail('unsupported version.');
    const common = {type:w.type,title:text(w.title,'title',{limit:160}),description:text(w.description,'description'),actions:actions(w.actions)};
    switch (w.type) {
      case 'card': return {...common,text:text(w.text,'card text'),badge:badge(w.badge)};
      case 'cards': return {...common,items:array(w.items,'cards',8).map(c => {
        if(!object(c))fail('each card must be an object.');
        return normalize({...c,type:'card'},depth+1);
      })};
      case 'stats': return {...common,items:array(w.items,'stats',8).map(s => {
        if (!object(s)) fail('a statistic must be an object.');
        return {label:text(s.label,'stat label',{required:true,limit:100}),value:scalar(s.value,'stat value'),detail:text(s.detail,'stat detail',{limit:200})};
      })};
      case 'list': return {...common,items:array(w.items,'list',40).map(s => {
        if (typeof s === 'string') return {title:text(s,'list title',{required:true}),text:'',badge:null,actions:[]};
        if (!object(s)) fail('a list item must be text or an object.');
        return {title:text(s.title,'list title',{required:true,limit:160}),text:text(s.text,'list text'),badge:badge(s.badge),actions:actions(s.actions)};
      })};
      case 'table': {
        const columns = array(w.columns,'columns',12).map(c => typeof c === 'string'?{label:text(c,'column',{required:true,limit:100}),align:'left'}:
          object(c)?{label:text(c.label,'column label',{required:true,limit:100}),align:['left','right','center'].includes(c.align)?c.align:'left'}:fail('column must be text or {label,align}.'));
        const rows = array(w.rows,'rows',200,false).map(r => {
          if (!Array.isArray(r) || r.length > 12) fail('table rows must be arrays of up to 12 cells.');
          return columns.map((_,i)=>scalar(r[i],'table cell'));
        });
        return {...common,columns,rows};
      }
      case 'chart': return {...common,unit:text(w.unit,'chart unit',{limit:40}),data:array(w.data,'chart data',30).map(d => {
        if (!object(d) || typeof d.value !== 'number' || !Number.isFinite(d.value) || Math.abs(d.value)>1e15) fail('chart values must be finite numbers between -1e15 and 1e15.');
        return {label:text(d.label,'chart label',{required:true,limit:100}),value:d.value};
      })};
      case 'image': return {...common,src:text(w.src,'image source',{required:true,limit:2000}),alt:text(w.alt,'image alt',{required:true,limit:300}),caption:text(w.caption,'image caption',{limit:500})};
      default: fail('unknown component type ' + String(w.type).slice(0,60) + '.');
    }
  };
  return array(input,'widgets',12).map(w=>normalize(w));
}

const badgeHTML = b => b?`<span class="chat-badge tone-${b.tone}">${esc(b.label)}</span>`:'';
function actionsHTML(items) {
  if (!items.length) return '';
  return `<div class="chat-view-actions">${items.map(a=>a.request?
    `<button type="button" data-widget-prompt="${esc(a.request)}" title="Prepare this follow-up in the composer">${esc(a.label)}</button>`:
    `<a href="${esc(a.href)}" target="_blank" rel="noopener noreferrer">${esc(a.label)} ↗</a>`).join('')}</div>`;
}
const displayValue = (value, unit='') => `${typeof value === 'number'?value.toLocaleString('en-US'):value}${unit?' '+unit:''}`;
export function compareWidgetValues(a,b) {
  if (typeof a === 'number' && typeof b === 'number') return a-b;
  return String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'});
}
function sortedRows(rows,sort) {
  return rows.map((cells,index)=>({cells,index})).sort((a,b)=>sort && Number.isInteger(sort.column)?(compareWidgetValues(a.cells[sort.column],b.cells[sort.column])*(sort.direction==='descending'?-1:1)||a.index-b.index):a.index-b.index);
}
function tableHTML(w,key,sort) {
  return `<div class="md-table chat-view-table" tabindex="0" role="region" aria-label="${esc(w.title||'Data table')}"><table><thead><tr>${w.columns.map((c,i)=>
    `<th scope="col" style="text-align:${c.align}" aria-sort="${sort?.column===i?sort.direction:'none'}"><button type="button" data-widget-sort="${i}" aria-label="Sort by ${esc(c.label)}">${esc(c.label)}<span aria-hidden="true">${sort?.column===i?(sort.direction==='descending'?' ↓':' ↑'):' ↕'}</span></button></th>`).join('')}</tr></thead><tbody>${sortedRows(w.rows,sort).map(({cells,index})=>
    `<tr data-widget-row="${index}">${cells.map((c,i)=>`<td style="text-align:${w.columns[i].align}" data-widget-number="${typeof c==='number'?c:''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>${!w.rows.length?'<p class="chat-view-empty">No rows to show.</p>':''}</div>`;
}

export function renderWidgets(value,{markdown=esc,resolveFile=null,key='view',sorts=null}={}) {
  const widgets = normalizeWidgets(value);
  const render = (w,k) => {
    const heading = w.title?`<div class="chat-view-heading"><strong>${esc(w.title)}</strong>${badgeHTML(w.badge)}</div>`:badgeHTML(w.badge);
    const description = w.description?`<div class="chat-view-description">${markdown(w.description)}</div>`:'';
    let body = '';
    switch (w.type) {
      case 'card': body = w.text?`<div class="chat-view-copy">${markdown(w.text)}</div>`:''; break;
      case 'cards': body = `<div class="chat-view-grid">${w.items.map((c,i)=>render(c,k+'-'+i)).join('')}</div>`; break;
      case 'stats': body = `<dl class="chat-view-stats">${w.items.map(s=>`<div><dt>${esc(s.label)}</dt><dd>${esc(displayValue(s.value))}</dd>${s.detail?`<small>${esc(s.detail)}</small>`:''}</div>`).join('')}</dl>`; break;
      case 'list': body = `<ul class="chat-view-list">${w.items.map(s=>`<li><div class="chat-view-heading"><strong>${esc(s.title)}</strong>${badgeHTML(s.badge)}</div>${s.text?`<div class="chat-view-copy">${markdown(s.text)}</div>`:''}${actionsHTML(s.actions)}</li>`).join('')}</ul>`; break;
      case 'table': body = tableHTML(w,k,sorts?.get(k)); break;
      case 'chart': {
        const negative=w.data.some(d=>d.value<0),positive=w.data.some(d=>d.value>0),mixed=negative&&positive,max=Math.max(1,...w.data.map(d=>Math.abs(d.value)));
        body=`<figure class="chat-view-chart"><ul>${w.data.map(d=>`<li><span class="chart-label">${esc(d.label)}</span><span class="chart-track ${mixed?'mixed':negative?'negative':''}" aria-hidden="true"><i class="${d.value<0?'negative':'positive'}" style="width:${Math.abs(d.value)/max*(mixed?50:100)}%"></i></span><span class="chart-value">${esc(displayValue(d.value,w.unit))}</span></li>`).join('')}</ul><figcaption>${esc(w.title||'Bar chart')}${w.unit?' · '+esc(w.unit):''}</figcaption></figure>`; break;
      }
      case 'image': {
        let file=null;try{file=resolveFile?.(w.src);}catch{}
        // Local images resolve only through the current task's recorded artifacts.
        const src=file?.url||safeWidgetURL(w.src);
        body=src?`<figure class="chat-view-image"><img src="${esc(src)}" alt="${esc(w.alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">${w.caption?`<figcaption>${esc(w.caption)}</figcaption>`:''}</figure>`:`<p class="chat-view-empty">${esc(w.alt)} — image unavailable.</p>`; break;
      }
    }
    return `<section class="chat-view view-${w.type}" data-widget-key="${esc(k)}" aria-label="${esc(w.title||w.type)}">${heading}${description}${body}${actionsHTML(w.actions)}</section>`;
  };
  return widgets.map((w,i)=>render(w,key+'-'+i)).join('');
}

/** Only an explicit seek-ui fence is a view. All other code stays code. */
export function renderRichReply(source,options={}) {
  const markdown=options.markdown||esc,lines=String(source??'').replace(/\r\n?/g,'\n').split('\n');
  let out='',buffer=[],index=0;
  const flush=()=>{if(buffer.length){out+=markdown(buffer.join('\n'));buffer=[];}};
  for(let i=0;i<lines.length;i++) {
    const open=/^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if(!open){buffer.push(lines[i]);continue;}
    const close=new RegExp('^\\s{0,3}'+open[1][0]+'{'+open[1].length+',}\\s*$');
    let end=i+1;while(end<lines.length&&!close.test(lines[end]))end++;
    const block=lines.slice(i,Math.min(end+1,lines.length));
    if(open[2].trim()!=='seek-ui'){buffer.push(...block);i=end;continue;}
    flush();
    if(end===lines.length)out+='<div class="chat-view-pending" role="status">Preparing view…</div>';
    else try {out+=renderWidgets(JSON.parse(lines.slice(i+1,end).join('\n')),{...options,key:(options.key||'reply')+'-'+index++});}
    catch {out+=`<details class="chat-view-fallback"><summary>View could not be displayed · show source</summary>${markdown(block.join('\n'))}</details>`;}
    i=end;
  }
  flush();return out;
}

/** Plain-text representation for copy, search, exports and branch context. */
export function widgetText(value) {
  const describe=w=>[w.title,w.description,w.badge?.label,
    w.type==='card'?w.text:w.type==='cards'?w.items.map(describe).join('\n\n'):
    w.type==='stats'?w.items.map(s=>`${s.label}: ${displayValue(s.value)}${s.detail?' — '+s.detail:''}`).join('\n'):
    w.type==='list'?w.items.map(s=>[s.title,s.text,s.badge?.label].filter(Boolean).join(' — ')).join('\n'):
    w.type==='table'?[w.columns.map(c=>c.label).join(' | '),...w.rows.map(r=>r.join(' | '))].join('\n'):
    w.type==='chart'?w.data.map(d=>`${d.label}: ${displayValue(d.value,w.unit)}`).join('\n'):[w.alt,w.caption].filter(Boolean).join('\n'),
    w.actions.map(a=>a.label+': '+(a.request||a.href)).join('\n')].filter(Boolean).join('\n');
  return normalizeWidgets(value).map(describe).join('\n\n');
}

/** Native buttons/links and table sorting; follow-ups go through the composer. */
export function installWidgetInteractions(root,{onPrompt,sorts=new Map()}={}) {
  const handle=event=>{
    const button=event.target.closest?.('[data-widget-prompt],[data-widget-sort]');
    if(!button||!root.contains(button)||!button.closest('.chat-view'))return;
    if(button.hasAttribute('data-widget-prompt')){event.preventDefault();onPrompt?.(button.dataset.widgetPrompt);return;}
    const table=button.closest('table'),head=button.closest('th'),column=Number(button.dataset.widgetSort),key=button.closest('[data-widget-key]').dataset.widgetKey;
    const direction=head.getAttribute('aria-sort')==='ascending'?'descending':'ascending';
    const value=row=>{const cell=row.cells[column],number=cell.dataset.widgetNumber;return number!==''?Number(number):cell.textContent;};
    const rows=[...table.tBodies[0].rows].sort((a,b)=>compareWidgetValues(value(a),value(b))*(direction==='descending'?-1:1)||Number(a.dataset.widgetRow)-Number(b.dataset.widgetRow));
    for(const h of table.tHead.rows[0].cells){h.setAttribute('aria-sort',h===head?direction:'none');h.querySelector('span').textContent=h===head?(direction==='descending'?' ↓':' ↑'):' ↕';}
    table.tBodies[0].append(...rows);
    if(sorts.size>200)sorts.clear();sorts.set(key,{column,direction});
  };
  root.addEventListener('click',handle);return ()=>root.removeEventListener('click',handle);
}

export const WIDGET_GUIDE = 'Replies support Markdown tables and native chat views. For comparisons, measured data, options or visual explanations, use work_present with a view object (or an array of objects), choosing type: card {title,text,badge?,actions?}, cards {title,items:[{title,text,actions?}]}, stats {title,items:[{label,value,detail?}]}, list {title,items:[{title,text,badge?,actions?}]}, table {title,columns:["Name","Value"],rows:[["A",1]]}, chart {title,unit?,data:[{label,value:number}]}, image {title,src,alt,caption?}. All types allow description and actions:[{label,request}] for a follow-up or {label,href} for an HTTP(S) source link. Follow-ups prepare a draft for the user to send. Use verified values; never invent chart data. Prefer plain Markdown for simple answers. Do not duplicate the entire view in prose. Supply text only for a short explanation. An explicit ```seek-ui JSON fence in your reply also renders a view. Never emit HTML, JSX, JavaScript or unrequested external actions.';
