// Free web_search backend for the DeepSeek Harness. No API key, no paid API.
//
// WHY THIS EXISTS: the harness ships exactly one search provider,
// `dsh-web-search-deepseek`, which needs a paid DEEPSEEK_API_KEY. The other
// providers it names (exa, perplexity, fetch-http) are published on a STALE
// version line (`dsh-web@^0.0.1-rc.x`) while this install is `0.1.0-rc.7`, so
// installing them risks pulling a second, unused copy of the `ctx.web` seam.
//
// So instead of a new provider plugin, this reuses the already-installed and
// version-matched deepseek provider and only swaps where it points. That
// provider's `baseURL` is configurable, so this process impersonates the one
// endpoint it calls -- Anthropic's Messages API with the native web_search
// server tool -- and answers from a local SearXNG container instead.
//
//   dsh -> ctx.web -> web-search-deepseek -> :18802 (this) -> :18801 (searxng)
//
// Contract, read out of dsh-web-search-deepseek/lib/index.js (not guessed):
//   REQUEST : POST {baseURL}/messages, body.messages[0].content[0].text is
//             literally `Perform a web search for the query: <QUERY>`.
//   RESPONSE: content[] must contain >=1 `web_search_tool_result` block or the
//             provider throws (it is deliberately strict and will NOT scrape
//             prose). Each item needs {type:'web_search_result', url, title,
//             page_age}. Snippets are NOT read from those items -- they come
//             from a SEPARATE `text` block's citations[], keyed by url as
//             {url, cited_text}, first occurrence wins.
const http = require('node:http');
const fs = require('node:fs');

const LISTEN = 18802;
const SEARXNG = 'http://127.0.0.1:18801';
const MAX_RESULTS = 20;           // the seam truncates to its own maxResults
const SNIPPET_CHARS = 400;
const LOG = 'C:/Users/Joel Robinson/.dsh/proxy/search.log';

const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

// The provider wraps the real query in a fixed sentence; strip it back off.
const PREFIX = 'Perform a web search for the query:';
function extractQuery(body) {
  const blocks = body?.messages?.[0]?.content;
  const text = Array.isArray(blocks)
    ? blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ').trim()
    : typeof blocks === 'string' ? blocks.trim() : '';
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length).trim() : text;
}

async function searxng(query, signal) {
  const url = `${SEARXNG}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
  const body = await res.json();
  const out = []; const seen = new Set();
  for (const r of body.results ?? []) {
    if (!r || typeof r.url !== 'string' || r.url.length === 0) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({
      url: r.url,
      title: typeof r.title === 'string' && r.title.length > 0 ? r.title : r.url,
      // SearXNG's publishedDate is an ISO string when the engine supplied one.
      page_age: typeof r.publishedDate === 'string' ? r.publishedDate : '',
      snippet: (typeof r.content === 'string' ? r.content : '').slice(0, SNIPPET_CHARS),
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

function toAnthropic(results, query) {
  return {
    id: 'msg_searxng_' + Date.now().toString(36),
    type: 'message',
    role: 'assistant',
    model: 'searxng-local',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_searxng',
        content: results.map((r) => ({
          type: 'web_search_result',
          url: r.url,
          title: r.title,
          page_age: r.page_age,
        })),
      },
      {
        // Snippets ride here, NOT on the result items -- this is the only place
        // the provider reads them from.
        type: 'text',
        text: `Found ${results.length} results for ${query}.`,
        citations: results
          .filter((r) => r.snippet.length > 0)
          .map((r) => ({
            type: 'web_search_result_location',
            url: r.url,
            title: r.title,
            cited_text: r.snippet,
            encrypted_index: '',
          })),
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

const send = (res, code, obj) => {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
};

http.createServer((req, res) => {
  if (!req.url.endsWith('/messages') || req.method !== 'POST') {
    return send(res, 404, { error: { message: 'only POST /messages is served' } });
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let query = '';
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      query = extractQuery(body);
      if (!query) throw new Error('no query in request');
      const t0 = Date.now();
      const results = await searxng(query);
      log(`OK "${query}" -> ${results.length} results in ${Date.now() - t0}ms`);
      // An empty result set is still a valid answer: emit the block anyway so
      // the provider reports "no sources" instead of throwing PROVIDER_ERROR.
      send(res, 200, toAnthropic(results, query));
    } catch (e) {
      log(`FAIL "${query}": ${e.message}`);
      send(res, 502, { type: 'error', error: { type: 'api_error', message: String(e.message) } });
    }
  });
  req.on('error', () => { try { res.destroy(); } catch {} });
}).listen(LISTEN, '127.0.0.1', () =>
  console.log(`searxng search adapter on ${LISTEN} -> ${SEARXNG}`));
