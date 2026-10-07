// Cookie-session reverse proxy in front of the DeepSeek Harness web UI.
// cloudflared -> 127.0.0.1:18799 (this) -> 127.0.0.1:3080 (dsh web)
// The harness has no auth of its own and Standard mode can run PowerShell,
// so nothing reaches it until auth passes.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PROXY_RELEASE = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0,20);
const os = require('node:os');
const {SessionStore}=require('./work-session-store.cjs');

const LISTEN_PORT = process.env.DSH_PROXY_LISTEN_PORT===undefined?18799:Number(process.env.DSH_PROXY_LISTEN_PORT);
const LISTEN_HOST = '127.0.0.1';
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = process.env.DSH_PROXY_TARGET_PORT===undefined?3080:Number(process.env.DSH_PROXY_TARGET_PORT);
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
// Security activity shared with Work (work-security.js reads the same file). Never logs
// passwords, tokens or the username of a failed attempt.
const securityFile = path.join(familyRoot, 'security-events.jsonl');
function securityEvent(type, req, detail = {}) {
  try {
    const agent = String(req?.headers?.['user-agent'] || '');
    const device = /iPhone|iPad/.test(agent) ? 'iPhone/iPad' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'Mac' : agent ? 'Other' : undefined;
    const line = JSON.stringify({ at: Date.now(), source: 'proxy', type, ip: req ? requestIp(req) : undefined, device, ...detail }) + '\n';
    try { if (fs.statSync(securityFile).size > 1024 * 1024) fs.renameSync(securityFile, securityFile + '.1'); } catch {}
    fs.appendFileSync(securityFile, line, { mode: 0o600 });
  } catch {}
}

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
const sessions=new SessionStore(path.join(familyRoot,'auth-sessions.json'),{secret:SECRET,credentialsDigest:signIdentity(USER+'\0'+PASS)});
const sessionSockets=new Map();
const closeSessionSockets=id=>{for(const socket of sessionSockets.get(id)||[])socket.destroy();sessionSockets.delete(id);};
function sessionId(token){if(token.startsWith('v2.')){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')).sid||sessions.id(token);}catch{return '';}}return sessions.id(token);}
function sameOrigin(req){if(req.headers['sec-fetch-site']==='cross-site')return false;if(req.headers.origin===undefined)return true;try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}

function mintToken(identity,req) {
  const exp=Date.now()+TTL_MS,sid=sessions.create(identity,exp,{userAgent:req?.headers['user-agent']});
  const payload = Buffer.from(JSON.stringify({ id: identity, sid, exp, version: identity === 'partner' ? family.partner?.version : sessions.data.ownerVersion })).toString('base64url');
  return `v2.${payload}.${signIdentity(payload)}`;
}

function tokenIdentity(token) {
  if (!token) return null;
  if (token.startsWith('v2.')) {
    const [, payload, mac] = token.split('.');
    if (!payload || !mac || !safeEqual(mac, signIdentity(payload))) return null;
    try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!Number.isSafeInteger(data.exp) || data.exp < Date.now()) return null;
      if (data.id === 'owner'&&sessions.accept({id:data.sid,identity:'owner',expiresAt:data.exp,version:data.version,token})) return 'owner';
      if (data.id === 'partner' && family.partner && data.version === family.partner.version&&sessions.accept({id:data.sid,identity:'partner',expiresAt:data.exp,token})) return 'partner';
    } catch { return null; }
    return null;
  }
  // Existing single-user cookies remain owner sessions until their original expiry.
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  return safeEqual(mac, sign(exp))&&sessions.accept({identity:'owner',expiresAt:Number(exp),version:0,token}) ? 'owner' : null;
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

// CalDAV (Apple Calendar and Reminders) signs in with HTTP Basic, never the cookie. Each device has
// its own generated password, created and revoked in Seek (work-dav-auth.js writes only scrypt hashes).
const DAV_FILE = path.join(familyRoot, 'caldav-devices.json');
const DAV_USER = 'seek';
let davCache = { mtime: -1, devices: [] };
const davVerified = new Map();
function davDevices() {
  let mtime = 0;
  try { mtime = fs.statSync(DAV_FILE).mtimeMs; } catch { davCache = { mtime: 0, devices: [] }; davVerified.clear(); return davCache.devices; }
  if (mtime !== davCache.mtime) {
    let devices = [];
    try { devices = JSON.parse(fs.readFileSync(DAV_FILE, 'utf8')).devices || []; } catch {}
    davCache = { mtime, devices: Array.isArray(devices) ? devices : [] }; davVerified.clear();
  }
  return davCache.devices;
}
function davDevice(req) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8'), colon = decoded.indexOf(':');
  if (colon < 0) return null;
  const user = decoded.slice(0, colon), pass = decoded.slice(colon + 1);
  if (!safeEqual(user.toLowerCase(), DAV_USER) || pass.length < 8 || pass.length > 200) return null;
  const devices = davDevices(), fingerprint = crypto.createHmac('sha256', SECRET).update(pass).digest('hex');
  // Phones sync in bursts of requests; a verified password skips scrypt until the file changes.
  const known = davVerified.get(fingerprint);
  if (known && devices.some(d => d.id === known)) return known;
  for (const d of devices) {
    if (typeof d.salt !== 'string' || typeof d.hash !== 'string') continue;
    const attempt = crypto.scryptSync(pass, Buffer.from(d.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
    if (safeEqual(attempt, d.hash)) { davVerified.set(fingerprint, d.id); return d.id; }
  }
  return null;
}
// Paired computers (Seek Desktop) hold a device key: "<id>.<64 hex>", checked against the scrypt
// hashes Work keeps in desktop-devices.json. They never use the browser cookie.
const DESKTOP_FILE = path.join(familyRoot, 'desktop-devices.json');
let desktopCache = { mtime: -1, devices: [] };
const desktopVerified = new Map();
function desktopDevice(req) {
  const m = /^Bearer\s+([0-9a-f-]{36})\.([a-f0-9]{64})\s*$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  let mtime = 0;
  try { mtime = fs.statSync(DESKTOP_FILE).mtimeMs; } catch { return null; }
  if (mtime !== desktopCache.mtime) { let devices = []; try { devices = JSON.parse(fs.readFileSync(DESKTOP_FILE, 'utf8')).devices || []; } catch {} desktopCache = { mtime, devices: Array.isArray(devices) ? devices : [] }; desktopVerified.clear(); }
  const fingerprint = crypto.createHmac('sha256', SECRET).update(m[0]).digest('hex'), known = desktopVerified.get(fingerprint);
  if (known && desktopCache.devices.some(d => d.id === known)) return known;
  const d = desktopCache.devices.find(x => x.id === m[1]);
  if (!d || typeof d.salt !== 'string' || typeof d.hash !== 'string') return null;
  const attempt = crypto.scryptSync(m[2], Buffer.from(d.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  if (!safeEqual(attempt, d.hash)) return null;
  desktopVerified.set(fingerprint, d.id); return d.id;
}
function proxyDav(req, res) {
  const ip = requestIp(req), now = Date.now(), recent = (loginAttempts.get(ip) || []).filter(at => now - at < LOGIN_WINDOW_MS);
  const challenge = { 'WWW-Authenticate': 'Basic realm="Seek Calendar", charset="UTF-8"', 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' };
  if (recent.length >= LOGIN_ATTEMPTS) { securityEvent('caldav.rate_limited', req, { attempts: recent.length }); res.writeHead(429, { 'Retry-After': '900', 'Cache-Control': 'no-store' }); return res.end('Too many attempts'); }
  const device = davDevice(req);
  if (!device) {
    if (req.headers.authorization) { recent.push(now); loginAttempts.set(ip, recent); securityEvent('caldav.failed', req, { attempts: recent.length }); }
    req.resume(); res.writeHead(401, challenge); return res.end('Sign in with a Seek device password');
  }
  const headers = stripAuth(req.headers);
  delete headers.cookie;
  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: { ...headers, 'x-seek-dav-device': device, 'x-seek-proxy-release': PROXY_RELEASE } },
    (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.on('error', () => res.destroy()); proxyRes.pipe(res); },
  );
  req.on('error', () => proxyReq.destroy());
  res.on('error', () => proxyReq.destroy());
  proxyReq.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`upstream error: ${e.message}\n`); });
  req.pipe(proxyReq);
}

