// Vault sign-in: a fake Bitwarden CLI and synthetic test logins only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../lib/index.js';
import {Vault, siteOf} from '../lib/vault.js';

assert.equal(siteOf('accounts.google.com'), 'google.com');
assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
assert.equal(siteOf('127.0.0.1:18899'), '127.0.0.1');

// ── fixture site: single-step and two-step sign-in ────────────────────────────
const submissions = [];
const html = (title, body) => `<!doctype html><title>${title}</title>${body}`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(raw));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/signin') {
      submissions.push(form);
      if (form.password === 'dummy-value') { res.writeHead(303, {'Set-Cookie': 'sid=abc; Path=/', Location: '/account'}); return res.end(); }
      res.writeHead(303, {Location: '/login?error=1'}); return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/step2') { res.writeHead(303, {Location: '/password?u=' + encodeURIComponent(form.email || '')}); return res.end(); }
    if (url.pathname === '/login') return res.end(html('Sign in', '<form method="post" action="/signin"><input type="email" name="email" autocomplete="username"><input type="password" name="password"><button type="submit">Sign in</button></form>'));
    if (url.pathname === '/step1') return res.end(html('Sign in', '<form method="post" action="/step2"><input type="email" name="email"><button type="submit">Next</button></form>'));
    if (url.pathname === '/password') return res.end(html('Password', `<form method="post" action="/signin"><input type="hidden" name="email" value="${url.searchParams.get('u')}"><input type="password" name="password"><button type="submit">Sign in</button></form>`));
    res.end(html('Account', '<h1>Your account</h1>'));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── fake Bitwarden CLI ────────────────────────────────────────────────────────
const calls = [];
const items = [
  {id: 'good', type: 1, name: 'Fixture', login: {username: 'dummy@example.test', password: 'dummy-value', uris: [{uri: base + '/login'}]}},
  {id: 'stale', type: 1, name: 'Fixture old', login: {username: 'dummy@example.test', password: 'out-of-date', uris: [{uri: base}]}},
  {id: 'other', type: 1, name: 'Elsewhere', login: {username: 'x', password: 'y', uris: [{uri: 'https://elsewhere.example'}]}},
  {id: 'note', type: 2, name: 'A secure note'}
];
const run = async (args, env = {}, input) => {
  calls.push({args, env: Object.keys(env), input});
  if (args[0] === 'create') { assert.equal(env.BW_SESSION, 'session-key'); const item = JSON.parse(Buffer.from(input, 'base64').toString()); const created = {...item, id: 'new-' + items.length}; items.push(created); return JSON.stringify(created); }
  if (args[0] === 'status') return JSON.stringify({status: 'locked'});
  if (args[0] === 'unlock') { assert.equal(env.BW_PASSWORD, 'test-master'); return 'session-key\n'; }
  assert.equal(env.BW_SESSION, 'session-key', 'every vault read needs the in-memory session');
  if (args[0] === 'sync' || args[0] === 'lock') return '';
  if (args[0] === 'list') return JSON.stringify(items);
  if (args[0] === 'get') return JSON.stringify(items.find(i => i.id === args[2]));
  throw new Error('unexpected ' + args.join(' '));
};
const vault = new Vault({run});
assert.equal((await vault.status()).state, 'locked');
assert.deepEqual(vault.matches('127.0.0.1'), [], 'nothing matches while locked');
await assert.rejects(vault.credential('good', '127.0.0.1'), /locked/);
await assert.rejects(vault.unlock('', 30), /master password/);
const unlocked = await vault.unlock('test-master', 30);
assert.equal(unlocked.state, 'unlocked');
assert.equal(calls.filter(c => c.env.includes('BW_PASSWORD')).length, 1, 'the master password only goes to unlock');
assert.equal(JSON.stringify(vault.items).includes('dummy-value'), false, 'the index keeps no passwords');
assert.deepEqual(vault.matches(base.replace('http://', '')).map(m => m.id).sort(), ['good', 'stale']);
await assert.rejects(vault.credential('other', '127.0.0.1'), /not for/);

// ── real Chrome fills ─────────────────────────────────────────────────────────
const c = new BrowserController({headless: true, windowWidth: 1000, windowHeight: 700, quality: 40, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'dsh-vault-test-'))}});
c.vault = vault;
try {
  await c.navigate(base + '/login');
  c.paused = true; // a handoff is in progress, so the agent is blind
  let r = await c.fillFromVault('good');
  assert.equal(r.signedIn, true);
  assert.equal(JSON.stringify(r).includes('dummy-value'), false, 'the result carries no secret');
  assert.deepEqual(submissions.at(-1), {email: 'dummy@example.test', password: 'dummy-value'});
  assert.equal(await c.cdp.evaluate(c.activeTabId, 'document.title'), 'Account');

  // Two-step: email, Next, then password.
  await c.navigate(base + '/step1');
  r = await c.fillFromVault('good');
  assert.equal(r.signedIn, true);
  assert.deepEqual(submissions.at(-1), {email: 'dummy@example.test', password: 'dummy-value'});

  // A stale saved password is detected as "still signing in", not reported as success.
  await c.navigate(base + '/login');
  r = await c.fillFromVault('stale');
  assert.equal(r.signedIn, false);

  // A saved login is never filled into a different site.
  await assert.rejects(c.fillFromVault('other'), /not for/);

  // Signed-in sites: cookies are counted per site and cleared by sign-out.
  assert.equal((await c.cookieCounts())['127.0.0.1'], 1);
  const out = await c.signOut('127.0.0.1');
  assert.equal(out.cleared, 1);
  assert.equal((await c.cookieCounts())['127.0.0.1'] || 0, 0);

  // Secure card: a new login is saved through stdin (never argv) and used at once.
  await c.navigate(base + '/login');
  const saved = await vault.saveLogin(base.replace('http://', ''), 'dummy@example.test', 'dummy-value');
  const createCall = calls.find(x => x.args[0] === 'create');
  assert.equal(createCall.args.join(' ').includes('dummy-value'), false, 'the password is not in the command line');
  assert.ok(Buffer.from(createCall.input, 'base64').toString().includes('dummy-value'));
  assert.equal(JSON.stringify(vault.items).includes('dummy-value'), false);
  r = await c.fillFromVault(saved.id);
  assert.equal(r.signedIn, true);

  vault.lock();
  assert.equal(vault.unlocked, false);
  await assert.rejects(vault.saveLogin('127.0.0.1', 'a', 'b'), /locked/);
  await assert.rejects(c.fillFromVault('good'), /locked/);
  console.log('PASS: vault unlock/index/lock, single- and two-step fills, stale-password detection, site pinning, sign-out.');
} finally {
  await c.close();
  server.close();
}
