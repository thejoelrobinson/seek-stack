import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import {productsScript} from './products-debug.mjs';
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'tt-'))}});
try {
  await c.start('about:blank'); const tab = await c._activeTab();
  for (const url of ['https://www.target.com/s?searchTerm=coconut+milk', 'https://www.bestbuy.com/site/searchpage.jsp?st=usb+c+cable']) {
    await c.cdp.navigate(tab, url); await c.settle(); await new Promise(r => setTimeout(r, 3000));
    const r = await c.cdp.evaluate(tab, productsScript(1, 6));
    for (const row of r.cards.slice(2, 5)) console.log('---', row.name.slice(0, 60), '| rating', row.rating, '\n', row._text);
  }
} finally { await c.stop().catch(() => {}); }
