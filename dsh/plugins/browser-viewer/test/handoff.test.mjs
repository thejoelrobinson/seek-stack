// Real-Chrome checks for Muse-style handoff: deterministic login/CAPTCHA gates,
// the agent is blind while the user holds control, and hard-to-undo clicks wait
// for approval.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController, buildTools} from '../lib/index.js';

const pages = {
  '/login': '<title>Sign in</title><h1>Sign in</h1><label>Email<input id="email"></label><label>Password<input id="pw" type="password"></label><button>Sign in</button>',
  '/captcha': '<title>Security check</title><p>One more step</p><iframe src="/recaptcha/api2/anchor" width="300" height="80"></iframe>',
  '/mobile': '<meta name="viewport" content="width=device-width"><title>Mobile sign in</title><input type="password">',
  '/checkout':'<title>Checkout</title><h1>Review your order</h1><button onclick="document.querySelector(\'#r\').textContent=\'Coupon applied\'">Apply coupon</button><button onclick="document.querySelector(\'#r\').textContent=\'Order placed\'">Place order</button><p id="r"></p>'
};
pages['/grid'] = '<title>Desktop grid</title><style>body{margin:0}.g{display:grid;grid-template-columns:repeat(4,280px);gap:12px;padding:12px}button{height:90px}</style><div class="g">' + Array.from({length: 12}, (_, i) => '<button onclick="window.__hit=' + i + '">' + i + '</button>').join('') + '</div>';
pages['/form'] = '<title>Order form</title><form method="post" action="/posted"><button>Submit</button></form>';
const loads = {count: 0, posted: 0};
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/count') { loads.count++; res.end('<title>Counted</title><p>loaded</p>'); return; }
  if (req.url === '/posted') { loads.posted++; res.end('<title>Posted</title><p>thanks</p>'); return; }
  res.end(pages[req.url] || '<title>Frame</title>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const c = new BrowserController({headless:true, windowWidth:1000, windowHeight:700, quality:40, intervalMs:400, browserOptions:{userDataDir:await mkdtemp(join(tmpdir(), 'dsh-handoff-test-'))}});
const events = [];
c.onHandoff = h => events.push(['handoff', h]);
c.onHandBack = h => events.push(['handback', h]);
c.onApproval = a => events.push(['approval', a]);
c.onDecision = (a, d, s) => events.push(['decision', a, d, s]);
const tools = new Map(buildTools(c).map(t => [t.name, t]));
const exec = {agent:{id:'session-1'}};
const call = (name, args = {}) => tools.get(name).execute(args, exec);
const ref = (s, text) => { const el = s.elements.find(e => e.text === text); assert.ok(el, 'missing ' + text); return el.ref; };
const pageText = () => c.cdp.evaluate(c.activeTabId, 'document.querySelector("#r")?.textContent || ""');

try {
  assert.equal(tools.size,23);

  // Login wall: the agent is steered to hand off and can never type a password.
  let s = await call('viewer_navigate', {url: base + '/login'});
  assert.equal(s.gate, 'login');
  assert.match(s.gateNote, /viewer_handoff/);
  await assert.rejects(call('viewer_fill', {ref: ref(s, 'Password'), text: 'hunter2'}), /typed by the user/);
  s = await call('viewer_click', {ref: ref(s, 'Password')});
  await assert.rejects(call('viewer_type', {text: 'hunter2'}), /typed by the user/);
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'document.querySelector("#pw").value'), '');

  // Pressing "Sign in" with an empty password field hands off instead of submitting.
  s = await call('viewer_snapshot');
  const signIn = await call('viewer_click', {ref: ref(s, 'Sign in')});
  assert.equal(signIn.handedOff, true);
  assert.equal(c.handoff.reason, 'login');
  await c.handBack();

  // Explicit handoff: the browser goes to the user and the agent is blind until hand back.
  const h = await call('viewer_handoff', {reason: 'login', message: 'Sign in to the fixture.'});
  assert.equal(h.handedOff, true);
  assert.equal(c.paused, true);
  assert.equal(c.statusNow().control, 'user');
  assert.equal(c.statusNow().handoff.reason, 'login');
  assert.equal(events.at(-1)[0], 'handoff');
  assert.equal(events.at(-1)[1].sessionId, 'session-1');
  await assert.rejects(call('viewer_snapshot'), /paused/);
  await assert.rejects(call('viewer_screenshot'), /paused/);
  assert.equal((await call('viewer_status')).paused, true);
  assert.equal(c.userMayDrive(), true);
  await c.handBack('Signed in.');
  assert.equal(c.paused, false);
  assert.equal(c.handoff, null);
  assert.equal(events.at(-1)[0], 'handback');
  assert.equal(events.at(-1)[1].note, 'Signed in.');
  assert.match(events.at(-1)[1].url, /\/login$/);

  // CAPTCHA: handed to the user automatically, not left to the model.
  s = await call('viewer_navigate', {url: base + '/captcha'});
  assert.equal(s.gate, 'captcha');
  assert.match(s.gateNote, /^HANDOFF/);
  assert.equal(c.paused, true);
  assert.equal(c.handoff.reason, 'captcha');
  await c.handBack();

  // Checkout: ordinary clicks go through; "Place order" waits for approval.
  s = await call('viewer_navigate', {url: base + '/checkout'});
  s = await call('viewer_click', {ref: ref(s, 'Apply coupon')});
  assert.equal(await pageText(), 'Coupon applied');
  let held = await call('viewer_click', {ref: ref(s, 'Place order')});
  assert.equal(held.approvalRequired, true);
  assert.equal(await pageText(), 'Coupon applied', 'Held click must not happen.');
  assert.equal(c.statusNow().approval.label, 'Place order');
  await c.decide(c.approval, 'approve', 'once');
  assert.equal(events.at(-1)[0], 'decision');
  s = await call('viewer_snapshot');
  s = await call('viewer_click', {ref: ref(s, 'Place order')});
  assert.equal(await pageText(), 'Order placed');
  held = await call('viewer_click', {ref: ref(s, 'Place order')});
  assert.equal(held.approvalRequired, true, 'A once-approval is consumed.');
  await c.decide(c.approval, 'reject');
  assert.equal(c.approval, null);
  // "Always on this site" is remembered for that exact action; the next click goes straight through.
  s = await call('viewer_navigate', {url: base + '/checkout'});
  held = await call('viewer_click', {ref: ref(s, 'Place order')});
  assert.equal(held.approvalRequired, true);
  await c.decide(c.approval, 'approve', 'always');
  assert.deepEqual(c.alwaysAllow.map(a => a.label), ['Place order']);
  s = await call('viewer_snapshot');
  s = await call('viewer_click', {ref: ref(s, 'Place order')});
  assert.equal(held.approvalRequired && s.approvalRequired, undefined);
  s = await call('viewer_navigate', {url: base + '/checkout'});
  s = await call('viewer_click', {ref: ref(s, 'Place order')});
  assert.equal(s.approvalRequired, undefined, 'still allowed on a later visit');
  c.alwaysAllow.length = 0;

  // Phone in control: phone-sized page at 2x; hand back restores the agent's desktop page.
  await c.takeControl();
  await c.setViewport('mobile', {width: 390, height: 700});
  await c.navigate(base + '/mobile');
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'screen.width'), 390);
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'devicePixelRatio'), 2);
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'innerWidth'), 390, 'A mobile-friendly page reflows to phone width.');
  assert.equal(c.statusNow().viewport, 'mobile');
  assert.equal(c.inputScale, 2);
  await c.handBack();
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'innerWidth'), 1000);
  assert.equal(c.inputScale, 1);
  await c.setViewport('mobile', {width: 390, height: 700});
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'innerWidth'), 1000, 'A late phone request after hand back is refused.');
  // Even if Chrome is left on a phone page, the agent's next action restores desktop first.
  await c.cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 700, deviceScaleFactor: 2, mobile: true}, c.cdp.tabs.get(c.activeTabId));
  c.appliedViewports.set(c.activeTabId, 'mobile');
  await call('viewer_snapshot');
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'innerWidth'), 1000);

  // A phone in control gets the phone version of sites: Android identity (client hints too) and touch,
  // the page in front reloaded once to switch; hand back restores desktop.
  await c.navigate(base + '/count');
  const desktopTouch = await c.cdp.evaluate(c.activeTabId, 'navigator.maxTouchPoints');
  await c.takeControl();
  const before = loads.count;
  await c.setViewport('mobile', {width: 392, height: 451});
  await new Promise(r => setTimeout(r, 400));
  assert.match(await c.cdp.evaluate(c.activeTabId, 'navigator.userAgent'), /Android.*Mobile/);
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'navigator.userAgentData && navigator.userAgentData.mobile'), true);
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'navigator.maxTouchPoints'), 5);
  assert.equal(loads.count, before + 1, 'the page in front is reloaded once so it serves its phone layout');
  await c.setViewport('mobile', {width: 392, height: 460});
  assert.equal(loads.count, before + 1, 'a resize does not reload again');
  // Taps land where the finger is, even on a desktop page that Chrome zooms out to fit the phone.
  await c.navigate(base + '/grid');
  await new Promise(r => setTimeout(r, 200));
  const grid = await c.cdp.evaluate(c.activeTabId, '({scale: visualViewport.scale, dpr: devicePixelRatio, at: [...document.querySelectorAll("button")].map(b => { const r = b.getBoundingClientRect(); return {x: (r.left + r.width / 2 - visualViewport.offsetLeft) * visualViewport.scale * devicePixelRatio, y: (r.top + r.height / 2 - visualViewport.offsetTop) * visualViewport.scale * devicePixelRatio}; })})');
  assert.ok(grid.scale < 0.6, 'a desktop-only page is zoomed out at phone size: ' + grid.scale);
  const frame = {fw: 392 * grid.dpr, fh: 451 * grid.dpr};
  const tap = async (p, extra) => { await c.cdp.evaluate(c.activeTabId, 'window.__hit = null'); for (const event of ['pressed', 'released']) await c._onMessage(Buffer.from(JSON.stringify({type: 'mouse', event, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: 0, ...extra}))); return c.cdp.evaluate(c.activeTabId, 'window.__hit'); };
  const visible = grid.at.map((p, i) => [p, i]).filter(([p]) => p.x < frame.fw && p.y < frame.fh);
  assert.ok(visible.length >= 4);
  for (const [p, i] of visible) assert.equal(await tap(p, frame), i, 'tap with the frame size lands on button ' + i);
  for (const [p, i] of visible) assert.equal(await tap(p, {}), i, 'a client without the frame size lands on button ' + i + ' too');
  // A tab opened while the phone has control gets the phone page.
  await c.tab({action: 'open', url: base + '/grid'});
  await c._tick();
  assert.match(await c.cdp.evaluate(c.activeTabId, 'navigator.userAgent'), /Android/);
  await c.handBack();
  for (const tab of (await c.listTabs()).tabs) {
    await c.tab({action: 'switch', tabId: tab.id});
    assert.doesNotMatch(await c.cdp.evaluate(c.activeTabId, 'navigator.userAgent'), /Android|Mobile/, 'hand back restores desktop on every tab');
    assert.equal(await c.cdp.evaluate(c.activeTabId, 'navigator.maxTouchPoints'), desktopTouch, 'touch emulation is off again');
  }
  // The result of a form submission is never reloaded behind the user's back (it could resend it).
  await c.navigate(base + '/form');
  await c.click({x: 30, y: 15});
  await new Promise(r => setTimeout(r, 400));
  assert.equal(loads.posted, 1);
  await c.takeControl();
  await c.setViewport('mobile', {width: 392, height: 451});
  await new Promise(r => setTimeout(r, 400));
  assert.equal(loads.posted, 1, 'a form result is not reloaded');
  await c.handBack();

  // While a Work task runs, the user must take control before driving.
  c.agentActive = () => true;
  assert.equal(c.userMayDrive(), false);
  await c.takeControl();
  assert.equal(c.userMayDrive(), true);
  await c.handBack();
  c.agentActive = () => false;

  console.log('PASS: login/CAPTCHA gates, password guard, blind-while-user-controls, hand back, approval hold and consumption.');
} finally {
  await c.close();
  server.close();
}
