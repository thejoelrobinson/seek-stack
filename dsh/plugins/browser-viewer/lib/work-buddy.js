import {applyProductPalette} from '/work/theme.js';
// Seek's character: a small plush sprite that acts out what the agent is doing
// (Muse's Alfred is the reference). Placements are plain markup,
// <span class="buddy" data-buddy="hero">, mounted wherever they appear;
// data-task="<id>" follows one task, data-pose="<state>" pins a pose, and
// otherwise a buddy follows the agent as a whole.
//
// Motion is a small physics rig rather than looping keyframes, so it follows the
// principles of animation: the body squashes and stretches with volume kept
// (sx = 1/sy), jumps are ballistic with a crouch of anticipation and a squash on
// landing, and the sprout, arms and face are damped springs that lag, overshoot
// and settle (follow-through / overlapping action). Poses only set spring
// targets, so every change eases in and out. Bézier curves do the shaping: the
// arms are rubber-hose curves that bend behind their motion, the sprout stem
// bends, keys and z's travel curved paths, and
// scripted timing uses CSS-style cubic-bezier easing. CSS swaps the expressions.

import {getModels,modelCharacterState} from '/work/models.js';

export const PALETTES = {
  lavender: { label: 'Lavender', hi: '#fdf8ff', mid: '#cdbcf0', deep: '#8b73c6', cheek: '#ff9dbb', line: '#7560ad' },
  peach: { label: 'Peach', hi: '#fff8f0', mid: '#ffcdb0', deep: '#e98d67', cheek: '#ff8e8e', line: '#c46c4c' },
  mint: { label: 'Mint', hi: '#f4fff9', mid: '#b8ecd2', deep: '#5db58c', cheek: '#ff9fb2', line: '#469a73' },
  sky: { label: 'Sky', hi: '#f4faff', mid: '#bfdfff', deep: '#5d9de2', cheek: '#ffa0bb', line: '#4a83c3' },
  honey: { label: 'Honey', hi: '#fffcee', mid: '#ffe49e', deep: '#e3ad3e', cheek: '#ff9b86', line: '#bd8e27' },
  cream: { label: 'Marshmallow', hi: '#ffffff', mid: '#f1e8dc', deep: '#c8b49c', cheek: '#ffab9e', line: '#a38d74' },
  midnight: { label: 'Midnight', hi: '#dcdaff', mid: '#7a70d4', deep: '#302a74', cheek: '#ff8fc4', line: '#2a2466' }
};
export const ACCESSORIES = { none: 'Nothing', glasses: 'Glasses', shades: 'Sunglasses', headphones: 'Headphones', bow: 'Bow', beanie: 'Beanie' };

