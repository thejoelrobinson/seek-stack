import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import {productsScript, productLines} from '../../plugins/browser-viewer/lib/page-products.js';
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'cs-'))}});
try {
  await c.start('about:blank'); const tab = await c._activeTab();
  for (let i = 0; i < 2; i++) {
    await c.cdp.navigate(tab, 'https://www.walmart.com/search?q=fresh+thyme'); await c.settle();
    const info = await c.cdp.evaluate(tab, `(() => { const a = [...document.querySelectorAll('a[href*="/ip/"]')].find(a => /Fresh-Thyme/i.test(a.href) && /clamshell/i.test(a.href + a.innerText)); if (!a) return {found: false, text: document.body.innerText.includes('Clamshell')};
      const chain = []; for (let e = a; e && e !== document.body && chain.length < 12; e = e.parentElement) chain.push(e.tagName + (e.getAttribute('data-item-id') ? '[item]' : '') + ':' + e.children.length + ':' + (e.innerText||'').length);
      let card = a; for (let k = 0; k < 6; k++) card = card.parentElement; return {found: true, href: a.href.slice(0, 90), chain, cardText: (card.innerText||'').replace(/\s+/g, ' ').slice(0, 300)}; })()`);
    console.log(JSON.stringify(info, null, 1));
    const r = await c.cdp.evaluate(tab, productsScript(1, 60));
    console.log('rows with Clamshell:', productLines(r, 'https://www.walmart.com').filter(l => /clamshell/i.test(l)).map(l => l.slice(0, 160)));
  }
} finally { await c.stop().catch(() => {}); }
