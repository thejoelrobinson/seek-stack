# Finance

The **Finance** view uses Plaid to show linked account balances, estimated net worth, month-to-date cash flow, spending categories, transaction search, budgets, recurring activity, investment holdings, and available liability details. Linking an account is optional. Finance data is separate from browser-collected Walmart receipts.

## Connect an institution

1. On the local Windows PC, open **Finance** and configure your Plaid app credentials. Select the matching environment: `sandbox`, `development`, or `production`. Sandbox connections do not link real banks.
2. Choose **Add bank** or **Add investments** and complete Plaid Link yourself. Each institution or login becomes a separate connected Item, so adding one does not replace another.
3. Use **Manage accounts** to update an existing Item or its selected accounts. Keep every account you want to retain selected during the update.
4. Refresh Finance when you need recent transactions. Use the transaction search and account filters to inspect what was actually synced.

Plaid credentials, access tokens, and cached finance data are protected locally with Windows DPAPI for the current user. The model receives bounded read-only results, not those credentials or tokens. A bank connection owned by another app cannot be reused automatically; link it to Seek separately. **Disconnect** revokes a selected Item and removes its local data. **Disconnect all** removes the Items, local transaction cache, and budgets.

## Ask about spending

Example:

> What was my posted spending in August 2026? Separate income from transfers and refunds, show categories, and tell me the synced date range and any missing coverage.

For monthly totals, Work uses `finance_spending_report` to calculate locally across synced transactions. It returns bounded totals, transaction counts, date coverage, pending counts, and separate currencies. A simple transaction list is capped and can be incomplete, so do not add up a displayed page of rows and call it the full month.

The Finance agent tools are read-only. They cannot move money, trade, pay bills, or change bank accounts. Plaid data can also be incomplete if an institution has not synced the requested period.

Related: [Connections](https://github.com/thejoelrobinson/seek-stack/wiki/Connections) · [Browser and receipts](https://github.com/thejoelrobinson/seek-stack/wiki/Browser-and-Receipts)
