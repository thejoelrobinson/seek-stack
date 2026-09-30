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
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pages[req.url] || '<title>Frame</title>'); });
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
  assert.equal(tools.size, 21);

  // Login wall: the agent is steered to hand off and can never type a password.
  let s = await call('viewer_navigate', {url: base + '/login'});
  assert.equal(s.gate, 'login');
  assert.match(s.note, /viewer_handoff/);
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
  assert.match(s.note, /^HANDOFF/);
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
  c.appliedViewport = 'mobile';
  await call('viewer_snapshot');
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'innerWidth'), 1000);

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
