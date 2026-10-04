/**
 * web-search-chrome-mcp - a WebSearchProvider for the ctx.web seam that runs
 * web search through a real Chrome browser.
 *
 * Architecture: this provider is a thin MCP client. It lazily spawns
 * `~/.dsh/chrome-mcp/server.js` (a stdio MCP server) which launches and
 * drives Chrome over raw CDP in a throwaway user-data-dir, scrapes the engine
 * page (DuckDuckGo HTML endpoint by default; Bing and Google supported), and
 * returns structured results. The MCP session is kept warm across searches and
 * is (re)spawned when the child dies or settings change.
 *
 * OFF by default. The \`web\` row in \`~/.dsh/cordis.patch.yml\` selects
 * \`deepseek-official\` unless \`DSH_WEB_SEARCH_PROVIDER=chrome-mcp\` is set (or the
 * row's searchProvider is edited). Registration is safe in that state: an
 * explicitly configured provider id always wins, and available() gates the
 * rest.
 *
 * Local-by-design: this package is not published. The registry packages pin
 * \`dsh-web@^0.0.1-rc.x\` and would introduce a second seam instance; living in
 * the shared \`~/.dsh/profiles/node_modules\` resolves against the same host
 * copy the running harness uses.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const name = "web-search-chrome-mcp";
const inject = ["web"];

const CHROME_MCP_PROVIDER_ID = "chrome-mcp";
const ENGINES = new Set(["ddg", "bing", "google"]);
const MCP_CLIENT_NAME = "dsh-web-search-chrome-mcp";
const MCP_CLIENT_VERSION = "0.1.0";
const STDIO_BUFFER_LIMIT = 4096;

function defaultChromePath() {
  if (process.platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "/usr/bin/google-chrome";
}
function defaultServerScript() {
  return path.join(os.homedir(), ".dsh", "chrome-mcp", "server.js");
}

/**
 * Plugin Config (schemastery). Empty strings mean "use the built-in default"
 * so the section renders sensibly with an empty config.
 */
const Config = z.object({
  chromePath: z.string().default("").comment("Path to the Chrome executable. Empty = platform default."),
  serverScript: z.string().default("").comment("Path to the Chrome MCP server script. Empty = ~/.dsh/chrome-mcp/server.js."),
  engine: z.string().default("ddg").comment("Search engine: ddg (DuckDuckGo HTML endpoint), bing, or google."),
  maxResults: z.number().step(1).min(1).max(25).default(8).comment("Result cap used when the caller does not specify one."),
  headless: z.boolean().default(true).comment("Run Chrome headless. Set false for a visible browser window (debugging)."),
  searchTimeoutMs: z.number().step(1).min(1000).max(300000).default(60000).comment("Per-search timeout in milliseconds.")
});

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function resolveOptions(ctx, config) {
  return {
    chromePath: ((config?.chromePath ?? "") + "").trim() || defaultChromePath(),
    serverScript: ((config?.serverScript ?? "") + "").trim() || defaultServerScript(),
    engine: ((config?.engine ?? "ddg") + "").trim().toLowerCase() || "ddg",
    maxResults: positiveInt(config?.maxResults, 8, 1, 25),
    headless: config?.headless !== false,
    searchTimeoutMs: positiveInt(config?.searchTimeoutMs, 60000, 1000, 300000)
  };
}

/** Abort surfaced as the seam's abort code, retaining the caller's reason. */
function searchAborted(signal, fallback) {
  return new WebError("chrome-mcp search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal);
}
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error) {
  if (error instanceof Error) {
    const extra = error.cause ? " (cause: " + errorMessage(error.cause) + ")" : "";
    return error.message + extra;
  }
  return String(error);
}

