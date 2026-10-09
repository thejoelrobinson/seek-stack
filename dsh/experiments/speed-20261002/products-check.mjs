// Product rows on real listing pages, for checking the extractor by eye.
// Usage: node --import <register-profile> products-check.mjs [urls...]
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import {productsScript, productLines} from '../../plugins/browser-viewer/lib/page-products.js';
const URLS = process.argv.slice(2).length ? process.argv.slice(2) : ['https://www.walmart.com/search?q=fresh+rosemary', 'https://www.target.com/s?searchTerm=coconut+milk', 'https://www.amazon.com/s?k=jamaican+curry+powder', 'https://www.ebay.com/sch/i.html?_nkw=cast+iron+skillet', 'https://www.bestbuy.com/site/searchpage.jsp?st=usb+c+cable', 'https://www.homedepot.com/s/led%20bulb'];
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'products-check-'))}});
try {
  await c.start('about:blank');
  const tab = await c._activeTab();
  for (const url of URLS) {
    try {
      await c.cdp.navigate(tab, url); await c.settle(); if (/target.com/.test(url)) await new Promise(r => setTimeout(r, 3000));
      const t = performance.now(); const r = await c.cdp.evaluate(tab, productsScript(1, Number(process.env.ROWS || 12))); const ms = Math.round(performance.now() - t);
      const title = await c.cdp.evaluate(tab, 'document.title');
      console.log(`\n=== ${new URL(url).host} — ${title.slice(0, 60)} — ${r.count} cards found, ${ms} ms`);
      for (const l of productLines(r, url, {hrefs: true}).slice(0, Number(process.env.SHOW || 8))) console.log('  ' + l.slice(0, 260));
    } catch (e) { console.log(`\n=== ${url} ERROR ${e.message.slice(0, 200)}`); }
  }
} finally { await c.stop().catch(() => {}); }
