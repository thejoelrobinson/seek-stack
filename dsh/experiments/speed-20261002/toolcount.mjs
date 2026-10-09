import {readSession} from './readsession.mjs';
import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
const root='C:/Users/Joel Robinson/.dsh/sessions';
const dirs=readdirSync(root).filter(d=>d.includes('Joel~0020Robinson-.dsh-work-tasks'));
const count={},sessionsUsing={};
for(const d of dirs)for(const s of readdirSync(join(root,d))){
  const file=join(root,d,s,'session.jsonl.zstd');try{statSync(file);}catch{continue;}
  const used=new Set();for(const e of readSession(file))if(e.type==='tool/call'){count[e.data.name]=(count[e.data.name]||0)+1;used.add(e.data.name);}
  for(const n of used)sessionsUsing[n]=(sessionsUsing[n]||0)+1;
}
console.log(Object.entries(count).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+':'+v+'/'+sessionsUsing[k]+'s').join('  '));
