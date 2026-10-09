// Prints exactly what the agent sees for a navigate (and one Add-style click is not done: read-only).
// Usage: node --import <register-profile> outline-look.mjs <url> [lib=after|outline]
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const [url = 'https://www.walmart.com/search?q=fresh+thyme', which = 'after'] = process.argv.slice(2);
const {BrowserController, buildTools} = await import(which === 'outline' ? './outline-only/lib/index.js' : '../../plugins/browser-viewer/lib/index.js');
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'look-'))}});
const tools = new Map(buildTools(c).map(t => [t.name, t]));
try {
  await tools.get('viewer_start').execute({url: 'about:blank'}, {agent: {id: 'look'}});
  const v = await tools.get('viewer_navigate').execute({url}, {agent: {id: 'look'}});
  const text = tools.get('viewer_navigate').output.render({}, v)[0].text;
  const r = await fetch('http://127.0.0.1:18798/tokenize', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model: 'qwen3.8-27b', content: text})});
  console.log(`[${which}] ${text.length} chars, ${(await r.json()).tokens.length} tokens\n${text}`);
} finally { await c.stop().catch(() => {}); }
