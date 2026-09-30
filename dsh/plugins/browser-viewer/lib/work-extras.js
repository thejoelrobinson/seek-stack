// Small helpers for Work mode: a password-in-chat guard, and local-model
// calls for proactive ideas and short conversation titles.

const ROUTER = process.env.SEEK_MODEL_URL || 'http://127.0.0.1:18798';
let helperQueue=null;
export function setWorkModelQueue(queue){helperQueue=queue;}
const SYMBOL = /[!@#$%^&*()+=[\]{}|\\;'",<>?~`]/;

function secretToken(token) {
  if (token.length < 8 || /:\/\//.test(token) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) return false;
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && SYMBOL.test(token);
}

/**
 * True when a chat message appears to contain a password. Passwords typed into
 * chat reach the model; sign-ins belong in the secure card instead.
 */
export function looksLikePassword(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (/\b(password|passcode|passphrase|pwd|pin)\b[^\n]{0,20}?(\bis\b|:|=|\?)\s*\S{4,}/i.test(text)) return true;
  return text.split(/\s+/).some(secretToken);
}

/** The model already on the GPU, so a background call never forces a reload. */
async function pickModel() {
  try {
    const { data } = await (await fetch(`${ROUTER}/v1/models`, { signal: AbortSignal.timeout(5000) })).json();
    return (data.find(m => m.status?.value === 'loaded') || data.find(m => m.id === 'qwen3.8-27b') || data[0])?.id;
  } catch { return 'qwen3.8-27b'; }
}

export async function complete(messages, { maxTokens = 800, timeoutMs = 120000, temperature = 0.6, signal, priority=20, job='helper' } = {}) {
  const request=async(queueSignal)=>{
  const res = await fetch(`${ROUTER}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal,queueSignal,AbortSignal.timeout(timeoutMs)].filter(Boolean)),
    body: JSON.stringify({ model: await pickModel(), messages, max_tokens: maxTokens, temperature, chat_template_kwargs: { enable_thinking: false } })
  });
  if (!res.ok) throw new Error(`The local model returned ${res.status}.`);
  const value=await res.json();
  if(value.choices?.[0]?.finish_reason==='length')throw new Error('The local model reached the response limit. Request a smaller batch.');
  return String(value.choices?.[0]?.message?.content || '');
  };
  return helperQueue?helperQueue.submit(request,{priority,signal,label:job}):request();
}

/** A 2-6 word title, like Muse's auto-named side chats. */
export async function shortTitle(objective) {
  // The request is quoted as data; otherwise the model tends to answer it instead of naming it.
  const raw = await complete([
    { role: 'system', content: 'You write short titles for task requests. You never answer or carry out the request.' },
    { role: 'user', content: `Write a 2-6 word title, in sentence case, for the task request below. Output only the title.\n\n<request>\n${String(objective).slice(0, 2000)}\n</request>` }
  ], { maxTokens: 24, timeoutMs: 30000, temperature: 0.2,priority:10,job:'title' });
  const title = raw.split('\n')[0].replace(/^(title:\s*)/i, '').replace(/^["'\s#*]+|["'\s.*]+$/g, '').trim();
  if (!title || title.length > 60 || title.split(/\s+/).length > 8 || /\b(I|cannot|can't|sorry)\b/.test(title)) throw new Error('No usable title.');
  return title;
}

/** Up to three one-tap follow-ups for a finished task ("Tap to make it happen"). */
export async function nextSteps({ objective, result }) {
  const raw = await complete([
    { role: 'system', content: 'You propose follow-up actions for a personal agent that can browse the web, research, write documents and spreadsheets, and run tasks on a schedule. You never carry them out.' },
    { role: 'user', content: `A task just finished.\n<request>\n${String(objective).slice(0, 1500)}\n</request>\n<result>\n${String(result || '').slice(0, 3000)}\n</result>\nSuggest up to 3 useful next steps the agent could do for the user. Avoid purchases, messaging other people, or anything needing passwords. Reply with ONLY a JSON array of objects {"label": 2-4 word button text, "request": the exact instruction to run}. Reply [] if nothing is worth suggesting.` }
  ], { maxTokens: 400, timeoutMs: 60000, temperature: 0.4,priority:20,job:'suggestions' });
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  return JSON.parse(raw.slice(start, end + 1))
    .filter(i => i && typeof i.label === 'string' && typeof i.request === 'string')
    .map(i => ({ label: i.label.trim().slice(0, 40), request: i.request.trim().slice(0, 2000) }))
    .filter(i => i.label && i.request).slice(0, 3);
}

/** Proactive suggestions from what the user has asked for and told the agent to remember. */
export async function generateIdeas({ name, memory, tasks, now = new Date() }) {
  const recent = tasks.slice(-15).map(t => `- ${t.title} (${t.status})${t.result ? ': ' + String(t.result).replace(/\s+/g, ' ').slice(0, 160) : ''}`).join('\n') || '(no tasks yet)';
  const raw = await complete([
    { role: 'system', content: `You are ${name}, a personal agent that can browse the web, research, make documents and spreadsheets, and run tasks on a schedule. Suggest useful things you could do next for this user without being asked. Be specific to their history and preferences; never invent facts about them. Avoid purchases, sending messages to other people, or anything needing passwords. Reply with ONLY a JSON array of 4 objects: {"title": short action phrase (max 60 chars), "why": one sentence on why it helps them (max 140 chars), "request": the exact instruction to hand to yourself}.` },
    { role: 'user', content: `Today is ${now.toDateString()}.\nWhat they want you to remember:\n${memory || '(nothing yet)'}\n\nRecent tasks:\n${recent}` }
  ], { maxTokens: 1200, timeoutMs: 180000,priority:30,job:'ideas' });
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('The model did not return ideas.');
  const items = JSON.parse(raw.slice(start, end + 1))
    .filter(i => i && typeof i.title === 'string' && typeof i.request === 'string')
    .slice(0, 6)
    .map(i => ({ title: i.title.trim().slice(0, 80), why: String(i.why || '').trim().slice(0, 200), request: i.request.trim().slice(0, 2000) }));
  if (!items.length) throw new Error('The model did not return ideas.');
  return items;
}
