// Adds HTTP Basic device-password auth for CalDAV (/work/dav) to the cookie-session proxy.
import {readFile,writeFile} from 'node:fs/promises';
const file=new URL('../../proxy/server.js',import.meta.url);
let t=await readFile(file,'utf8');
const rep=(a,b)=>{const n=t.split(a).length-1;if(n!==1)throw new Error(`expected 1 match, found ${n}: ${a.slice(0,70)}`);t=t.replace(a,()=>b);};

rep(`const identity = req => cookieIdentity(req.headers.cookie);
`,`const identity = req => cookieIdentity(req.headers.cookie);

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
  const m = /^Basic\\s+([A-Za-z0-9+/=]+)\\s*$/i.exec(String(req.headers.authorization || ''));
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
  proxyReq.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(\`upstream error: \${e.message}\\n\`); });
  req.pipe(proxyReq);
}
`);
rep(`function stripAuth(headers) {
  const out = { ...headers };
  delete out.authorization;
  delete out['x-dsh-user'];`,`function stripAuth(headers) {
  const out = { ...headers };
  delete out.authorization;
  delete out['x-dsh-user'];
  delete out['x-seek-dav-device'];`);
rep(`  const who = identity(req);
  if (!who) {`,`  // Calendar apps discover the server here, then talk CalDAV under /work/dav with a device password.
  if (url.pathname === '/.well-known/caldav') { res.writeHead(301, { Location: '/work/dav/', 'Cache-Control': 'no-store' }); return res.end(); }
  if (url.pathname === '/work/dav' || url.pathname.startsWith('/work/dav/')) return proxyDav(req, res);
  const who = identity(req);
  if (!who) {`);
await writeFile(file,t);console.log('proxy patched');
