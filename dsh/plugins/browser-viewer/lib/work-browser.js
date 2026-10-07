// Seek's browser inside the Work conversation, modelled on Muse's handoff:
// watch live, take control (the agent pauses and can't see the page), hand back
// (the agent resumes by itself). Works with mouse, keyboard and touch.
import {trapModal,approvalDetails,approvalAttributes} from '/work/product.js';
import {MirrorView} from '/work/mirror.js';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = n => `<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-${n}"/></svg>`;
const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

let ws = null, retry = null, idleClose = null, frame = null, status = {}, task = null, agentName = 'Seek';

// ── task-level actions go through the Work API so the engine resumes the task ──
async function api(body) {
  const res = await fetch('/work/api/control', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Unable to reach your agent.');
  return data;
}
function toast(message) { const t = $('#toast'); if (!t) return; t.textContent = message; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => t.hidden = true, 5000); }
// Browser actions show loading at once, as a browser does; Native resumes when the page arrives.
function send(obj) { if (ws && ws.readyState === 1) { if (['navigate', 'back', 'forward', 'reload', 'tab'].includes(obj.type)) mirrorView?.expectLoad(); ws.send(JSON.stringify(obj)); } }

let pendingControl = false,releaseFocus=null,returnFocus=null,expandedChoice=null,layoutModal=null;
let mirrorView=null,mirrorWanted=false,pictureChoice=false,mirrorFallback=false,mirrorRelay=false,mirrorLoading=false;
try{pictureChoice=localStorage.getItem('seek.browser.view')==='picture';}catch{}
function nativeView(on){mirrorView?.show(on);if(!on){linkStatus('');closeMenu();}$('#bv-canvas').hidden=on;const toggle=$('#bv-view');if(toggle){toggle.textContent=on?'Native':'Picture';toggle.setAttribute('aria-pressed',String(on));}$('#bv-keys').hidden=on?!mirrorRelay:status.control==='agent';if(on&&mirrorLoading)$('#bv-veil').hidden=false;}
function syncMirror(){const want=!!(status.running&&status.control==='user'&&status.mirror?.available&&!pictureChoice&&!$('#bv-sheet').hidden);if(want!==mirrorWanted){mirrorWanted=want;mirrorFallback=false;send({type:'mirror',on:want});}nativeView(want&&!mirrorFallback);}
function takeControl() { if (ws && ws.readyState === 1) send({type:'pause', paused:true}); else pendingControl = true; }
async function handBack() {
  try {
    if (task?.handoff) await api({id:task.id, action:'handback'});
    else send({type:'handback'});
    toast(`Handed back. ${agentName} is picking up where you left off.`);
  } catch (e) { toast(e.message); }
}
async function decide(decision, scope,button) {
  try {
    const review=button?.closest('[data-proposal-id]'),binding={proposalId:review?.dataset.proposalId||undefined,fingerprint:review?.dataset.fingerprint||undefined};
    if (task?.approval) await api({id:task.id, action:decision, scope,...binding});
    else send({type:decision, scope,...binding});
  } catch (e) { toast(e.message); }
}

