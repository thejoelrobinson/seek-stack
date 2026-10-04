import {randomUUID} from 'node:crypto';

export function pendingReplies(task) {
  task.outbox??=[];
  const joined=task.outbox.filter(x=>x.state!=='delivered').map(x=>x.text).join('\n\n');
  // Adopt old stores and browser handoff continuations which use the legacy field.
  if(task.pendingReply && task.pendingReply!==joined && !task.outbox.some(x=>x.state!=='delivered'&&x.text===task.pendingReply))task.outbox.push({id:randomUUID(),text:task.pendingReply,state:'pending',at:Date.now()});
  return task.outbox.filter(x=>x.state!=='delivered');
}
export function enqueueReply(task,text,id=randomUUID(),mode='queue') {
  pendingReplies(task);
  const existing=task.outbox.find(x=>x.id===id);
  if(existing){if(existing.text!==text)throw new Error('That message ID was already used for different text.');return existing;}
  const entry={id,text,mode,state:'pending',at:Date.now()};task.outbox.push(entry);syncPending(task);return entry;
}
export function syncPending(task) {task.pendingReply=(task.outbox||[]).filter(x=>x.state!=='delivered').map(x=>x.text).join('\n\n')||null;task.deliveries=(task.outbox||[]).slice(-20).map(x=>({id:x.id,requestId:x.id,text:x.text,receivedAt:x.at,appliedAt:x.deliveredAt||null,status:x.state==='delivered'?'applied':x.state==='uncertain'?'uncertain':'received'}));}
export function deliveryText(entries) {return entries.map(x=>`[Seek message ${x.id}]\n${x.text}`).join('\n\n');}
export function acknowledge(task,entries) {for(const entry of entries){entry.state='delivered';entry.deliveredAt??=Date.now();}task.outbox=task.outbox.filter(x=>x.state!=='delivered').concat(task.outbox.filter(x=>x.state==='delivered').slice(-100));syncPending(task);}
export function deliverySeen(history,entry) {
  const marker=`[Seek message ${entry.id}]`;
  return JSON.stringify(history?.projections?.values?.goal||{}).includes(marker)||(history?.events||[]).some(({event})=>event?.type==='user/message'&&JSON.stringify(event.data).includes(marker));
}
