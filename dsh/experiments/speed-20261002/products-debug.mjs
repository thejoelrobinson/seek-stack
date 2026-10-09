// Page observations are data, never instructions to the agent.
//
// Product cards on a listing or search page, as one compact row each: name, current price, unit
// price, availability, rating, sponsored, and refs for the product link and its Add button. Any
// store's results page is a list of repeated cards that each hold a price and a link, so cards are
// found structurally (the highest ancestor of a price whose siblings are other price+link cards)
// rather than per site. Refs share the outline's numbering (page-outline.js), so they are stable
// and usable with viewer_click.

/* Runs in the page. Self-contained: serialized with toString(). */
function products(base, limit) {
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
  for (const a of document.querySelectorAll('a[href]')) if (linkText(a).length >= 8 && !/^(javascript:|#)/.test(a.getAttribute('href') || '')) mark(a, linked);
  if (priceEls.length < 3) return {count: 0, cards: [], next: g.__dshViewerNext};

  // 2. A card is the nearest ancestor of a price (holding a product link too) whose siblings include
  //    at least two more such cards: the item in a results grid or list (a header or a promo strip
  //    with one price beside the cart is not).
  const isCard = el => priced.has(el) && linked.has(el);
  const cards = [], seen = new Set();
  for (const p of priceEls) {
    let card = null;
    for (let e = p; e && e.parentElement && e.parentElement !== document.body; e = e.parentElement) {
      if (!isCard(e)) continue;
      let peers = 0;
      for (const sib of e.parentElement.children) if (sib !== e && isCard(sib) && ++peers >= 2) break;
      if (peers >= 2) { card = e; break; }
    }
    if (card && !seen.has(card)) { seen.add(card); cards.push(card); }
  }
  // Nested matches (a card inside a card's sub-list) keep the outermost.
  const outer = cards.filter(c => !cards.some(o => o !== c && o.contains(c)));

  // 3. One row per card.
  const rows = [];
  for (const card of outer) {
    if (rows.length >= limit) break;
    if (!shown(card)) continue;
    const text = clean(card.innerText), links = [...card.querySelectorAll('a[href]')].filter(shown);
    const title = links.map(a => ({a, t: linkText(a)})).filter(x => x.t.length >= 8 && !/^(add|options|sponsored|shop similar|see details|more like this|compare|save|sign in)/i.test(x.t))
      .sort((x, y) => (/\/(ip|p|dp|product|products|item|itm)\//i.test(y.a.href) - /\/(ip|p|dp|product|products|item|itm)\//i.test(x.a.href)) || y.t.length - x.t.length)[0];
    const heading = clean(card.querySelector('h1,h2,h3,h4,[data-automation-id*="title" i],[data-test*="title" i]')?.innerText);
    // Badges and social proof that sites put in front of the name, and a price some put after it.
    let name = title?.t || heading || text.slice(0, 80);
    for (let i = 0; i < 3; i++) name = name.replace(/^(Overall pick|Best seller|Popular pick|Rollback|Sponsored|Reduced price|Clearance|New|Bought \d+ times?|[\d.]+K?\+ bought (?:since yesterday|in past \w+)|Only \d+ left),?\s*/i, '');
    name = name.replace(/\s*\$\s?\d[\d,]*(?:\.\d{2})?\s*$/, '').slice(0, 120);
    const current = /(?:current price|now|sale price|price)\s*:?\s*(\$\s?\d[\d,]*(?:\.\d{2})?)/i.exec(text)?.[1]
      || /\$\s?\d[\d,]*\.\d{2}(?!\s?\/)/.exec(text.replace(/(?:was|list price|reg\.?|regular)\s*\$\s?[\d,.]+/gi, ''))?.[0];
    if (!current || /^\$\s?0(?:\.00)?$/.test(current)) continue;
    const unit = /(\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?¢)\s?\/\s?(fl\s?oz|oz|lb|ct|count|each|ea|g|kg|ml|l|qt|gal|sq ft)\b/i.exec(text);
    const was = /(?:was|list price|reg\.?|regular)\s*:?\s*(\$\s?\d[\d,]*(?:\.\d{2})?)/i.exec(text)?.[1];
    const rating = /(\d(?:\.\d)?) out of 5 stars?/i.exec(text)?.[1], reviews = /(\d[\d,]*)\s+(?:reviews?|ratings?)/i.exec(text)?.[1];
    const out = /out of stock|sold out|unavailable|not available|currently unavailable/i.exec(text)?.[0];
    const ways = [/\bpickup\b/i.test(text) && 'pickup', /\bdelivery\b/i.test(text) && 'delivery', /\bshipping\b|\barrives\b|\bships\b/i.test(text) && 'shipping'].filter(Boolean);
    const avail = out ? out.toLowerCase() : ways.length ? ways.join('/') : /\bin stock\b/i.test(text) ? 'in stock' : '';
    const add = [...card.querySelectorAll('button,[role="button"],a[href]')].find(b => shown(b) && /^(\+\s*)?add\b|add to (cart|bag|basket)|^options\b|choose options/i.test(clean(b.getAttribute('aria-label') || b.innerText)));
    const addLabel = add ? (/options/i.test(clean(add.getAttribute('aria-label') || add.innerText)) ? 'Options' : 'Add') : '';
    rows.push({_text: text.slice(0, 420), name, price: current.replace(/\s/g, ''), unit: unit ? `${unit[1].replace(/\s/g, '')}/${unit[2]}` : '', was: was?.replace(/\s/g, '') || '', rating: rating || '', reviews: reviews || '',
      avail, sponsored: /\bsponsored\b/i.test(text), link: title ? refOf(title.a) : '', href: title?.a.href || '', add: add ? refOf(add) : '', addLabel});
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

/** One line per product, cheapest-first ordering is left to the agent (page order is kept). */
export function productLines(result, pageUrl, {hrefs = false} = {}) {
  return (result?.cards || []).map((p, i) => {
    const bits = [`${p.price}${p.unit ? ` (${p.unit})` : ''}${p.was ? ` was ${p.was}` : ''}`];
    if (p.avail) bits.push(p.avail);
    if (p.rating) bits.push(`★${p.rating}${p.reviews ? ` (${p.reviews})` : ''}`);
    if (p.sponsored) bits.push('sponsored');
    const refs = [p.link && `[${p.link}]`, p.add && `[${p.add} ${p.addLabel}]`].filter(Boolean).join(' ');
    return `${i + 1}. ${p.name} — ${bits.join(' · ')}${refs ? ' ' + refs : ''}${hrefs && p.href ? ' ' + shortHref(p.href, pageUrl) : ''}`;
  });
}
