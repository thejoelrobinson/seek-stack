// Cookie-session reverse proxy in front of the DeepSeek Harness web UI.
// cloudflared -> 127.0.0.1:18799 (this) -> 127.0.0.1:3080 (dsh web)
// The harness has no auth of its own and Standard mode can run PowerShell,
// so nothing reaches it until auth passes.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LISTEN_PORT = 18799;
const LISTEN_HOST = '127.0.0.1';
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 3080;
const COOKIE = 'dsh_auth';
const LOGIN_CSRF_COOKIE = 'dsh_login_csrf';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 8;
const loginAttempts = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, attempts] of loginAttempts) { const recent = attempts.filter(at => now - at < LOGIN_WINDOW_MS); if (recent.length) loginAttempts.set(ip, recent); else loginAttempts.delete(ip); } }, LOGIN_WINDOW_MS).unref();
const familyRoot = process.env.DSH_WORK_HOME || path.join(os.homedir(), '.dsh', 'work');
fs.mkdirSync(familyRoot, { recursive: true });
const familyFile = path.join(familyRoot, 'partner-login.json');

const USER = process.env.DSH_PROXY_USER;
const PASS = process.env.DSH_PROXY_PASS;
if (!USER || !PASS) {
  console.error('DSH_PROXY_USER and DSH_PROXY_PASS must be set');
  process.exit(1);
}
let family = { partner: null };
try { family = JSON.parse(fs.readFileSync(familyFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!family || typeof family !== 'object') throw new Error('Invalid family login store');
const saveFamily = () => { const temp = `${familyFile}.tmp`; fs.writeFileSync(temp, JSON.stringify(family), { mode: 0o600 }); fs.renameSync(temp, familyFile); };

// Persist the signing secret so a proxy restart doesn't sign everyone out.
const secretFile = path.join(__dirname, '.secret');
let SECRET;
try {
  SECRET = fs.readFileSync(secretFile, 'utf8').trim();
  if (!SECRET) throw new Error('empty');
} catch {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
}

const sign = (exp) => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const signIdentity = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

function mintToken(identity) {
  const payload = Buffer.from(JSON.stringify({ id: identity, exp: Date.now() + TTL_MS, version: identity === 'partner' ? family.partner?.version : 0 })).toString('base64url');
  return `v2.${payload}.${signIdentity(payload)}`;
}

function tokenIdentity(token) {
  if (!token) return null;
  if (token.startsWith('v2.')) {
    const [, payload, mac] = token.split('.');
    if (!payload || !mac || !safeEqual(mac, signIdentity(payload))) return null;
    try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!Number.isSafeInteger(data.exp) || data.exp < Date.now()) return null;
      if (data.id === 'owner') return 'owner';
      if (data.id === 'partner' && family.partner && data.version === family.partner.version) return 'partner';
    } catch { return null; }
    return null;
  }
  // Existing single-user cookies remain owner sessions until their original expiry.
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  return safeEqual(mac, sign(exp)) ? 'owner' : null;
}

function credentialsIdentity(username, password) {
  if (safeEqual(username, USER) && safeEqual(password, PASS)) return 'owner';
  const partner = family.partner;
  if (!partner || !safeEqual(username, partner.username)) return null;
  const attempt = crypto.scryptSync(password, Buffer.from(partner.salt, 'hex'), 32);
  return safeEqual(attempt.toString('hex'), partner.hash) ? 'partner' : null;
}

function cookieIdentity(header) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return tokenIdentity(rest.join('='));
  }
  return null;
}

const identity = req => cookieIdentity(req.headers.cookie);

function stripAuth(headers) {
  const out = { ...headers };
  delete out.authorization;
  delete out['x-dsh-user'];
  return out;
}

