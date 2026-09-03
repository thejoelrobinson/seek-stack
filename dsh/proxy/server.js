// HTTP Basic Auth reverse proxy in front of the DeepSeek Harness web UI.
// cloudflared -> 127.0.0.1:18799 (this) -> 127.0.0.1:3080 (dsh web)
// The harness has no auth of its own and Standard mode can run PowerShell,
// so nothing reaches it until auth passes.
//
// Basic auth alone re-prompted every few minutes: browsers do NOT attach
// cached Basic credentials to WebSocket handshakes, so every /api/events.mux
// reconnect drew a 401 + WWW-Authenticate and Chrome popped the login dialog.
// Fix: on first successful Basic auth issue a signed session cookie, which
// browsers DO send on same-origin WS handshakes. Upgrades are never
// challenged, so a failed one can no longer raise a prompt.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LISTEN_PORT = 18799;
const LISTEN_HOST = '127.0.0.1';
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 3080;
const REALM = 'DeepSeek Harness';
const COOKIE = 'dsh_auth';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const USER = process.env.DSH_PROXY_USER;
const PASS = process.env.DSH_PROXY_PASS;
if (!USER || !PASS) {
  console.error('DSH_PROXY_USER and DSH_PROXY_PASS must be set');
  process.exit(1);
}
const expected = Buffer.from('Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64'));

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

function mintToken() {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(exp)}`;
}

function tokenOk(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function basicOk(header) {
  if (!header) return false;
  const got = Buffer.from(String(header));
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieOk(header) {
  if (!header) return false;
  for (const part of String(header).split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return tokenOk(rest.join('='));
  }
  return false;
}

// Cookie first (covers WS), Basic second (the initial sign-in).
const authed = (req) => cookieOk(req.headers.cookie) || basicOk(req.headers.authorization);

function stripAuth(headers) {
  const out = { ...headers };
  delete out.authorization;
  return out;
}

const server = http.createServer((req, res) => {
  if (!authed(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain',
    });
    return res.end('Authentication required\n');
  }

  const extra = {};
  if (!cookieOk(req.headers.cookie)) {
    const https = String(req.headers['x-forwarded-proto'] || '').includes('https');
    extra['Set-Cookie'] =
      `${COOKIE}=${mintToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}` +
      (https ? '; Secure' : '');
  }

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
  if (!authed(req)) {
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
