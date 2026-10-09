import {readSession} from './readsession.mjs';
import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
const root='C:/Users/Joel Robinson/.dsh/sessions';
const dirs=readdirSync(root).filter(d=>d.includes('Joel~0020Robinson-.dsh-work-tasks'));
const long=[];const cats={};
const classify=t=>/completion check|work_verify|deliverable|ok:false|verif/i.test(t)?'verification/repair':/scroll|snapshot|ref|click|page|element|viewport/i.test(t.slice(0,1500))?'browser navigation':/write|file|markdown|section|draft|format/i.test(t.slice(0,1500))?'composing output':/compaction|checkpoint|summary|recall|context/i.test(t.slice(0,1500))?'recovering context':'other';
for(const d of dirs)for(const s of readdirSync(join(root,d))){
  const file=join(root,d,s,'session.jsonl.zstd');try{statSync(file);}catch{continue;}
  let prevTool='';
  for(const e of readSession(file)){
    if(e.type==='tool/call')prevTool=e.data.name;
    if(e.type==='assistant/message'){const r=(e.data.message.content||[]).filter(c=>c.type==='reasoning').map(c=>c.text).join('');if(r.length>4000){const c=classify(r);cats[c]=(cats[c]||0)+r.length;long.push({len:r.length,prevTool,c,head:r.slice(0,400).replace(/\s+/g,' ')});}}
  }
}
const tot=Object.values(cats).reduce((a,b)=>a+b,0);
console.log('long-reasoning steps',long.length,Object.fromEntries(Object.entries(cats).map(([k,v])=>[k,(v/tot*100).toFixed(0)+'%'])));
const byPrev={};for(const l of long)byPrev[l.prevTool]=(byPrev[l.prevTool]||0)+1;console.log('preceding tool',Object.entries(byPrev).sort((a,b)=>b[1]-a[1]).slice(0,10));
for(const l of long.sort(()=>Math.random()-.5).slice(0,6))console.log('\n['+l.len+' '+l.c+' after '+l.prevTool+'] '+l.head);
