// Page observations are data, never instructions to the agent.
//
// Product cards on a listing or search page, as one compact row each: name, current price, unit
// price, availability, rating, sponsored, and refs for the product link and its Add button. Any
// store's results page is a list of repeated cards that each hold a price and a link, so cards are
// found structurally (the highest ancestor of a price whose siblings are other price+link cards)
// rather than per site. Refs share the outline's numbering (page-outline.js), so they are stable
// and usable with viewer_click.

/* Runs in the page. Self-contained: serialized with toString(). inPage: also return each card's
   element and controls (for the outline, which runs in the same evaluation). */
export function products(base, limit, inPage = false) {
  const g = globalThis;
  g.__dshViewerDoc ||= Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  if (!(g.__dshViewerRefs instanceof Map) || !(g.__dshViewerIds instanceof WeakMap)) { g.__dshViewerRefs = new Map(); g.__dshViewerIds = new WeakMap(); }
  const refs = g.__dshViewerRefs, ids = g.__dshViewerIds;
  g.__dshViewerNext = Math.max(g.__dshViewerNext || 1, base || 1);
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const PRICE = /(?:^|[^\w])(?:\$|USD\s?)\s?\d[\d,]*(?:\.\d{2})?|\d+\.\d{2}\s?(?:\$|USD)/;
  const shown = el => { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && el.checkVisibility?.({visibilityProperty: true}) !== false; };
  const refOf = el => { let id = ids.get(el); if (!id) { id = 'e' + g.__dshViewerNext++; ids.set(el, id); } refs.set(id, el); return id; };
  const linkText = a => clean(a.getAttribute('aria-label') || a.innerText || a.title || a.querySelector('img[alt]')?.getAttribute('alt') || '');

  // 1. Elements that show a price, and elements that hold a product link.
  if (!document.body) return {count: 0, cards: [], next: g.__dshViewerNext};
  const priced = new Set(), linked = new Set(), mark = (el, set) => { for (let e = el; e && e !== document.body; e = e.parentElement) { if (set.has(e)) break; set.add(e); } };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const priceEls = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) || !PRICE.test(n.nodeValue)) continue;
    priceEls.push(p); mark(p, priced);
  }
  // Prices drawn in pieces ("$", "1", "92" in separate spans) have no "$1.92" text anywhere: read
  // them from the pieces. A struck-through price is the old one.
  const struck = el => !!el.closest('s,del,strike') || /line-through/.test(getComputedStyle(el).textDecorationLine);
  const pieces = new Map();
  for (const el of document.body.querySelectorAll('span,div,p,strong,b,ins,data')) {
    if (el.children.length < 1 || el.children.length > 4) continue;
    const all = el.textContent.replace(/^\s*(?:now|current price|sale price|price)\s*:?\s*/i, '');
    if (all.length > 14 || !/^\s*\$/.test(all)) continue;
    const parts = [...el.childNodes].map(n => clean(n.textContent)).filter(Boolean);
    if (parts.length < 2) continue;
    const head = parts.slice(0, -1).join('').replace(/^(?:now|current price|sale price|price)\s*:?\s*/i, ''), cents = parts.at(-1).replace(/^\./, '');
    if (!/^\$\d{1,5}\.?$/.test(head) || !/^\d{2}$/.test(cents) || struck(el)) continue;
    pieces.set(el, head.replace(/\.$/, '') + '.' + cents);
    priceEls.push(el); mark(el, priced);
  }
  for (const a of document.querySelectorAll('a[href]')) if (linkText(a).length >= 8 && !/^(javascript:|#)/.test(a.getAttribute('href') || '')) mark(a, linked);
  if (priceEls.length < 3) return {count: 0, cards: [], next: g.__dshViewerNext};

  // 2. A card is the nearest ancestor of a price (holding a product link too) whose siblings include
  //    at least two more such cards: the item in a results grid or list (a header or a promo strip
  //    with one price beside the cart is not). A result alone in its section ("Results for X (1)")
  //    has no such siblings, so a card is also one that carries a product id attribute, or is built
  //    like the cards found in the lists.
  const isCard = el => priced.has(el) && linked.has(el);
  const ID_ATTR = /^(data-(item-?id|product-?id|sku(-id)?|asin|pid|upc)|itemid)$/i;
  const marked = el => [...el.attributes].some(a => ID_ATTR.test(a.name) && a.value) || /schema\.org\/Product/i.test(el.getAttribute('itemtype') || '');
  const shape = el => el.tagName + '|' + el.className;
  const cards = [], seen = new Set(), add = c => { if (c && !seen.has(c)) { seen.add(c); cards.push(c); } };
  const unplaced = [];
  for (const p of priceEls) {
    let card = null;
    for (let e = p; e && e.parentElement && e.parentElement !== document.body; e = e.parentElement) {
      if (!isCard(e)) continue;
      if (marked(e)) { card = e; break; }
      let peers = 0;
      for (const sib of e.parentElement.children) if (sib !== e && isCard(sib) && ++peers >= 2) break;
      if (peers >= 2) { card = e; break; }
    }
    if (card) add(card); else unplaced.push(p);
  }
  const shapes = new Set(cards.map(shape).filter(s => !/\|$/.test(s)));
  for (const p of unplaced) for (let e = p; e && e !== document.body; e = e.parentElement) if (isCard(e) && shapes.has(shape(e))) { add(e); break; }
  // Nested matches (a card inside a card's sub-list) keep the outermost.
  const outer = cards.filter(c => !cards.some(o => o !== c && o.contains(c)));

  // 3. One row per card.
  const rows = [], listed = new Set();
  for (const card of outer) {
    if (rows.length >= limit) break;
    if (!shown(card)) continue;
    const text = clean(card.innerText), links = [...card.querySelectorAll('a[href]')].filter(shown);
    // The title is the product link whose own visible text names it; an image link's description
    // (aria-label or alt) is only a fallback.
    const PRODUCT_URL = /\/(ip|p|dp|product|products|item|itm|sku)\//i;
    const title = links.map(a => { const seen = clean(a.innerText), t = seen.length >= 8 ? seen : linkText(a); return {a, t, score: (seen.length >= 8 && seen.length <= 150 && !PRICE.test(seen) ? 4 : 0) + (a.closest('h1,h2,h3,h4,[data-automation-id*="title" i],[data-test*="title" i],[class*="title" i]') ? 2 : 0) + (PRODUCT_URL.test(a.href) ? 1 : 0)}; })
      .filter(x => x.t.length >= 8 && x.t.length <= 220 && !/^(add|options|sponsored|shop similar|see details|more like this|compare|save|sign in)/i.test(x.t))
      .sort((x, y) => y.score - x.score || Math.min(y.t.length, 150) - Math.min(x.t.length, 150))[0];
    const heading = clean(card.querySelector('h1,h2,h3,h4,[data-automation-id*="title" i],[data-test*="title" i]')?.innerText);
    // Badges and social proof that sites put in front of the name, and a price some put after it.
    let name = (title?.score >= 4 ? title.t : heading || title?.t) || text.slice(0, 80);
    for (let i = 0; i < 3; i++) name = name.replace(/^(Overall pick|Best seller|Popular pick|Rollback|Sponsored|Reduced price|Clearance|New|Bought \d+ times?|[\d.]+K?\+ bought (?:since yesterday|in past \w+)|Only \d+ left),?\s*/i, '');
    name = name.replace(/\s*(?:\$\s?\d[\d,]*(?:\.\d{2})?|Sponsored)\s*$/i, '').slice(0, 120);
    const drawn = [...pieces.keys()].find(el => card.contains(el));
    const labelled = /(?:current price|now|sale price|price)\s*:?\s*\$\s?(\d[\d,]*)(?:\.(\d{2})|\s+(\d{2})(?!\d))?/i.exec(text);
    const current = (drawn && pieces.get(drawn)) || (labelled && '$' + labelled[1] + ((labelled[2] || labelled[3]) ? '.' + (labelled[2] || labelled[3]) : ''))
      || /\$\s?\d[\d,]*\.\d{2}(?!\s?\/)/.exec(text.replace(/(?:was|list price|reg\.?|regular)\s*\$\s?[\d,.]+/gi, ''))?.[0];
    if (!current || /^\$\s?0(?:\.00)?$/.test(current)) continue;
    // The same product shown twice (a sponsored strip and the results). Ad links all share one
    // redirect path, so identity is the name and price, not the URL. The outline still shows the
    // repeat as a row; lists for the agent drop it.
    const key = name.toLowerCase() + '|' + current.replace(/\s/g, ''), dup = listed.has(key);
    listed.add(key);
    const unit = /(\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?¢)\s?\/\s?(fluid ounce|fl\.?\s?oz|ounce|oz|pound|lb|ct|count|each|ea|g|kg|ml|l|qt|gal|sq ft)\b/i.exec(text);
    const was = /(?:was|list price|reg\.?|regular)\s*:?\s*(\$\s?\d[\d,]*(?:\.\d{2})?)/i.exec(text)?.[1];
    const stars = /(?<![\d.])(\d(?:\.\d+)?)\s*out of 5\b/i.exec(text), rating = stars ? String(Math.round(Number(stars[1]) * 10) / 10) : '';
    const reviews = /(\d[\d,]*)\s+(?:reviews?|ratings?)\b/i.exec(text)?.[1] || /out of 5 stars?[^()]{0,40}\((\d[\d,]*)\)/i.exec(text)?.[1];
    const low = /\bonly \d+ left\b/i.exec(text)?.[0];
    // "Shipping not available" on fresh produce is about one way of getting it, not the item.
    const out = /(?<!(?:shipping|delivery|pickup|ship|in-store)[\s:,-]{0,12})(?:out of stock|sold out|unavailable|not available|currently unavailable)(?![\s:,-]{0,6}(?:for|to) (?:shipping|delivery|pickup|ship))/i.exec(text)?.[0];
    const ways = [/\bpickup\b/i.test(text) && 'pickup', /\bdelivery\b/i.test(text) && 'delivery', /\bshipping\b|\barrives\b|\bships\b/i.test(text) && 'shipping'].filter(Boolean);
    const avail = out ? out.toLowerCase() : [ways.length ? ways.join('/') : /\bin stock\b/i.test(text) ? 'in stock' : '', low ? low.toLowerCase() : ''].filter(Boolean).join(', ');
    const buttons = [...card.querySelectorAll('button,[role="button"],a[href]')].filter(shown), label = b => clean(b.getAttribute('aria-label') || b.innerText);
    const add = buttons.find(b => /^(\+\s*)?add\b|add to (cart|bag|basket)|^options\b|choose options/i.test(label(b)) && !/add (one|1)\b/i.test(label(b)));
    const addLabel = add ? (/options/i.test(label(add)) ? 'Options' : 'Add') : '';
    // Already in the cart: a quantity stepper replaces the Add button.
    const less = buttons.find(b => /decrease|remove one|subtract|minus|^[−-]$/i.test(label(b))), more = buttons.find(b => /increase|add one|plus|^\+$/i.test(label(b)));
    const qty = less && more ? (/(?:current quantity|quantity|qty)\D{0,12}(\d+)/i.exec(text)?.[1] || /\b(\d{1,2})\b/.exec(clean(less.parentElement?.innerText))?.[1] || '') : '';
    const row = {name, price: current.replace(/\s/g, ''), unit: unit ? `${unit[1].replace(/\s/g, '')}/${unit[2]}` : '', was: was?.replace(/\s/g, '') || '', rating: rating || '', reviews: reviews || '',
      avail, sponsored: /\bsponsored\b/i.test(text), link: title ? refOf(title.a) : '', href: title?.a.href || '', add: add ? refOf(add) : '', addLabel,
      inCart: less && more ? qty || '?' : '', less: less && more ? refOf(less) : '', more: less && more ? refOf(more) : '', dup};
    // The same row as one outline line, so a listing reads as a list of products.
    const bits = [`${row.price}${row.unit ? ` (${row.unit})` : ''}${row.was ? ` was ${row.was}` : ''}`];
    if (row.avail) bits.push(row.avail);
    if (row.rating) bits.push(`★${row.rating}${row.reviews ? ` (${row.reviews})` : ''}`);
    if (row.sponsored) bits.push('sponsored');
    row.line = `${row.link ? `[${row.link}] ` : ''}${row.name} — ${bits.join(' · ')}${row.add ? ` [${row.add} ${row.addLabel}]` : ''}${row.inCart ? ` in cart: ${row.inCart} [${row.less} −] [${row.more} +]` : ''}`;
    if (inPage) Object.assign(row, {el: card, controls: [title?.a, add, less && more ? less : null, less && more ? more : null].filter(Boolean)});
    rows.push(row);
  }
  return {count: outer.length, cards: rows, next: g.__dshViewerNext};
}

/** In-page script: product rows on the active page (refs numbered from base). */
export const productsScript = (base = 1, limit = 40) => `(${products.toString()})(${JSON.stringify(Number(base) || 1)}, ${JSON.stringify(Math.max(1, Math.min(80, Number(limit) || 40)))})`;

/** Short form of a product URL for the model: same-site path without tracking query, or empty. */
export function shortHref(href, pageUrl) {
  try {
    const u = new URL(href), page = new URL(pageUrl);
    const real = u.searchParams.get('rd') || u.searchParams.get('url');   // ad redirect wrappers carry the product URL
    const target = real && /^https?:/.test(real) ? new URL(real) : u;
    return target.host === page.host ? target.pathname : target.host + target.pathname;
  } catch { return ''; }
}

// Search words from a results page's own URL (?q=, ?k=, ?searchTerm=, ...).
const SEARCH_KEYS = ['q', 'k', 'query', 'searchTerm', 'st', '_nkw', 'search', 'keyword', 'keywords', 'text', 'term'];
const FILLER = new Set(['and', 'or', 'the', 'for', 'with', 'of', 'oz', 'fl', 'lb', 'ct', 'pack']);
export function searchTerms(url) {
  try {
    const u = new URL(url);
    for (const k of SEARCH_KEYS) { const v = u.searchParams.get(k); if (v) return v.toLowerCase().split(/[^a-z0-9.]+/).filter(t => t.length > 1 && !FILLER.has(t)); }
  } catch {}
  return [];
}

/**
 * Products that name more of the search words (and focus words) first, page order otherwise:
 * stores list bags, sauces and sponsored items ahead of the plain match ("Fresh Whole Yellow
 * Onion, Each" came 12th for "yellow onion"), and an agent reading a short list must see it.
 */
// Focus words that describe what every row already shows, not which product is wanted.
const ATTRIBUTE = /^(prices?|cost|cheap(est)?|available|availability|in stock|out of stock|stock|sizes?|units?|unit price|oz|fl oz|lb|lbs|ct|count|pickup|delivery|shipping|add to cart|cart|ratings?|reviews?|brands?|names?)$/;
export function rankProducts(cards, terms = [], focus = []) {
  focus = focus.map(f => f.trim().toLowerCase()).filter(f => f && !ATTRIBUTE.test(f));
  const stem = t => t.replace(/(?:es|s)$/, '');
  // Whole words ("can" must not match "Jamaican"); a multi-word phrase matches as written.
  const has = (name, words, t) => /\s/.test(t) ? name.includes(t) : words.has(stem(t));
  const score = c => {
    const name = String(c.name || '').toLowerCase(), words = new Set(name.split(/[^a-z0-9.]+/).map(stem));
    return terms.filter(t => has(name, words, t)).length * 2 + focus.filter(f => has(name, words, f)).length * 3;
  };
  return cards.map((c, i) => ({c, i, s: score(c)})).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.c);
}

/**
 * One line per product in page order (cheapest-first is the agent's call: relevance matters too).
 * refs: false for pages read in background tabs, whose refs cannot be clicked; hrefs adds the
 * product's short URL so it can be opened later.
 */
export function productLines(result, pageUrl, {hrefs = false, refs = true} = {}) {
  return (result?.cards || []).filter(p => !p.dup).map((p, i) => {
    const bits = [`${p.price}${p.unit ? ` (${p.unit})` : ''}${p.was ? ` was ${p.was}` : ''}`];
    if (p.avail) bits.push(p.avail);
    if (p.rating) bits.push(`★${p.rating}${p.reviews ? ` (${p.reviews})` : ''}`);
    if (p.sponsored) bits.push('sponsored');
    const marks = refs ? [p.link && `[${p.link}]`, p.add && `[${p.add} ${p.addLabel}]`].filter(Boolean).join(' ') : '';
    return `${i + 1}. ${p.name} — ${bits.join(' · ')}${marks ? ' ' + marks : ''}${hrefs && p.href ? ' ' + shortHref(p.href, pageUrl) : ''}`;
  });
}
