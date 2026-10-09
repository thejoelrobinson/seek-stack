// Confirms each arm's live browser instructions can be read the way agent-bench reads them.
import {readFile} from 'node:fs/promises';
for (const p of ['./before/lib/index.js', './outline-only/lib/index.js', '../../plugins/browser-viewer/lib/index.js']) {
  const s = await readFile(new URL(p, import.meta.url), 'utf8');
  const m = /name: 'tool:browser-viewer',\s*order: \d+,\s*text: '((?:[^'\\]|\\.)*)'/.exec(s);
  const text = m ? m[1].replace(/\\'/g, "'") : '';
  console.log(p.padEnd(44), text ? `${text.length} chars | outline note: ${/first look at a page/.test(text)} | batching: ${/do more per turn/.test(text)}` : 'NOT FOUND');
}
