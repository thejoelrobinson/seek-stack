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
