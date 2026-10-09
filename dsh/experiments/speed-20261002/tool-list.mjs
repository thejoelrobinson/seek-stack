import {readdirSync,statSync} from 'node:fs';import {join} from 'node:path';import {readSession} from './readsession.mjs';
const root='C:/Users/Joel Robinson/.dsh/sessions';
for(const d of readdirSync(root).filter(d=>d.includes(process.argv[2])))for(const s of readdirSync(join(root,d))){const f=join(root,d,s,'session.v4.jsonl.zstd');try{statSync(f);}catch{continue;}
 for(const e of readSession(f))if(e.type==='tool/call')console.log(new Date(e.time).toLocaleTimeString(),e.data.name,String(e.data.arguments).slice(0,170).replace(/\s+/g,' '));}
