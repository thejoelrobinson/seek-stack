import {readdirSync,statSync} from 'node:fs';import {join} from 'node:path';import {readSession} from './readsession.mjs';
const root='C:/Users/Joel Robinson/.dsh/sessions';
for(const d of readdirSync(root).filter(d=>d.includes(process.argv[2])))for(const s of readdirSync(join(root,d))){const f=join(root,d,s,'session.v4.jsonl.zstd');try{statSync(f);}catch{continue;}
 const ev=readSession(f);const types={};for(const e of ev)types[e.type]=(types[e.type]||0)+1;console.log(JSON.stringify(types));
 for(const e of ev)if(/approv|question|permission/i.test(e.type)||(e.time>Date.parse('2026-10-03T17:17:00Z')&&e.time<Date.parse('2026-10-03T20:12:00Z')&&!/chunk/.test(e.type)))console.log(new Date(e.time).toLocaleTimeString(),e.type,JSON.stringify(e.data).slice(0,260));}
