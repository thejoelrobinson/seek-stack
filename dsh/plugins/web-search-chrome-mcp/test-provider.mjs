#!/usr/bin/env node
/**
 * T4: provider isolation test - exercises the plugin (apply + provider) with a
 * fake ctx: registration, available() matrix, live search, abort/invalid
 * configs, and dispose. Run: node test-provider.mjs
 */
import { fileURLToPath } from "node:url";
import mod from "./lib/index.js";
import { WebError } from "@deepseek-ai/dsh-web";

const t0 = Date.now();
let pass = 0, failCount = 0;
const ok = (msg) => { pass++; console.log("  ok  - " + msg); };
const bad = (msg) => { failCount++; console.log("  FAIL- " + msg); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));
const guard = setTimeout(() => { console.log("FAIL: hard timeout"); process.exit(1); }, 150000);

// ── fake ctx ─────────────────────────────────────────────────────────────
function makeCtx(config) {
  const registered = [];
  const effects = [];
  const ctx = {
    web: {
      registerSearchProvider: (p) => {
        registered.push(p);
        return () => { const i = registered.indexOf(p); if (i >= 0) registered.splice(i, 1); };
      }
    },
    effect: (fn, label) => { const d = fn(); const rec = { label, dispose: d }; effects.push(rec); return () => { if (rec.dispose) rec.dispose(); }; },
    inject: (names, cb) => {
      const sctx = {
        settings: {
          register: (ns, schema, opts) => ({
            ns,
            get: () => opts?.base ?? {},
            watch: () => () => {}
          })
        },
        effect: (fn) => { const d = fn(); return () => { if (d) d(); }; }
      };
      const scope = cb(sctx);
      return () => { if (scope?.dispose) scope.dispose(); };
    }
  };
  return { ctx, registered, effects };
}

console.log("T4: provider isolation (fake ctx)");
check(mod.name === "web-search-chrome-mcp", "export name");
check(Array.isArray(mod.inject) && mod.inject.includes("web"), "export inject includes web");
check(mod.Config["~standard"]?.vendor === "schemastery" && typeof mod.Config["~standard"]?.validate === "function", "Config exposes schemastery ~standard (v1 descriptor + validate)");

const { ctx, registered, effects } = makeCtx({});
mod.apply(ctx, {});
check(registered.length === 1, "apply registered exactly one provider");
const provider = registered[0];
check(provider?.id === "chrome-mcp", "provider id is chrome-mcp");
check(effects.length === 1 && /dispose/.test(effects[0].label), "apply registered a dispose effect");

// ── available() matrix ───────────────────────────────────────────────────
check(provider.available() === true, "available() true with defaults (chrome + script present)");
const noChromeCfg = { chromePath: "C:\definitely-not-chrome.exe" };
const noChrome = makeCtx(noChromeCfg);
mod.apply(noChrome.ctx, noChromeCfg);
const p2 = noChrome.registered[0];
check(p2.available() === false, "available() false when chromePath missing");
const noScriptCfg = { serverScript: "C:\definitely-not-a-server.js" };
const noScript = makeCtx(noScriptCfg);
mod.apply(noScript.ctx, noScriptCfg);
const p3 = noScript.registered[0];
check(p3.available() === false, "available() false when serverScript missing");

// ── live search ──────────────────────────────────────────────────────────
const ctrl = new AbortController();
const result = await provider.search({ query: "deepseek ai company", maxResults: 4 }, ctrl.signal);
check(Array.isArray(result.sources) && result.sources.length > 0 && result.sources.length <= 4, "live search returned 1..4 sources (got " + (result.sources?.length ?? 0) + ")");
check(result.sources.every((s) => /^https?:\/\//.test(s.url) && typeof s.title === "string"), "every source has http(s) url + title");
check(typeof result.content === "string" && result.content.includes("Chrome") && result.content.includes("ddg"), "content summarizes engine + provider");
console.log("  sample:", JSON.stringify(result.sources[0]).slice(0, 200));

// ── abort before the call ───────────────────────────────────────────────
const aborted = new AbortController();
aborted.abort(new Error("user cancelled"));
let abortedErr = null;
try { await provider.search({ query: "x" }, aborted.signal); } catch (e) { abortedErr = e; }
check(abortedErr instanceof WebError && abortedErr.code === "WEB_ABORTED", "pre-aborted signal -> WEB_ABORTED (" + (abortedErr?.code ?? "none") + ")");

// ── unknown engine fails loud ────────────────────────────────────────────
const badEngineCfg = { engine: "yahoo" };
const badEngine = makeCtx(badEngineCfg);
mod.apply(badEngine.ctx, badEngineCfg);
let engineErr = null;
try { await badEngine.registered[0].search({ query: "x" }, new AbortController().signal); } catch (e) { engineErr = e; }
check(engineErr instanceof WebError && engineErr.code === "WEB_PROVIDER_ERROR", "unknown engine -> WEB_PROVIDER_ERROR (" + (engineErr?.code ?? "none") + ")");

// ── missing chrome fails loud on search ──────────────────────────────────
let unavailErr = null;
try { await p2.search({ query: "x" }, new AbortController().signal); } catch (e) { unavailErr = e; }
check(unavailErr instanceof WebError && unavailErr.code === "WEB_PROVIDER_CONFIGURED_UNAVAILABLE", "missing chrome on search -> WEB_PROVIDER_CONFIGURED_UNAVAILABLE (" + (unavailErr?.code ?? "none") + ")");

// ── dispose ──────────────────────────────────────────────────────────────
await provider.dispose();
ok("dispose() resolved");
check(p2.dispose && typeof p2.dispose === "function", "provider exposes dispose");
await p2.dispose().catch(() => {});
await p3.dispose().catch(() => {});

clearTimeout(guard);
console.log("T4: " + pass + " passed, " + failCount + " failed | " + (Date.now() - t0) + "ms");
process.exit(failCount === 0 ? 0 : 1);
