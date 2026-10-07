# DeepSeek browser control

Version 0.3.0 includes the streamed Chrome viewer and Seek Work.
The harness model controls Chrome through 17 `viewer_*` tools. It receives page
text, labelled controls and new element references after each action, without
requiring a vision model. The Browser panel shows the same live page.

Supported: navigation, click, exact Unicode typing, replace/clear fields, native
dropdowns, keyboard shortcuts, scrolling, tabs/popups, back/forward/reload,
bounded waits, snapshots and screenshot files. The user can pause agent actions
with **Take over**, log in or use the browser manually, then **Resume agent**.
The panel also supports wheel scrolling, paste, tab selection and expansion.

The browser uses its own persistent Chrome profile, not the user's ordinary
Chrome tabs. Login/CAPTCHA can require manual takeover. Cross-origin frames,
closed shadow roots and canvas controls require screenshot coordinates. Page
content is untrusted; the model must verify results and stay within the user's
authorization. A single browser is shared by harness sessions; tool and manual
actions are serialized. Coordinate targeting can become stale if the page moves.

## Install/update

Run the install.ps1 script in this directory to copy the browser and optional Qwen Image plugins into the existing harness's shared profiles/node_modules, copy the image setup tool, and add both web-profile entries. Dependencies resolve from the harness's installed packages. Requires Node 22+, Chrome and an existing DeepSeek Harness installation.

Restart the DeepSeek web harness after installing, then refresh its browser UI.
From the deployed plugin directory, run `npm test` for the local Chrome integration
suite. It uses a temporary profile and a local HTTP fixture, with no external
submissions. Generated test profiles stay in the OS temporary directory.

Try: “Use the browser to open a website, search for a topic, open a result in a
new tab, and summarize what you find.” No new provider key is required.

## Verification

Tests cover actual CDP input, Unicode/multiline text, dropdown labels, checkbox
clicks, delayed text, popup tab discovery/switch/close, scrolling, history,
stale references, password-value redaction, pause, browser relaunch, tool schemas,
the overlay's DOM and the existing trusted-host/origin fence.

`node test/model.test.mjs` optionally checks the local Qwen model through the
configured localhost shim on port 18800. The tested model autonomously navigated,
filled a form with exact Unicode text and clicked Save; the resulting page and
fixture server confirmed success. `node test/harness.test.mjs` checks the actual
plugin stream and panel against a separate test harness on localhost:3081.

Protocol references: [Chrome Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
and [Chrome Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/).
# Bounded receipt batches

`viewer_collect_links` can gather order links across purchase-history pages, then pass its list ID to `viewer_receipts`. A receipt batch accepts up to 300 Walmart order-detail URLs in the existing signed-in browser, with four workers by default. Set `concurrency` from 1 through 6 when needed. Its `jobs` argument is a JSON array of `{ "url": "https://www.walmart.com/orders/…", "expectedLines": 17 }`; `expectedLines` is optional and must come from a prior observation. Without it, the displayed receipt unit count must match the extracted quantities.

The complete batch holds the existing browser action queue. Workers use separate tabs, preserve the foreground tab, and close their own tabs afterward. The reader clicks only Show items/Show all items disclosures, verifies that rows actually appeared, retries a still-collapsed disclosure at most three times, and waits for stable rows and summary data. Login, human verification, pause, cancellation, unexpected navigation, and timeouts stop collection. A gated tab remains available for user handoff.

Records use string order IDs and integer cents. Row prices are extended amounts, not unit prices. Discount basis is inferred only when the receipt arithmetic reconciles. Missing data, unexpected fees/refunds, incomplete quantities, truncation, and multiple delivery groups for the same order produce `needs_review`. The digest reports a verified subtotal for unique orders in the submitted batch; it is never the entire account history unless link collection and date coverage have also been checked. `complete` applies to the submitted batch only.

Each receipt is checkpointed under `~/.dsh/browser/receipts/<batch-id>/`; `batch.json` records outcomes, including failed/not-started jobs. These local files contain private receipt data. Completed files can be reused for reporting without reloading the site; there is no automatic cross-account cache or resume. Use the tool only for authorized access consistent with site requirements. `viewer_collect_links` handles bounded purchase-history pagination; `viewer_receipts` does not paginate, export cookies, bypass challenges, or share receipt contents with a hosted model.

Tests: `node --test test/receipt-batch.test.mjs` and `node --experimental-loader ./test/profile-loader.mjs test/receipt-browser.test.mjs`. The latter exercises the registered tool and four real Chrome tabs against local rendering fixtures.

## Native browser handoff

The Work browser sheet defaults to **Native** and fills the visible window while the user holds control. **Dock** restores the desktop panel beside the conversation, and **Expand** fills the window again. Watching defaults to the panel. The host's DOM and styles render in a local frame, so fields use the device's keyboard and taps identify elements. **Picture** remains available in the toolbar; the device remembers that choice. Phone stages request mobile layout, and larger stages fit the host viewport to the sheet. The sheet follows the visible viewport as the keyboard opens; resizing preserves focused fields. Hand-back stops the mirror before the agent resumes and restores the desktop viewport on every affected tab.

The frame allows event listeners from its parent, with a response CSP that blocks page scripts. A blocked-script canary must pass before Native renders. Markup and CSS are sanitized on both sides; images and fonts use signed URLs behind the existing Work route fence. Resources use Chrome's cache first, then a bounded fetch with pinned DNS and redirect checks. Cookie forwarding is limited to the main page's origin. Mirror secrets are redacted from text, attributes and styles; sensitive fields receive lengths only and stay sensitive after a show-password toggle. Reflection redaction reads current secret values transiently on the host; these values never enter the mirror output or agent status and are cleared when the mirror stops.

Same-origin and cross-origin frames and page shadow roots render natively. Cross-site targets have independent node namespaces, isolated reads and signed resource routing; they share trusted input through the authoritative browser. The viewer follows popups, supports background tabs and exposes a tab strip. Styles retain their cascade order, import conditions and shadow scope, and update in place. Font readiness, failed assets and visible layout drift have bounded checks and a user-visible retry. Viewport, device scale, pointer and color/motion preferences follow the viewing device.

Typing supports selection direction, IME, undo/redo, multiline and rich-text edits. Rich edits return Chrome's canonical markup and caret before queued characters continue. Clipboard paste into rich text is plain text; device clipboard permissions stay with the user. Pointer down/move/up, drag and double click use trusted Chrome events. Native operating-system menus, file pickers and date/color controls still require Picture or the existing browser flow.

Canvas, video, embedded content and unsupported frames use bounded PNG crops. Transparent union gaps and known sensitive fields/reflections are removed on the host; cross-frame regions use the main surface with frame offsets. Arbitrary private content painted into an image or canvas cannot be identified by DOM redaction. Rotated cross-frame raster regions, verification pages, unsupported input, excessive page/frame size or mirror failure switch to Picture. Capture and viewport writes are serialized across the browser so capture cannot undo a resize. Mobile reload finishes before a new mirror starts. Slow sockets receive a fresh model after draining; edit sequence numbers and acknowledgements belong to their connection. Resources also use Chrome's bounded network response cache for fonts/images absent from its page cache.

Set plugin configuration `mirror: false` to disable Native. Run `npm test` and `npm run test:browser` for regression coverage; `npm run test:mirror` runs the focused Chrome fixture using a temporary profile. Before treating a release as fully verified, trial Safari on a physical iPhone: native keyboard and caret editing, taps, scrolling, both view choices, hand-back, and resize on a laptop. Use Google sign-in, a Walmart search/cart interaction and Target's verification fallback. The automated Chrome suite does not verify Safari.
