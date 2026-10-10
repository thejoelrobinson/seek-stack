import test from 'node:test';
import assert from 'node:assert/strict';
import { md, inline, mdPage, CARET } from '../lib/work-markdown.js';

// inline formatting
assert.equal(inline('**bold** and *it* and _it_ and ~~gone~~'), '<strong>bold</strong> and <em>it</em> and <em>it</em> and <del>gone</del>');
assert.equal(inline('a *b* c'), 'a <em>b</em> c');
assert.equal(inline('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
assert.equal(inline('run `npm *install*` now'), 'run <code>npm *install*</code> now');
assert.equal(inline('[AllTrails](https://www.alltrails.com/trail/us/a_b_c)'), '<a href="https://www.alltrails.com/trail/us/a_b_c" target="_blank" rel="noopener noreferrer">AllTrails</a>');
assert.equal(inline('see https://example.com/x.'), 'see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
assert.equal(inline('(https://example.com/x)'), '(<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>)');
assert.equal(inline('q=1&r=2 https://e.com/?a=1&b=2'), 'q=1&amp;r=2 <a href="https://e.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://e.com/?a=1&amp;b=2</a>');

assert.equal(inline('see [plan.md](plan.md) and [x](./a b)'), 'see plan.md and [x](./a b)');
// nothing the model writes can become live HTML
const evil = md('<img src=x onerror=alert(1)> **<script>alert(1)</script>** [x](javascript:alert(1)) [y](https://e.com/"onmouseover="alert(1))');
assert.ok(!/<img|<script|href="javascript/i.test(evil), evil);
assert.ok(!/"onmouseover/.test(evil), evil);

// blocks
assert.equal(md('# Title\nSome text\nmore text\n\nNext para'), '<h1>Title</h1><p>Some text<br>more text</p><p>Next para</p>');
assert.equal(md('- one\n- two\n  - nested\n- three'), '<ul><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ul>');
assert.equal(md('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
assert.equal(md('1. a\n\nIn between.\n\n2. b'), '<ol><li>a</li></ol><p>In between.</p><ol start="2"><li>b</li></ol>');
assert.equal(md('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
assert.equal(md('- [ ] todo\n- [x] done'), '<ul><li>☐ todo</li><li>☑ done</li></ul>');
assert.equal(md('> quoted **bit**'), '<blockquote><p>quoted <strong>bit</strong></p></blockquote>');
assert.equal(md('```js\nconst a = "<b>";\n```'), '<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>');
assert.equal(md('text\n\n---\n\nmore'), '<p>text</p><hr><p>more</p>');
assert.equal(md('| Trail | Miles |\n|---|---:|\n| Lake Sequoyah | 2 |\n| Devil’s Den | 1.5 |'),
  '<div class="md-table"><table><thead><tr><th>Trail</th><th style="text-align:right">Miles</th></tr></thead><tbody><tr><td>Lake Sequoyah</td><td style="text-align:right">2</td></tr><tr><td>Devil’s Den</td><td style="text-align:right">1.5</td></tr></tbody></table></div>');
assert.equal(md('**1. Lake Sequoyah** — easy'), '<p><strong>1. Lake Sequoyah</strong> — easy</p>');

// typewriter: a caret marker survives rendering, including mid-link and mid-fence
assert.ok(md('Hello **wor' + CARET).includes(CARET));
assert.ok(md('see https://exa' + CARET).includes('href="https://exa"'));
assert.ok(md('```\ncode' + CARET).includes(CARET));

// .md preview page
const page = mdPage('# Plan\n- go', 'plan.md');
assert.ok(page.startsWith('<!doctype html>') && page.includes('<h1>Plan</h1>') && page.includes('<title>plan.md</title>'));

console.log('PASS: markdown inline/blocks/lists/tables/code, escaping, caret, preview page');

test('task-local file links resolve only through the supplied artifact resolver',()=>{
  const files={'report.md':{url:'/work/api/artifact?task=t&id=a',preview:'/work/api/artifact?task=t&id=a&preview=1'},'chart.png':{url:'/work/api/artifact?task=t&id=c'}};
  const resolveFile=path=>files[path.replace(/^\.\//,'')]||null;
  const html=md('Read [the report](./report.md), see ![Chart](chart.png), skip [secret](../x.md).',{resolveFile});
  assert.match(html,/<a class="md-file" href="\/work\/api\/artifact\?task=t&amp;id=a&amp;preview=1"[^>]*>the report<\/a>/);
  assert.match(html,/<img src="\/work\/api\/artifact\?task=t&amp;id=c" alt="Chart"/);
  assert.match(html,/skip secret\./,'unresolved links stay plain text');
  assert.doesNotMatch(md('[the report](report.md)'),/<a /,'no resolver keeps the old plain-text behavior');
  assert.doesNotMatch(md('![a" onerror="x](chart.png)',{resolveFile}),/onerror="/,'alt text stays escaped');
  assert.match(md('![photo](notes.md)',{resolveFile:()=>({url:'/u'})}),/<a class="md-file"/,'non-image files never render as <img>');
});

test('code spans naming a recorded artifact link to it; other code stays code',()=>{
  const resolveFile=path=>path==='weekend/plan.md'?{url:'/u?a=1&b=2',preview:'/p?a=1&b=2'}:null;
  const html=md('Saved `weekend/plan.md` and `npm test` and `other.md`.',{resolveFile});
  assert.match(html,/<a class="md-file" href="\/p\?a=1&amp;b=2"[^>]*><code>weekend\/plan\.md<\/code><\/a>/);
  assert.match(html,/<code>npm test<\/code>/);assert.match(html,/<code>other\.md<\/code>/);assert.equal((html.match(/<a /g)||[]).length,1);
  assert.equal(md('`weekend/plan.md`'),'<p><code>weekend/plan.md</code></p>');
});

test('tables preserve escaped pipes, code, links, alignment and rectangular rows',()=>{
  const html=md('Name | Expression | Price\r\n:--- | :---: | ---:\r\nA\\|B | `x\\|y` | **$10**\r\n[Source](https://example.com/?a=1&b=2) | partial\r\nC | complete | 3 | ignored');
  assert.match(html,/<th style="text-align:left">Name/);
  assert.match(html,/<th style="text-align:center">Expression/);
  assert.match(html,/<td style="text-align:left">A\|B<\/td>/);
  assert.match(html,/<code>x\|y<\/code>/);
  assert.match(html,/<td style="text-align:right"><strong>\$10<\/strong><\/td>/);
  assert.match(html,/href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.equal((html.match(/<td[ >]/g)||[]).length,9);
  assert.doesNotMatch(html,/ignored/);
  assert.match(html,/partial<\/td><td style="text-align:right"><\/td>/);
  assert.match(md('| empty | value |\n|---|---|\n||2|'),/<td><\/td><td>2<\/td>/);
  assert.match(md('A | B\n--- | ---\nOnly A'),/<td>Only A<\/td><td><\/td>/);
});

test('tables detect valid headers, stop at new blocks, and preserve literal code examples',()=>{
  assert.doesNotMatch(md('a | b\n--- | --- | ---\nc | d'),/<table/);
  assert.match(md('| Only |\n| --- |\n| one |'),/<table/);
  assert.doesNotMatch(md('one\\|two\n--- | ---'),/<table/);
  assert.match(md('| a | b |\n|---|---|\n|1|2|\n# Next | heading'),/<\/table><\/div><h1>Next \| heading<\/h1>/);
  assert.doesNotMatch(md('```markdown\n| a | b |\n|---|---|\n|1|2|\n```'),/<table/);
  assert.match(md('````markdown\n```\n| a | b |\n|---|---|\n````'),/<pre><code>```/);
});

test('tables inside quotes/lists render as blocks and keep the artifact resolver',()=>{
  const resolveFile=path=>path==='a.md'?{url:'/work/api/artifact?task=t&id=a'}:null;
  const quote=md('> | File | Value |\n> |---|---|\n> | [Report](a.md) | 2 |',{resolveFile});
  assert.match(quote,/<blockquote><div class="md-table">/);
  assert.match(quote,/<a class="md-file"/);
  const list=md('- Comparison\n\n  | File | Value |\n  |---|---|\n  | [Report](a.md) | 2 |\n\n- Next',{resolveFile});
  assert.match(list,/<li>Comparison<div class="md-table">/);
  assert.match(list,/<a class="md-file"/);
  assert.match(list,/<\/div><\/li><li>Next<\/li>/);
});
