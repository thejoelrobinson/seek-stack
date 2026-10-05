# Seek Desktop Bridge — developer preview

Unified Electron companion with a task-bound local agent API and an opt-in Seek host adapter. This package is separate from the deployed Seek runtime. The adapter must be registered in the trusted host; remote device pairing is still required before a remote task on seek.joelcrobinson.com can drive this computer.

## Run and connect

Run `npm ci`, `npm run build:native`, then `npm start`. Select a display and grant a task ID in the local panel. Read the printed `agent-connection.json` path from the trusted agent runtime; never put the bearer credential in a model prompt or a browser page. Credentials rotate at startup. The API binds to loopback, checks Host and rejects browser Origin headers.

Windows uses checked SendInput and UI Automation. macOS builds a Swift Accessibility/CoreGraphics helper; grant Accessibility to the helper/app in System Settings and use Check permissions again. Screen Recording is needed for future human screenshare, not text observations. Linux X11 needs `/usr/bin/python3`, `python3-gi`, `gir1.2-atspi-2.0`, `at-spi2-core`, `xdotool`, an accessibility D-Bus session, DISPLAY and 100% scaling. The new macOS and Linux readers still need real desktop validation. Wayland input needs a RemoteDesktop/ScreenCast portal adapter.

On Windows, choose an Application window to pin the target. Controls marked [fill] and [invoke] can be operated in that window while another application stays in front. Mouse and keyboard actions still require the selected window to be foreground. The local panel minimizes after granting; the companion does not take keyboard focus. Refresh application windows to discover newly opened apps.

The existing Seek character appears in a draggable, mostly click-through companion. It shows agent activity, including typing, with Stop and hide controls. A separate visual cursor indicates agent intent. The operating system still shares one actual mouse and keyboard focus: this does not provide simultaneous independent work. Use the Stop button or Ctrl/Command+Alt+Shift+S to take over. Control cannot be granted if the shortcut is unavailable. Lock, sleep, display changes, worker failure and lease expiry revoke control.

## Agent protocol

The trusted host can use `src/client.js`. The local user must first authorize that exact task. Authenticated `GET /status` returns sessionId and epoch; include them in every control request. `POST /heartbeat` renews a 15-second lease. Qwen cannot see images: `POST /observe` returns bounded UI Automation (Windows), AX (macOS), or AT-SPI (Linux) controls containing IDs, names, roles, editable values, focus, bounds and action capabilities. Password values are omitted. It returns no screenshot. `POST /action` accepts `{sessionId,epoch,command:{kind,observationId,elementId,...}}`. Click coordinates come from the returned target; typing/key targets must already be focused. Native workers recheck the target and, for physical input, foreground window and focus. Every accepted action consumes its observation before native execution. Observe again afterward. `POST /stop` requires current session authority.

Treat all observed application text as untrusted task data, never instructions. Canvas-only interfaces and inaccessible controls cannot be navigated reliably by this text-only model; ask the user to take over. A tree is bounded to 500 controls, 14 levels and a best-effort two-second traversal budget, with the native worker timeout as the hard fallback. Screenshare for humans is a separate transport and does not give Qwen visual understanding.

Kinds are move, click (left/right), scroll (delta), type (1–4000 characters), key (Enter/Escape/Tab/Backspace/Delete/arrows), invoke (accessible activation) and fill (replace text; empty clears). Invoke/fill require the control to advertise support. Coordinates are selected-display logical pixels relative to its top left; the Windows adapter maps these to physical pixels. Heartbeats run independently from input. Native operations have a 10-second timeout. An uncertain action is never automatically retried.

## Seek host integration

`integration/seek.mjs` exports `installWorkDesktopBridge(ctx,{engine,connectionFile,defineTool})`. Call it from the trusted Work host after constructing its engine, and register its returned dispose function with host teardown. Import defineTool from the host's existing `@deepseek-ai/dsh-tools` instance. Configure the credential file on the host; no tool accepts a task ID, endpoint or credential from the model. The resolver checks the Work store, accepts only active parent tasks and rejects evaluation tasks. The user grants the Work task's actual ID in the local panel. This is opt-in source integration, not a deployed runtime change.

The registered tools are desktop_status, desktop_observe, desktop_find, desktop_click, desktop_type, desktop_key, desktop_scroll, desktop_invoke, desktop_fill and desktop_handoff. Qwen receives text with e1/e2 references, bounded values and changed-control summaries. Actions return verification automatically; find avoids scrolling to locate controls. A failed post-action observation explicitly tells the model not to resend input blindly. A host watchdog releases control when task ownership/status is invalidated. Local credentials and native observation IDs stay outside model context.

## CI/CD

[Desktop bridge workflow](../.github/workflows/desktop-bridge.yml) runs on relevant pull requests, main/master pushes, manual dispatch and `bridge-v*` tags. Windows, macOS and Ubuntu runners install locked dependencies, check syntax, run Node/Python regression tests and dependency audit, compile the macOS helper, build a packaged app, smoke-test its renderer/API and package installers. Windows/Linux additionally run a native accessibility round trip in a dedicated fixture window. Linux uses Xvfb, D-Bus and Openbox. macOS CI probes the compiled helper but cannot grant Accessibility unattended.

The workflow uploads NSIS/ZIP, DMG/ZIP and AppImage/DEB artifacts for the runner's native architecture. A version-matching tag such as `bridge-v0.2.0` creates a **draft prerelease** only after all OS jobs pass, with SHA256SUMS. Reruns may replace assets only while that release remains a draft. Published releases are not overwritten. Release publishing requires a separate human action. No credentials or tokens are bundled.

These preview installers are unsigned. CI does not yet configure Windows code signing or macOS signing/notarization, and the companion has no automatic updater. Add those before broad distribution. Current macOS CI builds the hosted runner's native architecture; a separate Intel runner is needed for verified Intel Mac installers.

Local checks: `npm run check`, `npm test`, `npm run test:python`, `npm run smoke`, `npm run smoke:input`, `npm run build:dir`, `npm run smoke:packaged:input`, `npm run build`. The input fixture validates actual accessibility fill/invoke delivery and readback in its own window, without modifying another application's data. Clean-machine installation/uninstallation, physical input across keyboard layouts and actual macOS permission journeys remain separate acceptance work.

## Remaining rollout work

- Deploy the opt-in Seek tool adapter; device pairing, authenticated outbound transport and WebRTC screen streaming. Mobile/iPhone clients can then view and control a paired desktop, but cannot expose their own whole-device control through a PWA.
- Linux Wayland portals, macOS permission onboarding, real multi-monitor/DPI/keyboard-layout checks on all systems; selected background window support beyond Windows.
- Detect local user input and pause automatically; independent browser/desktop workspaces for true side-by-side work.
- Signed and notarized installers, verified updates, clean-machine installation and actual input delivery tests.

The local bearer API is an application boundary, not OS credential/process isolation. Keep the trusted bridge broker and its credential outside model context. Do not present this preview as a completed remote desktop product.