const SIZES = { hero: 164, top: 46, panel: 54, studio: 64, inline: 44, mini: 30, face: 18, brand: 36, preview: 140, id: 84 };
const STILL = new Set(['face', 'brand']);
const WORK = new Set(['type', 'browse', 'think']);
const MODEL_WORK = new Set(['tools-away','tools-out','tools-restore','paint','paint-finish']);
const GLOBAL_KINDS = new Set(['hero', 'top', 'panel', 'studio', 'id']);
const PREVIEW_TOUR = [['idle', 'Hanging out'], ['type', 'Working on a task'], ['browse', 'Reading a page'], ['wave', 'Needs you'], ['approve', 'Asking to approve'], ['blind', 'Not peeking while you sign in'], ['celebrate', 'All done!'], ['sleep', 'Dozing off']];
const $$ = s => [...document.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

let uid = 0;
const star = (x, y, r, n) => `<path class="b-star s${n}" d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z"/>`;
const f2 = n => Math.round(n * 100) / 100;

// ── Bézier toolkit ──
// cubicBezier(x1, y1, x2, y2) is the CSS timing function (same solver as browsers):
// Newton steps on x(t), falling back to bisection, then y(t).
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = t => ((ax * t + bx) * t + cx) * t, Y = t => ((ay * t + by) * t + cy) * t, dX = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) { const e = X(t) - x, d = dX(t); if (Math.abs(e) < 1e-5) return Y(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 30 && Math.abs(X(t) - x) > 1e-5; i++) { if (X(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return Y(t);
  };
}
const EASE = {
  out: cubicBezier(.2, .8, .2, 1),          // quick start, long settle
  inOut: cubicBezier(.65, 0, .35, 1),       // slow in, slow out
  in: cubicBezier(.55, .055, .675, .19),    // gathering speed (eyelids shutting)
  open: cubicBezier(.215, .61, .355, 1),    // eyelids lifting
  snap: cubicBezier(.2, 1.35, .35, 1)       // a quick move that overshoots a touch
};
// A point on a cubic Bézier path, for curved motion.
const bezierAt = (a, b, c, d, t) => { const u = 1 - t; return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]; };
const SHOULDER = { l: [26.5, 76], r: [93.5, 76] };
const limbPattern = id => `<pattern id="${id}" patternUnits="userSpaceOnUse" width="120" height="120"><rect width="120" height="120" fill="color-mix(in srgb,var(--b-mid) 35%,white)"/><image href="/work/plush.webp" x="-40" y="-40" width="200" height="200" opacity=".94" style="mix-blend-mode:multiply;filter:grayscale(1) contrast(1.7) brightness(.96)"/></pattern>`;
// Rubber-hose arm: a softly irregular plush sleeve and mitten follow one quadratic Bézier.
function arm(side, u) {
  const [x, y] = SHOULDER[side], hx = x + (side === 'l' ? -4 : 4);
  const d = `M${x} ${y}Q${x} ${y + 9} ${hx} ${y + 16}`;
  return `<g class="b-arm b-arm-${side}" filter="url(#${u}limbFur)"><path class="b-arm-edge" d="${d}"/><path class="b-arm-fill" d="${d}" style="stroke:url(#${u}arm-${side})"/><circle class="b-hand" cx="${hx}" cy="${y + 16}" r="6.8" style="fill:url(#${u}arm-${side})"/></g>`;
}
function rig(kind) {
  const u = 'bd' + (++uid);
  return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><defs>
<radialGradient id="${u}g" cx="50%" cy="100%" r="85%"><stop offset="0" stop-color="#eaf4ff" stop-opacity=".95"/><stop offset="1" stop-color="#eaf4ff" stop-opacity="0"/></radialGradient>
<linearGradient id="${u}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4160"/><stop offset="1" stop-color="#2c2640"/></linearGradient>
<mask id="${u}plush" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="10" y="14" width="100" height="100" style="mask-type:alpha"><image href="/work/plush.webp" x="12" y="16" width="96" height="96"/></mask>
<filter id="${u}limbFur" x="-35%" y="-35%" width="170%" height="170%"><feTurbulence type="fractalNoise" baseFrequency=".13" numOctaves="2" seed="13" result="furNoise"/><feDisplacementMap in="SourceGraphic" in2="furNoise" scale="2.2" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation=".2"/></filter>
${limbPattern(`${u}arm-l`)}${limbPattern(`${u}arm-r`)}${limbPattern(`${u}foot-l`)}${limbPattern(`${u}foot-r`)}
</defs>
<ellipse class="b-shadow" cx="60" cy="109" rx="30" ry="4.5"/>
<g class="b-sparkles">${star(16, 34, 5, 1)}${star(104, 40, 4, 2)}${star(11, 78, 3.5, 3)}${star(109, 84, 4.5, 4)}${star(30, 13, 3.5, 5)}${star(91, 10, 3, 6)}</g>
<g class="b-easel"><path class="b-easel-legs" d="M88 79L77 111M105 79L117 111M96 82L105 110M77 87H117M96 41V35"/><rect class="b-easel-canvas" x="78" y="42" width="37" height="42" rx="2"/><path class="b-paint-sky" d="M84 57Q94 52 108 57"/><path class="b-paint-hill" d="M83 74Q91 62 98 70Q105 64 110 73"/><circle class="b-paint-sun" cx="104" cy="52" r="3"/></g>
<g class="b-root">
<g class="b-feet" filter="url(#${u}limbFur)"><ellipse class="b-foot" cx="45" cy="107.5" rx="9.5" ry="6.2" style="fill:url(#${u}foot-l)"/><ellipse class="b-foot" cx="75" cy="107.5" rx="9.5" ry="6.2" style="fill:url(#${u}foot-r)"/></g>
<g class="b-sprout"><path class="b-stem" d="M60 28Q60 21 60 15.5"/><g class="b-leaves"><path class="b-leaf" d="M60.5 19C56 12 49 13 47 16C51 20 57 21 60.5 19Z"/><path class="b-leaf" d="M60.8 17.5C64 10 72 9 74 12C71 17 65 19 60.8 17.5Z"/></g></g>
<g class="b-plush-body"><image class="b-plush-detail" href="/work/plush.webp" x="12" y="16" width="96" height="96"/><rect class="b-plush-tint" x="12" y="16" width="96" height="96" fill="color-mix(in srgb,var(--b-mid) 70%,white)" mask="url(#${u}plush)"/></g>
<ellipse class="b-glow" cx="60" cy="84" rx="31" ry="17" fill="url(#${u}g)"/>
<g class="b-face">
<ellipse class="b-cheek" cx="37.5" cy="75" rx="5.5" ry="3.2"/><ellipse class="b-cheek" cx="82.5" cy="75" rx="5.5" ry="3.2"/>
<g class="b-eyes"><g class="b-eye"><ellipse cx="47" cy="64" rx="5.2" ry="6.6"/><circle class="b-shine" cx="48.9" cy="61.4" r="2.1"/><circle class="b-shine" cx="45.7" cy="66.8" r=".9"/></g><g class="b-eye"><ellipse cx="73" cy="64" rx="5.2" ry="6.6"/><circle class="b-shine" cx="74.9" cy="61.4" r="2.1"/><circle class="b-shine" cx="71.7" cy="66.8" r=".9"/></g></g>
<g class="b-eyes-happy"><path d="M42 66Q47 58.5 52 66"/><path d="M68 66Q73 58.5 78 66"/></g>
<g class="b-eyes-closed"><path d="M42 64Q47 68.5 52 64"/><path d="M68 64Q73 68.5 78 64"/></g>
<g class="b-brows b-brows-focus"><path d="M41.5 54.5L51 56.5"/><path d="M78.5 54.5L69 56.5"/></g>
<g class="b-brows b-brows-worry"><path d="M42 56.5L51 53.5"/><path d="M78 56.5L69 53.5"/></g>
<path class="b-m b-m-smile" d="M55 75.5Q60 80.5 65 75.5"/>
<ellipse class="b-m b-m-o" cx="60" cy="77.5" rx="2.6" ry="3.3"/>
<g class="b-m b-m-open"><path d="M52.5 74.5Q60 86 67.5 74.5Z"/><ellipse class="b-tongue" cx="60" cy="80" rx="3.6" ry="2.1"/></g>
<path class="b-m b-m-flat" d="M56 77.5Q59.5 79 64 76.8"/>
<path class="b-m b-m-wobble" d="M53.5 78q1.6-2 3.25 0t3.25 0t3.25 0t3.25 0"/>
<ellipse class="b-m b-m-sleep" cx="60" cy="78" rx="1.8" ry="2.2"/>
<g class="b-acc b-acc-glasses"><circle cx="47" cy="64" r="8.6"/><circle cx="73" cy="64" r="8.6"/><path d="M55.6 63Q60 60.5 64.4 63"/></g>
<g class="b-acc b-acc-shades"><path d="M37.5 58.5H56.5Q56.5 71 47 71Q37.5 71 37.5 58.5Z"/><path d="M63.5 58.5H82.5Q82.5 71 73 71Q63.5 71 63.5 58.5Z"/><path class="b-bridge" d="M56.5 60Q60 58 63.5 60"/><path class="b-glint" d="M41 61.5L45 61.5M67 61.5L71 61.5"/></g>
</g>
<path class="b-sweat" d="M90 38C90 38 85.5 44.5 85.5 47A4.5 4.5 0 0 0 94.5 47C94.5 44.5 90 38 90 38Z"/>
<g class="b-acc b-acc-headphones"><path class="b-band" d="M22 64C20 20 100 20 98 64"/><rect x="14" y="56" width="11" height="19" rx="5"/><rect x="95" y="56" width="11" height="19" rx="5"/></g>
<g class="b-acc b-acc-beanie"><path d="M25 52C25 20 95 20 95 52Z"/><path class="b-rim" d="M23 47C40 42 80 42 97 47L97 55C80 50 40 50 23 55Z"/><circle class="b-pom" cx="60" cy="22" r="7"/></g>
<g class="b-acc b-acc-bow"><path d="M78 32L70 25L69 37Z"/><path d="M78 32L87 26L87 38Z"/><circle cx="78" cy="32" r="3.2"/></g>
${arm('l', u)}${arm('r', u)}
<g class="b-palette"><ellipse cx="0" cy="0" rx="11" ry="8"/><circle class="b-palette-hole" cx="5" cy="1" r="2.5"/><circle cx="-5" cy="-3" r="2" fill="#b596d0"/><circle cx="0" cy="-4" r="2" fill="#88b79b"/><circle cx="-5" cy="3" r="2" fill="#e4b075"/></g>
<g class="b-brush"><path class="b-brush-handle" d="M-3 3L9-10"/><path class="b-brush-ferrule" d="M7-8L11-12"/><path class="b-brush-tip" d="M9-13Q9-19 15-18Q17-13 12-10Z"/></g>
<g class="b-tool"><g class="b-tool-wrench"><path d="M0 10V-5M0-5C-6-5-7-10-4-14L-2-9H2L4-14C7-10 6-5 0-5"/><circle cx="0" cy="8" r="1"/></g><g class="b-tool-brush"><path class="b-brush-handle" d="M0 9V-8"/><path class="b-brush-ferrule" d="M0-6V-11"/><path class="b-brush-tip" d="M-3-11Q-5-18 0-20Q5-18 3-11Z"/></g></g>
</g>
<g class="b-toolbox"><g class="b-toolbox-lid"><path d="M58 95V88Q58 86 61 86H97Q100 86 100 88V95Z"/><path class="b-toolbox-handle" d="M72 86V82H86V86"/></g><rect class="b-toolbox-base" x="56" y="94" width="46" height="17" rx="4"/><path class="b-toolbox-seam" d="M57 98H101"/><rect class="b-toolbox-latch" x="76" y="96" width="7" height="6" rx="1.5"/></g>
<g class="b-laptop"><rect x="35" y="85" width="50" height="22" rx="4" fill="url(#${u}l)"/><g class="b-logo b-logo-sprout"><path d="M60 100V94"/><path d="M60 95.5C57.5 91.5 54 92 53.5 93.5C55.5 95.5 58 96 60 95.5ZM60 94.5C62.5 90.5 66 91 66.5 92.5C64.5 94.5 62 95 60 94.5Z"/></g><g class="b-logo b-logo-globe"><circle cx="60" cy="95.5" r="5"/><path d="M55 95.5H65M60 90.5Q56.8 95.5 60 100.5M60 90.5Q63.2 95.5 60 100.5"/></g><rect class="b-base" x="30" y="105" width="60" height="4.5" rx="2.2"/></g>
<g class="b-glyphs"><rect class="b-key" x="-3" y="-3" width="6" height="6" rx="1.5"/><rect class="b-key" x="-3" y="-3" width="6" height="6" rx="1.5"/><rect class="b-key" x="-3" y="-3" width="6" height="6" rx="1.5"/><rect class="b-key" x="-3" y="-3" width="6" height="6" rx="1.5"/></g>
<g class="b-think"><circle cx="89" cy="40" r="2"/><circle cx="95" cy="32" r="3.2"/><ellipse cx="104" cy="17" rx="14" ry="10.5"/><circle class="b-td t1" cx="98" cy="17" r="1.8"/><circle class="b-td t2" cx="104" cy="17" r="1.8"/><circle class="b-td t3" cx="110" cy="17" r="1.8"/></g>
<g class="b-alert"><circle class="b-alert-dot" cx="101" cy="22" r="10"/><path d="M101 16.5V23.5"/><circle class="b-alert-pt" cx="101" cy="27.8" r="1.5"/></g>
<g class="b-sign"><path class="b-stick" d="M101 49V57"/><rect x="88" y="30" width="27" height="20" rx="4"/><path class="b-check" d="M94 40.5L98.5 45L108 35.5"/></g>
<g class="b-zzz"><text x="0" y="0">z</text><text x="0" y="0">z</text><text x="0" y="0">Z</text></g>
<g class="b-q"><text x="94" y="32">?</text></g>
<g class="b-heart"><path d="M60 22C60 22 52 16.5 52 12A4 4 0 0 1 60 10.5A4 4 0 0 1 68 12C68 16.5 60 22 60 22Z"/></g>
</svg>`;
}

// ── what the agent is doing ──────────────────────────────────────────────────
const S = {
  tasks: [], online: true, models: getModels(), prev: new Map(), first: true,
  oneshot: null, hold: null, lastInput: Date.now(),
  composer: { focus: false, text: '', secret: false },
  global: 'idle', lastSayAt: 0, greeted: false, look: 'lavender', acc: 'none', lookKey: '', favKey: ''
};

// Mirrors looksLikePassword in work-extras.js: the server refuses these; the buddy covers its eyes.
const SYMBOL = /[!@#$%^&*()+=[\]{}|\\;'",<>?~`]/;
const secretToken = t => t.length >= 8 && !/:\/\//.test(t) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && SYMBOL.test(t);
export function looksLikePassword(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (/\b(password|passcode|passphrase|pwd|pin)\b[^\n]{0,20}?(\bis\b|:|=|\?)\s*\S{4,}/i.test(text)) return true;
  return text.split(/\s+/).some(secretToken);
}

const prompt = document.getElementById('prompt');
const control = () => window.SeekBrowser?.status?.()?.control;
function activityState(t) {
  const a = (t.activity || '').toLowerCase();
  if (!a || /getting started|checking|queued|continuing|received/.test(a)) return 'think';
  if (/browser|page|form|option|looking through|searching|sign in|receipt|links|reading/.test(a)) return 'browse';
  return 'type';
}
function taskState(t) {
  if (!t) return 'idle';
  if (t.approval) return 'approve';
  if (t.handoff) return control() === 'user' ? 'blind' : 'wave';
  if (t.status === 'waiting') return 'wave';
  if (t.status === 'running') return activityState(t);
  if (t.status === 'queued' || t.status === 'scheduled') return 'think';
  if (t.status === 'attention') return 'oops';
  if (t.status === 'complete') return 'happy';
  return 'idle';
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late? I’m here.' : h < 12 ? 'Good morning!' : h < 18 ? 'Good afternoon!' : 'Good evening!';
}

// [state, speech, keepSpeechUp]
function computeGlobal() {
  const now = Date.now(), c = S.composer;
  c.focus = !!prompt && document.activeElement === prompt;
  if (!S.online) return ['offline', 'I can’t reach your PC right now…', true];
  if (c.secret) return ['blind', 'Eyes closed! Passwords go in the secure sign-in, not in chat.', true];
  const ap = S.tasks.find(t => t.approval);
  if (ap) return ['approve', `Okay if I press “${ap.approval.label}”?`];
  if (control() === 'user') return ['blind', 'Your turn. I’m not looking!'];
  if (S.tasks.some(t => t.handoff)) return ['wave', 'Your turn. I need you in the browser.'];
  if (S.tasks.some(t => t.status === 'waiting')) return ['wave', 'Need you for a sec!'];
  const modelPose=modelCharacterState(S.models);
  if(modelPose)return [modelPose];
  if (S.hold && now < S.hold.until) return [S.hold.s];
  if (S.oneshot && now >= S.oneshot.from && now < S.oneshot.until) return [S.oneshot.s, S.oneshot.say];
  if (c.focus && c.text) return ['listen'];
  const run = S.tasks.find(t => t.status === 'running');
  if (run) return [activityState(run)];
  if (S.tasks.some(t => t.status === 'queued')) return ['think'];
  if (c.focus) return ['listen'];
  if (now - S.lastInput > 150000) return ['sleep'];
  return ['idle'];
}

function queue(s, ms, say) {
  const from = Math.max(Date.now(), S.hold?.until || 0);
  S.oneshot = { s, from, until: from + ms, say };
}

function visible(el) {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}
function stages() { return ['hero', 'panel', 'top'].map(k => document.querySelector(`[data-stage="${k}"]`)).filter(visible); }

let sayTimer, saying = null;
function speak(text, ms = 3600) {
  saying = { text, until: ms ? Date.now() + ms : Infinity };
  S.lastSayAt = Date.now();
  show();
}
function show() {
  const stage = stages()[0];
  for (const b of $$('.buddy-say')) if (!stage || !stage.contains(b)) b.classList.remove('show');
  const bubble = stage?.querySelector('.buddy-say');
  if (!bubble || !saying) return;
  bubble.textContent = saying.text;
  bubble.classList.add('show');
  clearTimeout(sayTimer);
  if (saying.until !== Infinity) sayTimer = setTimeout(hush, Math.max(0, saying.until - Date.now()));
}
function hush() { clearTimeout(sayTimer); saying = null; for (const b of $$('.buddy-say')) b.classList.remove('show'); }
// A re-render can replace the buddy that was talking (e.g. the welcome buddy when a chat opens); carry the words over.
function keepTalking() {
  if (!saying || Date.now() > saying.until) return;
  if (!$$('.buddy-say.show').some(b => visible(b.closest('[data-stage]')))) show();
}

let lastKeep = false;
function apply() {
  const [g, say, keep] = computeGlobal();
  if (g !== S.global) {
    const was = S.global;
    S.global = g;
    let text = say;
    if (!text && WORK.has(g) && !WORK.has(was) && Date.now() - S.lastSayAt > 3000) text = g === 'think' ? 'Let me think…' : 'On it!';
    if (text) speak(text, keep ? 0 : 3600);
    else if (lastKeep) hush();
  } else if (keep && say) {
    const bubble = stages()[0]?.querySelector('.buddy-say');
    if (bubble && (!bubble.classList.contains('show') || bubble.textContent !== say)) speak(say, 0);
  }
  lastKeep = !!keep;
  if (document.body.dataset.agent !== g) document.body.dataset.agent = g;
  // The look editor's preview runs through the main beats so you see your choices in motion.
  const tour = PREVIEW_TOUR[Math.floor(Date.now() / 2800) % PREVIEW_TOUR.length];
  for (const label of $$('[data-pose-label]')) if (label.textContent !== tour[1]) label.textContent = tour[1];
  for (const el of $$('.buddy[data-mounted]')) {
    const kind = el.dataset.buddy;
    if (STILL.has(kind)) continue;
    // A paused question still waves in the header; the studio shows its own
    // model activity. Browser handoffs and stronger privacy cues stay global.
    const studioPose = kind === 'studio' && g === 'wave' && !S.tasks.some(t => t.handoff) ? modelCharacterState(S.models) : null;
    const s = el.dataset.pose || (kind === 'preview' ? tour[0] : el.dataset.task !== undefined ? taskState(S.tasks.find(t => t.id === el.dataset.task)) : studioPose || (GLOBAL_KINDS.has(kind) ? g : 'idle'));
    if (el.dataset.s !== s) { el.dataset.s = s; const I = rigs.get(el); if (I) enter(I, s); }
  }
  keepTalking();
  favicon(g);
}

/** Called by the Work page after every poll. */
export function update(state, { online = true } = {}) {
  const tasks = state?.tasks || [];
  if (!S.first) for (const t of tasks) {
    const was = S.prev.get(t.id);
    if (!was || was === t.status) continue;
    if (t.status === 'complete' && ['running', 'waiting', 'queued'].includes(was)) queue('celebrate', 3200, 'All done!');
    if (t.status === 'attention') queue('oops', 4500, 'Hmm, I hit a snag.');
  }
  S.prev = new Map(tasks.map(t => [t.id, t.status]));
  S.tasks = tasks;
  S.online = online;
  S.first = false;
  apply();
}

/** Keep a pose for a while, e.g. 'type' while a new reply is written out. */
export function hold(s, ms) { S.hold = { s, until: Date.now() + ms }; apply(); }

// ── looks ────────────────────────────────────────────────────────────────────
export function setLook(look) {
  const color = PALETTES[look?.color] ? look.color : 'lavender';
  const acc = ACCESSORIES[look?.accessory] ? look.accessory : 'none';
  if (color + acc === S.lookKey) return;
  S.lookKey = color + acc; S.look = color; S.acc = acc;
  const p = PALETTES[color];
  applyProductPalette(p);
  let style = document.getElementById('buddy-look');
  if (!style) { style = document.createElement('style'); style.id = 'buddy-look'; document.head.append(style); }
  style.textContent = `:root{--b-hi:${p.hi};--b-mid:${p.mid};--b-deep:${p.deep};--b-cheek:${p.cheek};--b-line:${p.line}}`;
  document.documentElement.dataset.buddyAcc = acc;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p.deep);
  S.favKey = '';
  favicon(S.global);
}

