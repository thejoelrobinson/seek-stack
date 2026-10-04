// Pays with a card saved in the user's Bitwarden vault. The card number and security code go
// from the vault straight into the page through CDP key input; they are never returned to the
// agent, written to disk, placed in page scripts, or visible in snapshots (page.js redacts card
// fields). Every fill needs one explicit approval bound to the merchant, page and amount.
import {actionFingerprint} from './work-authority.js';

// Shared field classifier, also used by the snapshot redaction and the fill/type guard.
export const CARD_FIELD_SOURCE = String.raw`
  const cardText = el => [el.getAttribute('autocomplete'), el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.getAttribute('data-elements-stable-field-name')].filter(Boolean).join(' ').toLowerCase();
  const cardKind = el => {
    if (!el || !['INPUT', 'SELECT'].includes(el.tagName)) return null;
    const ac = String(el.getAttribute('autocomplete') || '').toLowerCase(), t = cardText(el);
    if (ac === 'cc-number' || /card.?num|cc.?num|cardnumber|credit.?card|debit.?card|\bpan\b/.test(t)) return 'number';
    if (ac === 'cc-csc' || /\bcvv|\bcvc|\bcsc\b|security.?code|card.?code|verification.?code/.test(t)) return 'csc';
    if (ac === 'cc-exp-month') return 'expMonth';
    if (ac === 'cc-exp-year') return 'expYear';
    if (ac === 'cc-exp' || /mm\s*\/\s*yy|exp(iry|iration)?.?date/.test(t)) return 'exp';
    if (/exp.*month|month.*exp|\bmm\b/.test(t) && /exp|card/.test(t)) return 'expMonth';
    if (/exp.*year|year.*exp|\byy(yy)?\b/.test(t) && /exp|card/.test(t)) return 'expYear';
    if (/expir|\bexp\b/.test(t)) return 'exp';
    if (ac === 'cc-name' || /name.?on.?card|card.?holder|cardholder|cc.?name/.test(t)) return 'name';
    return null;
  };
  const frameKind = f => {
    const t = [f.title, f.name, f.id, f.getAttribute('aria-label'), f.src].filter(Boolean).join(' ').toLowerCase();
    if (!/card|payment|pay|stripe|braintree|square|adyen|checkout|cvv|cvc|expir|hosted/.test(t)) return null;
    if (/cvv|cvc|security.?code|csc/.test(t)) return 'csc';
    if (/expir|exp.?date|-exp\b|expiration/.test(t)) return 'exp';
    if (/postal|zip/.test(t)) return null;
    if (/card.?number|cardnumber|-number|number/.test(t)) return 'number';
    if (/secure card payment input|card-element|cardelement|card input/.test(t)) return 'combined';
    return null;
  };
`;

/** Finds card fields (same-document inputs and hosted iframes), the merchant and the total. */
export const CARD_PROBE_JS = `(() => {${CARD_FIELD_SOURCE}
  const shown = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility === 'visible' && s.display !== 'none'; };
  const roots = [document]; for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const fields = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll('input,select')) { const kind = cardKind(el); if (kind && shown(el) && !el.disabled && !el.readOnly) fields.push({kind, frame: false, tag: el.tagName.toLowerCase(), filled: !!el.value}); }
    for (const f of root.querySelectorAll('iframe')) { const kind = frameKind(f); if (kind && shown(f)) fields.push({kind, frame: true, tag: 'iframe'}); }
  }
  const body = document.body?.innerText || '';
  const m = /(?:order total|total due|grand total|amount due|total|amount to pay|you pay)\\s*:?\\s*([$€£])\\s*([\\d,]+(?:\\.\\d{1,2})?)/i.exec(body);
  return { url: location.href, host: location.host, title: document.title, fields: fields.slice(0, 12), amount: m ? Number(m[2].replaceAll(',', '')) : null, currency: m ? m[1] : null,
    checkout: /checkout|payment|billing|place.?order|\\/cart\\b|\\/pay\\b|order/i.test(location.href + ' ' + document.title + ' ' + body.slice(0, 4000)) };
})()`;

