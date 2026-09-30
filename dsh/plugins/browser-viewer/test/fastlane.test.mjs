import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController, buildTools} from '../lib/index.js';
import {findDate} from '../lib/fastlane.js';

// Local fixtures only: slow article pages with images, a paginated order list, a sign-in page,
// and Codex's hydrating Walmart receipt. Walmart URLs are mapped to localhost by a CDP proxy.
let imageHits = 0;
const LATENCY = 350;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/img/')) { imageHits++; setTimeout(() => { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.alloc(40000)); }, 300); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const send = html => setTimeout(() => res.end(html), LATENCY);
  if (url.pathname.startsWith('/page/')) {
    const n = url.pathname.split('/').pop();
    return send(`<!doctype html><title>Article ${n}</title><nav>Home · Deals · Account</nav><main><h1>Article ${n}</h1>${[1,2,3,4,5,6].map(i => `<img src="/img/${n}-${i}.png">`).join('')}<div id="body"></div></main><footer>Footer links</footer><script>
      setTimeout(() => { document.querySelector('#body').innerHTML = '<p>Trail ${n} is a gentle 2 mile loop with lake views, rated easy, open all year.</p><p>Price: $${n}.00 parking, delivered weekly updates.</p><ul><li>Dogs allowed</li><li>Restrooms</li></ul>'; }, ${200 + (n % 4) * 150});
    </script>`);
  }
  if (url.pathname === '/orders-list') {
    const page = Number(url.searchParams.get('page') || 1);
    const cards = [0,1,2,3,4].map(k => { const day = 21 - ((page - 1) * 5 + k) - 1, id = 1000 + (page - 1) * 5 + k;
      return `<div class="card"><p>Delivered on Sep ${day}, 2026</p><p>$23.10 · 4 items</p><a href="https://www.walmart.com/orders/${id}">View details</a></div>`; }).join('');
    return send(`<!doctype html><title>Purchase history</title><main><h1>Purchase history</h1>${cards}${page < 4 ? `<button onclick="location.href='?page=${page + 1}'">Next page</button>` : ''}</main>`);
  }
  if (url.pathname === '/login') return send('<!doctype html><title>Sign in</title><main><h1>Sign in</h1><input type="email"><input type="password"><button>Sign in</button></main>');
  if (url.pathname.startsWith('/orders/')) {
    const id = url.pathname.split('/').pop(), store = Number(id) % 2 === 0;
    return send(`<!doctype html><main><h1>Fixture receipt</h1><p>Sep 12, 2026 purchase</p><p>2 items</p><button aria-label="Show items" id="show">Show items</button><div id="rows"></div><h2>Payment method</h2><p>Subtotal</p><p>$10.00</p><p>Associate discount</p><p>-$1.00</p><p>Taxes</p><p>$0.50</p><p>Total</p><p>$9.50</p></main><script>
      let clicks=0;document.querySelector('#show').onclick=()=>{if(++clicks===1)return;setTimeout(()=>{document.querySelector('#show').setAttribute('aria-label','Hide items');document.querySelector('#show').textContent='Hide items';document.querySelector('#rows').innerHTML='<section><a href="/ip/test">Test product</a><div>Qty 2</div><div>${store ? '$10.00' : 'Discount price $9.00'}</div><button aria-label="Add to cart - Test product">Add to cart</button></section>';},300);};
    </script>`);
  }
  res.statusCode = 404; res.end('nope');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// dates on cards
const now = new Date(Date.UTC(2026, 8, 28));
assert.equal(new Date(findDate('Delivered on Sep 12, 2026', now)).toISOString().slice(0, 10), '2026-09-12');
assert.equal(new Date(findDate('Purchased Dec 30', now)).toISOString().slice(0, 10), '2025-12-30');
assert.equal(new Date(findDate('09/03/2026', now)).toISOString().slice(0, 10), '2026-09-03');

