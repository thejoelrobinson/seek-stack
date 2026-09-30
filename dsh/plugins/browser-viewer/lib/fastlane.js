// Fast lane: many pages per tool call, in reused background tabs.
//
// With the local model a browser step costs ~10 s, almost all of it the model: reading the new
// observation (~1,150 prompt tok/s on the 3090) and thinking before the next action (~70 tok/s).
// So the speed-up comes from fewer turns and smaller results, not faster tabs. These helpers take a
// list (or the id of a list saved by an earlier call), do the navigation, waiting and extraction in
// code across a pool of tabs, save everything to files, and hand the model a short digest.

import {mkdir, writeFile, readFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';

export const ROOT = join(homedir(), '.dsh', 'browser', 'fastlane');
export const POOL_SIZE = 4;
export const MAX_URLS = 300;

// Not needed to read a page and often most of its weight: images, media, fonts, ad/analytics hosts.
// Site scripts (including bot-protection) are never blocked, or sites would challenge the browser.
export const BLOCKED = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.ico', '*.bmp',
  '*.mp4', '*.webm', '*.m4v', '*.mov', '*.mp3', '*.m3u8', '*.woff', '*.woff2', '*.ttf', '*.otf',
  '*doubleclick.net*', '*googlesyndication.com*', '*google-analytics.com*', '*googletagmanager.com*',
  '*googleadservices.com*', '*facebook.net*', '*hotjar.com*', '*criteo.*', '*adsystem.com*',
  '*taboola.com*', '*outbrain.com*', '*scorecardresearch.com*', '*quantserve.com*', '*adnxs.com*', '*bat.bing.com*'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n) => (s = String(s ?? '').replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

/** A sign-in page or human check stops the batch: only the user can pass it. */
export class GateError extends Error {
  constructor(gate, tab, url) { super(`Human handoff required: ${gate}`); this.gate = gate; this.tab = tab; this.url = url; }
}

// Resolves once the DOM has been quiet for quietMs (SPAs keep rendering after DOMContentLoaded),
// or after maxMs. One round trip instead of polling from Node.
const SETTLE_JS = (quietMs, maxMs, minText) => `new Promise(done => {
  const t0 = performance.now(); let last = t0;
  const mo = new MutationObserver(() => { last = performance.now(); });
  mo.observe(document, {subtree: true, childList: true, characterData: true, attributes: true});
  (function tick() {
    const now = performance.now(), text = (document.body && document.body.innerText || '').length;
    const ready = document.readyState !== 'loading' && text >= ${minText};
    if ((ready && now - last >= ${quietMs}) || now - t0 >= ${maxMs}) { mo.disconnect(); done({ready, ms: Math.round(now - t0), text}); }
    else setTimeout(tick, 60);
  })();
})`;

export async function settle(cdp, tab, {quietMs = 350, maxMs = 8000, minText = 60} = {}) {
  for (let tries = 0; tries < 4; tries++) {
    try { return await cdp.evaluate(tab, SETTLE_JS(quietMs, maxMs, minText)); }
    catch (e) {
      // A redirect or client-side navigation replaced the page mid-wait; wait on the new one.
      if (!/context|destroyed|navigat|Cannot find|Inspected target/i.test(e.message)) throw e;
      await sleep(150);
    }
  }
  return {ready: false};
}

export const GATE_JS = `(() => {
  const shown = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const text = (document.body && document.body.innerText || '').slice(0, 20000);
  const captcha = /verify (that )?you are (a )?human|are you a robot|press (and|&) hold|complete the security check|unusual traffic|access denied|too many requests/i.test(text)
    || /^just a moment/i.test(document.title)
    || [...document.querySelectorAll('iframe')].some(e => shown(e) && /captcha|turnstile|challenges\\.cloudflare|arkoselabs|perimeterx|px-captcha/i.test(e.src));
  const login = [...document.querySelectorAll('input[type=password]')].some(shown) || /\\/(account\\/)?(login|signin|sign-in)\\b/i.test(location.pathname);
  return captcha ? 'captcha' : login ? 'login' : null;
})()`;

// Readable text: the page's main region if it holds most of the text, else the body; innerText
// already follows layout and visibility. Lines are de-duplicated and capped.
const EXTRACT_JS = (maxChars, linkMatch) => `(() => {
  const body = document.body; if (!body) return {title: document.title, url: location.href, text: '', links: []};
  const all = body.innerText || '';
  const main = [...document.querySelectorAll('main, [role=main], article')].sort((a, b) => b.innerText.length - a.innerText.length)[0];
  const root = main && main.innerText.length > all.length * 0.4 ? main : body;
  const seen = new Set(), out = []; let n = 0;
  for (let line of (root.innerText || '').split('\\n')) {
    line = line.replace(/\\s+/g, ' ').trim();
    if (!line || (line.length < 40 && seen.has(line))) continue;
    seen.add(line); out.push(line); n += line.length + 1;
    if (n > ${maxChars}) break;
  }
  const heads = [...root.querySelectorAll('h1, h2, h3')].map(h => h.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);
  const want = ${JSON.stringify(linkMatch || '')};
  const test = want ? (want.length > 2 && want.startsWith('/') && want.endsWith('/') ? (h => new RegExp(want.slice(1, -1), 'i').test(h)) : (h => h.includes(want))) : null;
  const links = test ? [...root.querySelectorAll('a[href]')].map(a => ({href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 120)})).filter(l => /^https?:/.test(l.href) && test(l.href)).slice(0, 300) : [];
  return {title: document.title, url: location.href, text: out.join('\\n'), headings: heads, links, truncated: n > ${maxChars}};
})()`;

// Links matching a pattern, each with the text of the card it sits in (order date, total, etc.).
const LINKS_JS = match => `(() => {
  const want = ${JSON.stringify(match)};
  const test = want.length > 2 && want.startsWith('/') && want.endsWith('/') ? (h => new RegExp(want.slice(1, -1), 'i').test(h)) : (h => h.includes(want));
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (!/^https?:/.test(a.href) || !test(a.href) || !shown(a)) continue;
    // The nearest container with enough text is the link's card; stop before the whole list.
    let node = a, context = '', prev = '';
    for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
      const t = (node.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.length > 600) { context = prev || t; break; }
      prev = t;
      if (t.length >= 40) { context = t; break; }
    }
    if (!context) context = prev;
    out.push({href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 100), context: context.slice(0, 280)});
  }
  return out;
})()`;

// Moves to the next page of a list: a rel=next link, a Next / Load more control, or a scroll for
// infinite lists. Never presses anything that could buy, send, post or delete.
const NEXT_JS = `(() => {
  const shown = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = e => (e.getAttribute('aria-label') || e.innerText || e.title || '').replace(/\\s+/g, ' ').trim();
  const off = e => e.disabled || e.getAttribute('aria-disabled') === 'true' || /disabled/i.test(e.className || '');
  const rel = [...document.querySelectorAll('a[rel~=next]')].find(e => shown(e) && !off(e));
  const ok = /^(next( page)?|next results|›|»|>|load more( \\w+)?|show more( \\w+)?|see more( \\w+)?|view more( \\w+)?|more results|older( orders)?)$/i;
  const bad = /order|buy|pay|send|post|delete|remove|cancel|checkout|subscribe/i;
  const control = rel || [...document.querySelectorAll('a, button, [role=button]')].find(e => shown(e) && !off(e) && ok.test(label(e)) && !bad.test(label(e).replace(/older orders/i, '')));
  if (control) { control.scrollIntoView({block: 'center'}); control.click(); return {how: 'click', label: label(control).slice(0, 40)}; }
  const el = document.scrollingElement || document.documentElement, before = el.scrollTop;
  el.scrollTop = el.scrollHeight;
  return {how: el.scrollTop > before + 10 ? 'scroll' : 'none'};
})()`;

// "Sep 12", "Sep 12, 2026", "September 3 2025", "9/12/2026", "2026-09-12" -> ms since epoch.
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
export function findDate(text, now = new Date()) {
  const s = String(text || '');
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()), day = +m[2];
  let year = m[3] ? +m[3] : now.getUTCFullYear();
  if (!m[3] && Date.UTC(year, month, day) > now.getTime() + 86400000) year--;   // "Dec 30" seen in January is last year
  return Date.UTC(year, month, day);
}