// Tab icon that follows the agent: a face plus a badge for working / needs you / done.
function favicon(g) {
  const key = g + S.lookKey;
  if (key === S.favKey) return;
  S.favKey = key;
  const p = PALETTES[S.look], eye = '#2a2140';
  const eyes = g === 'celebrate' || g === 'happy' ? `<path d="M19 36Q24 29 29 36M35 36Q40 29 45 36" fill="none" stroke="${eye}" stroke-width="3.4" stroke-linecap="round"/>`
    : g === 'sleep' ? `<path d="M19 34Q24 39 29 34M35 34Q40 39 45 34" fill="none" stroke="${eye}" stroke-width="3.4" stroke-linecap="round"/>`
    : `<ellipse cx="24" cy="34" rx="3.8" ry="4.8" fill="${eye}"/><ellipse cx="40" cy="34" rx="3.8" ry="4.8" fill="${eye}"/><circle cx="25.4" cy="32" r="1.4" fill="#fff"/><circle cx="41.4" cy="32" r="1.4" fill="#fff"/>`;
  const badge = ['wave', 'approve'].includes(g) ? '<circle cx="50" cy="13" r="11" fill="#ffb547" stroke="#fff" stroke-width="2.5"/><path d="M50 7.5V14.5" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><circle cx="50" cy="19" r="1.9" fill="#fff"/>'
    : WORK.has(g)||MODEL_WORK.has(g) ? '<circle cx="50" cy="13" r="11" fill="#7461b5" stroke="#fff" stroke-width="2.5"/><circle cx="45" cy="13" r="1.9" fill="#fff"/><circle cx="50" cy="13" r="1.9" fill="#fff"/><circle cx="55" cy="13" r="1.9" fill="#fff"/>'
    : g === 'celebrate' ? '<circle cx="50" cy="13" r="11" fill="#5f9c80" stroke="#fff" stroke-width="2.5"/><path d="M45 13.5L48.5 17L55 10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
    : g === 'offline' ? '<circle cx="50" cy="13" r="9" fill="#9a95a3" stroke="#fff" stroke-width="2.5"/>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" cx="38%" cy="30%" r="80%"><stop offset="0" stop-color="${p.hi}"/><stop offset=".5" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.deep}"/></radialGradient></defs><path d="M32 8C49 8 59 20 59 36C59 52 48 61 32 61C16 61 5 52 5 36C5 20 15 8 32 8Z" fill="url(#g)"/><ellipse cx="18" cy="43" rx="4" ry="2.4" fill="${p.cheek}" opacity=".6"/><ellipse cx="46" cy="43" rx="4" ry="2.4" fill="${p.cheek}" opacity=".6"/>${eyes}${badge}</svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// ── the motion rig ───────────────────────────────────────────────────────────
const GRAVITY = 1150;                   // viewBox units / s²
const rigs = new Map();                 // .buddy element -> rig state
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
// A damped spring: stiffness k, damping ratio z (< 1 overshoots and settles).
const spring = (x, k, z) => ({ x, v: 0, t: x, k, c: 2 * z * Math.sqrt(k) });
const stepSpring = (s, dt) => { s.v += (-s.k * (s.x - s.t) - s.c * s.v) * dt; s.x += s.v * dt; };
const PROPS = { laptop: [60, 107], think: [89, 40], alert: [101, 22], sign: [101, 56], q: [98, 30], toolbox: [79, 111], easel: [97, 111] };

function makeRig(el) {
  const q = s => el.querySelector(s);
  const I = {
    el, still: STILL.has(el.dataset.buddy), since: performance.now(), seed: Math.random() * 100, script: [], visible: true,
    p: {
      root: q('.b-root'), stem: q('.b-stem'), leaves: q('.b-leaves'), face: q('.b-face'), eyes: [...el.querySelectorAll('.b-eye')],
      arms: { l: [...el.querySelectorAll('.b-arm-l path'), q('.b-arm-l .b-hand')], r: [...el.querySelectorAll('.b-arm-r path'), q('.b-arm-r .b-hand')] },
      shadow: q('.b-shadow'), glow: q('.b-glow'), keys: [...el.querySelectorAll('.b-key')], zzz: [...el.querySelectorAll('.b-zzz text')],
      laptop: q('.b-laptop'), think: q('.b-think'), alert: q('.b-alert'), sign: q('.b-sign'), q: q('.b-q'),
      toolbox: q('.b-toolbox'), lid: q('.b-toolbox-lid'), tool: q('.b-tool'), easel: q('.b-easel'), brush: q('.b-brush'), palette: q('.b-palette')
    },
    y: 0, vy: 0, air: false, ground: spring(0, 320, .55),
    sq: spring(1, 440, .38), lean: spring(0, 140, .5), bx: spring(0, 55, .6), jig: spring(0, 300, .16),
    fx: spring(0, 180, .62), fy: spring(0, 180, .62),
    sprout: spring(0, 90, .14),
    aL: spring(14, 240, .4), aR: spring(-14, 240, .4), lL: spring(1, 240, .5), lR: spring(1, 240, .5),
    // The bend of each arm: a slower spring chasing the arm's angle, so the curve trails the motion.
    bL: spring(14, 135, .72), bR: spring(-14, 135, .72),
    wiggle: spring(0, 170, .22),
    pops: Object.fromEntries(Object.keys(PROPS).map(k => [k, spring(0, 330, .42)])),
    look: null, crouch: null, blinkAt: -1, glow: 0, toolboxOpen: 0, toolVisible: false, toolKind: 'wrench',
    burst: 0, nextTap: 0, tapLeft: false, keys: [], keyIx: 0,
    col: 0, line: 0, scanX: -2.4, nextSaccade: 0, nextHop: 0, nextFidget: performance.now() + rand(5000, 11000), fidget: null
  };
  rigs.set(el, I);
  io?.observe(el);
  enter(I, el.dataset.s || 'idle', true);
  render(I, performance.now());
  loop();
  return I;
}

// Jumps are ballistic: a crouch (anticipation), a launch with stretch, a squash on landing.
function hop(I, h, now = performance.now(), crouch = .84, wait = 110) {
  if (reduced.matches || I.still) return;
  if (now > performance.now() + 8) { I.script.push({ at: now, run: () => hop(I, h, now, crouch, wait) }); return; }
  I.crouch = { until: now + wait, val: crouch };
  I.script.push({ at: now + wait, run: () => {
    I.air = true; I.vy = -Math.sqrt(2 * GRAVITY * h);
    if (I.el.dataset.s === 'celebrate') { I.side = -(I.side || 1); I.bx.v += I.side * 42; }   // an arc, not a pogo stick
    I.sq.x = Math.max(I.sq.x, .97); I.sq.v = 3 + h * .22;   // the crouch releases into a stretch
    I.sprout.v += (Math.random() < .5 ? -1 : 1) * rand(120, 200);
    I.aL.v += 200; I.aR.v -= 200;
  } });
}

function enter(I, s, first = false) {
  const now = performance.now();
  I.since = now;
  loop();
  if (first || I.still) return;
  blink(I, now);                       // a blink hides the swap of drawn expressions
  I.sq.v -= .9;                        // every change of pose starts with a little dip
  I.burst = 0; I.nextTap = now + 200; I.nextHop = now + 2400; I.fidget = null;
  if (s === 'sent') hop(I, 10, now);
  else if (s === 'celebrate') { hop(I, 17, now, .78, 150); hop(I, 9, now + 1050, .88, 100); I.nextHop = now + 2200; }
  else if (s === 'wake') { I.sq.v += 3.2; hop(I, 6, now + 80, .92, 60); }
  else if (s === 'oops') { I.sq.v += 2.8; I.sprout.v += 280; }
  else if (s === 'hello') hop(I, 6, now + 180, .9, 90);
  else if (s === 'approve') hop(I, 5, now + 150, .9, 80);
  else if (s === 'blind') I.sq.v -= 1.6;
  else if (s === 'think') I.fx.v += 40;
  else if (s === 'browse') { I.col = 0; I.line = 0; I.nextSaccade = now + 250; }
}

function blink(I, now = performance.now()) { if (!reduced.matches) I.blinkAt = now; }

/** A tap: squash, a little hop and a heart. */
function poke(I) {
  if (reduced.matches) return;
  I.sq.v -= 4.4;
  I.jig.v += 60;
  I.fy.v += 30;
  hop(I, 7, performance.now() + 60, .86, 70);
}

// Set pose targets for this frame. Motion comes from the springs chasing them.
function behave(I, now, calm = false) {
  // calm (reduced motion): the settled pose of each state, with no cycles or impulses.
  const s = I.el.dataset.s || 'idle', t = calm ? 10 : (now - I.since) / 1000, T = now / 1000 + I.seed;
  const wave = calm ? () => 0 : (hz, ph = 0) => Math.sin(T * hz * 2 * Math.PI + ph);
  let aL = 14, aR = -14, lL = 1, lR = 1, lean = 1.1 * wave(.09, .5), ground = 0, sq = 1 + .017 * wave(.27) + .005 * wave(.61, 2), fx = 0, fy = 0;
  let sprout = 3 * wave(.16, 1) + 2 * wave(.37), wiggle = 0;
  const pop = { laptop: 0, think: 0, alert: 0, sign: 0, q: 0, toolbox: 0, easel: 0 };
  I.toolboxOpen=0;I.toolVisible=false;I.toolKind='wrench';
  const look = I.look;
  switch (s) {
    case 'idle': case 'happy':
      if (look) { fx = look.x; fy = look.y; }
      if (!calm) idleFidget(I, now, s);
      if (I.fidget?.until > now) ({ aL = aL, aR = aR, lL = lL, lR = lR, fx = fx, fy = fy, sq = sq } = I.fidget.pose);
      break;
    case 'listen': ground = 1.6; sq = .985 + .008 * wave(.3); lean = 0; aL = -8; aR = 8; fx = (look?.x || 0) * .5; fy = 2.4; break;
    case 'think': fx = 2.6; fy = -2.6; lean = -2.2 + 1.6 * wave(.28); aR = 72; sq = 1 + .012 * wave(.25); pop.think = 1; sprout += 4 * wave(.5); break;
    case 'type': fy = 2.6; aL = -34; aR = 34; lean = .5 * wave(.2); sq = .99; pop.laptop = 1; if (!calm) typing(I, now); break;
    case 'browse': fy = 2.2 + I.line * .8; fx = calm ? 0 : I.scanX; aL = -34; aR = 32; lean = .4 * wave(.15); pop.laptop = 1; if (!calm) reading(I, now); break;
    case 'tools-away': case 'tools-out': case 'tools-restore': {
      // One small exchange, then a settled pose while the real load continues.
      const restore=s==='tools-restore',putting=s==='tools-away'||(restore&&t<1.5),age=restore&&!putting?t-1.5:t;
      const exchange=EASE.inOut(clamp(age/1.5,0,1));
      const reach=putting?exchange:1-exchange;
      aR=-130+160*reach;lR=1.45;fy=1.5;lean=1.2*reach;sq=.99;pop.toolbox=1;
      I.toolboxOpen=calm?0:Math.sin(Math.PI*clamp(age/1.9,0,1));
      I.toolVisible=!putting||exchange<.9;
      I.toolKind=restore&&putting||S.models?.active&&S.models.job?.phase==='loadingImage'?'brush':'wrench';
      if(calm){aR=s==='tools-away'?30:-130;I.toolVisible=s!=='tools-away';}
      break;
    }
    case 'paint': case 'paint-finish':
      aL=-30;lL=1.05;aR=s==='paint'?-122+12*wave(.28):-142;lR=1.42;fx=2;fy=.8;lean=.5*wave(.17);sq=1;pop.easel=1;break;
    case 'hello': case 'wave': {
      // An arcing wave: the arm dips first (anticipation), then swings; its spring lags and overshoots each swing.
      const swing = wave(1.8);
      aR = t < .14 ? 14 : -144 + 24 * swing; lR = 1.3;
      lean = t < .14 ? -1.2 : 2.2 + 1.2 * wave(1.8, -.7);
      if (s === 'wave') { pop.alert = 1; if (!calm && now > I.nextHop) { hop(I, 5, now, .9, 90); I.nextHop = now + 2600; } }
      else if (look) { fx = look.x * .6; fy = look.y * .6; }
      break;
    }
    case 'approve': aR = t < .12 ? 8 : -160; lR = 1.25; pop.sign = 1; wiggle = 6 * wave(.7); fx = 1.5; fy = -1; lean = 1.4 + .6 * wave(.4); break;
    case 'blind': {
      const cycle = t % 4.4, peek = cycle > 3.2 && cycle < 3.95;
      aL = peek ? -96 : -118; lL = peek ? 1.3 : 1.45; aR = 118; lR = 1.45;
      sq = .955 + .01 * wave(.35); lean = peek ? -1.6 : .3 * wave(.2);
      break;
    }
    case 'celebrate':
      if (t < .15) { aL = 32; aR = -32; }             // arms down and back while crouching
      else { aL = 146 + 12 * wave(2.2); aR = -146 - 12 * wave(2.2, 1.3); lL = lR = 1.35; }
      lean = t < .15 ? 0 : 2.2 * wave(1.1);
      if (!calm && now > I.nextHop && !I.air) { hop(I, 6, now, .88, 80); I.nextHop = now + 1000; }
      break;
    case 'sent': aL = 58; aR = -58; break;
    case 'wake': fy = -1; break;
    case 'oops': {
      aL = -22; aR = 22; fy = .5;
      const b = t % 2.2;
      if (b < .36) lean = 1.5 * Math.sin(b * 72);          // a nervous shiver in short bursts, then stillness
      break;
    }
    case 'sleep': {
      // Breathes slowly, nods off to one side, then catches itself.
      sq = .965 + .03 * wave(1 / 4.6);
      const c = (t % 7.5) / 7.5;
      lean = c < .87 ? 8 * EASE.inOut(c / .87) : 8 * (1 - EASE.snap((c - .87) / .13));
      fy = 1.6 + lean * .3; fx = lean * .2; aL = 4; aR = -4; sprout = -22 - lean * 1.2;
      if (c > .87 && !I.caught) { I.caught = true; I.sq.v += 1.6; I.sprout.v += 160; }   // catches itself with a start
      if (c < .5) I.caught = false;
      break;
    }
    case 'offline': lean = 3 * wave(.33); pop.q = 1; break;
  }
  // Overlapping action: the face trails the body's vertical motion, the sprout drags against the lean.
  fy -= I.vy * .006;
  sprout -= I.lean.x * .9;
  I.aL.t = aL; I.aR.t = aR; I.lL.t = lL; I.lR.t = lR; I.lean.t = lean; I.ground.t = ground;
  I.fx.t = fx; I.fy.t = fy; I.sprout.t = sprout; I.wiggle.t = wiggle;
  I.sq.t = I.crouch && now < I.crouch.until ? I.crouch.val : sq;
  for (const k in pop) I.pops[k].t = pop[k];
}

// Typing comes in bursts with pauses, alternating hands; each press is an impulse the arm spring answers.
function typing(I, now) {
  if (now < I.nextTap) return;
  if (I.burst <= 0) {
    I.burst = Math.floor(rand(4, 11));
    I.nextTap = now + rand(260, 820);
    if (Math.random() < .4) I.fy.v += 26;               // a small nod between thoughts
    else if (Math.random() < .3) I.fx.v += rand(-40, 40); // or a glance
    return;
  }
  I.burst--;
  I.tapLeft = Math.random() < .8 ? !I.tapLeft : I.tapLeft;
  if (I.tapLeft) I.aL.v += 330; else I.aR.v -= 330;
  I.sq.v -= .28;
  I.glow = 1;
  I.keys.push({ at: now, ix: I.keyIx++ % I.p.keys.length, x: I.tapLeft ? rand(40, 56) : rand(64, 80), spin: rand(-20, 20) });
  if (I.keys.length > 6) I.keys.shift();
  I.nextTap = now + rand(80, 160);
}

// Reading moves the eyes in saccades across a line, then sweeps back to the next line; now and then a scroll.
function reading(I, now) {
  if (now < I.nextSaccade) return;
  I.col = (I.col + 1) % 5;
  if (I.col === 0) I.line = (I.line + 1) % 3;
  I.scanX = -2.6 + I.col * 1.3;
  I.nextSaccade = now + (I.col === 0 ? 420 : rand(170, 420));
  if (I.col === 0 && I.line === 0 && Math.random() < .6) { I.aR.v -= 280; I.glow = .7; }   // flick to scroll
}

// While idle, the occasional small bit of business: a glance, a stretch, a hop, a wiggle.
function idleFidget(I, now, s) {
  if (!GLOBAL_KINDS.has(I.el.dataset.buddy) && I.el.dataset.buddy !== 'preview') return;
  if (now < I.nextFidget || I.air) return;
  I.nextFidget = now + rand(7000, 15000);
  const pick = Math.floor(rand(0, 5));
  if (pick === 0) I.fidget = { until: now + 1300, pose: { fx: rand(-1, 1) < 0 ? -3.2 : 3.2, fy: -.6 } };
  else if (pick === 1) I.fidget = { until: now + 1100, pose: { aL: 140, aR: -140, lL: 1.3, lR: 1.3, sq: 1.07, fy: -1.2 } };
  else if (pick === 2) hop(I, 6, now);
  else if (pick === 3) I.sprout.v += 300;
  else I.fidget = { until: now + 900, pose: { fy: 2.2, sq: .97 } };
}

function integrate(I, dt) {
  I.bL.t = I.aL.x; I.bR.t = I.aR.x;
  for (const s of [I.sq, I.lean, I.bx, I.jig, I.fx, I.fy, I.sprout, I.aL, I.aR, I.bL, I.bR, I.lL, I.lR, I.wiggle, ...Object.values(I.pops)]) stepSpring(s, dt);
  if (I.air) {
    const was = I.vy;
    I.vy += GRAVITY * dt;
    I.y += I.vy * dt;
    if (was < 0 && I.vy >= 0 && I.el.dataset.s === 'celebrate') flash(I.el, 'burst', 1000);   // sparkles at the top of the jump
    if (I.y >= 0) {
      // Landing: the speed turns into squash, the sprout and arms keep going and settle.
      const impact = I.vy;
      I.y = 0; I.vy = 0; I.air = false; I.ground.x = 0; I.ground.v = 0;
      I.sq.v -= impact * .017;
      I.jig.v += impact * .35;
      I.sprout.v += (Math.random() < .5 ? -1 : 1) * impact * 1.3;
      I.aL.v -= impact * .9; I.aR.v += impact * .9;
      I.fy.v += impact * .12;
    }
  } else {
    stepSpring(I.ground, dt);
    I.y = I.ground.x;
  }
  I.glow *= Math.exp(-dt * 7);
}

function snap(I) {
  I.bL.t = I.aL.t; I.bR.t = I.aR.t; I.bx.t = 0; I.jig.t = 0;
  for (const s of [I.sq, I.lean, I.bx, I.jig, I.fx, I.fy, I.sprout, I.aL, I.aR, I.bL, I.bR, I.lL, I.lR, I.wiggle, I.ground, ...Object.values(I.pops)]) { s.x = s.t; s.v = 0; }
  I.air = false; I.y = I.ground.x; I.vy = 0; I.keys = []; I.glow = 0;
}

function render(I, now) {
  const p = I.p;
  // Squash and stretch keep the volume: whatever height it gains it loses in width.
  const stretch = I.air ? Math.min(.16, Math.abs(I.vy) / 1000 * .45) : 0;   // longest at speed, round at the top
  const sy = clamp(I.sq.x * (1 + stretch), .72, 1.3), sx = 1 / sy;
  const painting=['paint','paint-finish'].includes(I.el.dataset.s),size=painting ? .82 : 1;
  p.root?.setAttribute('transform', `translate(${f2((painting?43:60) + I.bx.x)} ${f2(104 + I.y)}) rotate(${f2(I.lean.x)}) scale(${f2(sx*size)} ${f2(sy*size)}) translate(-60 -104)`);
  const lift = clamp(-I.y / 36, 0, .45);
  p.shadow?.setAttribute('transform', `translate(60 109) scale(${f2((1 - lift) * Math.sqrt(sx))} ${f2(1 - lift)}) translate(-60 -109)`);
  if (p.shadow) p.shadow.style.opacity = f2(.13 * (1 - lift));
  // The stem is a quadratic Bézier: its control point bends less than the tip, so it curves rather than pivots.
  const bend = I.sprout.x * Math.PI / 180, tip = [60 + 12.5 * Math.sin(bend), 28 - 12.5 * Math.cos(bend)], ctl = [60 + 7 * Math.sin(bend * .35), 28 - 7 * Math.cos(bend * .35)];
  p.stem?.setAttribute('d', `M60 28Q${f2(ctl[0])} ${f2(ctl[1])} ${f2(tip[0])} ${f2(tip[1])}`);
  p.leaves?.setAttribute('transform', `translate(${f2(tip[0])} ${f2(tip[1])}) rotate(${f2(I.sprout.x)}) translate(-60.5 -17)`);
  p.face?.setAttribute('transform', `translate(${f2(I.fx.x)} ${f2(I.fy.x)})`);
  limb(p.arms.l, SHOULDER.l, I.aL.x, I.bL.x + 7, I.lL.x);
  limb(p.arms.r, SHOULDER.r, I.aR.x, I.bR.x - 7, I.lR.x);
  const leftHand=handPoint(SHOULDER.l,I.aL.x,I.lL.x),rightHand=handPoint(SHOULDER.r,I.aR.x,I.lR.x);
  for(const [prop,shown,hand,angle] of [[p.tool,I.toolVisible,rightHand,-18],[p.brush,painting,rightHand,0],[p.palette,painting,leftHand,-12]]){
    if(!prop)continue;
    prop.toggleAttribute('data-on',!!shown);
    if(shown)prop.setAttribute('transform',`translate(${f2(hand[0])} ${f2(hand[1])}) rotate(${angle})`);
  }
  if(p.tool)p.tool.dataset.kind=I.toolKind;
  p.lid?.setAttribute('transform',`rotate(${f2(-18*I.toolboxOpen)} 58 94)`);
  // Blink: shut fast, open a little slower.
  let e = 1;
  if (I.blinkAt >= 0) {
    const b = (now - I.blinkAt) / 170;
    if (b >= 1) I.blinkAt = -1;
    else e = b < .35 ? 1 - .92 * EASE.in(b / .35) : .08 + .92 * EASE.open((b - .35) / .65);
  }
  if (e !== I.lastEye) { I.lastEye = e; p.eyes.forEach((g, k) => g.setAttribute('transform', `translate(${k ? 73 : 47} 64) scale(1 ${f2(e)}) translate(${k ? -73 : -47} -64)`)); }
  for (const [k, [ax, ay]] of Object.entries(PROPS)) {
    const el = p[k], sc = Math.max(0, I.pops[k].x);
    if (!el) continue;
    if (sc < .02) { if (el.hasAttribute('data-on')) el.removeAttribute('data-on'); continue; }
    if (!el.hasAttribute('data-on')) el.setAttribute('data-on', '');
    const extra = k === 'laptop' ? ` translate(0 ${f2((1 - Math.min(1, sc)) * 14)})` : k === 'sign' ? ` rotate(${f2(I.wiggle.x)} 101 56)` : k === 'alert' ? ` translate(0 ${f2(1.6 * Math.sin(now / 330))})` : '';
    el.setAttribute('transform', `translate(${ax} ${ay}) scale(${f2(sc)}) translate(${-ax} ${-ay})${extra}`);
  }
  if (p.glow) p.glow.style.opacity = f2(I.el.dataset.s === 'type' || I.el.dataset.s === 'browse' ? .16 + .3 * I.glow : 0);
  // Keys pop out of the laptop on each press and curl away along a Bézier path.
  const shown = new Set();
  for (const k of I.keys) {
    const age = (now - k.at) / 700, el = p.keys[k.ix];
    if (age > 1 || !el) continue;
    shown.add(el);
    const dir = k.x < 60 ? -1 : 1, [x, y] = bezierAt([k.x, 86], [k.x + dir * 2, 74], [k.x + dir * 9, 67], [k.x + dir * 13, 58], EASE.out(age));
    const o = age < .12 ? age / .12 : 1 - (age - .12) / .88;
    el.setAttribute('transform', `translate(${f2(x)} ${f2(y)}) rotate(${f2(k.spin * age)}) scale(${f2(.5 + .5 * EASE.out(Math.min(1, age * 3)))})`);
    el.style.opacity = f2(o);
    el.setAttribute('data-on', '');
  }
  for (const el of p.keys) if (!shown.has(el) && el.hasAttribute('data-on')) el.removeAttribute('data-on');
  // Asleep: z's drift up an S-curve, growing as they go.
  if (I.el.dataset.s === 'sleep') p.zzz.forEach((z, k) => {
    const age = (now / 3000 + k / 3) % 1, [x, y] = bezierAt([84, 44], [97, 35], [79, 22], [97, 8], EASE.out(age));
    z.setAttribute('transform', `translate(${f2(x)} ${f2(y)}) scale(${f2(.55 + .6 * age)})`);
    z.style.opacity = f2(age < .2 ? age / .2 : 1 - (age - .2) / .8);
  });
}

// Draw one arm: shoulder -> hand along the arm's angle; the control point follows the slower bend angle.
function handPoint([x,y],angle,len){const a=angle*Math.PI/180,L=16*len;return [x-L*Math.sin(a),y+L*Math.cos(a)];}
function limb([edge, fill, hand], [x, y], angle, bendAngle, len) {
  if (!edge) return;
  const L = 16 * len, a = angle * Math.PI / 180, b = bendAngle * Math.PI / 180;
  const hx = x - L * Math.sin(a), hy = y + L * Math.cos(a), cx = x - L * .55 * Math.sin(b), cy = y + L * .55 * Math.cos(b);
  const d = `M${x} ${y}Q${f2(cx)} ${f2(cy)} ${f2(hx)} ${f2(hy)}`;
  edge.setAttribute('d', d); fill.setAttribute('d', d);
  hand.setAttribute('cx', f2(hx)); hand.setAttribute('cy', f2(hy));
}

let rafId = 0, lastFrame = 0;
function loop() { if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame); }
function frame(now) {
  rafId = 0;
  const dt = Math.min(.034, lastFrame ? (now - lastFrame) / 1000 : .016);
  lastFrame = now;
  let active = false;
  for (const [el, I] of rigs) {
    if (!el.isConnected) { rigs.delete(el); io?.unobserve(el); continue; }
    if (I.script.length) I.script = I.script.filter(x => (now >= x.at ? (x.run(), false) : true));
    if (!I.visible) continue;
    if (I.still) { if (I.blinkAt >= 0) { render(I, now); active = true; } continue; }
    if (reduced.matches) {
      // Reduced motion: settle straight into each pose and only redraw when something changes.
      const key = I.el.dataset.s + (I.look ? f2(I.look.x) + ',' + f2(I.look.y) : '') + (I.blinkAt >= 0);
      if (key === I.calmKey) continue;
      I.calmKey = key;
      behave(I, now, true);
      snap(I);
    } else {
      behave(I, now);
      // Two half steps keep the stiffer springs stable on slow frames.
      integrate(I, dt / 2); integrate(I, dt / 2);
    }
    render(I, now);
    active = true;
  }
  if (active) rafId = requestAnimationFrame(frame);
  else lastFrame = 0;
}
const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) { const I = rigs.get(e.target); if (I) I.visible = e.isIntersecting; }
  loop();
}) : null;
document.addEventListener('visibilitychange', () => { lastFrame = 0; loop(); });
reduced.addEventListener('change',()=>{for(const I of rigs.values())I.calmKey=null;lastFrame=0;loop();});

