// Installable Work app (manifest, icons, service worker) and Web Push.
// Pushes are sent WITHOUT a payload: the push service only learns "something
// happened"; the service worker then fetches the details from Seek itself.
import { generateKeyPairSync, createPrivateKey, sign, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const b64url = value => Buffer.from(value).toString('base64url');

export class Push {
  constructor(root, { subject = 'mailto:seek@localhost', fetchImpl = globalThis.fetch, log = console } = {}) {
    this.file = join(root, 'push.json');
    this.subject = subject;
    this.fetch = fetchImpl;
    this.log = log;
    this.data = null;
  }
  async init() {
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!this.data?.vapid) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.data = { vapid: { privateJwk: privateKey.export({ format: 'jwk' }), publicJwk: publicKey.export({ format: 'jwk' }) }, subs: [], outbox: [] };
      await this.save();
    }
    this.key = createPrivateKey({ key: this.data.vapid.privateJwk, format: 'jwk' });
    const { x, y } = this.data.vapid.publicJwk;
    this.publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]));
    return this;
  }
  async save() {
    await writeFile(this.file + '.tmp', JSON.stringify(this.data, null, 2));
    await rename(this.file + '.tmp', this.file);
  }
  get count() { return this.data.subs.length; }
  async subscribe(sub) {
    let endpoint;
    try { endpoint = new URL(sub?.endpoint); } catch { throw new Error('Invalid push subscription.'); }
    if (endpoint.protocol !== 'https:') throw new Error('Push endpoints must use https.');
    this.data.subs = this.data.subs.filter(s => s.endpoint !== sub.endpoint);
    this.data.subs.push({ endpoint: sub.endpoint, at: Date.now() });
    await this.save();
  }
  async unsubscribe(endpoint) {
    this.data.subs = this.data.subs.filter(s => s.endpoint !== endpoint);
    await this.save();
  }
  /** RFC 8292 VAPID header: an ES256 JWT for the push service's origin. */
  vapidHeader(endpoint) {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject }));
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${this.publicKey}`;
  }
  async notify({ title, body = '', taskId = null, tag = null }) {
    const item = { id: randomUUID(), title: String(title).slice(0, 120), body: String(body).slice(0, 240), taskId, tag, at: Date.now() };
    this.data.outbox = [...this.data.outbox, item].slice(-30);
    await this.save();
    const gone = [];
    await Promise.all(this.data.subs.map(async s => {
      try {
        const res = await this.fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', Authorization: this.vapidHeader(s.endpoint), 'Content-Length': '0' } });
        if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
        else if (!res.ok) this.log.warn?.(`push service returned ${res.status}`);
      } catch (e) { this.log.warn?.('push failed: ' + e.message); }
    }));
    if (gone.length) { this.data.subs = this.data.subs.filter(s => !gone.includes(s.endpoint)); await this.save(); }
    return item;
  }
  latest(since = 0) { return this.data.outbox.filter(i => i.at > since); }
}

// ── app shell ────────────────────────────────────────────────────────────────
export const MANIFEST = JSON.stringify({
  name: 'Seek', short_name: 'Seek', description: 'Your personal agent',
  start_url: '/work/', scope: '/work/', display: 'standalone',
  background_color: '#faf9f6', theme_color: '#74618e',
  icons: [
    { src: '/work/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/work/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});

export const SERVICE_WORKER = `// Seek service worker: shows notifications for payload-less pushes.
const SEEN = '/work/__push_seen';
async function lastSeen() { const c = await caches.open('seek'); const r = await c.match(SEEN); return r ? Number(await r.text()) || 0 : 0; }
async function setSeen(t) { const c = await caches.open('seek'); await c.put(SEEN, new Response(String(t))); }
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('push', e => e.waitUntil((async () => {
  let items = [];
  try {
    const r = await fetch('/work/api/push/latest?since=' + (await lastSeen()), { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) items = (await r.json()).items || [];
  } catch {}
  if (!items.length) return self.registration.showNotification('Seek', { body: 'You have an update.', tag: 'seek-update', icon: '/work/icon-192.png', data: { url: '/work/' } });
  for (const i of items.slice(-3)) {
    await self.registration.showNotification(i.title, { body: i.body, tag: i.tag || i.id, renotify: true, icon: '/work/icon-192.png', badge: '/work/icon-192.png', data: { url: i.taskId ? '/work/?task=' + encodeURIComponent(i.taskId) : '/work/' } });
  }
  await setSeen(Math.max(...items.map(i => i.at)));
})()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/work/';
  e.waitUntil((async () => {
    for (const c of await clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(c.url).pathname.startsWith('/work')) { await c.focus(); return c.navigate(url); }
    }
    return clients.openWindow(url);
  })());
});
`;

/** The Seek orb as a PNG (maskable: the orb sits inside the safe zone). */
export function iconPng(size) {
  const stops = [[0, [254, 246, 223]], [0.27, [228, 217, 255]], [0.48, [182, 163, 221]], [0.69, [121, 99, 180]], [0.94, [182, 202, 221]], [1, [182, 202, 221]]];
  const at = t => { for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i], k = (t - a) / (b - a || 1); return ca.map((v, j) => Math.round(v + (cb[j] - v) * k)); } return stops.at(-1)[1]; };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2, r = size * 0.34, hx = c - r * 0.44, hy = c - r * 0.52;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const d = Math.hypot(x - c, y - c);
      let col = [237, 231, 245];
      if (d <= r) col = at(Math.min(1, Math.hypot(x - hx, y - hy) / (r * 1.45)));
      else if (d <= r + 1) { const k = d - r; const inner = at(Math.min(1, Math.hypot(x - hx, y - hy) / (r * 1.45))); col = inner.map((v, j) => Math.round(v * (1 - k) + [237, 231, 245][j] * k)); }
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2]; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
