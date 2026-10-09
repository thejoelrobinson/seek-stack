// Feasibility probe for "send the page, not pixels" (DOM mirroring). For each real page at a phone
// size in the phone identity Seek now uses: (1) the live frame as the phone sees it today (JPEG),
// (2) Chrome's own archive of the current DOM with its CSS and images (MHTML), rendered natively
// in a fresh tab at the same size with no page JavaScript, and screenshotted for comparison.
// Also counts what a mirror would have to handle: DOM size, stylesheets, images, iframes, canvases.
// Usage: node --import <register-profile> mirror-probe.mjs
import {mkdtemp, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';

const SITES = ['https://www.walmart.com/search?q=fresh+thyme', 'https://www.target.com/s?searchTerm=coconut+milk', 'https://www.allrecipes.com/recipe/16354/easy-meatloaf/', 'https://en.wikipedia.org/wiki/Scotch_bonnet'];
const out = new URL('./mirror-probe/', import.meta.url);
await mkdir(out, {recursive: true});
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 60, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'mirror-'))}});
const PHONE = {width: 393, height: 660};
const COUNTS = `(() => { const all = [...document.querySelectorAll('*')];
  return {elements: all.length, html: document.documentElement.outerHTML.length, sheets: document.styleSheets.length,
    images: document.images.length, iframes: document.querySelectorAll('iframe').length, crossOriginFrames: [...document.querySelectorAll('iframe')].filter(f => { try { return !f.contentDocument; } catch { return true; } }).length,
    canvases: document.querySelectorAll('canvas').length, videos: document.querySelectorAll('video').length,
    shadowRoots: all.filter(e => e.shadowRoot).length, scripts: document.scripts.length}; })()`;
try {
  await c.start('about:blank');
  c.paused = true;                                            // phone mode is only for a user in control
  for (const url of SITES) {
    const host = new URL(url).host.replace(/^www\./, '');
    await c.navigate(url); await c.settle();
    await c.setViewport('mobile', PHONE);
    await new Promise(r => setTimeout(r, 1500)); await c.settle();
    const tab = await c._activeTab(), s = c.cdp.tabs.get(tab);
    const t0 = performance.now();
    const jpeg = Buffer.from((await c.cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 60}, s)).data, 'base64');
    const t1 = performance.now();
    const {data: mhtml} = await c.cdp.send('Page.captureSnapshot', {format: 'mhtml'}, s);
    const t2 = performance.now();
    const counts = await c.cdp.evaluate(tab, COUNTS);
    await writeFile(new URL(`${host}-live.jpg`, out), jpeg);
    const archive = new URL(`${host}.mhtml`, out);
    await writeFile(archive, mhtml);
    // Render the archive natively at the same phone size, scripts off, in a fresh tab.
    const viewer = await c.cdp.newTab('about:blank');
    const vs = c.cdp.tabs.get(viewer);
    await c.cdp.send('Emulation.setDeviceMetricsOverride', {...PHONE, deviceScaleFactor: 2, mobile: true}, vs);
    await c.cdp.send('Emulation.setScriptExecutionDisabled', {value: true}, vs);
    const t3 = performance.now();
    await c.cdp.navigate(viewer, archive.href);
    await new Promise(r => setTimeout(r, 800));
    const t4 = performance.now();
    const shot = Buffer.from((await c.cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 60}, vs)).data, 'base64');
    await writeFile(new URL(`${host}-mirror.jpg`, out), shot);
    await c.cdp.closeTab(viewer);
    await c.tab({action: 'switch', tabId: tab}).catch(() => {});
    console.log(`${host.padEnd(24)} frame ${String(Math.round(jpeg.length / 1024)).padStart(4)} KB (${Math.round(t1 - t0)} ms) | page archive ${String(Math.round(mhtml.length / 1024)).padStart(5)} KB (${Math.round(t2 - t1)} ms), renders in ${Math.round(t4 - t3)} ms | DOM ${counts.elements} elements, ${Math.round(counts.html / 1024)} KB HTML, ${counts.sheets} sheets, ${counts.images} images, ${counts.iframes} iframes (${counts.crossOriginFrames} cross-origin), ${counts.canvases} canvas, ${counts.videos} video, ${counts.shadowRoots} shadow roots, ${counts.scripts} scripts`);
  }
} finally { await c.stop().catch(() => {}); }