// ── saved lists: later calls take a list id instead of the model re-typing hundreds of URLs ──
export async function saveJson(dir, name, value) {
  await mkdir(dir, {recursive: true});
  const p = join(dir, name);
  await writeFile(p + '.tmp', JSON.stringify(value, null, 2));
  await rename(p + '.tmp', p);
  return p;
}
export async function loadList(ref) {
  const id = String(ref || '').trim();
  const file = /^[\w-]{8,64}$/.test(id) ? join(ROOT, id, 'links.json') : id;
  if (!file.startsWith(ROOT)) throw new Error('Unknown list. Pass the listId returned by viewer_collect_links.');
  const list = JSON.parse(await readFile(file, 'utf8'));
  return list.links || [];
}
export function parseUrls(value) {
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : v?.url || v?.href).filter(Boolean);
  const s = String(value ?? '').trim();
  if (s.startsWith('[')) return parseUrls(JSON.parse(s));
  return s.split(/[\s,]+/).filter(v => /^https?:\/\//.test(v));
}

// ── progress for the Work page (and anyone else listening) ──
export function progress(c, session, batch) {
  const now = Date.now();
  batch.updatedAt = now;
  const per = batch.done ? (now - batch.startedAt) / batch.done : null;
  batch.etaMs = per && batch.total > batch.done ? Math.round(per * (batch.total - batch.done)) : null;
  c.batch = batch;
  if (now - (batch._sent || 0) > 250 || batch.done === batch.total || batch.state !== 'running') {
    batch._sent = now;
    c.sendStatus?.();
    try { c.onBatch?.(session, publicBatch(batch)); } catch {}
  }
}
export const publicBatch = b => b && ({id: b.id, kind: b.kind, label: b.label, state: b.state, done: b.done, total: b.total, ok: b.ok, review: b.review, failed: b.failed, tabs: b.tabs, startedAt: b.startedAt, etaMs: b.etaMs, recent: (b.items || []).slice(-8)});

