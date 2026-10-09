// Network-aware settle prototype: wait until the page's own XHR/fetch requests (same site; trackers
// on other domains ignored) are done AND no text has changed for 200 ms; cap 3 s. Compared with a
// long settle for completeness. Usage: node --import <register-profile> quiet-bench3.mjs
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import {outlineScript, unchangedLines} from '../../plugins/browser-viewer/lib/page-outline.js';

const site = host => host.split('.').slice(-2).join('.');
const TEXT_QUIET = `(() => { const g = globalThis; if (!g.__dshQuiet) { g.__dshQuiet = {last: performance.now()};
  const SKIP = /^(SCRIPT|STYLE|IFRAME|IMG|LINK|META|NOSCRIPT|SVG|PICTURE|SOURCE|VIDEO|CANVAS)$/i;
  const counts = n => n.nodeType === 3 ? !!n.nodeValue.trim() : n.nodeType === 1 && !SKIP.test(n.tagName) && !!n.textContent.trim();
  new MutationObserver(list => { for (const m of list) if (m.type === 'characterData' || [...m.addedNodes].some(counts) || [...m.removedNodes].some(counts)) { g.__dshQuiet.last = performance.now(); return; } })
    .observe(document, {subtree: true, childList: true, characterData: true}); }
  return Math.round(performance.now() - g.__dshQuiet.last); })()`;
const URLS = ['https://www.walmart.com/search?q=fresh+rosemary', 'https://www.walmart.com/search?q=garlic', 'https://www.target.com/s?searchTerm=coconut+milk', 'https://www.target.com/s?searchTerm=paper+towels', 'https://www.allrecipes.com/recipe/16354/easy-meatloaf/', 'https://www.africanbites.com/jamaican-curry-shrimp/', 'https://en.wikipedia.org/wiki/Scotch_bonnet'];
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'quiet-bench-'))}});
try {
  await c.start('about:blank');
  const tab = await c._activeTab(), sid = c.cdp.tabs.get(tab), inflight = new Map();
  await c.cdp.send('Network.enable', {maxTotalBufferSize: 0, maxResourceBufferSize: 0}, sid);
  c.cdp.onEvent(sid, 'Network.requestWillBeSent', p => { if (p.type === 'XHR' || p.type === 'Fetch') inflight.set(p.requestId, {at: performance.now(), host: (() => { try { return new URL(p.request.url).host; } catch { return ''; } })()}); });
  c.cdp.onEvent(sid, 'Network.loadingFinished', p => inflight.delete(p.requestId));
  c.cdp.onEvent(sid, 'Network.loadingFailed', p => inflight.delete(p.requestId));
  const settle = async (pageHost, cap = 3000) => {
    const t0 = performance.now(); let waitedNet = 0;
    while (performance.now() - t0 < cap) {
      const quietFor = await c.cdp.evaluate(tab, TEXT_QUIET);
      const now = performance.now(), mine = [...inflight.values()].filter(r => site(r.host) === site(pageHost) && now - r.at < 2500).length;
      if (mine) waitedNet++;
      if (quietFor >= 200 && !mine) break;
      await new Promise(r => setTimeout(r, 50));
    }
    return {ms: Math.round(performance.now() - t0), waitedNet};
  };
  for (const url of URLS) {
    const host = new URL(url).host;
    await c.cdp.navigate(tab, url);
    await new Promise(r => setTimeout(r, 100));
    const s = await settle(host);
    const got = await c.cdp.evaluate(tab, outlineScript(1, 'view'));
    await new Promise(r => setTimeout(r, 3000));
    const full = await c.cdp.evaluate(tab, outlineScript(1, 'view'));
    const differ = unchangedLines(got.lines, full.lines).filter(k => !k).length;
    await c.scroll({direction: 'down', pixels: 600});
    await new Promise(r => setTimeout(r, 100));
    const sc = await settle(host);
    console.log(host.padEnd(22), `settle ${String(s.ms).padStart(5)}ms (net-wait polls ${s.waitedNet}), lines differing from +3s: ${String(differ).padStart(3)} of ${full.lines.length} | scroll settle ${sc.ms}ms`);
  }
} finally { await c.stop().catch(() => {}); }
