// Rebuilds the "outline only" browser code (the version measured at 0.67x) as a control: a copy of
// the current plugin with the product rows, read_pages product digests and turn-batching guidance
// taken back out. Usage: node make-outline-only.mjs
import {cp, readFile, writeFile, rm} from 'node:fs/promises';
const src = new URL('../../plugins/browser-viewer/', import.meta.url), dst = new URL('./outline-only/', import.meta.url);
await rm(dst, {recursive: true, force: true});
for (const p of ['lib', 'skills', 'package.json']) await cp(new URL(p, src), new URL(p, dst), {recursive: true});
const edit = async (file, pairs) => {
  const url = new URL('lib/' + file, dst); let s = await readFile(url, 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(`${file}: missing ${a.slice(0, 60)}`); s = s.split(a).join(b); }
  await writeFile(url, s);
};
await edit('page-outline.js', [
  ["import {products} from './page-products.js';\n", ''],
  ['  const findProducts = ${products.toString()};', '  const findProducts = null;'],
]);
await edit('fastlane.js', [["const listing = await c.cdp.evaluate(tab, productsScript(1, 40)).catch(() => null);", 'const listing = null;']]);
await edit('agent-tools.js', [[' Search and listing pages come back as product lists (name, price, unit price, availability, rating, link), so to compare several things pass one search URL per item, e.g. walmart.com/search?q=fresh+thyme and walmart.com/search?q=garlic, in a single call.', '']]);
await edit('index.js', [["Each turn costs you seconds, so do more per turn. To compare or look up several things (one search per item on a shopping list, several stores, several articles), call viewer_read_pages once with all the URLs: search pages come back as product lists. When the next steps are certain, call several browser tools in one turn, in order: for example click Add for this item and open the search for the next one; each returns what changed. ", '']]);
console.log('outline-only control written to', dst.pathname);
