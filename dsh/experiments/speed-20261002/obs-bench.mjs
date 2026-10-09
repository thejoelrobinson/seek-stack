// A/B: what the model has to read after each browser step, before vs after the page-outline
// change, on real pages. Same headless Chrome setup and viewport as the live browser (1366x900).
// For each site: navigate, scroll x2, snapshot, text — rendered exactly as the model sees it, then
// counted with the live model's tokenizer (llama-server /tokenize). Also times each tool call.
// Usage: node --import ../../plugins/browser-viewer/test/register-profile.mjs obs-bench.mjs [sites...]
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SITES = process.argv.slice(2).filter(a => a.startsWith('http')).length ? process.argv.slice(2).filter(a => a.startsWith('http')) : [
  'https://www.africanbites.com/jamaican-curry-shrimp/',
  'https://www.allrecipes.com/recipe/16354/easy-meatloaf/',
  'https://www.target.com/s?searchTerm=coconut+milk',
  'https://www.walmart.com/search?q=fresh+thyme',
  'https://en.wikipedia.org/wiki/Jamaican_cuisine',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
];
const STEPS = [['viewer_navigate', url => ({url})], ['viewer_scroll', () => ({direction: 'down', pixels: 600})], ['viewer_scroll', () => ({direction: 'down', pixels: 600})], ['viewer_snapshot', () => ({})], ['viewer_text', () => ({})]];

async function tokens(text) {
  const r = await fetch('http://127.0.0.1:18798/tokenize', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model: 'qwen3.8-27b', content: text})});
  return (await r.json()).tokens.length;
}

async function run(label, lib) {
  const {BrowserController, buildTools} = await import(lib);
  const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {userDataDir: await mkdtemp(join(tmpdir(), 'obs-bench-'))}});
  const tools = new Map(buildTools(c).map(t => [t.name, t])), rows = [], samples = {};
  try {
    await tools.get('viewer_start').execute({url: 'about:blank'}, {agent: {id: 'bench'}});
    for (const url of SITES) {
      const host = new URL(url).host.replace(/^www\./, '');
      for (const [name, args] of STEPS) {
        const t0 = performance.now();
        let text;
        try { const v = await tools.get(name).execute(args(url), {agent: {id: 'bench'}}); text = tools.get(name).output.render({}, v)[0].text; }
        catch (e) { text = 'ERROR ' + e.message; }
        const ms = Math.round(performance.now() - t0);
        rows.push({label, host, step: name, ms, chars: text.length, tokens: await tokens(text)});
        (samples[host] ??= []).push(`### ${name} (${ms} ms)\n${text}`);
      }
    }
  } finally { await c.stop().catch(() => {}); }
  await writeFile(new URL(`obs-samples-${label}.txt`, import.meta.url), Object.entries(samples).map(([h, s]) => `======== ${h}\n${s.join('\n\n')}`).join('\n\n'));
  return rows;
}

const before = await run('before', new URL('./before/lib/index.js', import.meta.url).href);
const after = await run('after', new URL('../../plugins/browser-viewer/lib/index.js', import.meta.url).href);
await writeFile(new URL('obs-bench.json', import.meta.url), JSON.stringify({at: new Date().toISOString(), before, after}, null, 1));
console.log('site'.padEnd(26), 'step'.padEnd(16), 'tokens before → after', '   ms before → after');
const sum = {b: 0, a: 0, bms: 0, ams: 0}, byStep = {};
for (let i = 0; i < before.length; i++) {
  const b = before[i], a = after[i];
  console.log(b.host.slice(0, 25).padEnd(26), b.step.padEnd(16), String(b.tokens).padStart(6), '→', String(a.tokens).padStart(5), `(${Math.round((1 - a.tokens / b.tokens) * 100)}% less)`.padEnd(13), String(b.ms).padStart(6), '→', String(a.ms).padStart(5));
  sum.b += b.tokens; sum.a += a.tokens; sum.bms += b.ms; sum.ams += a.ms;
  const k = byStep[b.step] ??= {b: 0, a: 0, n: 0, bms: 0, ams: 0}; k.b += b.tokens; k.a += a.tokens; k.n++; k.bms += b.ms; k.ams += a.ms;
}
console.log(`\nall steps: ${sum.b} → ${sum.a} tokens (${Math.round((1 - sum.a / sum.b) * 100)}% less); tool time ${sum.bms} → ${sum.ams} ms`);
for (const [k, v] of Object.entries(byStep)) console.log(`  ${k.padEnd(16)} avg ${Math.round(v.b / v.n)} → ${Math.round(v.a / v.n)} tokens, avg ${Math.round(v.bms / v.n)} → ${Math.round(v.ams / v.n)} ms`);