/**
 * Runs jobs across a pool of reused tabs. worker(tab, job, index, workerIndex) returns a result;
 * an error marks that job failed and the pool moves on. The pool stops early (the rest stay
 * not_started) when a page needs the user (GateError: that tab stays open for them), when the user
 * takes control (the agent must not look at pages then), or after three failures in a row, which
 * means something systemic like the network. Aborts reject.
 */
export async function runPool(c, jobs, worker, {concurrency = POOL_SIZE, block = true, signal, onDone} = {}) {
  const results = new Array(jobs.length).fill(null);
  let cursor = 0, gate = null, stop = null, streak = 0;
  const cdpSend = (method, params, tab) => typeof c.cdp.send === 'function' ? c.cdp.send(method, params, c.cdp.tabs?.get(tab)).catch(() => {}) : null;
  const workers = Array.from({length: Math.max(1, Math.min(concurrency, jobs.length))}, async (_, w) => {
    let tab = null;
    try {
      while (cursor < jobs.length && !gate && !stop) {
        signal?.throwIfAborted();
        if (c.paused) { stop = 'paused'; break; }
        const i = cursor++, started = Date.now();
        try {
          if (!tab) {
            tab = await c.cdp.newTab('about:blank');
            if (block) { await cdpSend('Network.enable', {}, tab); await cdpSend('Network.setBlockedURLs', {urls: BLOCKED}, tab); }
          }
          results[i] = {...await worker(tab, jobs[i], i, w), ms: Date.now() - started};
          streak = 0;
          if (c.clients?.size) await thumb(c, tab, w);
        } catch (e) {
          if (e?.name === 'AbortError' || signal?.aborted) throw e;
          if (e instanceof GateError) { gate = e; results[i] = {status: 'blocked', gate: e.gate, url: e.url, ms: Date.now() - started}; tab = null; break; }
          if (c.paused || /paused/i.test(e?.message)) { stop = 'paused'; results[i] = null; cursor = Math.min(cursor, i); break; }
          results[i] = {status: 'failed', error: clip(e?.message || e, 200), ms: Date.now() - started};
          if (++streak >= 3) stop = 'failures';
        }
        await onDone?.(i, results[i]);
      }
    } finally {
      if (tab) await c.cdp.closeTab(tab).catch(() => {});
    }
  });
  const settled = await Promise.allSettled(workers);
  const fatal = settled.find(s => s.status === 'rejected');
  if (fatal) { if (gate?.tab) await c.cdp.closeTab(gate.tab).catch(() => {}); throw fatal.reason; }
  return {results, gate, stop};
}

// A small frame of a worker tab, so someone watching sees every tab at work (only when watched).
async function thumb(c, tab, slot) {
  try {
    const {data} = await c.cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 45, clip: {x: 0, y: 0, width: c.windowWidth || 1366, height: c.windowHeight || 900, scale: 0.3}}, c.cdp.tabs.get(tab));
    c.batchFrame?.(slot, data);
  } catch {}
}

