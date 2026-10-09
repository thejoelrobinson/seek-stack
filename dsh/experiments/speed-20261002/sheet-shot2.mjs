// Screenshots of the browser sheet harness: desktop pane width and phone width, old vs new banner.
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
const c = new BrowserController({headless: true, windowWidth: 1190, windowHeight: 760, quality: 80, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'sheet-'))}});
try {
  await c.start('about:blank');
  const tab = await c._activeTab(), session = c.cdp.tabs.get(tab);
  for (const [name, w, h, mobile] of [['desktop', 1190, 760, false], ['phone', 393, 852, true]]) {
    await c.cdp.send('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile}, session);
    for (const v of ['old', 'new']) {
      await c.cdp.navigate(tab, `http://127.0.0.1:18891/dsh/experiments/speed-20261002/sheet-harness.html${v === 'old' ? '?old' : ''}`);
      await new Promise(r => setTimeout(r, 400));
      const info = await c.cdp.evaluate(tab, '({title: document.title, banner: Math.round(document.getElementById("bv-banner").getBoundingClientRect().height)})');
      const {data} = await c.cdp.send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width: w, height: mobile ? 420 : 330, scale: 1}}, session);
      await writeFile(new URL(`sheet-${name}-${v}.png`, import.meta.url), Buffer.from(data, 'base64'));
      console.log(name.padEnd(8), v, `banner ${info.banner}px`, info.title);
    }
  }
} finally { await c.stop().catch(() => {}); }
