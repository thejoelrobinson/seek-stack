// viewer_read_pages on 8 real Walmart searches: wall time per call and product rows found per page,
// with the current settle and with a lighter one (text/children only, no attribute churn).
// Usage: node --import <register-profile> readpages-bench.mjs
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import * as fastlane from '../../plugins/browser-viewer/lib/fastlane.js';

const Q = ['fresh thyme', 'fresh rosemary', 'garlic bulb', 'yellow onion', 'red bell pepper', 'habanero pepper', 'coconut milk 13.5 oz', 'jamaican curry powder'];
const urls = Q.map(q => 'https://www.walmart.com/search?q=' + encodeURIComponent(q));
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'rp-bench-'))}});
try {
  await c.start('about:blank');
  for (const round of [1, 2]) {
    const t = performance.now();
    const r = await fastlane.readPages(c, {urls: JSON.stringify(urls), ...(process.env.CONC ? {concurrency: Number(process.env.CONC)} : {})}, {session: 'bench'});
    const counts = [...r.digest.matchAll(/— (\d+) products/g)].map(m => +m[1]);
    console.log(`round ${round}: ${((performance.now() - t) / 1000).toFixed(1)} s, ${r.ok}/${urls.length} ok, products per page: ${counts.join(', ')} (${counts.length} listing pages)`);
  }
} finally { await c.stop().catch(() => {}); }
