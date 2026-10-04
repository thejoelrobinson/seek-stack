---
name: walmart-purchase-audit
description: Audit Walmart purchase history, extract receipt items, and reconcile a date range using order identifiers and source-backed totals.
---

# Walmart purchase audit

Use this playbook for Walmart purchase-history summaries, itemized reports, and order-to-payment reconciliation.

## Collection

1. State the exact date range and whether dates refer to order date or posted payment date. Use the user's local timezone for the cutoff.
2. Enumerate the order-detail links for the full range with `viewer_collect_links`, then pass its `listId` to `viewer_receipts`. Do not manually copy a large order list or build the report from model context.
3. Preserve each source record's order ID, delivery-group identity, date, status, and URL. An order can have multiple delivery groups; do not silently discard a group or count it twice. Resolve repeated order IDs before aggregation.
4. Use Walmart's visible **Print invoice** control as the preferred source when the harness can save and extract the resulting PDF. First inspect one representative order and confirm the output is a readable invoice. Match the invoice's order ID and totals to the source order before processing the batch. Do not infer an invoice URL from page internals or claim a PDF was read when it was not.
5. The current `viewer_receipts` tool reads visible order-detail page content; it does not download or parse Print invoice PDFs. If the browser cannot capture or extract the invoice PDF, use its structured records as an order-page extraction, label that source clearly, and report that invoice verification was unavailable. Keep this limitation visible; do not treat an unreadable PDF or absent button as a zero-value order.

## Normalize and reconcile

- Keep order IDs as strings. Store money in integer cents until formatting the final output.
- Preserve item name, quantity, extended line amount, item/receipt discounts, tax, fees, order total, refunds, and source file/page. Never multiply an extended line amount by quantity a second time.
- Keep order totals separate from bank transactions. Partial payments, split tenders, EBT/SNAP, Walmart Cash, refunds, and posting-date shifts need explicit match categories; unmatched rows remain exceptions, not forced matches.
- Check expected order links against saved results; count verified, review, failed, and not-started records. Deduplicate only after comparing order ID and delivery group. Compare every invoice/order total and line count; investigate mismatches rather than silently adjusting numbers.
- Use code to generate the ledger and totals from saved JSON/CSV/PDF text. Do not hand-summarize a long capture into a final report. Do not label the report complete if any order is missing, duplicated ambiguously, unparsed, truncated, or unreconciled.
- Keep PDFs and itemized records inside the task workspace. Final chat responses should summarize coverage and exceptions without repeating item-level or payment details unless the user asks.

## Improve this skill from failures

For a failed or corrected run, record a sanitized feedback item in the task workspace with: workflow stage, observed failure, root cause, narrow proposed change, and a synthetic or redacted regression case. Do not include names, addresses, order IDs, products, payment details, or invoice contents in skill feedback.

Change this skill only when the failure is reproducible and the proposed rule would prevent it without breaking an existing case. Keep a dated copy or version-control diff, replay the relevant regression cases, and retain the change only when coverage improves. The agent may prepare a patch automatically; it must not silently rewrite this skill during the same purchase audit. Learned memories can suggest a review, but are not a replacement for a reviewed skill change.
