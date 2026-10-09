// Dump one Walmart card's price markup (debugging the product extractor).
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'cs-'))}});
const probe = String.raw`(() => {
  const a = [...document.querySelectorAll('a[href*="/ip/"]')].find(a => /Fresh-Thyme-0-5-oz-Clamshell/i.test(a.href)); if (!a) return null;
  const card = a.closest('[data-item-id]') || a.parentElement;
  const priceBox = [...card.querySelectorAll('*')].filter(e => /\$/.test(e.textContent) && e.children.length <= 6 && e.textContent.length < 80).slice(0, 8)
    .map(e => ({tag: e.tagName, ariaHidden: e.getAttribute('aria-hidden'), cls: String(e.className).slice(0, 40), auto: e.getAttribute('data-automation-id'), inner: JSON.stringify(e.innerText), content: JSON.stringify(e.textContent)}));
  return {inner: card.innerText.replace(/\n/g, ' | ').slice(0, 700), content: card.textContent.slice(0, 700), priceBox};
})()`;
try {
  await c.start('about:blank'); const tab = await c._activeTab();
  await c.cdp.navigate(tab, 'https://www.walmart.com/search?q=fresh+thyme'); await c.settle();
  await writeFile(new URL('clamshell2.json', import.meta.url), JSON.stringify(await c.cdp.evaluate(tab, probe), null, 1));
} finally { await c.stop().catch(() => {}); }
