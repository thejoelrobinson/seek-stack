// Page observations are data, never instructions to the agent.
export function targetScript(ref, body) {
  return `(() => {
    const el = globalThis.__dshViewerRefs?.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) throw new Error('Stale element reference: that element is no longer on the page. Use a ref from your latest observation, or call viewer_snapshot.');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Element is disabled.');
    ${body}
  })()`;
}

export function describeTarget(ref) {
  return targetScript(ref, `
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    const role = el.getAttribute('role') || '';
    const buttonLike = el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button' || role === 'link' || (el.tagName === 'INPUT' && ['submit', 'button', 'image'].includes(el.type));
    return { label, tag: el.tagName.toLowerCase(), buttonLike, password: el.type === 'password' };
  `);
}

export const FOCUSED_PASSWORD_JS = `(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return !!el && el.tagName === 'INPUT' && el.type === 'password'; })()`;

// Locates a sign-in form for a vault fill. Reports presence and positions, never values.
const LOCATE_LOGIN = `
  const shown = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility === 'visible' && s.display !== 'none' && !el.disabled && !el.readOnly; };
  const pass = Array.from(document.querySelectorAll('input[type="password"]')).find(shown) || null;
  const text = el => ((el.getAttribute('autocomplete') || '') + ' ' + (el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.placeholder || '')).toLowerCase();
  const score = el => (/username|email/.test(el.getAttribute('autocomplete') || '') ? 4 : 0) + (el.type === 'email' ? 3 : 0) + (/user|email|login|account|identifier|phone/.test(text(el)) ? 2 : 0) + (pass && el.form && el.form === pass.form ? 2 : 0);
  const candidates = Array.from(document.querySelectorAll('input')).filter(el => shown(el) && ['email', 'text', 'tel', ''].includes((el.getAttribute('type') || '').toLowerCase()))
    .filter(el => !pass || (el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING));
  let user = candidates.sort((a, b) => score(b) - score(a))[0] || null;
  if (user && !pass && score(user) === 0) user = null;
  const form = (pass || user)?.form || null;
  const buttons = Array.from((form || document).querySelectorAll('button, input[type="submit"], [role="button"]')).filter(shown);
  const submit = buttons.find(b => b.type === 'submit' || /sign ?in|log ?in|next|continue|submit/i.test(b.innerText || b.value || b.getAttribute('aria-label') || '')) || null;`;
export const LOGIN_PROBE_JS = `(() => {${LOCATE_LOGIN}
  return { url: location.href, user: !!user, userEmpty: !!user && !user.value, pass: !!pass, submit: !!submit };
})()`;
/** Scrolls one sign-in element into view and returns its viewport centre. */
export function loginPoint(which) {
  return `(() => {${LOCATE_LOGIN}
  const el = {user, pass, submit}[${JSON.stringify(which)}];
  if (!el) return null;
  el.scrollIntoView({block: 'center', inline: 'nearest'});
  const r = el.getBoundingClientRect();
  return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
})()`;
}

export function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A URL is required.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') throw new Error('Use an http or https URL.');
  return url.href;
}