// ── mounting ─────────────────────────────────────────────────────────────────
function mount(el) {
  if (el.dataset.mounted) return;
  el.dataset.mounted = '1';
  const kind = el.dataset.buddy;
  el.style.setProperty('--bs', (SIZES[kind] || 40) + 'px');
  // CSS loops (thought dots, zzz) run on the wall clock, so a re-created buddy picks up mid-motion.
  el.style.setProperty('--bp', -(Date.now() % 60000) + 'ms');
  if (STILL.has(kind)) { el.classList.add('still'); el.dataset.s = 'idle'; }
  el.innerHTML = rig(kind);
  makeRig(el);
  if (kind === 'hero' && !S.greeted) {
    S.greeted = true;
    if (['idle', 'listen', 'sleep'].includes(S.global)) { S.lastInput = Date.now(); queue('hello', 2600, greeting()); }
  }
}
const mountAll = root => { let n = 0; for (const el of root.querySelectorAll('.buddy[data-buddy]:not([data-mounted])')) { mount(el); n++; } return n; };
new MutationObserver(records => {
  let n = 0;
  for (const r of records) for (const node of r.addedNodes) {
    if (node.nodeType !== 1 || node.closest?.('svg')) continue;
    if (node.matches('.buddy[data-buddy]:not([data-mounted])')) { mount(node); n++; }
    n += mountAll(node);
  }
  if (n) apply();
}).observe(document.body, { childList: true, subtree: true });

