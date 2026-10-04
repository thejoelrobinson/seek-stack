---
name: retailer-purchases
description: Pull, normalize, reconcile, and query itemized purchase history from signed-in retailer accounts.
---

# Retailer purchase history

## Default workflow

1. Query `purchases_summary` and `purchases_search` before browsing; the local SQLite database may already have the answer.
2. Use `purchases_adapters` to see which deterministic retailer capture adapters are installed.
3. For Walmart, use `viewer_collect_links` on the signed-in order list, then `viewer_receipts`. That capture saves its raw JSON/CSV and imports normalized rows into SQLite automatically.
4. For an unconfigured retailer, inspect its actual signed-in order list and detail pages first. Add a site-specific DOM/API adapter only after seeing the real page structure; preserve source URLs, currency, order date, cents, line quantities, verification state, and parse issues. Write normalized `{results:[...]}` JSON to the task workspace and import it with `purchases_import_file`.
5. Prefer retailer APIs, visible structured DOM, and invoice PDFs parsed by code. Use an LLM only to resolve genuinely ambiguous labels or layouts, and retain the ambiguity as a review issue instead of silently guessing.
6. Report verified and needs-review records separately. Do not mix unverified orders into verified spend. Keep the exact source files and import summary so reruns can be compared.

## Record contract

Each result may contain `orderId`, `url` or `sourceUrl`, `date` (`YYYY-MM-DD`), `currency`, `totalCents`, `taxCents`, `associateDiscountCents`, `status`, `verified`, `issues`, and `rows`. Each row contains `name`, `quantity`, and `amountCents`. Amounts are integer cents. Do not store payment credentials or full card data.

## Improve the workflow safely

After each real capture, record only sanitized failure facts: retailer, page type, field/parser that failed, expected versus observed row counts, and whether reconciliation passed. Do not put names, addresses, order identifiers, or purchase contents in durable skill notes. Update the adapter and this skill only after a reproducible parser fix; keep a small synthetic fixture for the failure shape and run it before relying on the fix. Do not self-edit the skill during a live financial extraction.
