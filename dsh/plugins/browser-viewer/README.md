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
