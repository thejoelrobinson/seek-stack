// Screenshots of the browser sheet harness at an iPhone size (393x852 @2x), old and new banner.
// Usage: node --import <register-profile> sheet-shot.mjs   (needs the repo served on :18891)
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
const c = new BrowserController({headless: true, windowWidth: 393, windowHeight: 852, quality: 80, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'sheet-'))}});
try {
  await c.start('about:blank');
  const tab = await c._activeTab(), session = c.cdp.tabs.get(tab);
  await c.cdp.send('Emulation.setDeviceMetricsOverride', {width: 393, height: 852, deviceScaleFactor: 2, mobile: true}, session);
  for (const v of ['old', 'new']) {
    await c.cdp.navigate(tab, `http://127.0.0.1:18891/dsh/experiments/speed-20261002/sheet-harness.html${v === 'old' ? '?old' : ''}`);
    await new Promise(r => setTimeout(r, 500));
    const title = await c.cdp.evaluate(tab, 'document.title');
    const {data} = await c.cdp.send('Page.captureScreenshot', {format: 'png'}, session);
    const file = new URL(`sheet-${v}.png`, import.meta.url);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(v, title, file.pathname);
  }
} finally { await c.stop().catch(() => {}); }
