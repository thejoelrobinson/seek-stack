// How long does "wait until the DOM is quiet" take after real navigations and scrolls, and does
// the page keep changing after the cap? Measures QUIET_JS(quiet, max) per page in headless Chrome,
// plus how many outline lines appear between an early read (old timing, ~180 ms) and a settled one.
// Usage: node --import ../../plugins/browser-viewer/test/register-profile.mjs quiet-bench.mjs
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import {QUIET_JS, outlineScript, unchangedLines} from '../../plugins/browser-viewer/lib/page-outline.js';

const URLS = ['https://www.walmart.com/search?q=fresh+rosemary', 'https://www.walmart.com/search?q=red+bell+pepper', 'https://www.target.com/s?searchTerm=coconut+milk', 'https://www.allrecipes.com/recipe/16354/easy-meatloaf/', 'https://en.wikipedia.org/wiki/Scotch_bonnet'];
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'quiet-bench-'))}});
try {
  await c.start('about:blank');
  for (const url of URLS) {
    const tab = await c._activeTab();
    let t = performance.now(); await c.cdp.navigate(tab, url); const dcl = Math.round(performance.now() - t);
    await new Promise(r => setTimeout(r, 180));
    const early = await c.cdp.evaluate(tab, outlineScript(1, 'view'));
    const quietMs = await c.cdp.evaluate(tab, QUIET_JS(200, 3000));
    const settled = await c.cdp.evaluate(tab, outlineScript(1, 'view'));
    const missing = unchangedLines(early.lines, settled.lines).filter(k => !k).length;
    const again = await c.cdp.evaluate(tab, QUIET_JS(200, 3000));
    // A scroll, then the same measurement.
    await c.scroll({direction: 'down', pixels: 600});
    t = performance.now(); const scrollQuiet = await c.cdp.evaluate(tab, QUIET_JS(200, 3000));
    console.log(new URL(url).host.padEnd(22), `DCL ${dcl}ms | quiet after load ${quietMs}ms (again ${again}ms) | lines early ${early.lines.length} vs settled ${settled.lines.length}, ${missing} new after waiting | quiet after scroll ${scrollQuiet}ms`);
  }
} finally { await c.stop().catch(() => {}); }
