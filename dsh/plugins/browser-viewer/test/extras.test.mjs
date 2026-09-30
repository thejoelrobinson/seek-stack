// Password-in-chat guard, Web Push (VAPID signing, dead subscriptions, outbox) and app icons.
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicKey, verify} from 'node:crypto';
import {looksLikePassword} from '../lib/work-extras.js';
import {Push, iconPng, MANIFEST} from '../lib/work-push.js';

for (const [text, want] of [
  ['my password is hunter2', true], ['Try this password? ?A2r~9&%42y9A||Y[XrybVx', true], ['my pin is 4821', true],
  ['reset my password please', false], ['What is the password policy?', false],
  ['check gift card ZDYCM-903H-MEQU', false], ['email Joel.R@example.com', false], ['open https://Example.com/a?B=1&c=2', false]
]) assert.equal(looksLikePassword(text), want, text);

// Web Push: payload-less requests signed with a VAPID ES256 JWT for the push service origin.
const sent = [];
let status = 201;
const push = await new Push(await mkdtemp(join(tmpdir(), 'dsh-push-')), {subject: 'https://seek.example', fetchImpl: async (url, init) => { sent.push({url, init}); return {ok: status < 300, status}; }, log: {warn() {}}}).init();
await assert.rejects(push.subscribe({endpoint: 'http://insecure.example/x'}), /https/);
await push.subscribe({endpoint: 'https://push.example/abc', keys: {p256dh: 'x', auth: 'y'}});
await push.subscribe({endpoint: 'https://push.example/abc'});
assert.equal(push.count, 1, 'resubscribing does not duplicate');
const item = await push.notify({title: 'Done: order coffee', body: 'Order #1', taskId: 't1', tag: 'done-t1'});
assert.equal(sent.length, 1);
const {url, init} = sent[0];
assert.equal(url, 'https://push.example/abc');
assert.equal(init.method, 'POST');
assert.equal(init.body, undefined, 'no payload leaves this PC');
const m = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
assert.ok(m, 'VAPID authorization header');
const [h, c, s] = m[1].split('.');
const claims = JSON.parse(Buffer.from(c, 'base64url'));
assert.equal(claims.aud, 'https://push.example');
assert.equal(claims.sub, 'https://seek.example');
assert.ok(claims.exp > Date.now() / 1000);
const raw = Buffer.from(m[2], 'base64url');
const publicKey = createPublicKey({key: {kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url')}, format: 'jwk'});
assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), {key: publicKey, dsaEncoding: 'ieee-p1363'}, Buffer.from(s, 'base64url')), 'JWT signature verifies with the advertised key');
assert.deepEqual(push.latest(0).map(i => i.id), [item.id]);
assert.deepEqual(push.latest(item.at), []);
status = 410;
await push.notify({title: 'x'});
assert.equal(push.count, 0, 'expired subscriptions are dropped');

// App shell: manifest scope covers start_url; icons are real PNGs of the right size.
const manifest = JSON.parse(MANIFEST);
assert.ok(manifest.start_url.startsWith(manifest.scope));
for (const size of [192, 512]) {
  const png = iconPng(size);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}
console.log('PASS: password guard, VAPID-signed payload-less push, dead-subscription cleanup, outbox, manifest and icons.');
