// Bitwarden-backed login vault for Muse-style sign-in. The unlock key and the
// site index live only in this process's memory; a password is fetched once per
// approved fill, typed into the page by the host, and never returned to the
// agent or written anywhere. The agent has a shell as the same user, so the
// vault must stay locked except while the user has explicitly unlocked it.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const TWO_PART_SUFFIX = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

/** Registrable site for matching (accounts.google.com -> google.com; bbc.co.uk stays whole). */
export function siteOf(host) {
  const h = String(host || '').toLowerCase().split(':')[0].replace(/^www\./, '').replace(/\.$/, '');
  if (!h.includes('.') || /^[\d.]+$/.test(h)) return h;
  const p = h.split('.');
  return p.length > 2 && p[p.length - 1].length === 2 && TWO_PART_SUFFIX.has(p[p.length - 2]) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
export function hostOfUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : 'https://' + uri).host; } catch { return ''; }
}

function defaultRunner(script) {
  // `input` goes to stdin so secrets never appear in the process command line.
  return (args, extraEnv = {}, input) => new Promise((resolve, reject) => {
    const env = { ...process.env, BW_NOINTERACTION: 'true', ...extraEnv };
    if (!extraEnv.BW_SESSION) delete env.BW_SESSION;
    if (!extraEnv.BW_PASSWORD) delete env.BW_PASSWORD;
    const child = execFile(process.execPath, [script, ...args], { env, windowsHide: true, timeout: 90000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split(/\r?\n/)[0] || 'Bitwarden CLI failed.'));
      else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export class Vault {
  constructor({ script, run } = {}) {
    this.script = script || join(process.env.APPDATA || '', 'npm', 'node_modules', '@bitwarden', 'cli', 'build', 'bw.js');
    this.run = run || defaultRunner(this.script);
    this.session = null;
    this.until = 0;
    this.items = [];
    this.state = 'unknown';
    this.lockTimer = null;
  }

  get unlocked() { return !!this.session && Date.now() < this.until; }

  /** missing | unauthenticated | locked | unlocked | error */
  async status({ fresh = false } = {}) {
    if (this.unlocked) return { state: 'unlocked', until: this.until, logins: this.items.length };
    if (this.session) this.lock();
    // Spawning the CLI takes ~2s and this only changes on `bw login`/`logout`.
    if (!fresh && this.checkedAt && Date.now() - this.checkedAt < 30000) return { state: this.state };
    this.checkedAt = Date.now();
    try { this.state = JSON.parse(await this.run(['status'])).status || 'error'; }
    catch (e) { this.state = /Cannot find module|ENOENT/i.test(e.message) ? 'missing' : 'error'; }
    if (this.state === 'unlocked') this.state = 'locked'; // unlocked elsewhere, but this process holds no key
    return { state: this.state };
  }

  async unlock(password, minutes = 60) {
    if (typeof password !== 'string' || !password) throw new Error('Enter your Bitwarden master password.');
    const mins = Math.max(5, Math.min(720, Number(minutes) || 60));
    let key;
    try { key = (await this.run(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { BW_PASSWORD: password })).trim(); }
    catch (e) { throw new Error(/invalid master password/i.test(e.message) ? 'That master password was not accepted.' : e.message); }
    if (!key) throw new Error('Bitwarden did not unlock.');
    await this.run(['sync'], { BW_SESSION: key }).catch(() => {});
    const list = JSON.parse(await this.run(['list', 'items'], { BW_SESSION: key }));
    // Keep only what matching needs; the listing's passwords are dropped here.
    this.items = list.filter(i => i.type === 1 && i.login).map(i => ({
      id: i.id, name: String(i.name || ''), username: String(i.login.username || ''),
      sites: [...new Set((i.login.uris || []).map(u => siteOf(hostOfUri(u.uri))).filter(Boolean))]
    })).filter(i => i.sites.length);
    this.session = key;
    this.until = Date.now() + mins * 60000;
    this.state = 'unlocked';
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), mins * 60000);
    this.lockTimer.unref?.();
    return this.status();
  }

  lock() {
    this.session = null;
    this.until = 0;
    this.items = [];
    clearTimeout(this.lockTimer);
    if (this.state === 'unlocked') this.state = 'locked';
    this.run(['lock']).catch(() => {});
  }

  /** Non-secret matches for a page host, only while unlocked. */
  matches(host) {
    if (!this.unlocked) return [];
    const site = siteOf(host);
    return this.items.filter(i => i.sites.includes(site)).map(({ id, name, username }) => ({ id, name, username }));
  }

  /** Saves a new login for a site (Muse's "Secure Store" card) and indexes it without the password. */
  async saveLogin(host, username, password) {
    if (!this.unlocked) throw new Error('Your vault is locked. Unlock it in Seek on this PC first.');
    const site = siteOf(host);
    if (!site) throw new Error('No site to save a login for.');
    if (typeof password !== 'string' || !password) throw new Error('Enter the password to save.');
    const item = { type: 1, name: site, notes: null, favorite: false, folderId: null, organizationId: null, reprompt: 0,
      login: { username: String(username || ''), password, uris: [{ match: null, uri: `https://${String(host).split(':')[0]}` }] } };
    const encoded = Buffer.from(JSON.stringify(item), 'utf8').toString('base64');
    const created = JSON.parse(await this.run(['create', 'item'], { BW_SESSION: this.session }, encoded));
    const entry = { id: created.id, name: site, username: item.login.username, sites: [site] };
    this.items.push(entry);
    return { id: entry.id, name: entry.name, username: entry.username };
  }

  /** The secret, for one approved fill on a page whose site matches the saved login. */
  async credential(id, host) {
    if (!this.unlocked) throw new Error('Your vault is locked. Unlock it in Seek on this PC.');
    const item = this.items.find(i => i.id === id);
    if (!item || !item.sites.includes(siteOf(host))) throw new Error(`That saved login is not for ${host}.`);
    const full = JSON.parse(await this.run(['get', 'item', id], { BW_SESSION: this.session }));
    return { username: String(full.login?.username || ''), password: String(full.login?.password || '') };
  }
}
