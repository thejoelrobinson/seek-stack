// Reproduces the phone handoff: user in control, phone viewport, taps sent exactly as the Work sheet
// sends them (frame pixels). For each numbered button, tap where it appears in the frame and record
// which button the page says was clicked. Pages: desktop-only (no viewport meta) and phone-ready.
// Usage: node --import <register-profile> tap-repro.mjs [lib=after]
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const lib = process.argv[2] === 'before' ? './before/lib/index.js' : '../../plugins/browser-viewer/lib/index.js';
const {BrowserController} = await import(lib);

const grid = meta => `<!doctype html><html><head>${meta}<title>Tap fixture</title><style>body{margin:0;font:16px sans-serif}
.g{display:grid;grid-template-columns:repeat(4,${meta ? '22vw' : '280px'});gap:12px;padding:12px}button{height:90px;font-size:20px}</style></head>
<body><div class="g">${Array.from({length: 12}, (_, i) => `<button id="b${i}" onclick="window.__hit=${i}">${i}</button>`).join('')}</div></body></html>`;
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/phone' ? grid('<meta name="viewport" content="width=device-width,initial-scale=1">') : grid('')); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'tap-'))}});

// Where each button appears in the captured frame, in frame pixels (what a tap on it would send).
const FRAME_POS = `(() => { const vv = visualViewport, dpr = devicePixelRatio;
  return {dpr, scale: vv.scale, layoutWidth: document.documentElement.clientWidth, innerWidth,
    buttons: [...document.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect();
      return {x: Math.round(((r.left + r.width / 2) - vv.offsetLeft) * vv.scale * dpr), y: Math.round(((r.top + r.height / 2) - vv.offsetTop) * vv.scale * dpr)}; })}; })()`;
const jpegSize = b64 => { const b = Buffer.from(b64, 'base64'); for (let i = 2; i < b.length;) { const len = b.readUInt16BE(i + 2); if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xc3) return {w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5)}; i += 2 + len; } return null; };
try {
  await c.start('about:blank');
  for (const path of ['/desktop', '/phone']) {
    c.paused = true;                                   // the user holds the browser (handoff)
    await c.navigate(base + path); await c.settle();
    await c.setViewport('mobile', {width: 392, height: 451});   // what the phone sheet asks for
    await new Promise(r => setTimeout(r, 300));
    const tab = await c._activeTab();
    const frame = jpegSize(await c.cdp.screenshot(tab, {format: 'jpeg', quality: 50}));
    const pos = await c.cdp.evaluate(tab, FRAME_POS);
    let ok = 0; const wrong = [];
    for (const [i, p] of pos.buttons.entries()) {
      if (p.x < 0 || p.y < 0 || p.x >= frame.w || p.y >= frame.h) continue;          // not visible in the frame
      await c.cdp.evaluate(tab, 'window.__hit = null');
      for (const event of ['pressed', 'released']) await c._onMessage(Buffer.from(JSON.stringify({type: 'mouse', event, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: 0})));
      const hit = await c.cdp.evaluate(tab, 'window.__hit');
      if (hit === i) ok++; else wrong.push(`${i}->${hit}`);
    }
    console.log(`${path.padEnd(9)} frame ${frame.w}x${frame.h} dpr ${pos.dpr} pageScale ${pos.scale.toFixed(3)} layout ${pos.layoutWidth}px | taps landed right: ${ok}/${ok + wrong.length} ${wrong.length ? 'wrong: ' + wrong.join(' ') : ''}`);
  }
} finally { await c.stop().catch(() => {}); server.close(); }
