// Walmart order receipts, read in parallel and checked in code (Codex's reader, scaled up).
// Safety is unchanged from Codex's version: only walmart.com order-detail URLs, only visible DOM,
// the only click is the idempotent "Show items" disclosure, and a sign-in or human check hands the
// browser to the user. What changed for speed with the local model: one call takes up to 300 orders
// (or a listId from viewer_collect_links, which also carries each order's date), four reused
// lightweight tabs, a failed receipt no longer stops the batch, and the model gets a short digest
// while every line item goes to JSON and CSV files.

import {writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {runPool, settle, progress, handGate, loadList, parseUrls, saveJson, GateError, MAX_URLS, POOL_SIZE} from './fastlane.js';

export const RECEIPT_CONCURRENCY = POOL_SIZE;

export function validateReceiptJobs(value) {
  const jobs = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > MAX_URLS) throw Error(`Provide 1–${MAX_URLS} receipt jobs.`);
  const seen = new Set();
  return jobs.map(job => {
    const u = new URL(typeof job === 'string' ? job : job.url);
    if (u.origin !== 'https://www.walmart.com' || u.username || u.password || !/^\/orders\/\d+$/.test(u.pathname)) throw Error('Only Walmart order-detail URLs are supported.');
    if ([...u.searchParams.keys()].some(k => !['groupId', 'storePurchase'].includes(k))) throw Error('Unsupported receipt URL parameters.');
    u.hash = '';
    // Preserve group identity; do not silently discard different delivery legs.
    u.searchParams.sort();
    if (seen.has(u.href)) throw Error('Duplicate receipt URL in batch.');
    seen.add(u.href);
    const expectedLines = typeof job === 'object' ? job.expectedLines : undefined;
    if (expectedLines !== undefined && expectedLines !== null && (!Number.isInteger(expectedLines) || expectedLines < 1 || expectedLines > 300)) throw Error('expectedLines must be a known line count between 1 and 300; do not guess.');
    return {url: u.href, expectedLines: expectedLines ?? null, orderId: u.pathname.split('/').pop(), date: typeof job === 'object' ? job.date || null : null};
  });
}