function stripAuth(headers) {
  const out = { ...headers };
  delete out.authorization;
  delete out['x-dsh-user'];
  delete out['x-seek-dav-device'];
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
    if (!nonce || !safeEqual(form.get('csrf') || '', loginCsrf(nonce))) { securityEvent('login.csrf_rejected', req); res.writeHead(403, loginHeaders); return res.end('Sign-in page expired. Reload and try again.'); }
    const ip = requestIp(req), now = Date.now(), recent = (loginAttempts.get(ip) || []).filter(at => now - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_ATTEMPTS) { loginAttempts.set(ip, recent); securityEvent('login.rate_limited', req, { attempts: recent.length }); res.writeHead(429, loginHeaders); return res.end(loginPage(nonce, safeNext(form.get('next')), 'Too many attempts. Try again in 15 minutes.')); }
    const username = String(form.get('username') || ''), password = String(form.get('password') || '');
    const who = username.length <= 80 && password.length <= 200 ? credentialsIdentity(username, password) : null;
    if (!who) { recent.push(now); loginAttempts.set(ip, recent); securityEvent('login.failed', req, { attempts: recent.length }); res.writeHead(401, loginHeaders); return res.end(loginPage(nonce, safeNext(form.get('next')), 'That username or password did not work.')); }
    loginAttempts.delete(ip); securityEvent('login.success', req, { identity: who });
    res.writeHead(303, { 'Location': safeNext(form.get('next')), 'Cache-Control': 'no-store', 'Set-Cookie': [cookieHeader(req, mintToken(who,req)), clearCookie(req, LOGIN_CSRF_COOKIE, '/login')] });
    res.end();
  });
}
const familyPage = (token, message = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Partner login · Seek</title><style>body{font:15px system-ui;background:#f7f4f8;color:#30283a;max-width:560px;margin:6vh auto;padding:20px}main{background:white;border:1px solid #e6dfea;border-radius:20px;padding:30px;box-shadow:0 15px 45px #3d2a5012}h1{font-size:25px}p{line-height:1.6;color:#665e6d}label{display:block;margin:16px 0 5px;font-weight:600}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #d8cfdd;border-radius:10px;font:inherit}button{margin-top:20px;background:#665084;color:white;border:0;border-radius:10px;padding:12px 18px;font:inherit;cursor:pointer}button.remove{background:#a04c62}a{color:#665084}.notice{padding:10px 13px;background:#edf8ed;color:#2b6737;border-radius:9px}</style><main><a href="/work">← Back to Seek</a><h1>Partner login</h1><p>A partner login opens the same Seek workspace: chats, tasks, files, memory, finance, connected apps, and browser sessions. Both people can see and change shared content.</p>${message ? `<p class="notice">${htmlEscape(message)}</p>` : ''}${family.partner ? `<p><strong>Current partner:</strong> ${htmlEscape(family.partner.username)}</p>` : '<p>No partner login yet.</p>'}<form method="post" action="/family"><input type="hidden" name="csrf" value="${csrf(token)}"><input type="hidden" name="action" value="save"><label for="username">Partner username</label><input id="username" name="username" autocomplete="username" value="${htmlEscape(family.partner?.username || '')}" maxlength="80" required><label for="password">New partner password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required><p>Use a unique password of at least 12 characters. Saving a new password signs out the previous partner session.</p><button type="submit">${family.partner ? 'Update partner login' : 'Create partner login'}</button></form>${family.partner ? `<form method="post" action="/family"><input type="hidden" name="csrf" value="${csrf(token)}"><input type="hidden" name="action" value="remove"><button class="remove" type="submit">Remove partner access</button></form>` : ''}</main></html>`;
function manageFamily(req, res, who, sessionToken, newCookie) {
  if (who !== 'owner') { res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('Only the owner can manage partner access.'); }
  if(!sameOrigin(req)){res.writeHead(403,{'Cache-Control':'no-store'});return res.end('Open partner settings from Seek.');}
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', ...(newCookie ? { 'Set-Cookie': newCookie } : {}) };
  if (req.method === 'GET') { res.writeHead(200, headers); return res.end(familyPage(sessionToken)); }
  if (req.method !== 'POST') { res.writeHead(405, headers); return res.end('Method not allowed'); }
  let body = '', size = 0;
  req.on('data', chunk => { size += chunk.length; if (size > 4096) req.destroy(); else body += chunk; });
  req.on('end', () => {
    const form = new URLSearchParams(body);
    if (!safeEqual(form.get('csrf') || '', csrf(sessionToken))) { res.writeHead(403, headers); return res.end('Invalid session token'); }
    const action = form.get('action');
    if (action === 'remove') { family.partner = null; saveFamily();securityEvent('partner.removed',req);for(const id of sessions.revokeIdentity('partner'))closeSessionSockets(id);res.writeHead(200, headers); return res.end(familyPage(sessionToken, 'Partner access removed.')); }
    if (action !== 'save') { res.writeHead(400, headers); return res.end('Invalid action'); }
    const username = String(form.get('username') || '').trim(), password = String(form.get('password') || '');
    if (!/^[a-zA-Z0-9._@-]{3,80}$/.test(username) || username.toLowerCase() === USER.toLowerCase() || password.length < 12 || password.length > 200) { res.writeHead(400, headers); return res.end(familyPage(sessionToken, 'Use a distinct username and a password of 12–200 characters.')); }
    const salt = crypto.randomBytes(16), hash = crypto.scryptSync(password, salt, 32);
    family.partner = { username, salt: salt.toString('hex'), hash: hash.toString('hex'), version: crypto.randomUUID() };
    saveFamily();for(const id of sessions.revokeIdentity('partner'))closeSessionSockets(id);securityEvent('partner.saved',req);res.writeHead(200, headers); res.end(familyPage(sessionToken, 'Partner login saved. Share the Seek web address and the login details with your partner.'));
  });
}

const sessionCsrf=token=>signIdentity('sessions:'+token);
function manageSessions(req,res,who,token,url){
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  const reply=(status,value,extra={})=>{res.writeHead(status,{...headers,...extra});res.end(JSON.stringify(value));};
  if(who!=='owner')return reply(403,{error:'Only the workspace owner can manage device sessions.'});
  if(!sameOrigin(req))return reply(403,{error:'Open device sessions from Seek.'});
  const current=sessionId(token);
  if(url.pathname==='/auth/api/sessions'&&req.method==='GET')return reply(200,{sessions:sessions.list(current),csrf:sessionCsrf(token)});
  if(url.pathname!=='/auth/api/sessions/revoke'||req.method!=='POST')return reply(405,{error:'Method not allowed'});
  let body='',size=0,oversized=false;
  req.on('data',chunk=>{size+=chunk.length;if(size>4096)oversized=true;else body+=chunk;});
  req.on('end',()=>{
    if(oversized)return reply(413,{error:'Request is too large.'});
    let input;try{input=JSON.parse(body);}catch{return reply(400,{error:'Invalid request.'});}
    if(!safeEqual(input?.csrf||'',sessionCsrf(token)))return reply(403,{error:'Device-session page expired. Reload and try again.'});
    try{
      if(input.others===true){const others=sessions.list(current).filter(x=>!x.current);const revoked=sessions.revokeOthers(current);for(const s of others)closeSessionSockets(s.id);securityEvent('session.revoked_others',req,{count:revoked});return reply(200,{revoked,sessions:sessions.list(current)});}
      if(typeof input.id!=='string'||input.id.length>100)return reply(400,{error:'Choose a device session.'});
      sessions.revoke(input.id);closeSessionSockets(input.id);securityEvent('session.revoked',req,{current:input.id===current});
      return reply(200,{revoked:1,sessions:sessions.list(current)},input.id===current?{'Set-Cookie':clearCookie(req,COOKIE)}:{});
    }catch(error){return reply(400,{error:error.message});}
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/login') return manageLogin(req, res, url);
  if (url.pathname === '/logout') {
    if(!sameOrigin(req)){res.writeHead(403,{'Cache-Control':'no-store'});return res.end('Open sign out from Seek.');}
    const token=cookieValue(req.headers.cookie,COOKIE),signedOut=tokenIdentity(token);if(signedOut){const id=sessionId(token);sessions.revoke(id);closeSessionSockets(id);securityEvent('logout',req,{identity:signedOut});}
    res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie(req, COOKIE) });
    return res.end();
  }
  // Calendar apps discover the server here, then talk CalDAV under /work/dav with a device password.
  if (url.pathname === '/.well-known/caldav') { res.writeHead(301, { Location: '/work/dav/', 'Cache-Control': 'no-store' }); return res.end(); }
  if (url.pathname === '/work/dav' || url.pathname.startsWith('/work/dav/')) return proxyDav(req, res);
  if (url.pathname === '/work/desktop/pair') {
    const ip = requestIp(req), now = Date.now(), recent = (loginAttempts.get(ip) || []).filter(at => now - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_ATTEMPTS) { securityEvent('desktop.pair_rate_limited', req, { attempts: recent.length }); res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '900' }); return res.end('{"error":"Too many attempts. Try again in 15 minutes."}'); }
    const headers = stripAuth(req.headers); delete headers.cookie;
    const proxyReq = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: '/work/desktop/pair', headers: { ...headers, 'x-seek-proxy-release': PROXY_RELEASE } }, proxyRes => {
      if (proxyRes.statusCode !== 200) { recent.push(now); loginAttempts.set(ip, recent); }
      res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res);
    });
    req.on('error', () => proxyReq.destroy()); proxyReq.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end(); });
    return req.pipe(proxyReq);
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
  const sessionToken = cookieWho ? (String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1) : mintToken(who,req);
  const extra = {};
  if (!cookieWho) extra['Set-Cookie'] = cookieHeader(req, sessionToken);
  if (req.url?.split('?')[0] === '/family') return manageFamily(req, res, who, sessionToken, extra['Set-Cookie']);
  if(url.pathname==='/auth/api/sessions'||url.pathname==='/auth/api/sessions/revoke')return manageSessions(req,res,who,sessionToken,url);

  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: {...stripAuth(req.headers),'x-seek-proxy-release':PROXY_RELEASE} },
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
  // A paired computer's link: device key only, never the cookie.
  if (new URL(req.url, 'http://localhost').pathname === '/work/desktop/link') {
    const device = desktopDevice(req);
    if (!device) { securityEvent('desktop.link_refused', req); return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); }
    socket.on('error', () => socket.destroy());
    const headers = { ...req.headers }; delete headers.cookie; delete headers['x-dsh-user']; delete headers['x-seek-dav-device'];
    const proxyReq = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: '/work/desktop/link', headers: { ...headers, 'x-seek-desktop-device': device, 'x-seek-proxy-release': PROXY_RELEASE } });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      proxySocket.on('error', () => { proxySocket.destroy(); socket.destroy(); });
      socket.on('close', () => proxySocket.destroy()); proxySocket.on('close', () => socket.destroy());
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      proxySocket.pipe(socket).pipe(proxySocket);
    });
    proxyReq.on('response', r => { r.resume(); socket.end(`HTTP/1.1 ${r.statusCode} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); });
    proxyReq.on('error', () => socket.destroy());
    if (head && head.length) proxyReq.write(head);
    return proxyReq.end();
  }
  if (!identity(req)||!sameOrigin(req)) {
    // Deliberately NO WWW-Authenticate here: a challenge on a WebSocket
    // handshake is what made the browser re-prompt on every reconnect.
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const id=sessionId(cookieValue(req.headers.cookie,COOKIE));let sockets=sessionSockets.get(id);if(!sockets)sessionSockets.set(id,sockets=new Set());sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);if(!sockets.size)sessionSockets.delete(id);});
  socket.on('error', () => socket.destroy());
  const proxyReq = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: {...stripAuth(req.headers),'x-seek-proxy-release':PROXY_RELEASE},
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
  console.log(`dsh auth proxy listening on http://${LISTEN_HOST}:${server.address().port} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