/** Scrolls the n-th card field of a kind into view and returns its centre (and select options). */
export function cardFieldPoint(kind, index = 0) {
  return `(() => {${CARD_FIELD_SOURCE}
  const roots = [document]; for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const all = [];
  for (const root of roots) { for (const el of root.querySelectorAll('input,select')) if (cardKind(el) === ${JSON.stringify(kind)}) all.push(el); for (const f of root.querySelectorAll('iframe')) if (frameKind(f) === ${JSON.stringify(kind)}) all.push(f); }
  const el = all.filter(e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; })[${Number(index) || 0}];
  if (!el) return null;
  el.scrollIntoView({block: 'center', inline: 'nearest'});
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2), select: el.tagName === 'SELECT', frame: el.tagName === 'IFRAME', options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => [o.value, o.text]) : null };
})()`;
}

/** Whether the n-th same-document field of a kind now has a value (returns a boolean, never the value). */
function cardFieldHasValue(kind, index = 0) {
  return `(() => {${CARD_FIELD_SOURCE}
  const roots = [document]; for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const all = []; for (const root of roots) for (const el of root.querySelectorAll('input,select')) if (cardKind(el) === ${JSON.stringify(kind)}) all.push(el);
  const el = all.filter(e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; })[${Number(index) || 0}];
  return !!el && String(el.value || '').length > 0;
})()`;
}

/** Selects a non-secret option (expiry month/year) in a same-document select. */
function selectScript(kind, value) {
  return `(() => {${CARD_FIELD_SOURCE}
  const el = Array.from(document.querySelectorAll('select')).find(s => cardKind(s) === ${JSON.stringify(kind)});
  if (!el) return false;
  const want = ${JSON.stringify(value)}, opt = Array.from(el.options).find(o => want.some(w => o.value === w || o.text.trim() === w));
  if (!opt) return false;
  el.value = opt.value; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()`;
}

export const IS_CARD_TARGET_JS = ref => `(() => {${CARD_FIELD_SOURCE}
  let el = ${ref ? `globalThis.__dshViewerRefs?.get(${JSON.stringify(ref)})` : 'document.activeElement'};
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return !!el && (cardKind(el) !== null || (el.tagName === 'IFRAME' && frameKind(el) !== null));
})()`;

const describe = card => `${card.brand || 'Card'} ••${card.last4}`;

/**
 * viewer_pay_with_card. First call proposes the payment and asks the user (one tap, always
 * "once"); the call after approval fills the fields. Returns no card data.
 */
