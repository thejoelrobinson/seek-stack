// Text-only quiet wait vs any-mutation quiet wait: time to settle, and how complete the outline is
// compared with a long (3 s) settle. Usage: node --import <register-profile> quiet-bench2.mjs
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import {outlineScript, unchangedLines} from '../../plugins/browser-viewer/lib/page-outline.js';

const quiet = (textOnly, quietMs = 200, maxMs = 1500) => `new Promise(resolve => {
  const start = performance.now(); let last = start;
  const SKIP = /^(SCRIPT|STYLE|IFRAME|IMG|LINK|META|NOSCRIPT|SVG|PICTURE|SOURCE|VIDEO|CANVAS)$/i;
  const counts = n => n.nodeType === 3 ? !!n.nodeValue.trim() : n.nodeType === 1 && !SKIP.test(n.tagName) && !!n.textContent.trim();
  const mo = new MutationObserver(list => {
    if (!${textOnly}) { last = performance.now(); return; }
    for (const m of list) {
      if (m.type === 'characterData' || [...m.addedNodes].some(counts) || [...m.removedNodes].some(counts)) { last = performance.now(); return; }
    }
  });
  mo.observe(document, {subtree: true, childList: true, characterData: true});
  const tick = () => { const now = performance.now(); if (now - last >= ${quietMs} || now - start >= ${maxMs}) { mo.disconnect(); resolve(Math.round(now - start)); } else setTimeout(tick, 40); };
  setTimeout(tick, 40);
})`;
const URLS = ['https://www.walmart.com/search?q=fresh+rosemary', 'https://www.walmart.com/search?q=garlic', 'https://www.target.com/s?searchTerm=coconut+milk', 'https://www.allrecipes.com/recipe/16354/easy-meatloaf/', 'https://www.africanbites.com/jamaican-curry-shrimp/', 'https://en.wikipedia.org/wiki/Scotch_bonnet'];
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'quiet-bench-'))}});
const missing = (a, b) => unchangedLines(a.lines, b.lines).filter(k => !k).length;
try {
  await c.start('about:blank');
  for (const textOnly of [false, true]) for (const url of URLS) {
    const tab = await c._activeTab();
    await c.cdp.navigate(tab, url);
    await new Promise(r => setTimeout(r, 100));
    const ms = await c.cdp.evaluate(tab, quiet(textOnly));
    const got = await c.cdp.evaluate(tab, outlineScript(1, 'view'));
    await c.cdp.evaluate(tab, quiet(false, 400, 3000));
    const full = await c.cdp.evaluate(tab, outlineScript(1, 'view'));
    await c.scroll({direction: 'down', pixels: 600});
    await new Promise(r => setTimeout(r, 100));
    const sms = await c.cdp.evaluate(tab, quiet(textOnly));
    console.log((textOnly ? 'text-only' : 'any     ').padEnd(10), new URL(url).host.padEnd(22), `settle ${String(ms).padStart(5)}ms, lines differing from a 3s settle: ${String(missing(got, full)).padStart(3)} of ${full.lines.length} | scroll settle ${sms}ms`);
  }
} finally { await c.stop().catch(() => {}); }