const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const csrf = token => signIdentity(`family:${token}`);
const cookieHeader = (req, token) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : ''}`;
const loginCookie = (req, token) => `${LOGIN_CSRF_COOKIE}=${token}; Path=/login; HttpOnly; SameSite=Strict; Max-Age=900${String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : ''}`;
const clearCookie = (req, name, cookiePath = '/') => `${name}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : ''}`;
const cookieValue = (header, name) => { for (const part of String(header || '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) return rest.join('='); } return ''; };
const loginCsrf = token => signIdentity(`login:${token}`);
const safeNext = value => { const next = String(value || '/work'); return next.length <= 300 && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !/[\x00-\x1f]/.test(next) && !next.startsWith('/login') && !next.startsWith('/logout') ? next : '/work'; };
const loginHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
const loginPage = (token, next, error = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Seek</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 18% 10%,#eee5f4 0,transparent 35%),radial-gradient(circle at 85% 86%,#e8f4ec 0,transparent 35%),#faf8f7;color:#332b38;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}.wrap{width:min(100%,420px)}.mark{display:flex;align-items:center;gap:12px;margin:0 0 24px 4px;font-weight:750;font-size:18px;letter-spacing:-.4px}.orb{width:39px;height:39px;display:grid;place-items:center;border-radius:15px;background:#e8dff0;color:#665183;box-shadow:0 5px 16px #47385418;font-size:22px}main{background:#fff;border:1px solid #eae4ec;border-radius:24px;padding:36px;box-shadow:0 24px 65px #4b3f5b17}h1{font-size:29px;letter-spacing:-1px;line-height:1.15;margin:0 0 10px}p{color:#716977;margin:0 0 26px;font-size:13px}label{display:block;font-size:12px;font-weight:680;margin:19px 0 7px}input{width:100%;padding:13px 14px;border:1px solid #dcd5df;border-radius:11px;background:#fcfbfd;font:inherit;color:#332b38;outline:none}input:focus{border-color:#80669e;box-shadow:0 0 0 3px #9d80ba27}.error{background:#fff2f3;color:#8e3b4d;padding:11px 13px;border-radius:9px;margin:0 0 17px;font-size:12px}button{width:100%;border:0;border-radius:11px;margin-top:25px;padding:13px 18px;background:#6d568c;color:#fff;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#594573}.foot{font-size:11px;text-align:center;color:#8b8490;margin-top:18px}</style></head><body><div class="wrap"><div class="mark"><span class="orb">✧</span><span>Seek</span></div><main><h1>Welcome back.</h1><p>Sign in to your shared workspace.</p>${error ? `<div class="error" role="alert">${htmlEscape(error)}</div>` : ''}<form method="post" action="/login"><input type="hidden" name="csrf" value="${loginCsrf(token)}"><input type="hidden" name="next" value="${htmlEscape(next)}"><label for="username">Username</label><input id="username" name="username" autocomplete="username" maxlength="80" autofocus required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form></main><div class="foot">Your chats, files, finances and connections stay in one shared space.</div></div></body></html>`;
const requestIp = req => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').slice(0, 100);
function manageLogin(req, res, url) {
  if (req.method === 'GET') {
    const nonce = crypto.randomBytes(24).toString('hex');
    res.writeHead(200, { ...loginHeaders, 'Set-Cookie': loginCookie(req, nonce) });
    return res.end(loginPage(nonce, safeNext(url.searchParams.get('next'))));
  }
  if (req.method !== 'POST') { res.writeHead(405, loginHeaders); return res.end('Method not allowed'); }
  let body = '', size = 0;
  req.on('data', chunk => { size += chunk.length; if (size > 4096) req.destroy(); else body += chunk; });
  req.on('end', () => {
    const form = new URLSearchParams(body), nonce = cookieValue(req.headers.cookie, LOGIN_CSRF_COOKIE);
    if (!nonce || !safeEqual(form.get('csrf') || '', loginCsrf(nonce))) { res.writeHead(403, loginHeaders); return res.end('Sign-in page expired. Reload and try again.'); }
    const ip = requestIp(req), now = Date.now(), recent = (loginAttempts.get(ip) || []).filter(at => now - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_ATTEMPTS) { loginAttempts.set(ip, recent); res.writeHead(429, loginHeaders); return res.end(loginPage(nonce, safeNext(form.get('next')), 'Too many attempts. Try again in 15 minutes.')); }
    const username = String(form.get('username') || ''), password = String(form.get('password') || '');
    const who = username.length <= 80 && password.length <= 200 ? credentialsIdentity(username, password) : null;
    if (!who) { recent.push(now); loginAttempts.set(ip, recent); res.writeHead(401, loginHeaders); return res.end(loginPage(nonce, safeNext(form.get('next')), 'That username or password did not work.')); }
    loginAttempts.delete(ip);
    res.writeHead(303, { 'Location': safeNext(form.get('next')), 'Cache-Control': 'no-store', 'Set-Cookie': [cookieHeader(req, mintToken(who)), clearCookie(req, LOGIN_CSRF_COOKIE, '/login')] });
    res.end();
  });
}
const familyPage = (token, message = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Partner login · Seek</title><style>body{font:15px system-ui;background:#f7f4f8;color:#30283a;max-width:560px;margin:6vh auto;padding:20px}main{background:white;border:1px solid #e6dfea;border-radius:20px;padding:30px;box-shadow:0 15px 45px #3d2a5012}h1{font-size:25px}p{line-height:1.6;color:#665e6d}label{display:block;margin:16px 0 5px;font-weight:600}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #d8cfdd;border-radius:10px;font:inherit}button{margin-top:20px;background:#665084;color:white;border:0;border-radius:10px;padding:12px 18px;font:inherit;cursor:pointer}button.remove{background:#a04c62}a{color:#665084}.notice{padding:10px 13px;background:#edf8ed;color:#2b6737;border-radius:9px}</style><main><a href="/work">← Back to Seek</a><h1>Partner login</h1><p>A partner login opens the same Seek workspace: chats, tasks, files, memory, finance, connected apps, and browser sessions. Both people can see and change shared content.</p>${message ? `<p class="notice">${htmlEscape(message)}</p>` : ''}${family.partner ? `<p><strong>Current partner:</strong> ${htmlEscape(family.partner.username)}</p>` : '<p>No partner login yet.</p>'}<form method="post" action="/family"><input type="hidden" name="csrf" value="${csrf(token)}"><input type="hidden" name="action" value="save"><label for="username">Partner username</label><input id="username" name="username" autocomplete="username" value="${htmlEscape(family.partner?.username || '')}" maxlength="80" required><label for="password">New partner password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required><p>Use a unique password of at least 12 characters. Saving a new password signs out the previous partner session.</p><button type="submit">${family.partner ? 'Update partner login' : 'Create partner login'}</button></form>${family.partner ? `<form method="post" action="/family"><input type="hidden" name="csrf" value="${csrf(token)}"><input type="hidden" name="action" value="remove"><button class="remove" type="submit">Remove partner access</button></form>` : ''}</main></html>`;
function manageFamily(req, res, who, sessionToken, newCookie) {
  if (who !== 'owner') { res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('Only the owner can manage partner access.'); }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', ...(newCookie ? { 'Set-Cookie': newCookie } : {}) };
  if (req.method === 'GET') { res.writeHead(200, headers); return res.end(familyPage(sessionToken)); }
  if (req.method !== 'POST') { res.writeHead(405, headers); return res.end('Method not allowed'); }
  let body = '', size = 0;
  req.on('data', chunk => { size += chunk.length; if (size > 4096) req.destroy(); else body += chunk; });
  req.on('end', () => {
    const form = new URLSearchParams(body);
    if (!safeEqual(form.get('csrf') || '', csrf(sessionToken))) { res.writeHead(403, headers); return res.end('Invalid session token'); }
    const action = form.get('action');
    if (action === 'remove') { family.partner = null; saveFamily(); res.writeHead(200, headers); return res.end(familyPage(sessionToken, 'Partner access removed.')); }
    if (action !== 'save') { res.writeHead(400, headers); return res.end('Invalid action'); }
    const username = String(form.get('username') || '').trim(), password = String(form.get('password') || '');
    if (!/^[a-zA-Z0-9._@-]{3,80}$/.test(username) || username.toLowerCase() === USER.toLowerCase() || password.length < 12 || password.length > 200) { res.writeHead(400, headers); return res.end(familyPage(sessionToken, 'Use a distinct username and a password of 12–200 characters.')); }
    const salt = crypto.randomBytes(16), hash = crypto.scryptSync(password, salt, 32);
    family.partner = { username, salt: salt.toString('hex'), hash: hash.toString('hex'), version: crypto.randomUUID() };
    saveFamily(); res.writeHead(200, headers); res.end(familyPage(sessionToken, 'Partner login saved. Share the Seek web address and the login details with your partner.'));
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/login') return manageLogin(req, res, url);
  if (url.pathname === '/logout') {
    res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie(req, COOKIE) });
    return res.end();
  }
  const who = identity(req);
  if (!who) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/work' || url.pathname === '/work/' || String(req.headers.accept || '').includes('text/html'))) {
      res.writeHead(303, { Location: `/login?next=${encodeURIComponent(safeNext(req.url))}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end('{"error":"Sign in required"}');
  }

  const cookieWho = cookieIdentity(req.headers.cookie);
  const sessionToken = cookieWho ? (String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1) : mintToken(who);
  const extra = {};
  if (!cookieWho) extra['Set-Cookie'] = cookieHeader(req, sessionToken);
  if (req.url?.split('?')[0] === '/family') return manageFamily(req, res, who, sessionToken, extra['Set-Cookie']);

  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: stripAuth(req.headers) },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...extra });
      proxyRes.on('error', () => res.destroy());
      proxyRes.pipe(res);
    },
  );
  // A dsh restart resets in-flight sockets. Without these handlers Node
  // promotes ECONNRESET to an uncaught exception and kills the proxy.
  req.on('error', () => proxyReq.destroy());
  res.on('error', () => proxyReq.destroy());
  proxyReq.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`upstream error: ${e.message}\n`);
  });
  req.pipe(proxyReq);
});

server.on('upgrade', (req, socket, head) => {
  if (!identity(req)) {
    // Deliberately NO WWW-Authenticate here: a challenge on a WebSocket
    // handshake is what made the browser re-prompt on every reconnect.
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  socket.on('error', () => socket.destroy());
  const proxyReq = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: stripAuth(req.headers),
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on('error', () => { proxySocket.destroy(); socket.destroy(); });
    socket.on('close', () => proxySocket.destroy());
    proxySocket.on('close', () => socket.destroy());
    const lines = Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines}\r\n\r\n`);
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
    proxySocket.pipe(socket).pipe(proxySocket);
  });
  proxyReq.on('error', () => socket.destroy());
  if (head && head.length) proxyReq.write(head);
  proxyReq.end();
});

// Malformed/aborted client connections must not be fatal either.
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  socket.destroy();
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`dsh auth proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
