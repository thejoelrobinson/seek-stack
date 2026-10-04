/**
 * dsh-browser-viewer — client face (browser classic script).
 *
 * A self-contained floating "Browser" overlay appended to <body>. It opens a
 * fenced WebSocket to /browser/stream, renders the host's JPEG frames on a
 * canvas, and forwards mouse/keyboard back to the host (which drives the
 * shared CDP browser). No React, no injected services: the UI is raw DOM and
 * the only transport is the WebSocket.
 *
 * Per the client-modules lazy-CJS contract, this factory body is the module's
 * side effect — it runs at materialization (the shell imports us at boot via
 * `dsh.client.immediately: true`), NOT at script execution.
 */
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-browser-viewer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		function buildOverlay() {
			var doc = document;
			if (doc.getElementById("dsh-bv-fab")) return; // idempotent

			// ── styles ─────────────────────────────────────────────────────────
			var style = doc.createElement("style");
			style.setAttribute("data-plugin", "@deepseek-ai/dsh-browser-viewer");
			style.textContent = [
				"#dsh-bv-fab{position:fixed;top:14px;right:14px;z-index:2147483646;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:#1c2027;color:#e6e9ef;font-size:19px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}",
				"#dsh-bv-fab:hover{background:#242a33}",
				"#dsh-bv-panel{position:fixed;top:64px;right:14px;z-index:2147483646;width:min(760px,calc(100vw - 28px));max-height:calc(100dvh - 78px);display:flex;flex-direction:column;background:#0f1216;border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.6);color:#e6e9ef;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden}",
				"#dsh-bv-panel[hidden]{display:none}",
				".dsh-bv-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#151a20;border-bottom:1px solid rgba(255,255,255,.08)}",
				".dsh-bv-dot{width:9px;height:9px;border-radius:50%;background:#5b626d;flex:none}",
				".dsh-bv-dot.on{background:#3ecf7a;box-shadow:0 0 6px #3ecf7a}",
				".dsh-bv-title{font-weight:600;letter-spacing:.2px}",
				".dsh-bv-head .dsh-bv-spacer{flex:1}",
				".dsh-bv-iconbtn{width:26px;height:26px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:#1c2129;color:#cfd5dd;cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center}",
				".dsh-bv-iconbtn:hover{background:#262d37}",
				".dsh-bv-iconbtn:disabled{opacity:.4;cursor:default}",
				".dsh-bv-bar{display:flex;gap:6px;flex-wrap:wrap;padding:8px 10px;background:#11151a;border-bottom:1px solid rgba(255,255,255,.06)}",
				"#dsh-bv-addr{flex:1;min-width:0;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:#0b0e12;color:#e6e9ef;padding:0 10px;font-size:12px;outline:none}",
				"#dsh-bv-addr:focus{border-color:#4b8bff}",
				".dsh-bv-btn{height:28px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:#1c2129;color:#cfd5dd;cursor:pointer;padding:0 12px;font-size:12px;flex:none}",
				".dsh-bv-btn:hover{background:#262d37}",
				".dsh-bv-btn.go{background:#2f6feb;border-color:#2f6feb;color:#fff}",
				".dsh-bv-btn.go:hover{background:#3b78f5}",
				".dsh-bv-canvaswrap{position:relative;background:#05070a;flex:1;min-height:240px;display:flex;align-items:center;justify-content:center;overflow:hidden}",
				"#dsh-bv-canvas{display:block;max-width:100%;max-height:100%;object-fit:contain;cursor:default;outline:none}",
				"#dsh-bv-canvas:focus{box-shadow:inset 0 0 0 2px #2f6feb}",
				".dsh-bv-canvas-empty{position:absolute;color:#5b626d;font-size:13px;pointer-events:none}",
				".dsh-bv-foot{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#11151a;border-top:1px solid rgba(255,255,255,.06);font-size:12px}",
				".dsh-bv-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa4b2}",
				".dsh-bv-err{color:#ff6b6b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}"
			].join("\n");
			doc.head.appendChild(style);

			// ── elements ───────────────────────────────────────────────────────
			var root = doc.createElement("button");
			root.id = "dsh-bv-fab";
			root.title = "Open browser";
			root.setAttribute("aria-label", "Open browser");
			root.textContent = "\u{1F310}";
			doc.body.appendChild(root);
			if (!location.pathname.startsWith('/work')) {
				var workLink = doc.createElement('a');
				workLink.id = 'dsh-work-link'; workLink.href = '/work'; workLink.textContent = 'Work';
				workLink.style.cssText = 'position:fixed;top:18px;right:67px;z-index:2147483646;background:#ede7f5;color:#66517f;border:1px solid #d7cce5;border-radius:20px;padding:7px 16px;font:13px system-ui;text-decoration:none';
				doc.body.appendChild(workLink);
			}

			var panel = doc.createElement("div");
			panel.id = "dsh-bv-panel";
			panel.hidden = true;

			var head = doc.createElement("div");
			head.className = "dsh-bv-head";
			var dot = doc.createElement("span");
			dot.className = "dsh-bv-dot";
			var title = doc.createElement("span");
			title.className = "dsh-bv-title";
			title.textContent = "Browser";
			var activity = doc.createElement("span");
			activity.style.cssText = "color:#9aa4b2;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
			var pauseBtn = doc.createElement("button");
			pauseBtn.className = "dsh-bv-btn";
			pauseBtn.textContent = "Take control";
			pauseBtn.title = "Pause the agent while you use the browser";
			var paused = false;
			var approveBtn = doc.createElement("button");
			approveBtn.className = "dsh-bv-btn go";
			approveBtn.textContent = "Approve once";
			approveBtn.hidden = true;
			var rejectBtn = doc.createElement("button");
			rejectBtn.className = "dsh-bv-btn";
			rejectBtn.textContent = "Reject";
			rejectBtn.hidden = true;
			var expandBtn = iconBtn("⛶", "Expand browser");
			var spacer = doc.createElement("span");
			spacer.className = "dsh-bv-spacer";
			var closeBtn = doc.createElement("button");
			closeBtn.className = "dsh-bv-iconbtn";
			closeBtn.textContent = "\u00d7";
			closeBtn.title = "Close";
			head.appendChild(dot);
			head.appendChild(title);
			head.appendChild(activity);
			head.appendChild(spacer);
			head.appendChild(approveBtn);
			head.appendChild(rejectBtn);
			head.appendChild(pauseBtn);
			head.appendChild(expandBtn);
			head.appendChild(closeBtn);

			var bar = doc.createElement("div");
			bar.className = "dsh-bv-bar";
			var backBtn = iconBtn("\u2190", "Back");
			var fwdBtn = iconBtn("\u2192", "Forward");
			var reloadBtn = iconBtn("\u21bb", "Reload");
			var addr = doc.createElement("input");
			addr.id = "dsh-bv-addr";
			addr.placeholder = "https://…";
			addr.setAttribute("aria-label", "Browser address");
			addr.setAttribute("spellcheck", "false");
			var goBtn = doc.createElement("button");
			goBtn.className = "dsh-bv-btn go";
			goBtn.textContent = "Go";
			var newTabBtn = iconBtn("+", "New tab");
			var tabsBtn = doc.createElement("select");
			tabsBtn.setAttribute("aria-label", "Browser tabs");
			tabsBtn.style.cssText = "max-width:180px;min-width:60px;background:#1c2129;color:#cfd5dd;border:1px solid #394252;border-radius:6px";
			var closeTabBtn = iconBtn("×", "Close active tab");
			var startBtn = doc.createElement("button");
			startBtn.className = "dsh-bv-btn";
			startBtn.textContent = "Start";
			var stopBtn = doc.createElement("button");
			stopBtn.className = "dsh-bv-btn";
			stopBtn.textContent = "Stop";
			[backBtn, fwdBtn, reloadBtn, addr, goBtn, startBtn, stopBtn].forEach(function (el) {
				bar.appendChild(el);
			});

			var tabBar = doc.createElement("div");
			tabBar.className = "dsh-bv-bar";
			[tabsBtn,newTabBtn,closeTabBtn].forEach(el => tabBar.appendChild(el));
			var canvasWrap = doc.createElement("div");
			canvasWrap.className = "dsh-bv-canvaswrap";
			var canvas = doc.createElement("canvas");
			canvas.id = "dsh-bv-canvas";
			canvas.width = 1366;
			canvas.height = 900;
			canvas.tabIndex = 0;
			canvas.title = "Click to focus, then type / click in the page.";
			var empty = doc.createElement("div");
			empty.className = "dsh-bv-canvas-empty";
			empty.textContent = "Ask the agent to browse, or press Start. Use Take over to log in yourself.";
			canvasWrap.appendChild(canvas);
			canvasWrap.appendChild(empty);

			var foot = doc.createElement("div");
			foot.className = "dsh-bv-foot";
			var err = doc.createElement("span");
			err.className = "dsh-bv-err";
			var urlLine = doc.createElement("span");
			urlLine.className = "dsh-bv-url";
			urlLine.textContent = "disconnected";
			foot.appendChild(err);
			foot.appendChild(urlLine);

			panel.appendChild(head);
			panel.appendChild(bar);
			panel.appendChild(tabBar);
			panel.appendChild(canvasWrap);
			panel.appendChild(foot);
			doc.body.appendChild(panel);

			function iconBtn(glyph, label) {
				var b = doc.createElement("button");
				b.className = "dsh-bv-iconbtn";
				b.textContent = glyph;
				b.title = label;
				return b;
			}

			// ── WebSocket ──────────────────────────────────────────────────────
			var ws = null;
			var open = false;
			var reconnectTimer = null;
			var tabsSignature = "";
			var remoteControls = [pauseBtn,backBtn,fwdBtn,reloadBtn,goBtn,startBtn,stopBtn,newTabBtn,tabsBtn,closeTabBtn];
			function setConnected(ready) { remoteControls.forEach(function(b) { b.disabled = !ready; }); }
			setConnected(false);

			function wsUrl() {
				var proto = location.protocol === "https:" ? "wss" : "ws";
				return proto + "://" + location.host + "/browser/stream";
			}
			function send(obj) {
				if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
			}
			function connect() {
				if (ws) return;
				setConnected(false);
				activity.textContent = "Connecting…";
				try {
					ws = new WebSocket(wsUrl());
				} catch (e) {
					urlLine.textContent = "socket error: " + e.message;
					return;
				}
				ws.binaryType = "arraybuffer";
				ws.onopen = function () {
					open = true;
					err.textContent = "";
				};
				ws.onmessage = function (ev) {
					if (typeof ev.data === "string") {
						var m;
						try {
							m = JSON.parse(ev.data);
						} catch {
							return;
						}
						if (m && m.type === "status") onStatus(m);
					} else {
						renderFrame(ev.data);
					}
				};
				ws.onclose = function () {
					setConnected(false);
					ws = null;
					open = false;
					dot.className = "dsh-bv-dot";
					urlLine.textContent = "disconnected — reconnecting";
					if (!panel.hidden) reconnectTimer = setTimeout(connect, 1500);
				};
				ws.onerror = function () {
					err.textContent = "socket error";
				};
			}
			function disconnect() {
				setConnected(false);
				clearTimeout(reconnectTimer);
				if (ws) {
					try {
						ws.close();
					} catch {}
					ws = null;
				}
				open = false;
			}
			var approvalBinding = {};
			function onStatus(m) {
				approvalBinding = {proposalId:m.approval?.proposalId||m.approval?.id,fingerprint:m.approval?.fingerprint};
				setConnected(true);
				paused = !!m.paused;
				pauseBtn.textContent = paused ? "Hand back" : "Take control";
				activity.textContent = m.approval ? "Approve “" + m.approval.label + "” on " + m.approval.host + "?"
					: m.handoff ? "Your turn: " + m.handoff.message
					: paused ? "You're in control (agent paused)" : m.activity ? "Agent: " + m.activity : "Ready";
				approveBtn.hidden = rejectBtn.hidden = !m.approval;
				empty.style.display = m.running ? "none" : "block";
				if (!m.running) canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);
				if (m.tabs) {
					var signature = JSON.stringify([m.tabs,m.activeTabId]);
					if (signature !== tabsSignature) {
						tabsSignature = signature; tabsBtn.replaceChildren();
						m.tabs.forEach(t => { var o = doc.createElement("option"); o.value=t.id; o.textContent=t.title || t.url || "New tab"; o.selected=t.id===m.activeTabId; tabsBtn.appendChild(o); });
					}
				}
				dot.className = "dsh-bv-dot" + (m.running ? " on" : "");
				err.textContent = m.error || "";
				urlLine.textContent = m.url || (m.running ? "(running)" : "not running");
				if (m.url && doc.activeElement !== addr) addr.value = m.url;
			}

			// ── frame rendering ────────────────────────────────────────────────
			function renderFrame(buf) {
				if (!open) return;
				var blob = new Blob([buf], { type: "image/jpeg" });
				var url = URL.createObjectURL(blob);
				var img = new Image();
				img.onload = function () {
					if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
						canvas.width = img.naturalWidth;
						canvas.height = img.naturalHeight;
					}
					empty.style.display = "none";
					var g = canvas.getContext("2d");
					g.drawImage(img, 0, 0);
					URL.revokeObjectURL(url);
				};
				img.onerror = function () {
					URL.revokeObjectURL(url);
				};
				img.src = url;
			}

			// ── coordinate mapping + input forwarding ──────────────────────────
			function toViewport(e) {
				var rect = canvas.getBoundingClientRect();
				var x = (e.clientX - rect.left) / rect.width * canvas.width;
				var y = (e.clientY - rect.top) / rect.height * canvas.height;
				return {
					x: Math.max(0, Math.min(canvas.width, x)),
					y: Math.max(0, Math.min(canvas.height, y))
				};
			}
			function buttonName(e) {
				if (e.button === 0) return "left";
				if (e.button === 2) return "right";
				if (e.button === 1) return "middle";
				return "none";
			}
			function modifiers(e) {
				var m = 0;
				if (e.altKey) m |= 1;
				if (e.ctrlKey) m |= 2;
				if (e.metaKey) m |= 4;
				if (e.shiftKey) m |= 8;
				return m;
			}
			var dragging = null;
			canvas.addEventListener("mousedown", function (e) {
				e.preventDefault();
				canvas.focus();
				var p = toViewport(e);
				dragging = { button: buttonName(e), clickCount: e.detail || 1, modifiers: modifiers(e) };
				send({ type: "mouse", event: "pressed", x: p.x, y: p.y, button: dragging.button, clickCount: dragging.clickCount, modifiers: dragging.modifiers });
			});
			window.addEventListener("mousemove", function (e) {
				var rect = canvas.getBoundingClientRect();
				var inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
				if (!inside && !dragging) return;
				var p = toViewport(e);
				send({ type: "mouse", event: "moved", x: p.x, y: p.y });
			});
			window.addEventListener("mouseup", function (e) {
				if (!dragging) return;
				var p = toViewport(e);
				send({ type: "mouse", event: "released", x: p.x, y: p.y, button: dragging.button, clickCount: dragging.clickCount, modifiers: dragging.modifiers });
				dragging = null;
			});
			canvas.addEventListener("contextmenu", function (e) {
				e.preventDefault();
			});
			canvas.addEventListener("keydown", function (e) {
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
				e.preventDefault();
				send({ type: "key", event: "keyDown", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: modifiers(e) });
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					send({ type: "key", event: "char", text: e.key, windowsVirtualKeyCode: e.keyCode });
				}
			});
			canvas.addEventListener("keyup", function (e) {
				e.preventDefault();
				send({ type: "key", event: "keyUp", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: modifiers(e) });
			});

			canvas.addEventListener("wheel", function(e) {
                e.preventDefault(); var p = toViewport(e);
                var scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.height : 1;
                send({type:"wheel",x:p.x,y:p.y,deltaX:e.deltaX*scale,deltaY:e.deltaY*scale});
            }, {passive:false});
            canvas.addEventListener("paste", function(e) {
                e.preventDefault(); send({type:"text",text:e.clipboardData.getData("text/plain")});
            });
            pauseBtn.addEventListener("click", () => send({type:"pause",paused:!paused}));
            approveBtn.addEventListener("click", () => send({type:"approve",scope:"once",...approvalBinding}));
            rejectBtn.addEventListener("click", () => send({type:"reject",...approvalBinding}));
            expandBtn.addEventListener("click", () => {
                var large = panel.dataset.expanded !== "true";
                panel.dataset.expanded = String(large);
                panel.style.width = large ? "calc(100vw - 28px)" : "";
                panel.style.height = large ? "calc(100dvh - 78px)" : "";
            });
            newTabBtn.addEventListener("click", () => send({type:"tab",action:"open"}));
            tabsBtn.addEventListener("change", () => send({type:"tab",action:"switch",tabId:tabsBtn.value}));
            closeTabBtn.addEventListener("click", () => {if(tabsBtn.value) send({type:"tab",action:"close",tabId:tabsBtn.value});});
            // ── toolbar wiring ─────────────────────────────────────────────────
			function navigateTo() {
				var u = addr.value.trim();
				if (!u) return;
				if (!/^https?:\/\//i.test(u)) u = "https://" + u;
				send({ type: "navigate", url: u });
			}
			goBtn.addEventListener("click", navigateTo);
			addr.addEventListener("keydown", function (e) {
				if (e.key === "Enter") navigateTo();
			});
			backBtn.addEventListener("click", function () {
				send({ type: "back" });
			});
			fwdBtn.addEventListener("click", function () {
				send({ type: "forward" });
			});
			reloadBtn.addEventListener("click", function () {
				send({ type: "reload" });
			});
			startBtn.addEventListener("click", function () {
				send({ type: "start", url: addr.value.trim() || undefined });
			});
			stopBtn.addEventListener("click", function () {
				send({ type: "stop" });
			});

			// ── panel toggle ───────────────────────────────────────────────────
			function setPanel(show) {
				panel.hidden = !show;
				if (show) {
					connect();
					canvas.focus();
				} else {
					disconnect();
				}
			}
			root.addEventListener("click", function () {
				setPanel(panel.hidden);
			});
			closeBtn.addEventListener("click", function () {
				setPanel(false);
			});
		}

		// Build at materialization (module side effect). Guarded so a re-import
		// (HMR) does not duplicate the overlay.
		if (typeof document !== "undefined" && document.body) {
			buildOverlay();
		} else if (typeof document !== "undefined") {
			document.addEventListener("DOMContentLoaded", buildOverlay, { once: true });
		}

		function apply() {}
		var inject = [];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
