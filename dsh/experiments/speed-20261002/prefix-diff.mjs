// Where do two Work sessions' first requests diverge? (prompt-cache reuse across task starts)
import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {readSession} from './readsession.mjs';
const root=process.argv[2]||'C:/Users/Joel Robinson/.dsh-next/sessions';
const files=[];
for(const d of readdirSync(root))for(const s of readdirSync(join(root,d))){const f=join(root,d,s,'session.v4.jsonl.zstd');try{files.push({f,t:statSync(f).mtimeMs});}catch{}}
files.sort((a,b)=>b.t-a.t);
const headers=[];for(const {f} of files){const ev=readSession(f),h=ev.find(e=>e.type==='request/header')?.data?.header;const sys=ev.find(e=>e.type==='system/message')?.data;if(h&&sys)headers.push({f,h:{...h,system:sys}});if(headers.length===4)break;}
const [A,B]=headers;const a=A.h,b=B.h;
console.log('header keys:',Object.keys(a).join(','));
const sa=JSON.stringify(a.system),sb=JSON.stringify(b.system);let i=0;while(i<sa.length&&sa[i]===sb[i])i++;
console.log('system chars',sa.length,sb.length,'| first difference at',i===sa.length&&sa.length===sb.length?'none (identical)':i);
if(i<sa.length)console.log(' A:',sa.slice(Math.max(0,i-160),i+100),'\n B:',sb.slice(Math.max(0,i-160),i+100));
const ta=a.tools.map(t=>t.name),tb=b.tools.map(t=>t.name);let j=0;while(j<Math.min(ta.length,tb.length)&&JSON.stringify(a.tools[j])===JSON.stringify(b.tools[j]))j++;
console.log('tools',ta.length,tb.length,'| identical leading tools',j,'| first difference:',ta[j],'vs',tb[j]);
console.log('tool order A:',ta.join(' '));
