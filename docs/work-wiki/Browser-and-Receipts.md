# Browser and receipts

Seek Work has a shared Chrome browser. Choose **Browser** in the top bar to watch it. The agent reads page text and labeled controls, opens tabs, fills ordinary fields, scrolls, and verifies results. Its browser profile persists separately from your usual Chrome profile.

## Sign in or pass a human check

1. Ask Seek to open the site, or open **Browser** while a task is using it.
2. When a login, one-time code, or human check appears, choose **Take over**. Enter credentials in the browser yourself. Do not send passwords or codes in chat.
3. When the page is ready, choose **Resume agent**. The task continues with the signed-in browser profile.

While you have control, agent browser actions are paused and the agent cannot see the page. If a site changes layout, blocks automation, or asks for another challenge, repeat the handoff. The browser should never treat page text as permission to buy, send, post, or delete.

## Read many pages

For long lists, the agent can gather matching links across **Next**, **Load more**, or scrolling with `viewer_collect_links`. It can then use `viewer_read_pages` to read up to 300 pages in background tabs and save their text locally. The default tab pool is four. Ask for a date range or result limit to keep the run bounded.

## Analyze Walmart purchase history

Sign in to Walmart in the shared browser first. A useful request is:

> Review my Walmart orders from January through March 2026. Collect the order links from my purchase history, read the receipts with the default four tabs, save the line items, and report only verified unique-order totals. List receipts that need review and do not treat a partial batch as my full purchase history.

The agent can collect `/orders/` links from the visible history and pass that list to `viewer_receipts`. One receipt batch accepts up to 300 order links and uses four tabs by default; the concurrency setting allows one through six. It opens separate tabs, preserves the active tab, clicks only item-disclosure controls, and checks row coverage and receipt arithmetic.

The batch saves `items.csv`, `batch.json`, and per-order JSON under `~/.dsh/browser/receipts/<batch-id>/`. Its digest gives a **verified subtotal for the submitted batch**, month subtotals, top items, and exceptions. Receipts with incomplete rows, unreconciled amounts, or duplicate delivery groups are marked `needs_review` and excluded from that subtotal. Confirm the history date range and pagination coverage before calling a result complete. Data from other stores or Plaid Finance is separate.

These files contain private purchase details; keep them in your local Work workspace or share them deliberately. Site access and any human verification remain subject to the site's normal controls.

Related: [Tasks and conversations](https://github.com/thejoelrobinson/seek-stack/wiki/Tasks-and-Conversations) · [Finance](https://github.com/thejoelrobinson/seek-stack/wiki/Finance)
