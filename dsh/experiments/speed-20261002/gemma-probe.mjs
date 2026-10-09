// One capped request with the agent-bench tools, to see how a model formats its first tool call.
// Usage: MODEL=gemma-4-26b-a4b node --import <register-profile> gemma-probe.mjs
const {BrowserController, buildTools} = await import('../../plugins/browser-viewer/lib/index.js');
const c = new BrowserController({headless: true, windowWidth: 1366, windowHeight: 900, quality: 50, intervalMs: 400, browserOptions: {}});
const USE = ['viewer_navigate', 'viewer_click', 'viewer_scroll', 'viewer_snapshot', 'viewer_text', 'viewer_find'];
const tools = buildTools(c).filter(t => USE.includes(t.name)).map(t => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.parameters}}));
const t0 = performance.now();
const res = await fetch('http://127.0.0.1:18798/v1/chat/completions', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
  model: process.env.MODEL || 'gemma-4-26b-a4b', max_tokens: Number(process.env.MAX || 600), stream: false, tools,
  messages: [{role: 'system', content: 'You are a fast, careful web agent working in a real Chrome browser through viewer_* tools. When you have the answer, reply with it as plain text and no tool call.'},
    {role: 'user', content: 'On walmart.com, find the cheapest fresh thyme shown as available: product name, price and size.'}]})});
const j = await res.json();
console.log('ms', Math.round(performance.now() - t0), 'status', res.status, 'finish', j.choices?.[0]?.finish_reason, 'timings', JSON.stringify(j.timings || {}).slice(0, 200));
const m = j.choices?.[0]?.message || j;
console.log('tool_calls', JSON.stringify(m.tool_calls || null).slice(0, 600));
console.log('reasoning', String(m.reasoning_content || '').slice(0, 800));
console.log('content', String(m.content || '').slice(0, 1500));
