// Does Walmart's multi-item add-to-cart link still work? Guest session in a throwaway headless
// profile (never Joel's): find two item ids from search pages, open one affil add-to-cart URL with
// both, then read the cart. Usage: node --import <register-profile> walmart-multiadd.mjs
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';

const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'walmart-multiadd-'))}});
const ids = [];
try {
  await c.start('about:blank');
  const tab = await c._activeTab();
  for (const q of ['fresh thyme', 'garlic bulb']) {
    await c.cdp.navigate(tab, 'https://www.walmart.com/search?q=' + encodeURIComponent(q));
    await c.settle();
    const hrefs = await c.cdp.evaluate(tab, `[...document.querySelectorAll('a[href*="/ip/"]')].map(a => a.href).slice(0, 5)`);
    const id = hrefs.map(h => /\/ip\/(?:[^/]+\/)?(\d{5,})/.exec(h)?.[1]).find(Boolean);
    console.log(q, '->', id, hrefs[0]);
    if (id) ids.push(id);
  }
  for (const url of [`https://affil.walmart.com/cart/addToCart?items=${ids.map(i => i + '|1').join(',')}`, `https://www.walmart.com/cart`]) {
    const t = performance.now();
    await c.cdp.navigate(tab, url); await c.settle();
    const info = await c.cdp.evaluate(tab, `({url: location.href, title: document.title, text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 700)})`);
    console.log(`\n${url}\n  ${Math.round(performance.now() - t)} ms -> ${info.url}\n  ${info.title}\n  ${info.text}`);
  }
} finally { await c.stop().catch(() => {}); }
