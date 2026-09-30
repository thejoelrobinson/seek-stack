// A small, safe Markdown renderer for agent replies and .md previews (browser and
// Node). Everything is HTML-escaped first; only the constructs below become markup:
// headings, paragraphs, bold/italic/strike, inline and fenced code, links and bare
// URLs, bullet/numbered/task lists (nested), blockquotes, rules and pipe tables.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LINK = 'target="_blank" rel="noopener noreferrer"';
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// Private-use characters hold code spans and URLs out of the emphasis pass.
const HOLD = /(\d+)/g;
/** Marks where a typewriter caret goes; callers replace it after rendering. */
export const CARET = '';

export function inline(text) {
  const held = [];
  const hold = html => `${held.push(html) - 1}`;
  let h = esc(String(text ?? '').replace(/[]/g, ''));
  h = h.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  h = h.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${hold(url)}" ${LINK}>${label}</a>`);
  // Links to anything but a web address (e.g. a file name in the task folder) keep their label as plain text.
  h = h.replace(/!?\[([^\]\n]+)\]\((?!https?:)[^\s)\uE010]+\)/g, '$1');
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, pre, url) => {
    // Sentence punctuation after a bare URL isn't part of it, nor is a closing bracket it never opened.
    let tail = url.match(/[.,;:!?]+$/)?.[0] || '';
    url = url.slice(0, url.length - tail.length);
    if (url.endsWith(')') && !url.includes('(')) { url = url.slice(0, -1); tail = ')' + tail; }
    return `${pre}<a href="${hold(url)}" ${LINK}>${hold(url)}</a>${tail}`;
  });
  h = h.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, '$1<strong>$2</strong>');
  h = h.replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g, '$1<em>$2</em>');
  h = h.replace(/(^|[^_\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![_\w])/g, '$1<em>$2</em>');
  h = h.replace(/~~(?=\S)([^\n]*?\S)~~/g, '<del>$1</del>');
  return h.replace(HOLD, (_, k) => held[k]);
}

export function md(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const indent = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const isItem = n => ITEM.test(lines[n]);
  const isTable = n => lines[n].includes('|') && n + 1 < lines.length && TABLE_SEP.test(lines[n + 1]);
  const startsBlock = n => FENCE.test(lines[n]) || HEADING.test(lines[n]) || RULE.test(lines[n]) || /^\s*>/.test(lines[n]) || isItem(n) || isTable(n);
  const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const item = parts => parts.map((p, k) => typeof p !== 'string' ? p.sub
    : (k ? '<br>' : '') + inline(k ? p : p.replace(/^\[([ xX])\]\s+/, (_, c) => c === ' ' ? '☐ ' : '☑ '))).join('');

  function list() {
    const base = indent(lines[i]), marker = lines[i].match(ITEM)[2], ordered = /\d/.test(marker);
    const items = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line ends the list unless more of it follows.
        let n = i + 1;
        while (n < lines.length && !lines[n].trim()) n++;
        if (n < lines.length && indent(lines[n]) >= base && (isItem(n) || indent(lines[n]) > base)) { i = n; continue; }
        break;
      }
      const m = line.match(ITEM), ind = indent(line);
      if (m && ind === base) { items.push([m[3]]); i++; continue; }
      if (m && ind > base && items.length) { items.at(-1).push({ sub: list() }); continue; }
      if (!m && items.length && (ind > base || (lines[i - 1].trim() && !startsBlock(i)))) { items.at(-1).push(line.trim()); i++; continue; }
      break;
    }
    const tag = ordered ? 'ol' : 'ul', first = parseInt(marker, 10);
    return `<${tag}${ordered && first > 1 ? ` start="${first}"` : ''}>${items.map(p => `<li>${item(p)}</li>`).join('')}</${tag}>`;
  }

  let out = '';
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    const h = line.match(HEADING);
    if (h) { out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (RULE.test(line)) { out += '<hr>'; i++; continue; }
    if (isTable(i)) {
      const head = cells(line), align = cells(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      out += `<div class="md-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, k) => cell('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out += `<blockquote>${md(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (isItem(i)) { out += list(); continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && (!buf.length || !startsBlock(i))) buf.push(lines[i++]);
    out += `<p>${buf.map(l => inline(l.trim())).join('<br>')}</p>`;
  }
  return out;
}

/** Styles for rendered Markdown; the Work page carries the same rules in work.css. */
export const MD_CSS = `.md{line-height:1.65;overflow-wrap:break-word}.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:0 0 .8em}.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{font-weight:600;line-height:1.35;margin:1.2em 0 .5em;color:#2f2839}
.md h1{font-size:1.45em}.md h2{font-size:1.25em}.md h3{font-size:1.1em}.md h4,.md h5,.md h6{font-size:1em}
.md ul,.md ol{margin:0 0 .8em;padding-left:1.45em}.md li{margin:.3em 0}.md li>ul,.md li>ol{margin:.3em 0}.md li::marker{color:#9b87bb}
.md code{font:.88em ui-monospace,SFMono-Regular,Consolas,monospace;background:#f3f0f7;border-radius:5px;padding:1px 5px}
.md pre{background:#1f1b27;color:#eee8f7;border-radius:10px;padding:12px 14px;overflow:auto;margin:0 0 .8em}.md pre code{background:none;padding:0;color:inherit;white-space:pre}
.md blockquote{margin:0 0 .8em;padding:2px 0 2px 12px;border-left:3px solid #d9cfe9;color:#5f5868}
.md hr{border:0;border-top:1px solid #ece8f0;margin:1.1em 0}
.md .md-table{overflow-x:auto;margin:0 0 .8em;border:1px solid #ece8f0;border-radius:10px;overflow-wrap:normal}
.md table{border-collapse:collapse;width:100%;font-size:.93em}.md th,.md td{padding:7px 10px;border-bottom:1px solid #f0edf3;text-align:left;vertical-align:top}
.md th{background:#f7f5fa;font-weight:600}.md tr:last-child td{border-bottom:0}
.md a{color:#514381;text-decoration:underline;text-decoration-color:#cbbfe0;text-underline-offset:2px}.md strong{font-weight:650}`;

/** A standalone page for previewing a .md file. */
export function mdPage(src, title = 'Preview') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;padding:28px clamp(16px,5vw,48px);max-width:820px;font:15px/1.65 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#282b32;background:#fff}${MD_CSS}</style></head><body class="md">${md(src)}</body></html>`;
}
