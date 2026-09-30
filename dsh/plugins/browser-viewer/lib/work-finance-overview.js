const label = name => String(name || 'OTHER').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const percent = (part, total) => total > 0 ? Math.round(part / total * 100) : 0;
const palette = ['#6752a2', '#9278bc', '#b49bd0', '#cdb8df', '#dfcce9', '#e9dded', '#f2eaf4', '#ddd7e4'];

export function financeOverview({data, status, busy, cash, cashExact, date, esc}) {
  const s = data.summary || {};
  const cats = data.categories || [];
  const merchantRows = data.topMerchants || [];
  const months = data.cashflowMonths || [];
  const maxMonth = Math.max(1, ...months.flatMap(m => [m.spend, m.income]));
  const top = cats.slice(0, 7);
  const remainder = cats.slice(7).reduce((n, c) => n + c.amount, 0);
  const segments = [...top.map((c, i) => ({...c, color: palette[i]})), ...(remainder ? [{name: 'OTHER_CATEGORIES', amount: remainder, color: palette[7]}] : [])];
  let at = 0;
  const gradient = segments.length ? `conic-gradient(${segments.map(c => {
    const start = at;
    at += c.amount / (s.monthSpend || 1) * 100;
    return `${c.color} ${start}% ${Math.min(100, at)}%`;
  }).join(', ')})` : '#eee9f3';
  const change = s.spendChange == null ? 'No comparable prior month' : `${s.spendChange > 0 ? '+' : ''}${s.spendChange.toFixed(1)}% vs same days last month`;
  const current = months.at(-1);
  const currentKey = current?.key || new Date().toISOString().slice(0, 7);
  const bankCount = status.connections?.length || 0;
  const accountGroups = [
    {title:'Cash accounts', types:['depository'], icon:'◫'},
    {title:'Investments', types:['investment','brokerage','cryptocurrency'], icon:'⌁'},
    {title:'Credit & loans', types:['credit','loan'], icon:'▤'}
  ];
  return `<section class="fin-overview fin-v2">
    <header class="fin-head fin-v2-head"><div><div class="fin-eyebrow">YOUR FINANCIAL PICTURE</div><h2>Overview</h2><p>${bankCount} linked ${bankCount === 1 ? 'institution' : 'institutions'} · Updated ${data.status.updatedAt ? new Date(data.status.updatedAt).toLocaleString() : 'just now'}</p></div><div class="fin-head-actions"><button data-fin="add-bank">＋ Add account</button><button class="fin-refresh" data-fin="refresh" ${busy ? 'disabled' : ''}>↻ Refresh</button></div></header>
    ${status.error ? `<p class="fin-error" role="alert">Some data is still syncing: ${esc(status.error)}</p>` : ''}
    <div class="fin-v2-summary">
      <article class="fin-v2-net"><span>Estimated net worth</span><strong>${cash(s.netWorth)}</strong><small>${cash(s.assets)} assets · ${cash(s.debt)} debt</small><button data-fin="show-accounts">Explore accounts <span aria-hidden="true">↗</span></button></article>
      <div class="fin-v2-metrics">
        <button class="fin-v2-metric" data-fin-drill="spending" data-fin-month="${esc(currentKey)}"><span>Spent this month <b>↗</b></span><strong>${cash(s.monthSpend)}</strong><small>${change}</small></button>
        <button class="fin-v2-metric" data-fin-drill="income" data-fin-month="${esc(currentKey)}"><span>Income this month <b>↗</b></span><strong>${cash(s.monthIncome)}</strong><small>Posted, Plaid-categorized income</small></button>
        <article class="fin-v2-metric fin-v2-netflow"><span>After spending</span><strong>${cash(s.monthNet)}</strong><small>Income less spending this month</small></article>
      </div>
    </div>
    <div class="fin-v2-insights">
      <section class="fin-panel fin-v2-cashflow"><div class="fin-section-title"><div><h3>Cash flow</h3><p>Monthly income and spending from synced transactions</p></div><div class="fin-v2-legend"><span><i class="income"></i> Plaid income</span><span><i class="spend"></i> Spending</span></div></div>
        <div class="fin-v2-chart" role="group" aria-label="Six month cash flow. Select a bar to inspect transactions.">${months.map(m => `<div class="fin-v2-month"><div class="fin-v2-bar-pair"><button class="fin-v2-bar income" data-fin-drill="income" data-fin-month="${esc(m.key)}" style="height:${Math.max(3, m.income / maxMonth * 100)}%" aria-label="${esc(m.label)} income ${esc(cashExact(m.income))}" title="${esc(m.label)} income · ${esc(cashExact(m.income))}"></button><button class="fin-v2-bar spend" data-fin-drill="spending" data-fin-month="${esc(m.key)}" style="height:${Math.max(3, m.spend / maxMonth * 100)}%" aria-label="${esc(m.label)} spending ${esc(cashExact(m.spend))}" title="${esc(m.label)} spending · ${esc(cashExact(m.spend))}"></button></div><span>${esc(m.label)}</span></div>`).join('')}</div>
        <div class="fin-v2-chart-footer"><span>Tap a bar for the transactions behind it.</span><button class="fin-link" data-fin-tab="transactions">Explore activity →</button></div>
      </section>
      <section class="fin-panel fin-v2-categories"><div class="fin-section-title"><div><h3>Spending breakdown</h3><p>This month · ${s.spendingTransactionCount || 0} posted spending transactions</p></div></div>
        <div class="fin-v2-donut-row"><div class="fin-v2-donut" style="background:${gradient}" role="img" aria-label="Spending by category"><div><span>Total spent</span><strong>${cash(s.monthSpend)}</strong></div></div><div class="fin-v2-cat-list">${segments.map(c => `<button class="fin-v2-cat-row" data-fin-drill="spending" data-fin-month="${esc(currentKey)}" ${c.name === 'OTHER_CATEGORIES' ? 'data-fin-other="1"' : `data-fin-category="${esc(c.name)}"`}><span class="fin-v2-dot" style="background:${c.color}"></span><span class="fin-v2-cat-name">${esc(c.name === 'OTHER_CATEGORIES' ? 'Other categories' : label(c.name))}</span><span class="fin-v2-cat-value"><strong>${cash(c.amount)}</strong><small>${percent(c.amount, s.monthSpend)}%</small></span></button>`).join('') || '<p class="fin-empty">Spending categories appear after transactions sync.</p>'}</div></div>
        ${cats.some(c => c.name === 'LOAN_PAYMENTS') ? `<button class="fin-v2-review" data-fin-drill="spending" data-fin-month="${esc(currentKey)}" data-fin-category="LOAN_PAYMENTS">Review loan payments: Plaid may group some card payments here. See entries →</button>` : ''}
      </section>
    </div>
    <div class="fin-v2-secondary">
      <section class="fin-panel"><div class="fin-section-title"><div><h3>Budget check-in</h3><p>Month-to-date against your targets</p></div><button class="fin-link" data-fin-tab="budgets">Manage →</button></div>${(data.budgets || []).slice(0, 4).map(b => { const actual = (data.budgetCategories||[]).find(c => c.name === b.category)?.amount || 0; const p = percent(actual, b.amount); return `<div class="fin-v2-budget"><div><span>${esc(data.budgetCategoryNames?.[b.category]||label(b.category))}${b.source==='auto'?'<small class="fin-v2-auto-tag"> · Auto</small>':''}</span><strong>${cash(actual)} <small>of ${cash(b.amount)}</small></strong></div><div class="fin-track"><i class="${p >= 100 ? 'over' : ''}" style="width:${Math.min(100, p)}%"></i></div></div>`; }).join('') || '<div class="fin-v2-empty">Build a budget from your spending history or set a category target. <button class="fin-link" data-fin-tab="budgets">Auto-build →</button></div>'}</section>
      <section class="fin-panel"><div class="fin-section-title"><div><h3>Recurring activity</h3><p>Detected bills and income</p></div><button class="fin-link" data-fin-tab="recurring">See all →</button></div>${(data.recurring || []).slice(0, 4).map(r => `<div class="fin-row"><span class="fin-rec-icon">${r.type === 'income' ? '↙' : '↗'}</span><div><strong>${esc(r.name)}</strong><small>${esc(r.frequency)}${r.nextDate && r.nextDate >= new Date().toISOString().slice(0,10) ? ` · next ${date(r.nextDate)}` : ''}</small></div><b>${cash(Math.abs(r.amount))}</b></div>`).join('') || '<div class="fin-v2-empty">Recurring activity will appear when your institutions provide enough history.</div>'}</section>
    </div>
    <section class="fin-panel fin-v2-merchants"><div class="fin-section-title"><div><h3>Top merchants</h3><p>This month · ranked by posted spending</p></div><button class="fin-link" data-fin-tab="transactions">All activity →</button></div><div class="fin-v2-merchant-grid">${merchantRows.map(m => `<button class="fin-v2-merchant" data-fin-drill="spending" data-fin-month="${esc(currentKey)}" data-fin-merchant="${esc(m.name)}"><span><strong>${esc(m.name)}</strong><small>${m.count} ${m.count === 1 ? 'transaction' : 'transactions'}</small></span><b>${cash(m.amount)}</b><i style="width:${Math.max(2, m.amount / (merchantRows[0]?.amount || 1) * 100)}%"></i></button>`).join('') || '<p class="fin-v2-empty">Merchant details will appear after transactions sync.</p>'}</div></section>
    <section class="fin-v2-account-section"><div class="fin-section-title"><div><h3>Your accounts</h3><p>Balances reported by linked institutions</p></div><button class="fin-link" data-fin="add-investments">＋ Add investments</button></div>${accountGroups.map(g => {const accounts = (data.accounts || []).filter(a => g.types.includes(a.type)); return accounts.length ? `<div class="fin-v2-account-group"><h4>${g.title} <small>${accounts.length}</small></h4><div class="fin-accounts">${accounts.map(a => `<article class="fin-account"><div class="fin-bank-icon">${g.icon}</div><div class="fin-account-name"><strong>${esc(a.name)}</strong><span>${esc([a.institution, a.subtype, a.mask ? `••${a.mask}` : ''].filter(Boolean).join(' · '))}</span></div><div class="fin-account-balance"><strong>${cash(a.current, a.currency)}</strong><span>${a.available == null ? 'Current balance' : `${cash(a.available, a.currency)} available`}</span></div></article>`).join('')}</div></div>` : '';}).join('') || '<div class="fin-empty">No accounts were returned by Plaid.</div>'}</section>
    <details class="fin-v2-disclosure fin-panel"><summary>How these numbers are counted</summary><p>Income is ${cashExact(s.monthIncome)} in posted transactions Plaid labels as income. ${cashExact(s.otherInflows)} in other incoming payments, transfers, loan proceeds, rewards and refunds is excluded. Spending is ${cashExact(s.monthSpend)} after excluding ${cashExact(s.excludedOutflows)} in outgoing transfers and credit card payments. The category chart and budgets use this spending total. Figures depend on your bank's synced history and classifications.</p><div class="fin-v2-income-list"><strong>Income counted</strong>${(data.incomeTransactions || []).map(t => `<div><span>${date(t.date)} · ${esc(t.name)} · ${esc(t.institution)}</span><b>${cashExact(Math.abs(t.amount), t.currency)}</b></div>`).join('')}</div></details>
    <details class="fin-v2-disclosure fin-panel"><summary>Linked institutions & shared accounts</summary><p>Manage which accounts each connection shares, or add another institution.</p>${(status.connections || []).map(c => `<article class="fin-connection"><div class="fin-bank-icon">${c.kind === 'investment' ? '⌁' : '◫'}</div><div class="fin-connection-main"><strong>${esc(c.institution)}</strong><small>${c.accounts.length} shared ${c.accounts.length === 1 ? 'account' : 'accounts'}${c.accounts.length ? ` · ${esc(c.accounts.map(a => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`).join(', '))}` : ''}</small>${c.error ? `<small class="fin-error">${esc(c.error)}</small>` : ''}</div><div class="fin-connection-actions"><button data-fin="manage-accounts" data-connection="${esc(c.id)}">Manage accounts</button><button data-fin="remove-connection" data-connection="${esc(c.id)}">Disconnect</button></div></article>`).join('')}<button class="fin-link fin-v2-disconnect" data-fin="disconnect">Disconnect all institutions</button></details>
  </section>`;
}
