// Proxy: computer pairing (one-time code, no session) and the computer link (device key, no cookie).
import {readFile,writeFile} from 'node:fs/promises';
const f=new URL('../../proxy/server.js',import.meta.url);let t=await readFile(f,'utf8');
const rep=(a,b)=>{const n=t.split(a).length-1;if(n!==1)throw new Error(`expected 1 match, found ${n}: ${a.slice(0,80)}`);t=t.replace(a,()=>b);};
rep(`function proxyDav(req, res) {`,`// Paired computers (Seek Desktop) hold a device key: "<id>.<64 hex>", checked against the scrypt
// hashes Work keeps in desktop-devices.json. They never use the browser cookie.
const DESKTOP_FILE = path.join(familyRoot, 'desktop-devices.json');
let desktopCache = { mtime: -1, devices: [] };
const desktopVerified = new Map();
function desktopDevice(req) {
  const m = /^Bearer\\s+([0-9a-f-]{36})\\.([a-f0-9]{64})\\s*$/.exec(String(req.headers.authorization || ''));
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
function proxyDav(req, res) {`);
// Pairing: a new computer only has the one-time code Seek showed; Work checks it (and rate-limits).
rep(`  if (url.pathname === '/work/dav' || url.pathname.startsWith('/work/dav/')) return proxyDav(req, res);`,`  if (url.pathname === '/work/dav' || url.pathname.startsWith('/work/dav/')) return proxyDav(req, res);
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
  }`);
rep(`server.on('upgrade', (req, socket, head) => {
  if (!identity(req)||!sameOrigin(req)) {`,`server.on('upgrade', (req, socket, head) => {
  // A paired computer's link: device key only, never the cookie.
  if (new URL(req.url, 'http://localhost').pathname === '/work/desktop/link') {
    const device = desktopDevice(req);
    if (!device) { securityEvent('desktop.link_refused', req); socket.write('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n'); return socket.destroy(); }
    socket.on('error', () => socket.destroy());
    const headers = { ...req.headers }; delete headers.cookie; delete headers['x-dsh-user']; delete headers['x-seek-dav-device'];
    const proxyReq = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: '/work/desktop/link', headers: { ...headers, 'x-seek-desktop-device': device, 'x-seek-proxy-release': PROXY_RELEASE } });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      proxySocket.on('error', () => { proxySocket.destroy(); socket.destroy(); });
      socket.on('close', () => proxySocket.destroy()); proxySocket.on('close', () => socket.destroy());
      socket.write(\`HTTP/1.1 101 Switching Protocols\\r\\n\${Object.entries(proxyRes.headers).map(([k, v]) => \`\${k}: \${v}\`).join('\\r\\n')}\\r\\n\\r\\n\`);
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      proxySocket.pipe(socket).pipe(proxySocket);
    });
    proxyReq.on('response', r => { socket.write(\`HTTP/1.1 \${r.statusCode} Refused\\r\\nConnection: close\\r\\n\\r\\n\`); socket.destroy(); });
    proxyReq.on('error', () => socket.destroy());
    if (head && head.length) proxyReq.write(head);
    return proxyReq.end();
  }
  if (!identity(req)||!sameOrigin(req)) {`);
await writeFile(f,t);console.log('proxy patched');