// ── life: blinking together, following the pointer, dozing off ───────────────
function flash(el, cls, ms) { el.classList.remove(cls); void el.getBoundingClientRect(); el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); }
function blinkAll() {
  // Every copy is the same character, so they blink together (now and then twice).
  const now = performance.now();
  for (const I of rigs.values()) if (!['sleep', 'celebrate', 'blind'].includes(I.el.dataset.s)) blink(I, now);
  if (Math.random() < .2) setTimeout(() => { for (const I of rigs.values()) if (I.el.dataset.s !== 'sleep') blink(I); loop(); }, 260);
  loop();
  setTimeout(blinkAll, rand(2400, 6200));
}
let pointer = null, trackRaf = 0;
function track() {
  trackRaf = 0;
  for (const I of rigs.values()) {
    if (!I.el.hasAttribute('data-track') || !pointer) { I.look = null; continue; }
    const r = I.el.getBoundingClientRect();
    if (!r.width) continue;
    const dx = pointer.x - (r.left + r.width / 2), dy = pointer.y - (r.top + r.height * .55);
    I.look = { x: clamp(dx / 180, -1, 1) * 3.2, y: clamp(dy / 180, -1, 1) * 2.6 };
  }
  loop();
}
let lastMoveMark = 0;
function touch() {
  S.lastInput = Date.now();
  if (S.global === 'sleep') { queue('wake', 1300, 'Oh! Hi.'); apply(); }
}
document.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') { pointer = { x: e.clientX, y: e.clientY }; if (!trackRaf) trackRaf = requestAnimationFrame(track); }
  if (Date.now() - lastMoveMark > 1500) { lastMoveMark = Date.now(); touch(); }
}, { passive: true });
document.documentElement.addEventListener('mouseleave', () => { pointer = null; if (!trackRaf) trackRaf = requestAnimationFrame(track); });
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, touch, { passive: true });

