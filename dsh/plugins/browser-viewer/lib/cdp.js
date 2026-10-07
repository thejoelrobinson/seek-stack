/**
 * cdp.js — minimal CDP browser controller for the dsh browser plugin.
 *
 * Adapted from ~/.dsh/chrome-mcp/server.js (proven launch + id-matched send
 * over the Node >=22 global WebSocket). Extended with:
 *   - a PERSISTENT --user-data-dir so site logins survive restarts,
 *   - Page.startScreencast frame streaming (JPEG),
 *   - Input.dispatchMouseEvent / Input.dispatchKeyEvent for user driving,
 *   - tab (target) management: attach, navigate, evaluate, screenshot.
 *
 * No external dependencies. Node >= 22 only (global WebSocket).
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CDP_CALL_TIMEOUT_MS = 30000;
const METRICS_WAIT_MS = 3000, METRICS_STALLED = Symbol('metrics stalled');
const CAPTURE_WAIT_MS = 800;
export const CAPTURE_STALLED = 'capture stalled';
const CHROME_START_TIMEOUT_MS = 25000;
const LOAD_TIMEOUT_MS = 20000;

function defaultChromePath() {
  if (process.platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "/usr/bin/google-chrome";
}

function realisticUserAgent(chromeMajor) {
  const major = chromeMajor ?? "153.0.0.0";
  const base =
    process.platform === "win32"
      ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
      : process.platform === "darwin"
        ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
        : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/";
  return base + major + " Safari/537.36";
}

export class CdpBrowser {
  constructor(opts = {}) {
    this.chromePath = opts.chromePath ?? process.env.CHROME_PATH ?? defaultChromePath();
    // Persistent profile dir — logins survive restarts.
    this.userDataDir =
      opts.userDataDir ??
      process.env.DSH_BROWSER_USER_DATA_DIR ??
      path.join(os.homedir(), ".dsh", "browser", "profile");
    this.headless = opts.headless ?? (process.env.DSH_BROWSER_HEADLESS ?? "1") !== "0";
    this.userAgent = opts.userAgent ?? process.env.DSH_BROWSER_USER_AGENT ?? realisticUserAgent();
    this.windowSize = opts.windowSize ?? "1366,900";

    this.child = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.listeners = new Map(); // "sessionId:method" -> Set<fn>
    this.lostReason = null;
    this.endpoint = null;
    // Attached page targets: tabId -> sessionId
    this.tabs = new Map();
    this.visualCalls = new Map();
    this.resourceResponses = new Map();
    this.fontBodies = new Map();this.fontBytes=0;
  }

  get alive() {
    return this.ws !== null && this.lostReason === null;
  }

  launch() {
    return new Promise(async (resolve, reject) => {
      try {
        mkdirSync(this.userDataDir, { recursive: true });
        const args = [
          this.headless ? "--headless=new" : "",
          "--remote-debugging-port=0",
          "--user-data-dir=" + this.userDataDir,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-sync",
          "--disable-component-update",
          "--metrics-recording-off",
          "--window-size=" + this.windowSize,
          "--disable-blink-features=AutomationControlled",
          "--user-agent=" + this.userAgent,
          "about:blank",
        ].filter(Boolean);

        const child = spawn(this.chromePath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        this.child = child;
        let stderr = "";
        const endpoint = await new Promise((res, rej) => {
          const timer = setTimeout(() => {
            rej(new Error("Chrome did not report its DevTools endpoint within " + (CHROME_START_TIMEOUT_MS / 1000) + "s. stderr: " + stderr.slice(0, 400)));
          }, CHROME_START_TIMEOUT_MS);
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (m) { clearTimeout(timer); res(m[1]); }
          });
          child.on("error", (e) => { clearTimeout(timer); rej(new Error("could not start Chrome at " + this.chromePath + ": " + e.message)); });
          child.on("exit", (code) => { clearTimeout(timer); rej(new Error("Chrome exited before reporting its DevTools endpoint (code " + code + "): " + stderr.slice(0, 400))); });
        });
        this.child = child;
        this.endpoint = endpoint;
        await this.connect(endpoint);
        child.on("exit", () => this.drop("chrome process exited"));
        child.on("error", () => {});
        resolve(this);
      } catch (e) {
        this.drop('launch failed');
        reject(e);
      }
    });
  }

  connect(endpoint) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("DevTools WebSocket connection failed"));
      ws.onclose = () => this.drop("browser websocket closed");
      ws.onmessage = (ev) => {
        try { this.onMessage(typeof ev.data === "string" ? ev.data : ""); } catch {}
      };
    });
  }

  send(method, params, sessionId) {
    // Capture temporarily overrides viewport metrics. Related targets can share a
    // renderer; serialize captures and metric writes across this browser connection.
    if(['Page.captureScreenshot','Emulation.setDeviceMetricsOverride','Emulation.clearDeviceMetricsOverride'].includes(method)){
      const key='browser',previous=this.visualCalls.get(key)||Promise.resolve(),call=previous.catch(()=>{}).then(()=>method==='Emulation.setDeviceMetricsOverride'?this._metrics(params,sessionId):method==='Page.captureScreenshot'?this._capture(params,sessionId):this._send(method,params,sessionId));this.visualCalls.set(key,call);
      const done=()=>{if(this.visualCalls.get(key)===call)this.visualCalls.delete(key);};void call.then(done,done);return call;
    }
    return this._send(method,params,sessionId);
  }

  // Chrome sometimes leaves a metrics override on a tab that is just navigating unanswered until the
  // 30 s call timeout, and every capture and action queues behind it. Wait briefly, ask once more,
  // then carry on: the override still applies when Chrome gets to it.
  async _metrics(params, sessionId) {
    for (let attempt = 0; ; attempt++) {
      const call = this._send('Emulation.setDeviceMetricsOverride', params, sessionId); call.catch(() => {});
      const result = await Promise.race([call, new Promise(r => setTimeout(() => r(METRICS_STALLED), METRICS_WAIT_MS))]);
      if (result !== METRICS_STALLED) return result;
      if (attempt) return {};
    }
  }

  // A page going into the back/forward cache (or otherwise not drawing) can leave a capture unanswered for
  // seconds; skip that picture instead of holding every later capture and resize behind it.
  async _capture(params, sessionId) {
    const call = this._send('Page.captureScreenshot', params, sessionId); call.catch(() => {});
    const result = await Promise.race([call, new Promise(r => setTimeout(() => r(METRICS_STALLED), CAPTURE_WAIT_MS))]);
    if (result === METRICS_STALLED) throw new Error(CAPTURE_STALLED);
    return result;
  }

  _send(method, params, sessionId) {
    if (!this.alive) return Promise.reject(new Error("browser session is not alive" + (this.lostReason ? " (" + this.lostReason + ")" : "")));
    const id = this.nextId++;
    const frame = { id, method, params: params ?? {} };
    if (sessionId !== undefined) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CDP call timed out: " + method)); }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify(frame)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); this.drop("browser websocket send failed"); reject(e); }
    });
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if(msg.method==='Network.responseReceived'&&['Image','Font'].includes(msg.params?.type)&&msg.params.response?.status===200){const p=msg.params,key=msg.sessionId+'\n'+p.frameId+'\n'+p.response.url;this.resourceResponses.delete(key);this.resourceResponses.set(key,{requestId:p.requestId,mimeType:p.response.mimeType,sessionId:msg.sessionId,kind:p.type});while(this.resourceResponses.size>500)this.resourceResponses.delete(this.resourceResponses.keys().next().value);}
    if(msg.method==='Network.loadingFinished'){const entry=[...this.resourceResponses].find(([,r])=>r.kind==='Font'&&r.sessionId===msg.sessionId&&r.requestId===msg.params.requestId);if(entry)void this.cacheFont(...entry);}
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error("CDP error " + (msg.error.code ?? "") + ": " + (msg.error.message ?? "unknown")));
      else p.resolve(msg.result);
    } else if (msg.method) {
      const set = this.listeners.get((msg.sessionId ?? "") + ":" + msg.method);
      if (set) for (const fn of [...set]) { try { fn(msg.params); } catch {} }
    }
  }

  async cacheFont(key,row){try{if(!/^(?:font\/|application\/(?:font-woff2?|vnd.ms-fontobject|x-font-ttf|x-font-opentype)$)/i.test(row.mimeType))return;const result=await this._send('Network.getResponseBody',{requestId:row.requestId},row.sessionId),data=Buffer.from(result.body,result.base64Encoded?'base64':'utf8');if(!this.alive||data.length>10*1024*1024)return;const previous=this.fontBodies.get(key);if(previous)this.fontBytes-=previous.data.length;this.fontBodies.delete(key);this.fontBodies.set(key,{data,type:row.mimeType,sessionId:row.sessionId});this.fontBytes+=data.length;while(this.fontBytes>10*1024*1024){const [id,r]=this.fontBodies.entries().next().value;this.fontBytes-=r.data.length;this.fontBodies.delete(id);}}catch{}}

  /** Subscribe to a CDP event for a given session (or browser level). */
  onEvent(sessionId, method, fn) {
    const key = (sessionId ?? "") + ":" + method;
    const set = this.listeners.get(key) ?? new Set();
    set.add(fn);
    this.listeners.set(key, set);
    return () => { set.delete(fn); };
  }

  drop(reason) {
    if (this.lostReason !== null) return;
    this.lostReason = reason;
    const ws = this.ws;
    this.ws = null;
    for (const p of this.pending.values()) p.reject(new Error("browser session lost: " + reason));
    this.pending.clear();
    this.visualCalls.clear();
    this.resourceResponses.clear();
    this.fontBodies.clear();this.fontBytes=0;
    if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {} }
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
    try{this.onDrop?.(reason);}catch{}
  }

  async close() {
    const child = this.child;
    this.drop("shutting down");
    if (child) {
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 3000);
        child.once("exit", () => { clearTimeout(t); resolve(); });
      });
    }
  }

  // ── tab management ──────────────────────────────────────────────────────────

  async newTab(url) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    await this.attachTab(targetId);
    if (url && url !== 'about:blank') await this.navigate(targetId, url);
    return targetId;
  }

  async attachTab(targetId) {
    if (this.tabs.has(targetId)) return targetId;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Page.enable", {}, sessionId);
    // Page dialogs and file pickers would open invisibly in this Chrome and stall the page; the owner answers them instead.
    this.onEvent(sessionId, "Page.javascriptDialogOpening", (p) => this.onDialog?.(targetId, p));
    this.onEvent(sessionId, "Page.javascriptDialogClosed", () => this.onDialog?.(targetId, null));
    this.onEvent(sessionId, "Page.fileChooserOpened", (p) => this.onFileChooser?.(targetId, p));
    await this.send("Page.setInterceptFileChooserDialog", {enabled: true}, sessionId).catch(() => {});
    await this.send("Runtime.enable", {}, sessionId);
    await this.send('Network.enable',{maxTotalBufferSize:10*1024*1024,maxResourceBufferSize:10*1024*1024},sessionId);
    this.tabs.set(targetId, sessionId);
    const [width, height] = this.windowSize.split(',').map(Number);
    await this.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false}, sessionId);
    return targetId;
  }

  async listTabs() {
    const {targetInfos} = await this.send('Target.getTargets');
    return targetInfos.filter(t => t.type === 'page').map(t => ({id:t.targetId,url:t.url,title:t.title}));
  }

  async closeTab(targetId) {
    const sessionId = this.tabs.get(targetId);
    this.tabs.delete(targetId);
    for(const [key,r]of this.resourceResponses)if(r.sessionId===sessionId)this.resourceResponses.delete(key);
    for(const [key,r]of this.fontBodies)if(r.sessionId===sessionId){this.fontBytes-=r.data.length;this.fontBodies.delete(key);}
    if (sessionId) await this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    await this.send("Target.closeTarget", { targetId }).catch(() => {});
  }

  async reload(tabId){
    const sessionId=this.tabs.get(tabId);if(!sessionId)throw new Error('unknown tab '+tabId);let finish;
    const loaded=new Promise(resolve=>{const off=this.onEvent(sessionId,'Page.domContentEventFired',()=>finish()),timer=setTimeout(()=>finish(),LOAD_TIMEOUT_MS);finish=()=>{clearTimeout(timer);off();resolve();};});
    try{await this.send('Page.reload',{},sessionId);await loaded;}finally{finish();}
  }

  async navigate(tabId, url) {
    const sessionId = this.tabs.get(tabId);
    if (!sessionId) throw new Error("unknown tab " + tabId);
    // Wait for the load event if the page is loading.
    let finish;
    const loaded = new Promise((resolve) => {
      const off = this.onEvent(sessionId, "Page.domContentEventFired", () => finish());
      const timer = setTimeout(() => finish(), LOAD_TIMEOUT_MS);
      finish = () => { clearTimeout(timer); off(); resolve(); };
    });
    try {
      const result = await this.send("Page.navigate", { url }, sessionId);
      if (result.errorText) throw new Error('Navigation failed: ' + result.errorText);
      if (!result.loaderId) finish(); // Same-document / fragment navigation.
      await loaded;
    } finally { finish(); }
    return url;
  }

  async evaluate(tabId, expression) {
    const sessionId = this.tabs.get(tabId);
    if (!sessionId) throw new Error("unknown tab " + tabId);
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
      throw new Error("evaluate failed: " + desc);
    }
    return result.result?.value;
  }

  async screenshot(tabId, { format = "jpeg", quality = 80 } = {}) {
    const sessionId = this.tabs.get(tabId);
    if (!sessionId) throw new Error("unknown tab " + tabId);
    const { data } = await this.send("Page.captureScreenshot", { format, quality, captureBeyondViewport: false }, sessionId);
    return data; // base64
  }

  /**
   * Start streaming JPEG frames via Page.startScreencast.
   * onFrame(base64Jpeg, metadata) is called for each frame.
   * Returns a stop() function.
   */
  startScreencast(tabId, { format = "jpeg", quality = 60, maxWidth = 1280, maxHeight = 800, everyNthFrame = 1, onFrame } = {}) {
    const sessionId = this.tabs.get(tabId);
    if (!sessionId) throw new Error("unknown tab " + tabId);
    let stopped = false;
    let active = false;

    const off = this.onEvent(sessionId, "Page.screencastFrame", (params) => {
      if (stopped) return;
      try { this.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {}); } catch {}
      onFrame?.(params.data, params);
      // Keep the stream going (Chrome pauses until we request the next frame;
      // ack + a fresh startScreencast isn't needed — ack keeps it flowing).
    });

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      off();
      if (active) { await this.send("Page.stopScreencast", {}, sessionId).catch(() => {}); active = false; }
    };

    active = true;
    void this.send("Page.startScreencast", { format, quality, maxWidth, maxHeight, everyNthFrame }, sessionId).catch(() => {});
    return stop;
  }

  // ── user input (forwarded from the GUI) ─────────────────────────────────────

  async mouseEvent(tabId, type, x, y, { button = "none", clickCount = 1, modifiers = 0 } = {}) {
    const sessionId = this.tabs.get(tabId);
    if (!sessionId) throw new Error("unknown tab " + tabId);
    await this.send("Input.dispatchMouseEvent", {
      type, x: Math.round(x), y: Math.round(y), button, clickCount, modifiers,
    }, sessionId);
  }

  async keyEvent(tabId, type, { key, text, code, windowsVirtualKeyCode, modifiers = 0, autoRepeat = false } = {}) {
    const sessionId = this.tabs.get(tabId);
    if (!sessionId) throw new Error("unknown tab " + tabId);
    await this.send("Input.dispatchKeyEvent", {
      type, key, text, code, windowsVirtualKeyCode, modifiers, autoRepeat,
    }, sessionId);
  }

  /** Convenience: type a string into the focused element. */
  async typeText(tabId, text) {
    const sessionId = this.tabs.get(tabId);
    if (!sessionId) throw new Error('unknown tab ' + tabId);
    await this.send('Input.insertText', { text }, sessionId);
  }
}

export { realisticUserAgent, defaultChromePath };
