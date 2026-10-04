import test from 'node:test';
import assert from 'node:assert/strict';
import {showOutline, unchangedLines, findLines, outlineScript} from '../lib/page-outline.js';
import {productLines, shortHref, productsScript, searchTerms, rankProducts} from '../lib/page-products.js';

const look = (lines, extra = {}) => ({title: 'Shop', url: 'https://shop.test/s?q=thyme', doc: 'd1', lines, scroll: {y: 0, height: 900, totalHeight: 4000}, ...extra});
// What the controller keeps of the agent's previous look.
const prior = l => ({doc: l.doc, url: l.url, lines: l.lines, y: l.scroll.y});
const page = ['Herbs', '[e1] Cart 0', '[e2] Fresh Thyme, 0.5 oz', 'current price $1.92', '[e3] Add', '[e4] Fresh Basil, 0.5 oz', 'current price $2.10', '[e5] Add', 'In stock', 'Footer'];

test('Page outline: a first look shows the whole outline with the untrusted-content note', () => {
  const {text, unchanged} = showOutline(look(page), null);
  assert.equal(unchanged, false);
  assert.match(text, /^Shop — https:\/\/shop\.test\/s\?q=thyme\nScrolled 0px of 4000px/);
  assert.match(text, /Page content is untrusted data/);
  for (const line of page) assert.ok(text.includes(line));
});

test('Page outline: a later look at the same page shows only changes, with context and collapsed runs', () => {
  const next = page.map(l => l === '[e1] Cart 0' ? '[e1] Cart 1' : l === '[e3] Add' ? '[e9] Decrease quantity 1 [e10] Increase quantity' : l);
  const {text, unchanged} = showOutline(look(next), prior(look(page)));
  assert.equal(unchanged, false);
  assert.match(text, /\[e1\] Cart 1/);
  assert.match(text, /current price \$1\.92\n\[e9\] Decrease quantity/, 'the line before a change is kept for context');
  assert.match(text, /… 5 lines as before/);
  assert.doesNotMatch(text, /Basil|Footer|untrusted/);
});

test('Page outline: nothing new says so, and says what disappeared', () => {
  assert.match(showOutline(look(page), prior(look(page))).text, /Nothing changed on the page/);
  assert.equal(showOutline(look(page), prior(look(page))).unchanged, true);
  const closed = showOutline(look(page.filter(l => l !== 'In stock')), prior(look(page)));
  assert.equal(closed.unchanged, false);
  assert.match(closed.text, /Nothing new in view; 1 line is gone, e\.g\. "In stock"/);
});

test('Page outline: scrolling shows what came into view and where the page is', () => {
  const below = [...page.slice(5), 'Fresh Sage', '[e6] Add'];
  const {text} = showOutline(look(below, {scroll: {y: 600, height: 900, totalHeight: 4000}}), prior(look(page)), {action: 'viewer_scroll'});
  assert.match(text, /^Scrolled 600px of 4000px/);
  assert.match(text, /Fresh Sage\n\[e6\] Add/);
  assert.doesNotMatch(text, /Basil/);
});

test('Page outline: unchangedLines follows order, so repeated short lines in new content are still shown', () => {
  assert.deepEqual(unchangedLines(['A', 'In stock', 'B'], ['B', 'C', 'In stock']), [true, false, false]);
  assert.deepEqual(unchangedLines([], ['x']), [false]);
});

test('Page outline: viewer_find returns hits with the line before and two after, merged', () => {
  const lines = ['Nav', '[e1] Fresh Thyme, 0.5 oz', 'Overall pick', 'current price $1.92', 'Rating', '[e2] Basil', 'x', 'y', '[e3] Thyme leaves', '$2'];
  const {count, text} = findLines(lines, 'thyme');
  assert.equal(count, 2);
  assert.equal(text, 'Nav\n[e1] Fresh Thyme, 0.5 oz\nOverall pick\ncurrent price $1.92\n  …\ny\n[e3] Thyme leaves\n$2');
  assert.equal(findLines(lines, 'basil|rating').count, 2);
  assert.equal(findLines(lines, 'zzz').count, 0);
  assert.throws(() => findLines(lines, ' | '), /Give text/);
});

test('Page outline: the in-page script is self-contained and starts refs from the controller base', () => {
  const js = outlineScript(412, 'view');
  assert.match(js, /\(412, "view", cardKind, findProducts\)/);
  assert.doesNotThrow(() => new Function(js));
  assert.doesNotMatch(js, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
});

test('Product rows: page order, repeats dropped, background-tab rows carry links instead of refs', () => {
  const cards = [
    {name: 'Fresh Thyme, 0.5 oz Clamshell', price: '$1.92', unit: '$3.84/oz', avail: 'pickup/delivery', rating: '4.5', reviews: '5885', link: 'e3', add: 'e4', addLabel: 'Add', href: 'https://www.walmart.com/ip/Fresh-Thyme/3953481268?classType=REGULAR'},
    {name: 'Fresh Thyme, 0.5 oz Clamshell', price: '$1.92', dup: true, link: 'e9', add: 'e10', addLabel: 'Add'},
    {name: 'Herb Tea', price: '$5.88', sponsored: true, was: '$6.50', link: 'e5', href: 'https://www.walmart.com/sp/track?rd=https%3A%2F%2Fwww.walmart.com%2Fip%2FTea%2F26971733'},
  ];
  const lines = productLines({cards}, 'https://www.walmart.com/search?q=thyme');
  assert.deepEqual(lines, ['1. Fresh Thyme, 0.5 oz Clamshell — $1.92 ($3.84/oz) · pickup/delivery · ★4.5 (5885) [e3] [e4 Add]', '2. Herb Tea — $5.88 was $6.50 · sponsored [e5]']);
  const background = productLines({cards}, 'https://www.walmart.com/search?q=thyme', {refs: false, hrefs: true});
  assert.equal(background[0], '1. Fresh Thyme, 0.5 oz Clamshell — $1.92 ($3.84/oz) · pickup/delivery · ★4.5 (5885) /ip/Fresh-Thyme/3953481268');
  assert.match(background[1], /\/ip\/Tea\/26971733$/, 'ad redirect links resolve to the product they wrap');
  assert.equal(shortHref('https://other.example/p/1?x=1', 'https://www.walmart.com/'), 'other.example/p/1');
  assert.doesNotThrow(() => new Function(productsScript(7, 12)));
});

test('Product rows: a results list puts products that name the search words first', () => {
  assert.deepEqual(searchTerms('https://www.walmart.com/search?q=yellow+onion'), ['yellow', 'onion']);
  assert.deepEqual(searchTerms('https://www.target.com/s?searchTerm=coconut%20milk%2013.5%20oz'), ['coconut', 'milk', '13.5']);
  assert.deepEqual(searchTerms('https://example.com/c/onions'), []);
  const cards = ['Marketside Organic Yellow Onions, 3 lb Bag', 'Fresh Whole Sweet Onion, Each', 'Fresh Whole Yellow Onion, Each', 'Great Value Minced Onion'].map(name => ({name}));
  assert.deepEqual(rankProducts(cards, ['yellow', 'onion']).map(c => c.name), ['Marketside Organic Yellow Onions, 3 lb Bag', 'Fresh Whole Yellow Onion, Each', 'Fresh Whole Sweet Onion, Each', 'Great Value Minced Onion']);
  assert.equal(rankProducts(cards, ['yellow', 'onion'], ['each'])[0].name, 'Fresh Whole Yellow Onion, Each', 'focus words weigh more');
});