// ── the composer: listen while you type, look away from passwords ────────────
let lastNod = 0;
prompt?.addEventListener('focus', () => apply());
prompt?.addEventListener('blur', () => apply());
prompt?.addEventListener('input', () => {
  S.composer.text = prompt.value.trim();
  S.composer.secret = looksLikePassword(prompt.value);
  if (Date.now() - lastNod > 170) {
    lastNod = Date.now();
    for (const I of rigs.values()) if (GLOBAL_KINDS.has(I.el.dataset.buddy) && !reduced.matches) { I.fy.v += 38; I.sq.v -= .35; }
  }
  apply();
});
document.getElementById('composer')?.addEventListener('submit', () => {
  if (!S.composer.text || S.composer.secret) return;
  const reply = document.getElementById('mode')?.hidden || document.getElementById('mode')?.value === 'chat';
  S.composer.text = '';
  queue('sent', 1100, reply ? 'Got it!' : 'On it!');
  apply();
}, true);

// ── pokes ────────────────────────────────────────────────────────────────────
const GIGGLES = ['Hehe!', 'That tickles!', 'Boop!', 'Hi there!', 'I’m here!', '☺'];
document.addEventListener('click', e => {
  const el = e.target.closest('.buddy[data-mounted]');
  if (!el || STILL.has(el.dataset.buddy)) return;
  const I = rigs.get(el);
  if (I) poke(I);
  flash(el, 'bd-poke', 900);
  const stage = el.closest('[data-stage]')?.dataset.stage;
  if ((stage === 'hero' || stage === 'panel') && ['idle', 'listen', 'happy', 'sleep'].includes(el.dataset.s)) speak(GIGGLES[Math.floor(Math.random() * GIGGLES.length)], 1800);
});

/** A little hop, e.g. when you change its look. */
export function cheer(el) { const I = el && rigs.get(el); if (I) poke(I); if (el) flash(el, 'bd-poke', 900); }

window.addEventListener('seek-model-state',event=>{S.models=event.detail;apply();});
mountAll(document);
setLook(null);
apply();
setInterval(apply, 500);
setTimeout(blinkAll, 1800);

window.SeekBuddy = { update, hold, setLook, cheer, looksLikePassword, PALETTES, ACCESSORIES, get state() { return S.global; } };