// Only visible DOM is read. No cookies, hidden app state, or private endpoints.
export function receiptPageState() {
  const shown = e => {const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const text = document.body?.innerText || '';
  const captcha = /verify (that )?you are (a )?human|are you a robot|press (and|&) hold|complete the security check|access denied|too many requests/i.test(text) || /^just a moment/i.test(document.title) || [...document.querySelectorAll('iframe')].some(e=>shown(e)&&/captcha|turnstile|challenges\.cloudflare|arkoselabs/i.test(e.src));
  const login = [...document.querySelectorAll('input[type=password]')].some(shown) || /sign in to do more with your account/i.test(text) || /\/account\/login/.test(location.pathname);
  if (captcha || login) return {url:location.href,gate:captcha?'captcha':'login'};
  const buttons=[...document.querySelectorAll('button')].filter(shown);
  const label=e=>(e.getAttribute('aria-label')||e.innerText||'').trim();
  const expand=buttons.filter(e=>/^(Show items|Show all items)$/i.test(label(e)));
  const rows=buttons.filter(e=>/^Add to cart -/.test(label(e))).map(button=>{
    let node=button;
    for(let depth=0;node&&depth<16;depth++,node=node.parentElement){
      if (/\bQty\s+\d+/.test(node.innerText||'') && node.querySelector('a[href*="/ip/"]')) {
        if (node.querySelectorAll('button[aria-label^="Add to cart -"]').length!==1) break;
        const raw=node.innerText;
        return {name:label(button).replace(/^Add to cart -\s*/,''),raw:raw.slice(0,4000),truncated:raw.length>4000};
      }
    }
    return {name:label(button),raw:'',truncated:false};
  });
  const main=(document.querySelector('main')||document.body).innerText;
  const payment=main.lastIndexOf('Payment method');
  const summary=payment>=0?main.slice(payment).split(/(?:Order|TC)\s*#/)[0]:'';
  const unitLabels=[...main.matchAll(/(?:^|\n)(\d+) items?(?: picked up| delivered)?\s*(?=\n|$)/g)].map(m=>Number(m[1]));
  const dateText=(main.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, \d{4}\b/)||[])[0]||null;
  return {url:location.href,gate:null,expandCount:expand.length,rows,declaredUnits:unitLabels.length===1?unitLabels[0]:null,summary:summary.slice(0,12000),truncated:summary.length>12000,dateText};
}
export const RECEIPT_STATE_JS = `(${receiptPageState.toString()})()`;
export function expandReceiptItems() {
  const shown=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const buttons=[...document.querySelectorAll('button')].filter(e=>shown(e)&&/^(Show items|Show all items)$/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
  // Narrow, idempotent disclosure action: never toggle Hide items or click commerce controls.
  for(const b of buttons) if(!b.disabled) b.click();
  return buttons.length;
}
const cents = s => {const m=/^(-?)(\d+)\.(\d{2})$/.exec(String(s).replaceAll(',',''));const n=m?(m[1]?-1:1)*(Number(m[2])*100+Number(m[3])):null;return Number.isSafeInteger(n)?n:null;};
export function normalizeReceipt(state, job) {
  const issues=[];
  const rows=state.rows.map(r=>{
    const quantity=Number(r.raw.match(/\bQty\s+(\d+)/)?.[1]);
    const price=r.raw.match(/Discount price\s*\$([\d,]+\.\d{2})/i)?.[1] ?? r.raw.match(/^\s*\$([\d,]+\.\d{2})\s*$/m)?.[1];
    const amountCents=cents(price);
    if(!Number.isInteger(quantity)||quantity<1||amountCents===null||r.truncated)issues.push('Unparsed or truncated item row');
    return {name:r.name,quantity:Number.isInteger(quantity)?quantity:null,amountCents,raw:r.raw};
  });
  const totalCents=cents(state.summary.match(/(?:^|\n)Total\s*\n?\s*\$([\d,]+\.\d{2})/i)?.[1]);
  const taxCents=cents(state.summary.match(/Taxes(?:\s*Taxes)?\s*\$([\d,]+\.\d{2})/i)?.[1]);
  const discount=cents(state.summary.match(/Associate discount\s*[−-]?\$([\d,]+\.\d{2})/i)?.[1]);
  const discountCents=/Associate discount/i.test(state.summary)?discount:0;
  const lineSumCents=rows.every(r=>r.amountCents!==null)?rows.reduce((n,r)=>n+r.amountCents,0):null;
  if(job.expectedLines!==null&&rows.length!==job.expectedLines)issues.push('Item line count mismatch');
  const units=rows.every(r=>r.quantity!==null)?rows.reduce((n,r)=>n+r.quantity,0):null;
  if(state.declaredUnits===null&&job.expectedLines===null)issues.push('No independent item coverage count');
  if(state.declaredUnits!=null&&units!==state.declaredUnits)issues.push('Item quantity coverage mismatch');
  if(state.truncated)issues.push('Truncated summary');
  if(totalCents===null||taxCents===null||discountCents===null)issues.push('Unparsed receipt totals');
  if(/refund|tip|express|fee|adjusted total/i.test(state.summary))issues.push('Additional adjustments require review');
  const included=lineSumCents!==null&&taxCents!==null&&lineSumCents+taxCents===totalCents;
  const excluded=lineSumCents!==null&&taxCents!==null&&discountCents!==null&&lineSumCents-discountCents+taxCents===totalCents;
  if(!included&&!excluded)issues.push('Line amounts do not reconcile to total');
  return {orderId:job.orderId,sourceUrl:state.url,expectedLines:job.expectedLines,rows,unitCount:rows.every(r=>r.quantity!==null)?rows.reduce((n,r)=>n+r.quantity,0):null,lineSumCents,taxCents,associateDiscountCents:discountCents,totalCents,priceBasis:included?'discount_included':excluded?'discount_excluded':'unresolved',verified:issues.length===0,issues:[...new Set(issues)],summary:state.summary};
}

// One receipt in a worker tab: open, expand items (bounded retries), wait until stable, parse.
async function readOne(c, tab, job, timeoutMs) {
  const look = () => { if (c.paused) throw Error('Browser paused: user has control.'); };
  look();
  await c.cdp.navigate(tab, job.url);
  look();
  await settle(c.cdp, tab, {quietMs: 250, maxMs: 4000});
  const deadline = Date.now() + timeoutMs;
  let previous = '', stable = 0, attempts = 0, lastExpand = 0;
  while (Date.now() < deadline) {
    look();
    const state = await c.cdp.evaluate(tab, RECEIPT_STATE_JS);
    if (state.gate) throw new GateError(state.gate, tab, state.url);
    const actual = new URL(state.url);
    if (actual.origin !== 'https://www.walmart.com' || actual.pathname !== new URL(job.url).pathname) throw Error('Receipt navigation left the expected order.');
    if (state.expandCount) {
      stable = 0;
      if (attempts < 3 && Date.now() - lastExpand >= 800) { await c.cdp.evaluate(tab, `(${expandReceiptItems.toString()})()`); attempts++; lastExpand = Date.now(); await settle(c.cdp, tab, {quietMs: 200, maxMs: 2500}); continue; }
    } else if (state.rows.length > 0 && (job.expectedLines === null || state.rows.length === job.expectedLines)) {
      const key = JSON.stringify([state.rows, state.summary]);
      stable = key === previous ? stable + 1 : 0; previous = key;
      if (stable >= 1) return {receipt: normalizeReceipt(state, job), attempts, dateText: state.dateText};
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw Error('Receipt items did not become complete and stable before timeout.');
}

const csvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
const money = c => c === null || c === undefined ? '' : (c / 100).toFixed(2);
const usd = c => '$' + (c / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

export async function readReceiptBatch(c, args, {signal, sessionId, outputDir = join(homedir(), '.dsh', 'browser', 'receipts'), timeoutMs = 20000} = {}) {
  let source = args.from ? (await loadList(args.from)).map(l => ({url: l.href, date: l.date})) : args.jobs !== undefined ? args.jobs : parseUrls(args.urls);
  if (typeof source === 'string') source = JSON.parse(source);
  if (Array.isArray(source)) source = source.filter(j => /\/orders\/\d+/.test(typeof j === 'string' ? j : j?.url || ''));
  if (args.limit) source = source.slice(0, Number(args.limit));
  const jobs = validateReceiptJobs(source);
  const concurrency = Number(args.concurrency ?? RECEIPT_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw Error('Concurrency must be 1–6.');
  signal?.throwIfAborted();
  if (c.paused) throw Error('Browser paused: user has control.');
  if (c.ensureBrowser) await c.ensureBrowser(); else if (!c.running) throw Error('Open the browser first.');
  const batchId = randomUUID(), dir = join(outputDir, batchId);
  await mkdir(dir, {recursive: true});
  const batch = {id: batchId, kind: 'receipts', label: `Reading ${jobs.length} receipt${jobs.length === 1 ? '' : 's'}`, state: 'running', done: 0, total: jobs.length, ok: 0, review: 0, failed: 0, tabs: Math.min(concurrency, jobs.length), startedAt: Date.now(), items: []};
  progress(c, sessionId, batch);
  const {results: raw, gate, stop} = await runPool(c, jobs, async (tab, job) => {
    const {receipt, attempts, dateText} = await readOne(c, tab, job, timeoutMs);
    return {status: receipt.verified ? 'verified' : 'needs_review', expansionAttempts: attempts, date: job.date || (dateText ? new Date(Date.parse(dateText)).toISOString().slice(0, 10) : null), ...receipt};
  }, {concurrency, signal, onDone: async (i, r) => {
    batch.done++; r.status === 'verified' ? batch.ok++ : r.status === 'needs_review' ? batch.review++ : batch.failed++;
    batch.items.push({i, label: `Order ${jobs[i].orderId}${r.totalCents != null ? ' · ' + usd(r.totalCents) : ''}`, status: r.status});
    progress(c, sessionId, batch);
    if (r) await saveJson(dir, `${i}.json`, {url: jobs[i].url, ...r});
  }});
  const results = raw.map((r, i) => r ? {url: jobs[i].url, ...r} : {url: jobs[i].url, status: 'not_started'});
  const counts = new Map(); for (const r of results) if (r.orderId) counts.set(r.orderId, (counts.get(r.orderId) || 0) + 1);
  for (const r of results) if (counts.get(r.orderId) > 1) { r.status = 'needs_review'; r.verified = false; r.issues.push('Multiple delivery groups share this order ID; reconcile once before aggregation'); }
  for (let i = 0; i < results.length; i++) if (counts.get(results[i].orderId) > 1) await saveJson(dir, `${i}.json`, results[i]);
  batch.ok = results.filter(r => r.status === 'verified').length;
  batch.review = results.filter(r => r.status === 'needs_review').length;
  batch.state = gate || stop ? 'blocked' : 'done'; progress(c, sessionId, batch);
  if (gate) await handGate(c, sessionId, gate, 'reading receipts');

  // Files: the full records, and a flat CSV of every line item for analysis.
  const result = {batchId, concurrency, complete: results.every(r => r.status === 'verified'), path: join(dir, 'batch.json'), csv: join(dir, 'items.csv'), results};
  const header = 'order_id,date,status,item,quantity,amount,order_total,tax,associate_discount,source_url';
  const rows = results.flatMap(r => (r.rows || []).map(x => [r.orderId, r.date, r.status, x.name, x.quantity, money(x.amountCents), money(r.totalCents), money(r.taxCents), money(r.associateDiscountCents), r.sourceUrl].map(csvCell).join(',')));
  await writeFile(result.csv, [header, ...rows].join('\n') + '\n');

  // The digest the model sees: totals, what needs a look, where the data is.
  const read = results.filter(r => r.status === 'verified' && Number.isSafeInteger(r.totalCents));
  const spend = read.reduce((n, r) => n + r.totalCents, 0);
  const byMonth = new Map(); for (const r of read) { const m = (r.date || '').slice(0, 7) || 'unknown'; byMonth.set(m, (byMonth.get(m) || 0) + r.totalCents); }
  const items = new Map(); for (const r of read) for (const x of r.rows || []) if (x.amountCents != null) items.set(x.name, (items.get(x.name) || 0) + x.amountCents);
  const top = [...items].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const problems = results.filter(r => r.status !== 'verified').slice(0, 10).map(r => `- ${r.orderId || r.url}: ${r.status}${r.issues?.length ? ' — ' + r.issues.join('; ') : r.error ? ' — ' + r.error : ''}`);
  const secs = ((Date.now() - batch.startedAt) / 1000).toFixed(1);
  const digest = [
    `Read ${read.length}/${jobs.length} receipts in ${secs} s across ${batch.tabs} tabs: ${batch.ok} verified, ${batch.review} need review, ${batch.failed} failed${gate ? ', STOPPED for the user' : ''}.`,
    `Verified, unique-order subtotal: ${usd(spend)} (${read.length} orders). Receipts needing review and duplicate order groups are excluded; this is not the full account history.`,
    byMonth.size ? `By month: ${[...byMonth].sort().map(([m, v]) => `${m} ${usd(v)}`).join(' · ')}` : '',
    top.length ? `Biggest items by spend: ${top.map(([n, v]) => `${n.slice(0, 50)} ${usd(v)}`).join('; ')}` : '',
    problems.length ? `Needs a look:\n${problems.join('\n')}` : '',
    `Files: every line item in ${result.csv} (columns: ${header}); full records in ${result.path}. Use code on the CSV for exact sums and categories rather than retyping numbers.`,
    gate ? `STOPPED: a receipt page needs the user (${gate.gate}); the browser was handed to them. End your turn; you will be resumed, then call viewer_receipts again for the rest.` : '',
    stop === 'paused' ? 'STOPPED: the user took control of the browser. End your turn; you will be resumed when they hand it back.' : stop === 'failures' ? 'STOPPED after three failures in a row; check the site or connection before retrying.' : ''
  ].filter(Boolean).join('\n');
  const out = {...result, digest, halt: !!gate || stop === 'paused'};
  await writeFile(result.path, JSON.stringify(out, null, 2));
  return out;
}
