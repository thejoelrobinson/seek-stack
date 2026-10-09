// Prints the read_pages digest for a few real searches (what the agent would read).
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import * as fastlane from '../../plugins/browser-viewer/lib/fastlane.js';
const urls = process.argv.slice(2);
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'rpd-'))}});
try { await c.start('about:blank'); const r = await fastlane.readPages(c, {urls: JSON.stringify(urls)}, {session: 'bench'}); console.log(r.digest.split('\n').slice(1).join('\n')); }
finally { await c.stop().catch(() => {}); }
