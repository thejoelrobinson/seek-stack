// Shim between DeepSeek Harness and llama-server (18798).
//
// WHY THIS EXISTS: dsh 0.1.0-rc.7 gives the compaction summarizer a hard-coded
// 8192-token cap that "may include reasoning tokens", and exposes no settings
// namespace to change it (checked: no compaction namespace, and the tree entry
// carrying that config is disabled because agent presets own the live one).
// Qwen3.8 spends the entire 8192 thinking, so the summary is truncated,
// compaction never shrinks the conversation, and every agent turn afterwards
// dies on max-tokens.
//
// Measured: same summarization prompt with thinking off returns a complete
// answer in 29 tokens and 0 reasoning tokens.
//
// The summarizer is identifiable by its 8192 cap; agent turns carry the
// configured 24576. Only that one call is rewritten. Delete this file and point
// baseURL back at 18798 to restore stock behaviour.
const http = require('node:http');
const fs = require('node:fs');

const LISTEN = 18800, TARGET = 18798;
const SUMMARIZER_CAP = 8192;
const LOG = 'C:/Users/Joel Robinson/.dsh/proxy/wire.log';

const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let buf = Buffer.concat(chunks);
    if (req.url.includes('chat/completions')) {
      try {
        const j = JSON.parse(buf.toString('utf8'));
        const cap = j.max_completion_tokens ?? j.max_tokens;
        if (cap === SUMMARIZER_CAP) {
          j.chat_template_kwargs = { ...(j.chat_template_kwargs || {}), enable_thinking: false };
          buf = Buffer.from(JSON.stringify(j));
          log(`SUMMARIZER cap=${cap} msgs=${(j.messages || []).length} -> thinking DISABLED`);
        } else {
          log(`passthrough cap=${cap} msgs=${(j.messages || []).length}`);
        }
      } catch (e) { log(`parse-fail ${e.message}`); }
    }
    const headers = { ...req.headers, host: `127.0.0.1:${TARGET}` };
    delete headers['content-length'];
    headers['content-length'] = Buffer.byteLength(buf);
    const p = http.request({ host: '127.0.0.1', port: TARGET, method: req.method, path: req.url, headers }, (pr) => {
      res.writeHead(pr.statusCode, pr.headers);
      pr.on('error', () => res.destroy());
      pr.pipe(res);
    });
    // A client hang-up fires 'close', NOT 'error'. Without this the upstream
    // request survives the harness aborting (idle timeout, user stop, tab
    // close) and llama.cpp keeps generating for a client that is gone --
    // burning the GPU and leaking a socket per abandoned turn.
    // NOTE: do NOT abort on req 'close' -- that fires normally once the request
    // body has been read, long before the response is done. Only res 'close'
    // without writableFinished means the client actually hung up.
    const abort = () => { if (!p.destroyed) p.destroy(); };
    req.on('error', abort);
    res.on('error', abort);
    res.on('close', () => { if (!res.writableFinished) abort(); });
    p.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(e.message); });
    p.end(buf);
  });
}).listen(LISTEN, '127.0.0.1', () => console.log(`summarizer shim on ${LISTEN} -> ${TARGET}`));