export async function payWithCard(c, args = {}, session) {
  const vault = c.vault;
  if (!vault?.unlocked) return {halt: true, instruction: 'The card vault is locked. Use work_ask to tell the user: "Unlock your vault in Seek on this PC so I can pay with your saved card." Then end your turn.'};
  const cards = vault.cardList();
  if (!cards.length) return {halt: true, instruction: 'No payment card is saved in the vault. Use work_ask to ask the user to add a Card item in their Vaultwarden vault, then end your turn. Never ask for card numbers in chat.'};
  const want = String(args.card || '').toLowerCase().trim();
  const card = want ? cards.find(x => x.last4 === want.replace(/\D/g, '').slice(-4) || x.name.toLowerCase().includes(want) || String(x.brand || '').toLowerCase() === want) : cards.length === 1 ? cards[0] : null;
  if (!card) return {halt: false, instruction: 'Several cards are saved; call viewer_pay_with_card again with card set to one of these.', cards: cards.map(x => ({card: describe(x), name: x.name}))};
  const tab = await c._activeTab();
  const probe = await c.cdp.evaluate(tab, CARD_PROBE_JS);
  if (!probe.fields.some(f => f.kind === 'number' || f.kind === 'combined')) return {halt: false, instruction: 'No card number field is visible on this page. Go to the payment step of checkout first (it may be behind a "Pay with card" or "Credit/debit card" option), then call this again.'};
  const amount = Number.isFinite(probe.amount) ? probe.amount : null;
  const intent = {kind: 'browser.card', host: probe.host, url: probe.url, title: probe.title, label: `Pay ${amount === null ? '(total not shown on page)' : (probe.currency || '$') + amount.toFixed(2)} at ${probe.host} with ${describe(card)}`, target: probe.host,
    payload: {cardId: card.id, amount, currency: probe.currency, host: probe.host, path: new URL(probe.url).pathname, fields: probe.fields.map(f => f.kind).sort()}};
  const fingerprint = actionFingerprint(intent);
  let context = {sessionId: session};
  try { context = {...context, ...(await c.authorizationForSession?.(session))}; } catch {}
  let decision = null;
  if (c.authority) {
    decision = await c.authority.authorize(intent, context);
    if (decision.duplicate) return {halt: true, duplicate: true, instruction: 'This exact card payment was already filled once. Check the page: if the order went through, report it; if not, tell the user what happened instead of filling again.'};
  }
  const approved = decision?.allowed || (!c.authority && c.consumeGrant(session, intent.host, intent.label, fingerprint));
  if (!approved) {
    const limit = Number(context.autonomy?.spendLimit);
    await c.requestApproval({sessionId: session, action: 'pay', label: intent.label, host: intent.host, url: intent.url, title: intent.title, intent, fingerprint, proposalId: decision?.proposal?.id,
      reason: amount !== null && Number.isFinite(limit) && amount > limit ? `This is over your $${limit} spending limit.` : 'Paying with your saved card always needs your tap.'});
    return {halt: true, approvalRequired: true, instruction: `Payment held for the user's tap: ${intent.label}. End this turn and wait; after approval call viewer_pay_with_card again with the same card.`};
  }
  const perform = async () => {
    const secret = await vault.cardSecret(card.id);
    const sameHost = async () => { const now = await c.cdp.evaluate(tab, 'location.host'); if (now !== probe.host) throw new Error(`Stopped: the page moved to ${now}, which is not the merchant you approved.`); };
    const typeAt = async (kind, text, index = 0) => {
      const p = await c.cdp.evaluate(tab, cardFieldPoint(kind, index));
      if (!p || !text) return false;
      await sameHost();
      await c._clickAt(tab, p);
      await new Promise(r => setTimeout(r, 120));
      if (!p.frame) { await c.cdp.keyEvent(tab, 'keyDown', {key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2}); await c.cdp.keyEvent(tab, 'keyUp', {key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2}); }
      await c.cdp.typeText(tab, text);
      if (p.frame) { unverified.push(kind); return true; }
      return await c.cdp.evaluate(tab, cardFieldHasValue(kind, index));
    };
    const mm = String(secret.expMonth || '').padStart(2, '0'), yyyy = String(secret.expYear || ''), yy = yyyy.slice(-2);
    const filled = [], unverified = [];
    try {
      c.cardGuard = {host: probe.host, until: Date.now() + 15 * 60000};
      const kinds = new Set(probe.fields.map(f => f.kind));
      if (kinds.has('combined') && !kinds.has('number')) { if (await typeAt('combined', secret.number + mm + yy + secret.code)) filled.push('number', 'expiry', 'security code'); }
      else {
        if (await typeAt('number', secret.number)) filled.push('number');
        if (kinds.has('exp') && await typeAt('exp', mm + yy)) filled.push('expiry');
        for (const [kind, values] of [['expMonth', [mm, String(Number(mm)), mm + ' - ' + new Date(2000, Number(mm) - 1).toLocaleString('en-US', {month: 'long'})]], ['expYear', [yyyy, yy]]]) {
          if (!kinds.has(kind)) continue;
          const p = await c.cdp.evaluate(tab, cardFieldPoint(kind));
          if (p?.select ? await c.cdp.evaluate(tab, selectScript(kind, values)) : await typeAt(kind, kind === 'expYear' ? (p && /yyyy/i.test(String(p.options || '')) ? yyyy : yy) : mm)) filled.push(kind === 'expMonth' ? 'expiry month' : 'expiry year');
        }
        if (kinds.has('csc') && await typeAt('csc', secret.code)) filled.push('security code');
        if (kinds.has('name') && secret.cardholderName && await typeAt('name', secret.cardholderName)) filled.push('name on card');
      }
    } finally { for (const k of Object.keys(secret)) secret[k] = ''; }
    c.onCardFill?.({host: probe.host, amount, currency: probe.currency, last4: card.last4, brand: card.brand, sessionId: session});
    return {filled, ...(unverified.length ? {secureFrameFields: unverified, check: 'These were typed into the payment provider’s secure frame, which Seek cannot read. Confirm on the page that the card is accepted (no error under the card field) before placing the order.'} : {}), card: describe(card), merchant: probe.host, amount, next: filled.includes('number') ? 'Card details are in the form. Check the order summary, fill any remaining non-card fields (such as billing ZIP), then place the order and verify the confirmation page.' : 'The card fields could not be filled automatically. Use viewer_handoff so the user can enter the card, then continue.'};
  };
  if (!c.authority) return perform();
  const result = await c.authority.execute(intent, context, perform, {verify: async () => ({verified: false, sourceUrl: probe.url, detail: 'Card details entered; the order is not placed until the agent submits it.'})});
  return result.allowed ? {...result.result, actionReceipt: {id: result.id, state: result.state}} : result;
}