const c = new BrowserController({headless: true, windowWidth: 1100, windowHeight: 800, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'fastlane-'))}});
const handoffs = [], batches = [];
c.requestHandoff = async h => { handoffs.push(h); };
c.onBatch = (_s, b) => batches.push(b);
const tools = Object.fromEntries(buildTools(c).map(t => [t.name, t]));
try {
  await c.start(base + '/page/0'); c.stopStreaming();
  const original = c.activeTabId;
  const raw = c.cdp;
  // Chrome's own startup tab is there too; compare against what existed before any batch.
  const tabIds = async () => (await raw.listTabs()).map(t => t.id).sort();
  const baseline = await tabIds();

  // 1. Collect order links across a Next-button list, stopping at a date.
  const list = await tools.viewer_collect_links.execute({url: base + '/orders-list', match: '/orders/', since: '2026-09-08'}, {});
  assert.equal(list.count, 13, list.digest);
  assert.match(list.digest, /passed the since date/);
  assert.ok(list.digest.length < 4000, 'collect digest stays small');

  // 2. Read 16 slow pages: one tab at a time vs the fast lane.
  const urls = Array.from({length: 16}, (_, i) => `${base}/page/${i + 1}`);
  let t0 = Date.now();
  for (const u of urls) { await raw.navigate(original, u); await new Promise(r => setTimeout(r, 900)); }   // what a one-tab reader waits per page
  const sequential = Date.now() - t0;
  imageHits = 0;
  t0 = Date.now();
  const read = await tools.viewer_read_pages.execute({urls: JSON.stringify(urls), focus: 'price, dogs'}, {});
  const fast = Date.now() - t0;
  assert.equal(read.ok, 16, read.digest);
  assert.equal(imageHits, 0, 'images are not downloaded in fast-lane tabs');
  assert.ok(read.digest.length < 6000, `digest is compact (${read.digest.length} chars)`);
  assert.match(read.digest, /Price: \$\d+\.00 parking/);
  const first = await readFile(join(read.folder, '001.md'), 'utf8');
  assert.match(first, /Trail 1 is a gentle 2 mile loop/, 'late-rendered content was waited for');
  assert.doesNotMatch(first, /Footer links/, 'main content preferred over page chrome');
  assert.ok(sequential / fast >= 2.5, `fast lane ${fast} ms vs one tab ${sequential} ms`);
  assert.deepEqual(await tabIds(), baseline, 'worker tabs are closed');
  assert.equal(c.activeTabId, original);
  assert.ok(batches.some(b => b.kind === 'pages' && b.state === 'running' && b.done > 0 && b.done < 16), 'progress reported while running');

  // 3. A sign-in page in the batch stops it and hands that page to the user.
  const gated = await tools.viewer_read_pages.execute({urls: [base + '/page/1', base + '/login', base + '/page/2'].join('\n')}, {});
  assert.equal(gated.halt, true);
  assert.equal(handoffs.at(-1).reason, 'login');
  assert.match(gated.digest, /STOPPED/);
  assert.match(await raw.evaluate(c.activeTabId, 'location.pathname'), /\/login/, 'the sign-in page is the active tab for the user');
  c.activeTabId = original;
  for (const t of await raw.listTabs()) if (!baseline.includes(t.id)) await raw.closeTab(t.id);

  // 4. Receipts from the collected list: Walmart URLs mapped to the fixture.
  c.cdp = new Proxy(raw, {get(obj, key) {
    if (key === 'navigate') return async (id, u) => obj.navigate(id, u.startsWith('https://www.walmart.com') ? base + new URL(u).pathname : u);
    if (key === 'evaluate') return async (id, js) => { const r = await obj.evaluate(id, js); if (r && typeof r === 'object' && typeof r.url === 'string') r.url = r.url.replace(base, 'https://www.walmart.com'); return r; };
    const v = obj[key]; return typeof v === 'function' ? v.bind(obj) : v;
  }});
  t0 = Date.now();
  const receipts = await tools.viewer_receipts.execute({from: list.listId}, {});
  const receiptMs = Date.now() - t0;
  const res = JSON.parse(await readFile(receipts.path, 'utf8'));
  assert.equal(res.results.length, 13);
  assert.ok(res.results.every(r => r.status === 'verified' && r.totalCents === 950 && r.unitCount === 2), JSON.stringify(res.results.find(r => r.status !== 'verified')));
  assert.ok(res.results.every(r => /^2026-09-\d\d$/.test(r.date)), 'dates carried from the list');
  const csv = await readFile(receipts.csv, 'utf8');
  assert.equal(csv.trim().split('\n').length, 14, 'CSV header + one line item per receipt');
  assert.match(receipts.digest, /Read 13\/13 receipts/);
  assert.match(receipts.digest, /2026-09 \$123\.50/);
  assert.ok(receipts.digest.length < 3000, `receipt digest is compact (${receipts.digest.length} chars)`);
  assert.deepEqual(await tabIds(), baseline);
  console.log(`PASS: collect_links paged + date stop (13 links); read_pages 16 pages in ${fast} ms vs ${sequential} ms one tab (${(sequential / fast).toFixed(1)}x), no images, compact digest, late content, tab cleanup, progress; login gate hands off; receipts from listId 13/13 verified in ${receiptMs} ms with dates, CSV and month totals.`);
} finally {
  c.cdp = c.cdp?.valueOf ? c.cdp : c.cdp;
  await c.stop().catch(() => {});
  await c.close().catch(() => {});
  await new Promise(r => server.close(r));
}