// ── stream ──────────────────────────────────────────────────────────────────
function wanted() { return !document.hidden && (!$('#bv-sheet').hidden || !!document.querySelector('[data-bv-thumb]')); }
function sync() {
  if (wanted()) {
    clearTimeout(idleClose); idleClose = null;
    if (!ws) connect();
  } else if (ws && !idleClose) {
    idleClose = setTimeout(() => { idleClose = null; if (!wanted() && ws) { const s = ws; ws = null; s.onclose = null; s.close(); } }, 10000);
  }
}
function connect() {
  clearTimeout(retry);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/browser/stream`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') { try { const m = JSON.parse(ev.data); if (m.type === 'status') onStatus(m); else if(m.type?.startsWith('mirror-')){if(m.type==='mirror-reset'){mirrorFallback=false;nativeView(mirrorWanted);}void mirrorView?.message(m);}else if (m.type === 'batchFrame') { batchFrames[m.slot] = 'data:image/jpeg;base64,' + m.jpeg; paintBatch(); } } catch {} return; }
    createImageBitmap(new Blob([ev.data], {type:'image/jpeg'})).then(bmp => { frame?.close?.(); frame = bmp; paint(); }).catch(() => {});
  };
  ws.onclose = () => { ws = null;mirrorWanted=false;nativeView(false); if (wanted()) retry = setTimeout(connect, 1500); };
}

function paint() {
  if (!frame) return;
  const main = $('#bv-canvas');
  if (!$('#bv-sheet').hidden) {
    if (main.width !== frame.width || main.height !== frame.height) { main.width = frame.width; main.height = frame.height; fit(); }
    main.getContext('2d').drawImage(frame, 0, 0);
  }
  for (const c of document.querySelectorAll('[data-bv-thumb]')) {
    const r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const s = Math.max(w / frame.width, h / frame.height);
    c.getContext('2d').drawImage(frame, 0, 0, frame.width, frame.height, 0, 0, frame.width * s, frame.height * s);
  }
}
function fit() {
  const stage = $('#bv-stage').getBoundingClientRect(), c = $('#bv-canvas');
  if (!c.width || !stage.width) return;
  const s = Math.min(stage.width / c.width, stage.height / c.height);
  c.style.width = Math.floor(c.width * s) + 'px';
  c.style.height = Math.floor(c.height * s) + 'px';
}

function layoutSheet(){
  const sheet=$('#bv-sheet');if(!sheet||sheet.hidden)return;
  const phone=matchMedia('(max-width:640px)').matches,desktop=matchMedia('(min-width:1200px)').matches;
  const expanded=phone||(expandedChoice??status.control==='user'),modal=expanded||!desktop;
  sheet.classList.toggle('expanded',expanded);document.body.classList.toggle('bv-expanded',expanded);
  const toggle=$('#bv-layout');toggle.hidden=phone;toggle.textContent=expanded?(desktop?'Dock':'Restore'):'Expand';toggle.setAttribute('aria-pressed',String(expanded));toggle.setAttribute('aria-label',expanded?'Restore browser panel':'Expand browser to fill the window');
  const shell=sheet.querySelector('.bv-shell');shell.setAttribute('role',modal?'dialog':'region');if(modal)shell.setAttribute('aria-modal','true');else shell.removeAttribute('aria-modal');
  if(layoutModal!==modal){releaseFocus?.();releaseFocus=null;layoutModal=modal;if(modal)releaseFocus=trapModal(sheet,{returnTo:null,onClose:close});}
}
function sizeSheet(){
  const sheet=$('#bv-sheet'),v=window.visualViewport;if(!sheet)return;
  // Keyboard/browser chrome changes the visible viewport independently of the layout viewport.
  // Keep pinch zoom local: it must not repeatedly resize the remote page.
  if(!v||Math.abs(v.scale-1)<.01){sheet.style.setProperty('--bv-screen-height',(v?.height||innerHeight)+'px');sheet.style.setProperty('--bv-screen-top',(v?.offsetTop||0)+'px');}
  layoutSheet();
}

// ── status → UI ─────────────────────────────────────────────────────────────
const isPhone = () => matchMedia('(max-width: 640px)').matches;
const viewportMessage=r=>({type:'viewport',mode:isPhone()?'mobile':'fit',width:r.width,height:r.height,dpr:devicePixelRatio||1,coarse:matchMedia('(pointer:coarse)').matches,colorScheme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light',reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches});
let askedMobile = false, bannerOpen = false;
function onStatus(m) {
  if(mirrorFallback&&m.control==='user'&&m.url&&m.url!==status.url&&!pictureChoice){mirrorFallback=false;send({type:'mirror',on:true,retry:true});}
  if(status.control!==m.control)expandedChoice=null;
  status = m;
  if (pendingControl) { pendingControl = false; if (m.control !== 'user') send({type:'pause', paused:true}); }
  renderSheet();
  // In control on a phone: ask for a phone-sized page so it is readable and tappable.
  if (m.control !== 'user') askedMobile = false;
  else if (!askedMobile && !$('#bv-sheet').hidden) {
    askedMobile = true;
    const r = $('#bv-stage').getBoundingClientRect();
    send(viewportMessage(r));
  }
  if (m.error && /Take control first/.test(m.error)) toast(`${agentName} is using the browser. Take control first.`);
  syncMirror();
  paintBatch();
  for (const el of document.querySelectorAll('[data-bv-live="doing"]')) el.textContent = doing();
  for (const el of document.querySelectorAll('[data-bv-live="where"]')) el.textContent = where();
}
const doing = () => status.control === 'user' ? "You're in control" : status.activity ? `${agentName} is ${status.activity.replace(/^./, c => c.toLowerCase())}…` : status.running ? `${agentName} has the browser open` : 'The browser is closed';
const where = () => [status.title, hostOf(status.url)].filter(Boolean).join(' · ') || 'No page open';

// ── fast-lane batches: several background tabs at once ──────────────────────
const batchFrames = [];
const eta = ms => ms < 60000 ? `${Math.max(1, Math.ceil(ms / 1000))} s` : `${Math.round(ms / 60000)} min`;
function paintBatch() {
  const b = status.batch, live = !!(b && b.state === 'running');
  const box = $('#bv-batch');
  if (box) {
    box.hidden = !live;
    if (live) {
      box.querySelector('[data-b=label]').textContent = b.label;
      box.querySelector('[data-b=count]').textContent = `${b.done} of ${b.total}`;
      box.querySelector('[data-b=bar]').style.width = (b.total ? Math.round(b.done / b.total * 100) : 0) + '%';
      box.querySelector('[data-b=meta]').textContent = `${b.tabs} tab${b.tabs === 1 ? '' : 's'} in parallel${b.etaMs ? ` · about ${eta(b.etaMs)} left` : ''}`;
      for (const img of box.querySelectorAll('img[data-slot]')) {
        const src = batchFrames[img.dataset.slot];
        if (src && img.src !== src) img.src = src;
        img.parentElement.hidden = !src || Number(img.dataset.slot) >= b.tabs;
      }
    }
  }
  for (const mini of document.querySelectorAll('[data-bv-batch]')) {
    mini.hidden = !live || !batchFrames.length;
    if (live) for (const img of mini.querySelectorAll('img[data-slot]')) { const src = batchFrames[img.dataset.slot]; if (src && img.src !== src) img.src = src; img.hidden = !src; }
  }
  if (!live) batchFrames.length = 0;
}

function renderSheet() {
  if ($('#bv-sheet').hidden) return;
  layoutSheet();
  const handoff = task?.handoff || status.handoff, approval = task?.approval || status.approval;
  const control = status.control || 'idle', user = control === 'user';
  const tabs=$('#bv-tabs');if(tabs){tabs.hidden=!user;const top=$('.bv-top');if(matchMedia('(min-width:900px)').matches){if(tabs.parentNode!==top)top.insertBefore(tabs,$('#bv-who'));}else if(tabs.parentNode===top)top.after(tabs);const html=(status.tabs||[]).map(t=>`<div class="bv-tab${t.id===status.activeTabId?' active':''}"><button data-bv="tab-switch" data-tab="${esc(t.id)}" aria-current="${t.id===status.activeTabId?'page':'false'}">${esc(t.title||hostOf(t.url)||'New tab')}</button><button data-bv="tab-close" data-tab="${esc(t.id)}" aria-label="Close ${esc(t.title||'tab')}">×</button></div>`).join('')+'<button data-bv="tab-open" aria-label="New tab">+</button>';if(tabs.dataset.sig!==html){tabs.innerHTML=html;tabs.dataset.sig=html;}}
  $('#bv-title').textContent = status.title || 'Browser';
  $('#bv-host').textContent = hostOf(status.url);
  $('#bv-who').textContent = approval ? 'Waiting for your approval' : user ? "You're in control" : control === 'agent' ? `${agentName} is browsing` : 'Browser is free';
  $('#bv-who').className = 'bv-who ' + (approval ? 'wait' : user ? 'you' : control);
  const main = $('#bv-main');
  main.hidden = !!approval || (!status.running && !task);
  main.textContent = user ? `Hand back to ${agentName}` : 'Take control';
  main.dataset.bv = user ? 'handback' : 'control';
  const banner = $('#bv-banner');
  // Rebuild only on change: status arrives several times a second and a rebuild mid-click loses the click.
  const setBanner = (cls, html) => { if (banner.dataset.sig !== cls + html) { banner.className = 'bv-banner ' + cls; banner.innerHTML = html; banner.dataset.sig = cls + html; mountVault(); } banner.hidden = false; };
  if (approval) {
    setBanner('approve', `<div><strong>Approve this?</strong> ${esc(agentName)} wants to press “${esc(approval.label)}” on ${esc(approval.host)}. This can’t easily be undone.</div>${approvalDetails(approval)}<div class="bv-banner-actions" ${approvalAttributes(approval)}><button class="primary" data-bv="approve-once">Approve once</button><details class="approval-scopes"><summary>More approval options</summary><button data-bv="approve-task">For this task</button><button data-bv="approve-always">Always this action</button><p>This exact action can be reused. Changed content or recipients require a new review.</p></details><button data-bv="reject">Reject</button></div>`);
  } else if (user) {
    // The note is one line (two on a phone) with More, so the page keeps the room.
    const html = `<div class="bv-note">${handoff ? `<strong>Your turn.</strong> ${esc(handoff.message)} ` : ''}${esc(agentName)} is paused and can’t see the page while you’re in control. Passwords you type here never reach the agent.</div><button class="bv-more" data-bv="more" type="button">More</button>${task?.handoff?.reason === 'login' ? `<div class="bv-vault" data-bv-vault="${esc(task.id)}"></div>` : ''}`;
    if (banner.dataset.sig !== 'you' + html) bannerOpen = false;
    setBanner('you', html);
    banner.classList.toggle('open', bannerOpen);
    const more = banner.querySelector('.bv-more'); if (more) more.textContent = bannerOpen ? 'Less' : 'More';
  } else { banner.hidden = true; banner.dataset.sig = ''; }
  const drive = control !== 'agent';
  $('#bv-nav').hidden = !drive;
  $('#bv-keys').hidden = !drive || (mirrorWanted && !mirrorFallback && !mirrorRelay);
  const toggle=$('#bv-view');if(toggle)toggle.hidden=!user||!status.mirror?.available;
  $('#bv-veil').hidden = (drive || !status.running) && !(mirrorLoading && mirrorView?.active);
  $('#bv-empty').hidden = !!status.running;
  if (status.url && document.activeElement !== $('#bv-addr')) $('#bv-addr').value = status.url;
  renderAsk();
  requestAnimationFrame(fit);
}
// Hovered link address, bottom-left like Chrome's status bubble.
function linkStatus(url){const pill=$('#bv-status');if(!pill)return;clearTimeout(linkStatus.timer);if(url){pill.textContent=url;pill.hidden=false;}else linkStatus.timer=setTimeout(()=>{pill.hidden=true;},120);}
// Right-click on a link or selected text: the few entries a browser offers for them.
let menuData=null;
function openMenu(m){const menu=$('#bv-menu');menuData=m;menu.innerHTML=(m.href?'<button role="menuitem" data-bv="menu-open" type="button">Open link in new tab</button><button role="menuitem" data-bv="menu-copy-link" type="button">Copy link address</button>':'')+(m.text?'<button role="menuitem" data-bv="menu-copy" type="button">Copy</button>':'');menu.hidden=false;menu.style.left=Math.max(8,Math.min(m.x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(m.y,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button')?.focus({preventScroll:true});}
function closeMenu(refocus){const menu=$('#bv-menu');if(!menu||menu.hidden)return;menu.hidden=true;menuData=null;if(refocus&&mirrorView?.active)mirrorView.frame.focus({preventScroll:true});}
async function copyText(text,done){try{await navigator.clipboard.writeText(text);toast(done);}catch{toast('Copying is blocked in this browser.');}}
// The page's own questions (alert/confirm/prompt/leave) and file pickers, answered here as a browser would.
function renderAsk() {
  const box = $('#bv-ask'), d = status.dialog, f = !d && status.fileChooser, sig = JSON.stringify(d || f || null);
  if (!box || box.dataset.sig === sig) return;
  const was = !box.hidden; box.dataset.sig = sig; box.hidden = !d && !f;
  if (box.hidden) { box.innerHTML = ''; if (was) (mirrorView?.active ? mirrorView.frame : $('#bv-canvas')).focus({preventScroll:true}); return; }
  const from = esc(d?.host || hostOf(status.url) || 'This page'), files = f?.multiple ? 'files' : 'a file', leave = d?.type === 'beforeunload';
  box.innerHTML = d
    ? `<div class="bv-ask-card" role="alertdialog" aria-modal="true" aria-labelledby="bv-ask-title" aria-describedby="bv-ask-text"><strong id="bv-ask-title">${leave ? 'Leave site?' : `${from} says`}</strong><p id="bv-ask-text">${esc(leave ? 'Changes you made may not be saved.' : d.message)}</p>${d.type === 'prompt' ? `<input id="bv-ask-input" value="${esc(d.defaultPrompt)}" aria-label="Your answer" autocomplete="off">` : ''}<div class="bv-ask-actions">${d.type === 'alert' ? '' : '<button data-bv="ask-cancel" type="button">Cancel</button>'}<button class="primary" data-bv="ask-ok" type="button">${leave ? 'Leave' : 'OK'}</button></div></div>`
    : `<div class="bv-ask-card" role="dialog" aria-labelledby="bv-ask-title"><strong id="bv-ask-title">Upload ${files}</strong><p>${from} is asking for ${files} from this device.</p><div class="bv-ask-actions"><button data-bv="file-cancel" type="button">Cancel</button><button class="primary" data-bv="file-choose" type="button">Choose ${f.multiple ? 'files' : 'file'}…</button></div></div>`;
  const first = box.querySelector('#bv-ask-input') || box.querySelector('.primary');
  first?.focus({preventScroll:true}); first?.select?.();
  if (f) { const picker = $('#bv-file'); picker.accept = f.accept || ''; picker.multiple = !!f.multiple; picker.value = ''; if (navigator.userActivation?.isActive) picker.click(); }
}
const base64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
async function uploadPicked(input) {
  const token = status.fileChooser?.token, files = [...input.files]; input.value = '';
  if (!token || !files.length) return;
  if (files.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024) { toast('Those files are too large to upload here (50 MB at most).'); send({type:'upload', token, cancel:true}); return; }
  toast(files.length > 1 ? `Uploading ${files.length} files…` : `Uploading ${files[0].name}…`);
  send({type:'upload', token, files:await Promise.all(files.map(async f => ({name:f.name, type:f.type, data:base64(new Uint8Array(await f.arrayBuffer()))})))});
}

// ── inline card in the conversation ─────────────────────────────────────────
function card(t) {
  if (!t || !(t.usesBrowser || t.handoff || t.approval)) return '';
  const thumb = `<button class="bv-thumb" data-bv="open" aria-label="Open the browser"><canvas data-bv-thumb></canvas><span class="bv-live">${t.status === 'running' ? 'LIVE' : 'VIEW'}</span><span class="bv-mini-batch" data-bv-batch hidden>${[0,1,2,3].map(i => `<img data-slot="${i}" alt="">`).join('')}</span></button>`;
  if (t.handoff) return `<section class="bv-card turn">${thumb}<div class="bv-card-body"><div class="bv-kicker"><span class="buddy" data-buddy="mini" data-task="${esc(t.id)}"></span>YOUR TURN</div><p class="bv-say">${esc(t.handoff.message)}</p><p class="bv-meta">${esc(hostOf(t.handoff.url) || 'Browser')} · ${esc(agentName)} is paused and can’t see the page while you’re in control.</p>${t.handoff.reason === 'login' ? `<div class="bv-vault" data-bv-vault="${esc(t.id)}"></div>` : ''}<div class="bv-actions"><button class="primary" data-bv="control">Take control</button><button data-bv="handback">I’m done, hand back</button></div></div></section>`;
  if (t.approval) return `<section class="bv-card approve">${thumb}<div class="bv-card-body"><div class="bv-kicker"><span class="buddy" data-buddy="mini" data-task="${esc(t.id)}"></span>APPROVE THIS?</div><p class="bv-say">Press “${esc(t.approval.label)}” on ${esc(t.approval.host)}?</p><p class="bv-meta">${esc(t.approval.title || t.approval.url)} · This can’t easily be undone.</p>${approvalDetails(t.approval)}<div class="bv-actions" ${approvalAttributes(t.approval)}><button class="primary" data-bv="approve-once">Approve once</button><details class="approval-scopes"><summary>More approval options</summary><button data-bv="approve-task">For this task</button><button data-bv="approve-always">Always this action</button><p>This exact action can be reused. Changed content or recipients require a new review.</p></details><button data-bv="reject">Reject</button><button class="bv-link" data-bv="open">Look at the page</button></div></div></section>`;
  const live = t.status === 'running';
  return `<section class="bv-card">${thumb}<div class="bv-card-body"><div class="bv-kicker">${live ? 'IN THE BROWSER' : 'BROWSER'}</div><p class="bv-say" data-bv-live="doing">${esc(live ? doing() : 'Open the browser to see where things were left.')}</p><p class="bv-meta" data-bv-live="where">${esc(where())}</p><div class="bv-actions"><button data-bv="open">Open browser</button>${live ? '<button data-bv="control">Take control</button>' : ''}</div></div></section>`;
}

// ── saved logins: offered on sign-in handoffs, filled by the host after approval ──
const vaultCache = new Map();
async function mountVault() {
  for (const el of document.querySelectorAll('[data-bv-vault]')) {
    const id = el.dataset.bvVault;
    let v = vaultCache.get(id);
    if (!v || Date.now() - v.at > 5000) {
      try { v = {at:Date.now(), ...(await (await fetch('/work/api/vault/matches?task=' + encodeURIComponent(id))).json())}; } catch { continue; }
      vaultCache.set(id, v);
    }
    const html = v.state === 'missing' || v.state === 'error' ? ''
      : v.state === 'unauthenticated' ? `<p class="bv-vault-note">Tip: <button class="bv-link" data-view="memory" data-bv="close">connect Bitwarden</button> and ${esc(agentName)} can sign in for you next time, with your approval.</p>`
      : !v.unlocked
      ? `<p class="bv-vault-note">Have this login in Bitwarden? <button class="bv-link" data-view="memory" data-bv="close">Unlock your vault</button> on this PC and ${esc(agentName)} can sign in for you.</p>`
      : v.matches?.length
        ? `<div class="bv-actions">${v.matches.slice(0, 3).map(m => `<button class="primary" data-bv="vaultfill" data-item="${esc(m.id)}">Sign in as ${esc(m.username || m.name)}</button>`).join('')}<button class="bv-link" data-bv="secure-toggle">Use a different login</button></div><p class="bv-vault-note">From your vault. ${esc(agentName)} fills it without seeing the password.</p>${secureForm(id, v.site, true)}`
        : `<p class="bv-vault-note">No saved login for ${esc(v.site || 'this site')} in your vault yet.</p>${secureForm(id, v.site, false)}`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }
}
// Muse's "Secure Store" card: the login goes straight to Bitwarden and is used at once.
function secureForm(id, site, hidden) {
  return `<form class="bv-secure" data-bv-secure="${esc(id)}"${hidden ? ' hidden' : ''}><div class="bv-secure-head">Secure sign-in${site ? ` for ${esc(site)}` : ''}</div><input name="username" autocomplete="username" placeholder="Email or username" aria-label="Email or username"><input name="password" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required><button class="primary">Save &amp; sign in</button><p class="bv-vault-note">Saved to your Bitwarden vault and filled in for you. ${esc(agentName)} never sees it.</p></form>`;
}
document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-bv-secure]');
  if (!form) return;
  e.preventDefault();
  const username = form.elements.username.value.trim(), password = form.elements.password.value;
  form.elements.password.value = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  toast('Saving your login and signing in…');
  try {
    const res = await fetch('/work/api/vault/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:form.dataset.bvSecure, username, password})});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not save that login.');
    toast(`Saved and signed in. ${agentName} is picking up where it left off.`);
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; vaultCache.clear(); }
});
async function vaultFill(itemId) {
  if (!task) return;
  toast('Signing in with your saved login…');
  try { await api({id:task.id, action:'vaultfill', itemId}); toast(`Signed in. ${agentName} is picking up where it left off.`); vaultCache.clear(); }
  catch (e) { toast(e.message); vaultCache.clear(); }
}

// ── sheet ───────────────────────────────────────────────────────────────────
function build() {
  const el = document.createElement('div');
  el.id = 'bv-sheet'; el.className = 'bv-sheet'; el.hidden = true;
  el.innerHTML = `<div class="bv-shell" role="dialog" aria-modal="true" aria-label="Browser">
    <header class="bv-top"><button class="bv-close" data-bv="close" aria-label="Close browser">${icon('x')}</button>
      <div class="bv-where"><strong id="bv-title">Browser</strong><span id="bv-host"></span></div>
      <span class="bv-who" id="bv-who" aria-live="polite"></span><button class="bv-layout" id="bv-layout" data-bv="layout" type="button">Expand</button><button class="primary bv-main" id="bv-main"></button></header>
    <div class="bv-banner" id="bv-banner" hidden></div><div id="bv-tabs" class="bv-tabs" aria-label="Browser tabs" hidden></div>
    <div class="bv-nav" id="bv-nav" hidden><button data-bv="back" aria-label="Back">${icon('back')}</button><button data-bv="forward" aria-label="Forward">${icon('forward')}</button><button data-bv="reload" aria-label="Reload">${icon('reload')}</button><input id="bv-addr" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Address" placeholder="Search or enter address"></div>
    <div class="bv-stage" id="bv-stage"><canvas id="bv-canvas" tabindex="0" aria-label="Live browser"></canvas><div class="bv-empty" id="bv-empty">The browser isn’t open right now.</div><div class="bv-batch" id="bv-batch" hidden><div class="bv-batch-head"><strong data-b="label"></strong><span data-b="count"></span></div><div class="bv-batch-bar"><i data-b="bar"></i></div><div class="bv-batch-grid">${[0,1,2,3].map(i => `<figure hidden><img data-slot="${i}" alt=""><figcaption>Tab ${i + 1}</figcaption></figure>`).join('')}</div><div class="bv-batch-meta" data-b="meta"></div></div><div class="bv-veil" id="bv-veil" hidden>Watching · take control to use it yourself</div></div>
    <footer class="bv-keys" id="bv-keys" hidden><input id="bv-type" placeholder="Type into the page…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Type into the page"><button data-bv-key="Backspace" aria-label="Backspace">${icon('backspace')}</button><button data-bv-key="Tab">Tab</button><button data-bv-key="Enter">Enter</button></footer>
  </div>`;
  document.body.appendChild(el);
  sizeSheet();window.addEventListener('resize',sizeSheet);window.visualViewport?.addEventListener('resize',sizeSheet);window.visualViewport?.addEventListener('scroll',sizeSheet);
  const toggle=document.createElement('button');toggle.id='bv-view';toggle.type='button';toggle.dataset.bv='view';toggle.textContent='Picture';toggle.title='Switch between native page and pictures';$('#bv-nav').append(toggle);
  const pill=document.createElement('div');pill.id='bv-status';pill.className='bv-status';pill.hidden=true;$('#bv-stage').append(pill);
  const menu=document.createElement('div');menu.id='bv-menu';menu.className='bv-menu';menu.setAttribute('role','menu');menu.hidden=true;el.append(menu);
  menu.addEventListener('keydown',e=>{const items=[...menu.querySelectorAll('button')],at=items.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMenu(true);}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(at+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}});
  document.addEventListener('pointerdown',e=>{if(!menu.hidden&&!menu.contains(e.target))closeMenu();},true);
  const ask=document.createElement('div');ask.id='bv-ask';ask.className='bv-ask';ask.hidden=true;$('#bv-stage').append(ask);
  const picker=document.createElement('input');picker.type='file';picker.id='bv-file';picker.hidden=true;picker.addEventListener('change',()=>void uploadPicked(picker));el.append(picker);
  ask.addEventListener('keydown',e=>{if(e.key!=='Escape'&&!(e.key==='Enter'&&!e.target.closest('button')))return;e.preventDefault();e.stopPropagation();const b=ask.querySelector(e.key==='Escape'?'[data-bv=ask-cancel],[data-bv=file-cancel],[data-bv=ask-ok]':'.primary');b?.click();});
  const tools=document.createElement('button');tools.id='bv-tools';tools.type='button';tools.dataset.bv='tools';tools.setAttribute('aria-label','Browser options: tabs and reload');tools.setAttribute('aria-expanded','false');tools.innerHTML=icon('more');$('#bv-nav').append(tools);
  const quality=document.createElement('button');quality.id='bv-quality';quality.type='button';quality.dataset.bv='retry-assets';quality.hidden=true;$('#bv-nav').append(quality);
  mirrorView=new MirrorView($('#bv-stage'),{send,onCommand:command=>{if(command==='address'){$('#bv-addr').focus();$('#bv-addr').select();}else if(command==='new-tab')send({type:'tab',action:'open',url:'about:blank'});else if(command==='close-tab')send({type:'tab',action:'close',tabId:status.activeTabId});else if(command==='next-tab'||command==='previous-tab'){const tabs=status.tabs||[],at=tabs.findIndex(t=>t.id===status.activeTabId),next=tabs[(at+(command==='next-tab'?1:tabs.length-1))%tabs.length];if(next)send({type:'tab',action:'switch',tabId:next.id});}else if(/^tab-[1-9]$/.test(command)){const tabs=status.tabs||[],n=Number(command.slice(4)),t=n===9?tabs.at(-1):tabs[n-1];if(t&&t.id!==status.activeTabId)send({type:'tab',action:'switch',tabId:t.id});}else send({type:command});},onDiagnostics:d=>{quality.dataset.bv='retry-assets';quality.hidden=!d.fonts&&!d.images&&d.drift<4;quality.textContent=d.fonts?'Fonts missing · Retry':d.images?'Images missing · Retry':'Layout differs · Retry';quality.title='Reload Native view resources';},onFallback:reason=>{mirrorFallback=true;send({type:'mirror',on:false});nativeView(false);quality.hidden=false;quality.textContent=reason==='fonts'?'Fonts unavailable · Retry':reason==='captcha'?'Verification · Picture':'This page uses Picture · Retry';quality.dataset.bv='retry-native';toast(reason==='captcha'?'This page needs Picture view.':reason==='security'?'Native view could not start safely. Picture view is ready.':'Switched to Picture view for this page.');},onLoading:on=>{mirrorLoading=on;$('#bv-veil').hidden=!on;$('#bv-veil').textContent=on?'Loading Native view…':'Watching · take control to use it yourself';$('#bv-veil').classList.toggle('mirror-loading',on);},onRelay:on=>{mirrorRelay=on;$('#bv-keys').hidden=!on;},onLink:linkStatus,onMenu:m=>m?openMenu(m):closeMenu()});
  wireInput();
}
function open({control = false} = {}) {
  const sheet = $('#bv-sheet');
  const wasHidden=sheet.hidden;
  if(wasHidden)returnFocus=document.activeElement;
  sheet.hidden = false; document.body.classList.add('bv-open');
  sizeSheet();
  sync(); renderSheet(); paint();
  syncMirror();
  if (control && status.control !== 'user') takeControl();
  setTimeout(() => {if(!sheet.hidden&&!mirrorView?.active)$('#bv-canvas').focus({preventScroll:true});}, 50);
}
function close() { $('#bv-sheet').hidden = true; document.body.classList.remove('bv-open','bv-expanded');releaseFocus?.();releaseFocus=null;layoutModal=null;if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});returnFocus=null;syncMirror();sync(); }

// ── input: mouse, touch (tap = click, drag = scroll), keyboard ──────────────
const VK = {Backspace:8, Tab:9, Enter:13, Escape:27, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Delete:46};
function press(key) { send({type:'key', event:'keyDown', key, code:key, windowsVirtualKeyCode:VK[key]}); send({type:'key', event:'keyUp', key, code:key, windowsVirtualKeyCode:VK[key]}); }
function canDrive() {
  if (status.control !== 'agent') return true;
  $('#bv-veil').classList.remove('nudge'); void $('#bv-veil').offsetWidth; $('#bv-veil').classList.add('nudge');
  return false;
}
function wireInput() {
  const c = $('#bv-canvas');
  // In frame pixels, with the frame size, so the server maps it onto the page whatever its zoom.
  const point = e => { const r = c.getBoundingClientRect(); return {x:Math.max(0, Math.min(c.width, (e.clientX - r.left) / r.width * c.width)), y:Math.max(0, Math.min(c.height, (e.clientY - r.top) / r.height * c.height)), fw:c.width, fh:c.height}; };
  const mods = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const btn = e => e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  let touch = null, mouse = null, moveQueued = null;
  c.addEventListener('pointerdown', e => {
    e.preventDefault(); c.focus({preventScroll:true});
    if (!canDrive()) return;
    c.setPointerCapture(e.pointerId);
    const p = point(e);
    if (e.pointerType === 'touch') { touch = {start:p, last:{x:e.clientX, y:e.clientY}, scrolling:false}; return; }
    mouse = {button:btn(e), clickCount:e.detail || 1, modifiers:mods(e)};
    send({type:'mouse', event:'pressed', ...p, ...mouse});
  });
  c.addEventListener('pointermove', e => {
    if (touch && e.pointerType === 'touch') {
      const dx = e.clientX - touch.last.x, dy = e.clientY - touch.last.y;
      if (!touch.scrolling && Math.hypot(e.clientX - touch.last.x, e.clientY - touch.last.y) < 10) return;
      touch.scrolling = true; touch.last = {x:e.clientX, y:e.clientY};
      const r = c.getBoundingClientRect(), k = c.width / r.width;
      send({type:'wheel', ...touch.start, deltaX:-dx * k, deltaY:-dy * k});
      return;
    }
    if (status.control === 'agent') return;
    const p = point(e);
    if (!moveQueued) { moveQueued = requestAnimationFrame(() => { moveQueued = null; send({type:'mouse', event:'moved', ...p}); }); }
  });
  c.addEventListener('pointerup', e => {
    if (touch && e.pointerType === 'touch') {
      if (!touch.scrolling) { send({type:'mouse', event:'pressed', ...touch.start, button:'left', clickCount:1, modifiers:0}); send({type:'mouse', event:'released', ...touch.start, button:'left', clickCount:1, modifiers:0}); }
      touch = null; return;
    }
    if (!mouse) return;
    send({type:'mouse', event:'released', ...point(e), ...mouse}); mouse = null;
  });
  c.addEventListener('pointercancel', () => { touch = null; mouse = null; });
  c.addEventListener('contextmenu', e => e.preventDefault());
  c.addEventListener('wheel', e => { e.preventDefault(); if (!canDrive()) return; const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? c.height : 1; send({type:'wheel', ...point(e), deltaX:e.deltaX * k, deltaY:e.deltaY * k}); }, {passive:false});
  c.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.ctrlKey) { close(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    e.preventDefault(); if (!canDrive()) return;
    send({type:'key', event:'keyDown', key:e.key, code:e.code, windowsVirtualKeyCode:e.keyCode, modifiers:mods(e)});
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) send({type:'key', event:'char', text:e.key, windowsVirtualKeyCode:e.keyCode});
  });
  c.addEventListener('keyup', e => { e.preventDefault(); if (status.control !== 'agent') send({type:'key', event:'keyUp', key:e.key, code:e.code, windowsVirtualKeyCode:e.keyCode, modifiers:mods(e)}); });
  c.addEventListener('paste', e => { e.preventDefault(); if (canDrive()) send({type:'text', text:e.clipboardData.getData('text/plain')}); });

  // Phones have no physical keyboard: this field raises the on-screen one and relays text.
  const typer = $('#bv-type');
  let composing = false;
  typer.addEventListener('compositionstart', () => composing = true);
  typer.addEventListener('compositionend', e => { composing = false; if (e.data) send({type:'text', text:e.data}); typer.value = ''; });
  typer.addEventListener('input', e => {
    if (composing || e.isComposing) return;
    if (e.inputType === 'insertLineBreak') { press('Enter'); typer.value = ''; return; }
    if (typer.value) { send({type:'text', text:typer.value}); typer.value = ''; }
  });
  typer.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); press('Enter'); }
    else if (e.key === 'Backspace' && !typer.value) { e.preventDefault(); press('Backspace'); }
    else if (e.key === 'Tab') { e.preventDefault(); press('Tab'); }
  });
  $('#bv-addr').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    let u = e.target.value.trim(); if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? 'https://duckduckgo.com/?q=' + encodeURIComponent(u) : 'https://' + u;
    send({type:'navigate', url:u}); e.target.blur();
  });
  // Keep the phone page matched to the space it is shown in (banner, keyboard, rotation).
  let resizeTimer = null;
  new ResizeObserver(() => {
    fit(); paint();
    if (status.control !== 'user' || $('#bv-sheet').hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { const r = $('#bv-stage').getBoundingClientRect(); if(r.width>0&&r.height>0)send(viewportMessage(r)); }, 120);
  }).observe($('#bv-stage'));
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-bv],[data-bv-key]');
  if (!b) return;
  if (b.dataset.bvKey) { press(b.dataset.bvKey); return; }
  const a = b.dataset.bv;
  if (a === 'open') open();
  else if (a === 'close') close();
  else if (a === 'control') open({control:true});
  else if (a === 'handback') handBack();
  else if(a==='tab-open')send({type:'tab',action:'open',url:'about:blank'});
  else if(a==='tab-switch'||a==='tab-close')send({type:'tab',action:a==='tab-switch'?'switch':'close',tabId:b.dataset.tab});
  else if(a==='retry-assets'){mirrorView.repaired?.clear();void mirrorView.retryAssets();}
  else if(a==='retry-native'){mirrorFallback=false;pictureChoice=false;nativeView(true);send({type:'mirror',on:true,retry:true});}
  else if(a==='layout'){expandedChoice=!$('#bv-sheet').classList.contains('expanded');layoutSheet();}
  else if(a==='view'){const retryNative=mirrorFallback;pictureChoice=mirrorWanted&&!mirrorFallback;try{localStorage.setItem('seek.browser.view',pictureChoice?'picture':'native');}catch{}mirrorFallback=false;syncMirror();if(retryNative&&!pictureChoice)send({type:'mirror',on:true,retry:true});}
  else if(a==='tools'){const open=$('#bv-sheet').classList.toggle('tools-open');b.setAttribute('aria-expanded',String(open));requestAnimationFrame(fit);}
  else if (a === 'more') { bannerOpen = !bannerOpen; renderSheet(); }
  else if (a === 'approve-once') decide('approve', 'once',b);
  else if (a === 'approve-task') decide('approve', 'task',b);
  else if (a === 'approve-always') decide('approve', 'always',b);
  else if (a === 'reject') decide('reject', 'once',b);
  else if (a === 'secure-toggle') { const f = b.closest('.bv-vault')?.querySelector('.bv-secure'); if (f) { f.hidden = !f.hidden; if (!f.hidden) f.elements.username.focus(); } }
  else if (a === 'vaultfill') { b.disabled = true; vaultFill(b.dataset.item).finally(() => { b.disabled = false; }); }
  else if (['back', 'forward', 'reload'].includes(a)) send({type:a});
  else if (a === 'ask-ok' || a === 'ask-cancel') send({type:'dialog', accept:a === 'ask-ok', text:$('#bv-ask-input')?.value});
  else if (a === 'file-choose') $('#bv-file').click();
  else if (a === 'file-cancel') send({type:'upload', token:status.fileChooser?.token, cancel:true});
  else if (a === 'menu-open' || a === 'menu-copy-link' || a === 'menu-copy') { const m = menuData; closeMenu(true); if (!m) return; if (a === 'menu-open') send({type:'tab', action:'open', url:m.href}); else if (a === 'menu-copy-link') void copyText(m.href, 'Link address copied'); else void copyText(m.text, 'Copied'); }
});
document.addEventListener('visibilitychange', sync);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#bv-sheet').hidden && document.activeElement?.tagName !== 'INPUT') close(); });

build();
window.SeekBrowser = {
  card,
  open,
  close,
  // Who has the browser ('agent' | 'user' | 'idle'); the buddy covers its eyes while you're in control.
  status: () => status,
  // Called after every render of the Work page.
  refresh(t, name) { task = t || null; agentName = name || agentName; sync(); paint(); renderSheet(); paintBatch(); mountVault(); }
};