/** Hands the page with a sign-in or human check to the user, like viewer_handoff. */
export async function handGate(c, session, gate, what) {
  c.activeTabId = gate.tab;
  const host = (() => { try { return new URL(gate.url).host; } catch { return 'the site'; } })();
  await c.requestHandoff({sessionId: session, reason: gate.gate,
    message: gate.gate === 'captcha' ? `${host} wants to check a person is browsing. Complete the check, then hand the browser back and I'll carry on ${what}.`
      : `Sign in to ${host}, then hand the browser back and I'll carry on ${what}.`});
}

// ── read many pages ──
export async function readPages(c, args, {session, signal} = {}) {
  let urls = args.from ? (await loadList(args.from)).map(l => l.href) : parseUrls(args.urls);
  urls = [...new Set(urls.filter(u => /^https?:\/\//.test(u)))];
  if (!urls.length) throw new Error('Give urls (a list of http(s) links) or from (a listId from viewer_collect_links).');
  const limit = Math.min(MAX_URLS, Number(args.limit) || MAX_URLS);
  urls = urls.slice(0, limit);
  const maxChars = Math.min(20000, Math.max(1000, Number(args.maxChars) || 8000));
  const focus = String(args.focus || '').toLowerCase().split(/[,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 8);
  const id = randomUUID().slice(0, 12), dir = join(ROOT, id);
  await mkdir(dir, {recursive: true});
  await c.ensureBrowser();
  const batch = {id, kind: 'pages', label: `Reading ${urls.length} page${urls.length === 1 ? '' : 's'}`, state: 'running', done: 0, total: urls.length, ok: 0, review: 0, failed: 0, tabs: Math.min(POOL_SIZE, urls.length), startedAt: Date.now(), items: []};
  progress(c, session, batch);
  const {results, gate, stop} = await runPool(c, urls, async (tab, url, i) => {
    await c.cdp.navigate(tab, url);
    await settle(c.cdp, tab);
    const g = await c.cdp.evaluate(tab, GATE_JS);
    if (g) throw new GateError(g, tab, url);
    const page = await c.cdp.evaluate(tab, EXTRACT_JS(maxChars, args.links));
    const file = join(dir, `${String(i + 1).padStart(3, '0')}.md`);
    await writeFile(file, `# ${page.title}\n${page.url}\n\n${page.text}\n`);
    const lines = page.text.split('\n');
    const hits = focus.length ? lines.filter(l => focus.some(f => l.toLowerCase().includes(f))).slice(0, 4) : [];
    const lead = lines.filter(l => l.length > 50).slice(0, 2).join(' ');
    return {status: page.text.length > 80 ? 'ok' : 'empty', url, finalUrl: page.url, title: clip(page.title, 90), chars: page.text.length, truncated: page.truncated, file,
      excerpt: clip(hits.length ? hits.join(' … ') : lead, 320), headings: (page.headings || []).slice(0, 6).map(h => clip(h, 60)), links: page.links};
  }, {concurrency: Number(args.concurrency) || POOL_SIZE, signal, onDone: (i, r) => {
    batch.done++; r.status === 'ok' ? batch.ok++ : r.status === 'empty' ? batch.review++ : batch.failed++;
    batch.items.push({i, label: clip(r.title || urls[i], 60), status: r.status});
    progress(c, session, batch);
  }});
  batch.state = gate || stop ? 'blocked' : 'done';
  progress(c, session, batch);
  const index = results.map((r, i) => r && {n: i + 1, url: urls[i], ...r});
  await saveJson(dir, 'index.json', {id, createdAt: Date.now(), pages: index});
  const links = index.flatMap(r => r?.links || []);
  if (links.length) await saveJson(dir, 'links.json', {id, links: [...new Map(links.map(l => [l.href, l])).values()]});
  if (gate) await handGate(c, session, gate, 'reading the rest');
  // The digest is all the model sees: one line per page, full text in the files.
  const lines = index.map(r => r ? `${r.n}. [${r.status}] ${r.title || r.url}${r.status === 'ok' ? ` (${r.chars} chars)` : r.error ? ` — ${r.error}` : ''}\n   ${r.excerpt || ''}` : '');
  const failed = index.filter(r => r && r.status !== 'ok').length;
  return {id, folder: dir, pages: index.length, ok: batch.ok, failed, blocked: !!gate, halt: !!gate,
    digest: `Read ${batch.ok}/${urls.length} pages in ${((Date.now() - batch.startedAt) / 1000).toFixed(1)} s across ${batch.tabs} tabs. Full text of each page: ${dir}\\NNN.md (index.json lists them${links.length ? `; ${links.length} matching links saved, listId ${id}` : ''}). Read a page file with your file tools when you need its detail.${stop === 'paused' ? '\nSTOPPED: the user took control of the browser. End your turn; you will be resumed when they hand it back.' : stop === 'failures' ? '\nSTOPPED after three failures in a row; check the site or connection before retrying.' : ''}${gate ? `\nSTOPPED: page ${index.findIndex(r => r?.status === 'blocked') + 1} needs the user (${gate.gate}); the browser was handed to them. End your turn; you will be resumed.` : ''}\n\n${lines.filter(Boolean).join('\n')}`.slice(0, 16000)};
}

// ── collect links across a paginated or infinite list ──
export async function collectLinks(c, args, {session, signal} = {}) {
  const match = String(args.match || '').trim();
  if (!match) throw new Error('match is required: text every wanted link contains (e.g. "/orders/"), or /regex/.');
  const maxPages = Math.min(60, Math.max(1, Number(args.maxPages) || 20));
  const maxLinks = Math.min(1000, Math.max(1, Number(args.maxLinks) || 500));
  const since = args.since ? (findDate(args.since) ?? Date.parse(args.since)) : null;
  if (args.since && !Number.isFinite(since)) throw new Error('since must be a date like 2026-03-01.');
  if (args.url) await c.navigate(args.url); else await c._activeTab();
  const tab = await c._activeTab();
  const id = randomUUID().slice(0, 12), dir = join(ROOT, id);
  const found = new Map(); let pages = 0, stale = 0, older = 0, stop = 'end of list';
  const batch = {id, kind: 'links', label: 'Collecting links', state: 'running', done: 0, total: maxPages, ok: 0, review: 0, failed: 0, tabs: 1, startedAt: Date.now(), items: []};
  progress(c, session, batch);
  while (pages < maxPages) {
    signal?.throwIfAborted();
    if (c.paused) return {halt: true, digest: 'STOPPED: the user took control of the browser. End your turn; you will be resumed when they hand it back.'};
    await settle(c.cdp, tab, {quietMs: 300, maxMs: 6000});
    const g = await c.cdp.evaluate(tab, GATE_JS);
    if (g) {
      batch.state = 'blocked'; progress(c, session, batch);
      await handGate(c, session, {gate: g, tab, url: await c._currentUrl()}, 'collecting');
      return {halt: true, handedOff: true, digest: `STOPPED on page ${pages + 1}: it needs the user (${g}); the browser was handed to them. End your turn; you will be resumed.`};
    }
    let added = 0, pageOlder = 0;
    for (const l of await c.cdp.evaluate(tab, LINKS_JS(match))) {
      if (found.has(l.href)) continue;
      const date = findDate(l.context);
      if (since && date !== null && date < since) { pageOlder++; continue; }
      found.set(l.href, {...l, date: date === null ? null : new Date(date).toISOString().slice(0, 10)});
      added++;
    }
    pages++; older += pageOlder;
    batch.done = pages; batch.ok = found.size; batch.label = `Collecting links · ${found.size} found`;
    batch.items.push({i: pages - 1, label: `Page ${pages}: +${added}`, status: 'ok'});
    progress(c, session, batch);
    if (found.size >= maxLinks) { stop = 'maxLinks reached'; break; }
    if (since && pageOlder && !added) { stop = 'passed the since date'; break; }
    if (!added && ++stale >= 2) break;
    if (added) stale = 0;
    const moved = await c.cdp.evaluate(tab, NEXT_JS);
    if (moved.how === 'none') break;
    await sleep(moved.how === 'click' ? 250 : 400);
  }
  if (pages >= maxPages) stop = 'maxPages reached';
  const links = [...found.values()];
  await saveJson(dir, 'links.json', {id, match, since: args.since || null, pages, createdAt: Date.now(), links});
  batch.state = 'done'; batch.total = pages; progress(c, session, batch);
  const show = links.slice(0, Number(args.show) || 40).map((l, i) => `${i + 1}. ${l.href}${l.date ? ` · ${l.date}` : ''} · ${clip(l.context || l.text, 110)}`);
  return {listId: id, file: join(dir, 'links.json'), count: links.length, pages, skippedOlder: older,
    digest: `Collected ${links.length} links matching "${match}" from ${pages} page${pages === 1 ? '' : 's'} (${stop}${older ? `; ${older} older than ${args.since} skipped` : ''}). listId ${id} — pass it as "from" to viewer_read_pages or viewer_receipts instead of retyping the URLs.\n\n${show.join('\n')}${links.length > show.length ? `\n… ${links.length - show.length} more in ${join(dir, 'links.json')}` : ''}`};
}