function textContent(result) {
  return ((result?.content) ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

/**
 * Validate the MCP callTool result. Throws WebError for protocol-level
 * failures; returns the parsed payload ({results: [...], error?}) otherwise.
 */
function parseSearchPayload(result) {
  if (result?.isError === true) {
    throw new WebError(textContent(result) || "chrome-mcp reported a search error", "CHROME_MCP_ERROR");
  }
  let payload = result?.structuredContent;
  if (payload == null || typeof payload !== "object") {
    const text = textContent(result);
    try {
      payload = JSON.parse(text || "{}");
    } catch {
      throw new WebError("chrome-mcp returned an unparseable search payload", "CHROME_MCP_ERROR");
    }
  }
  if (!Array.isArray(payload.results)) {
    throw new WebError("chrome-mcp returned a payload without a results[] array", "CHROME_MCP_ERROR");
  }
  return payload;
}

/** Dedupe by url, drop entries without a url, keep first-seen order. */
function dedupeSources(results) {
  const seen = new Set();
  const sources = [];
  for (const entry of results) {
    if (!entry || typeof entry.url !== "string" || entry.url.length === 0) continue;
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    sources.push({
      url: entry.url,
      ...(typeof entry.title === "string" && entry.title.length > 0 ? { title: entry.title } : {}),
      ...(typeof entry.snippet === "string" && entry.snippet.length > 0 ? { snippet: entry.snippet } : {})
    });
  }
  return sources;
}

function disposeSessionQuietly(session) {
  session.dead = true;
  const client = session.client;
  session.client = null;
  if (!client) return Promise.resolve();
  return client.close().catch(() => {});
}

class ChromeMcpSearchProvider {
  #resolveOptions;
  #session = null;
  #ensuring = null;

  constructor(resolveOptions) {
    this.#resolveOptions = resolveOptions;
  }

  get id() {
    return CHROME_MCP_PROVIDER_ID;
  }

  /**
   * Cheap availability probe - no network, no spawn. False when the Chrome
   * executable or the MCP server script is missing; the seam then treats this
   * provider as absent (or, when explicitly configured, fails loud with
   * WEB_PROVIDER_CONFIGURED_UNAVAILABLE).
   */
  available() {
    let options;
    try {
      options = this.#resolveOptions();
    } catch {
      return false;
    }
    try {
      return existsSync(options.chromePath) && existsSync(options.serverScript);
    } catch {
      return false;
    }
  }

  async search(request, signal) {
    const options = this.#resolveOptions();
    throwIfSearchAborted(signal);
    if (!existsSync(options.chromePath)) {
      throw new WebError("chrome-mcp is unavailable: Chrome executable not found at " + options.chromePath, "WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
    }
    if (!existsSync(options.serverScript)) {
      throw new WebError("chrome-mcp is unavailable: MCP server script not found at " + options.serverScript, "WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
    }
    if (!ENGINES.has(options.engine)) {
      throw new WebError('chrome-mcp: unknown engine "' + options.engine + '" (expected ddg, bing, or google)', "WEB_PROVIDER_ERROR");
    }
    const query = ((request?.query ?? "") + "").trim();
    if (query.length === 0) throw new WebError("chrome-mcp: empty search query", "WEB_PROVIDER_ERROR");
    const callerMax = positiveInt(request?.maxResults, 0, 1, 1000);
    const maxResults = Math.min(callerMax || options.maxResults, 25);

    let session = null;
    try {
      session = await this.#ensureSession(options, signal);
      throwIfSearchAborted(signal);
      const result = await this.#callTool(session, {
        name: "search",
        arguments: { query, engine: options.engine, maxResults }
      }, signal, options.searchTimeoutMs);
      const payload = parseSearchPayload(result);
      if (payload.error) {
        throw new WebError("Chrome search produced no results for \"" + query + "\" (engine: " + options.engine + ") - " + payload.error, "WEB_PROVIDER_ERROR");
      }
      const sources = dedupeSources(payload.results);
      if (sources.length === 0) {
        throw new WebError("Chrome search produced no results for \"" + query + "\" (engine: " + options.engine + ")", "WEB_PROVIDER_ERROR");
      }
      return {
        content: "Web search via Chrome (engine: " + options.engine + ") for \"" + query + "\" returned " + sources.length + " source(s).",
        sources,
        truncated: false
      };
    } catch (error) {
      // Protocol/transport failures mean the session is suspect: drop it so
      // the next search respawns. Timeouts and aborts leave the stdio child
      // healthy, so keep it.
      if (session && !(error instanceof WebError && (error.code === "WEB_ABORTED" || error.code === "WEB_TIMEOUT"))) {
        this.#killSession(session);
      }
      throw error;
    }
  }

  /** Close the MCP client (and therefore the server + Chrome child). Idempotent. */
  dispose() {
    this.#ensuring = null;
    const session = this.#session;
    this.#session = null;
    if (session) return disposeSessionQuietly(session);
    return Promise.resolve();
  }

  #killSession(session) {
    if (this.#session === session) this.#session = null;
    if (this.#ensuring?.promise === session) this.#ensuring = null;
    return disposeSessionQuietly(session);
  }

  /**
   * Lazily start (or reuse) the MCP client session. Keyed by the settings that
   * affect the child process; a settings change disposes the old session.
   */
  async #ensureSession(options, signal) {
    const key = [options.serverScript, options.chromePath, String(options.headless)].join("|");
    const existing = this.#session;
    if (existing && !existing.dead && existing.key === key) return existing;
    if (existing) {
      this.#session = null;
      await disposeSessionQuietly(existing);
    }
    const pending = this.#ensuring;
    if (pending && pending.key === key) return await pending.promise;

    const session = { key, client: null, transport: null, dead: false, stderrTail: "" };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [options.serverScript],
      env: {
        ...process.env,
        CHROME_PATH: options.chromePath,
        CHROME_MCP_HEADLESS: options.headless ? "1" : "0"
      },
      stderr: "pipe"
    });
    const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
    const promise = (async () => {
      try {
        await client.connect(transport);
      } catch (error) {
        session.dead = true;
        const detail = session.stderrTail.trim().length > 0 ? " (server stderr: " + session.stderrTail.trim().slice(-300) + ")" : "";
        await client.close().catch(() => {});
        throw new WebError("failed to start the Chrome MCP server (" + options.serverScript + "): " + errorMessage(error) + detail, "CHROME_MCP_ERROR");
      }
      if (session.dead) {
        await client.close().catch(() => {});
        throw new WebError("chrome-mcp session was cancelled during startup", "WEB_ABORTED");
      }
      session.client = client;
      session.transport = transport;
      const stderr = transport.stderr;
      if (stderr) {
        stderr.on("data", (chunk) => {
          session.stderrTail = (session.stderrTail + chunk.toString()).slice(-STDIO_BUFFER_LIMIT);
        });
      }
      const replaced = this.#session;
      this.#session = session;
      if (replaced && replaced !== session && !replaced.dead) void disposeSessionQuietly(replaced);
      return session;
    })();
    this.#ensuring = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.#ensuring?.promise === promise) this.#ensuring = null;
    }
  }

  /**
   * callTool with native SDK cancellation/timeout plus an independent backstop
   * timer (guards against the SDK's own timer misbehaving).
   */
  #callTool(session, params, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        signal?.removeEventListener("abort", onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, searchAborted(signal));
      if (signal?.aborted === true) return finish(reject, searchAborted(signal));
      const backstop = setTimeout(
        () => finish(reject, new WebError("chrome-mcp search timed out after " + Math.round(timeoutMs / 1000) + "s", "WEB_TIMEOUT")),
        timeoutMs + 5000
      );
      if (typeof backstop.unref === "function") backstop.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      session.client
        .callTool(params, undefined, { timeout: timeoutMs, ...signal !== undefined ? { signal } : {} })
        .then(
          (value) => finish(resolve, value),
          (error) => {
            if (signal?.aborted === true || isAbortError(error)) return finish(reject, searchAborted(signal, error));
            if (String(error?.message ?? error).includes("RequestTimeout") || String(error?.code ?? "") === "-32001") {
              return finish(reject, new WebError("chrome-mcp search timed out after " + Math.round(timeoutMs / 1000) + "s", "WEB_TIMEOUT", { cause: error }));
            }
            finish(reject, new WebError("Chrome MCP call failed: " + errorMessage(error), "CHROME_MCP_ERROR", { cause: error }));
          }
        );
    });
  }
}

/**
 * Plugin entry: install the settings section, register the provider on the
 * web seam, and tear the MCP client down with the fiber.
 */
function apply(ctx, config) {
  // DSH 0.2: plugin settings come from the profile plugin config (this Config schema).
  const current = () => config;
  const provider = new ChromeMcpSearchProvider(() => resolveOptions(ctx, current()));
  ctx.web.registerSearchProvider(provider);
  ctx.effect(() => () => provider.dispose(), "web-search-chrome-mcp:dispose");
}

export { name, inject, Config, apply };
export default { name, inject, Config, apply };
