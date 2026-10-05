// Seek's browser inside the Work conversation, modelled on Muse's handoff:
// watch live, take control (the agent pauses and can't see the page), hand back
// (the agent resumes by itself). Works with mouse, keyboard and touch.
import {trapModal,approvalDetails,approvalAttributes} from '/work/product.js';
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
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

let pendingControl = false,releaseFocus=null;
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
    if (typeof ev.data === 'string') { try { const m = JSON.parse(ev.data); if (m.type === 'status') onStatus(m); else if (m.type === 'batchFrame') { batchFrames[m.slot] = 'data:image/jpeg;base64,' + m.jpeg; paintBatch(); } } catch {} return; }
    createImageBitmap(new Blob([ev.data], {type:'image/jpeg'})).then(bmp => { frame?.close?.(); frame = bmp; paint(); }).catch(() => {});
  };
  ws.onclose = () => { ws = null; if (wanted()) retry = setTimeout(connect, 1500); };
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

// ── status → UI ─────────────────────────────────────────────────────────────
const isPhone = () => matchMedia('(max-width: 640px), (pointer: coarse)').matches;
let askedMobile = false, bannerOpen = false;
function onStatus(m) {
  status = m;
  if (pendingControl) { pendingControl = false; if (m.control !== 'user') send({type:'pause', paused:true}); }
  // In control on a phone: ask for a phone-sized page so it is readable and tappable.
  if (m.control !== 'user') askedMobile = false;
  else if (!askedMobile && m.viewport !== 'mobile' && isPhone() && !$('#bv-sheet').hidden) {
    askedMobile = true;
    const r = $('#bv-stage').getBoundingClientRect();
    send({type:'viewport', mode:'mobile', width:r.width, height:r.height});
  }
  if (m.error && /Take control first/.test(m.error)) toast(`${agentName} is using the browser. Take control first.`);
  renderSheet();
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
  const handoff = task?.handoff || status.handoff, approval = task?.approval || status.approval;
  const control = status.control || 'idle', user = control === 'user';
  $('#bv-title').textContent = status.title || 'Browser';
  $('#bv-host').textContent = hostOf(status.url);
  $('#bv-who').textContent = approval ? 'Waiting for your approval' : user ? "You're in control" : control === 'agent' ? `${agentName} is browsing` : 'Browser is free';
  $('#bv-who').className = 'bv-who ' + (approval ? 'wait' : user ? 'you' : control);
  const main = $('#bv-main');
  main.hidden = !!approval || (control === 'idle' && !task);
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
  $('#bv-keys').hidden = !drive;
  $('#bv-veil').hidden = drive || !status.running;
  $('#bv-empty').hidden = !!status.running;
  if (status.url && document.activeElement !== $('#bv-addr')) $('#bv-addr').value = status.url;
  requestAnimationFrame(fit);
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
      <span class="bv-who" id="bv-who" aria-live="polite"></span><button class="primary bv-main" id="bv-main"></button></header>
    <div class="bv-banner" id="bv-banner" hidden></div>
    <div class="bv-nav" id="bv-nav" hidden><button data-bv="back" aria-label="Back">${icon('back')}</button><button data-bv="forward" aria-label="Forward">${icon('forward')}</button><button data-bv="reload" aria-label="Reload">${icon('reload')}</button><input id="bv-addr" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Address" placeholder="Search or enter address"></div>
    <div class="bv-stage" id="bv-stage"><canvas id="bv-canvas" tabindex="0" aria-label="Live browser"></canvas><div class="bv-empty" id="bv-empty">The browser isn’t open right now.</div><div class="bv-batch" id="bv-batch" hidden><div class="bv-batch-head"><strong data-b="label"></strong><span data-b="count"></span></div><div class="bv-batch-bar"><i data-b="bar"></i></div><div class="bv-batch-grid">${[0,1,2,3].map(i => `<figure hidden><img data-slot="${i}" alt=""><figcaption>Tab ${i + 1}</figcaption></figure>`).join('')}</div><div class="bv-batch-meta" data-b="meta"></div></div><div class="bv-veil" id="bv-veil" hidden>Watching · take control to use it yourself</div></div>
    <footer class="bv-keys" id="bv-keys" hidden><input id="bv-type" placeholder="Type into the page…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Type into the page"><button data-bv-key="Backspace" aria-label="Backspace">${icon('backspace')}</button><button data-bv-key="Tab">Tab</button><button data-bv-key="Enter">Enter</button></footer>
  </div>`;
  document.body.appendChild(el);
  wireInput();
}
function open({control = false} = {}) {
  const sheet = $('#bv-sheet');
  const wasHidden=sheet.hidden;
  sheet.hidden = false; document.body.classList.add('bv-open');
  const shell=sheet.querySelector('.bv-shell'),modal=!matchMedia('(min-width:1200px)').matches;shell.setAttribute('role',modal?'dialog':'region');if(modal)shell.setAttribute('aria-modal','true');else shell.removeAttribute('aria-modal');
  if(wasHidden&&modal)releaseFocus=trapModal(sheet,{onClose:close});
  sync(); renderSheet(); paint();
  if (control && status.control !== 'user') takeControl();
  setTimeout(() => $('#bv-canvas').focus({preventScroll:true}), 50);
}
function close() { $('#bv-sheet').hidden = true; document.body.classList.remove('bv-open');releaseFocus?.();releaseFocus=null;sync(); }

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
    if (status.control !== 'user' || status.viewport !== 'mobile' || !isPhone()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { const r = $('#bv-stage').getBoundingClientRect(); send({type:'viewport', mode:'mobile', width:r.width, height:r.height}); }, 300);
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
  else if (a === 'more') { bannerOpen = !bannerOpen; renderSheet(); }
  else if (a === 'approve-once') decide('approve', 'once',b);
  else if (a === 'approve-task') decide('approve', 'task',b);
  else if (a === 'approve-always') decide('approve', 'always',b);
  else if (a === 'reject') decide('reject', 'once',b);
  else if (a === 'secure-toggle') { const f = b.closest('.bv-vault')?.querySelector('.bv-secure'); if (f) { f.hidden = !f.hidden; if (!f.hidden) f.elements.username.focus(); } }
  else if (a === 'vaultfill') { b.disabled = true; vaultFill(b.dataset.item).finally(() => { b.disabled = false; }); }
  else if (['back', 'forward', 'reload'].includes(a)) send({type:a});
});
document.addEventListener('visibilitychange', sync);
window.addEventListener('resize',()=>{const sheet=$('#bv-sheet');if(!sheet||sheet.hidden)return;const modal=!matchMedia('(min-width:1200px)').matches,shell=sheet.querySelector('.bv-shell');shell.setAttribute('role',modal?'dialog':'region');if(modal){shell.setAttribute('aria-modal','true');if(!releaseFocus)releaseFocus=trapModal(sheet,{returnTo:$('#watch-browser'),onClose:close});}else{shell.removeAttribute('aria-modal');releaseFocus?.();releaseFocus=null;}});
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
