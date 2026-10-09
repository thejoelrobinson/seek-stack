// Adds calendar reminders to the PAW Discord bridge (~/.dsh/discord-bridge/bridge.js).
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
const file=join(homedir(),'.dsh','discord-bridge','bridge.js');
await copyFile(file,file+'.bak-calendar');
let t=await readFile(file,'utf8');
const crlf=t.includes(String.fromCharCode(13,10));const nl=x=>crlf?x.split(String.fromCharCode(10)).join(String.fromCharCode(13,10)):x;
const rep=(a,b)=>{a=nl(a);b=nl(b);const n=t.split(a).length-1;if(n!==1)throw new Error(`expected 1 match, found ${n}: ${a.slice(0,70)}`);t=t.replace(a,()=>b);};
rep(`// ── inbound messages ────────────────────────────────────────────────────────`,`// ── calendar reminders ──────────────────────────────────────────────────────
// Work queues a message when a calendar alert fires; PAW DMs it with Done/Snooze and acknowledges it.
async function deliverReminders() {
  let items;
  try { items = (await api('/work/api/calendar/outbox?channel=discord')).items || []; } catch { return; }
  if (!items.length) return;
  const dm = await ownerDM(), sent = [];
  state.reminders ??= {};
  for (const r of items) {
    const first = r.kind === 'todo' ? 'done' : 'dismiss';
    const row = new ActionRowBuilder().addComponents(
      button(\`c:\${first}:\${r.id}\`, r.kind === 'todo' ? 'Done' : 'OK', ButtonStyle.Success),
      button(\`c:snooze:\${r.id}\`, 'Snooze 10 min', ButtonStyle.Secondary));
    try {
      await dm.send({ content: \`**\${r.kind === 'todo' ? 'To-do' : 'Reminder'}: \${clip(r.title || 'Untitled', 180)}**\\n\${clip(r.when || '', 200)}\${webLink()}\`, components: [row], allowedMentions: NO_PINGS });
      state.reminders[r.id] = { key: r.key, at: Date.now() };
      sent.push(r.id);
    } catch (e) { log('reminder DM failed:', e.message); }
  }
  for (const [id, v] of Object.entries(state.reminders)) if (Date.now() - v.at > 3 * 86400000) delete state.reminders[id];
  if (sent.length) { await api('/work/api/calendar/outbox/ack', { ids: sent }).catch(e => log('reminder ack failed:', e.message)); await save(); }
}

// ── inbound messages ────────────────────────────────────────────────────────`);
rep(`  for (const id of Object.keys(state.tasks)) if (!live.has(id)) delete state.tasks[id];
  state.initialized = true;
  await save();
}`,`  for (const id of Object.keys(state.tasks)) if (!live.has(id)) delete state.tasks[id];
  state.initialized = true;
  await save();
  await deliverReminders();
}`);
rep(`  const [kind, arg, id] = i.customId.split(':');
  if (kind === 'w') {`,`  const [kind, arg, id] = i.customId.split(':');
  if (kind === 'c') {
    await i.deferUpdate();
    const key = state.reminders?.[id]?.key;
    if (!key) { await i.editReply({ components: [] }); return; }
    await api('/work/api/calendar/reminder', { key, action: arg, minutes: 10 });
    const note = arg === 'snooze' ? '**Snoozed for 10 minutes.**' : arg === 'done' ? '**Done.** Ticked off in your to-dos.' : '**Got it.**';
    await i.editReply({ content: clip(i.message.content, 1850) + '\\n' + note, components: [], allowedMentions: NO_PINGS });
    return;
  }
  if (kind === 'w') {`);
await writeFile(file,t);console.log('bridge patched; backup at',file+'.bak-calendar');
