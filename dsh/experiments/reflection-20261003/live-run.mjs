// Runs the new DreamingService (extract + audit) on real tasks with the real model, in a temp dir.
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DreamingService} from '../../plugins/browser-viewer/lib/work-dreaming.js';
import {complete} from '../../plugins/browser-viewer/lib/work-extras.js';
const only=process.argv.slice(2);
const db=new DatabaseSync('C:/Users/Joel Robinson/.dsh/work/work.sqlite',{readOnly:true});
const tasks=db.prepare('select id,data from tasks order by ordinal').all().map(r=>({...JSON.parse(r.data),messages:db.prepare('select data from messages where task_id=? order by ordinal').all(r.id).map(m=>JSON.parse(m.data))})).filter(t=>!only.length||only.some(p=>t.id.startsWith(p)));
const d=await new DreamingService(await mkdtemp(join(tmpdir(),'reflect-live-')),{tasks:()=>tasks,busy:()=>false,log:console,model:async(m,o)=>{const out=await complete(m,o);if(process.env.TRACE)console.log('>>',m[0].content.slice(0,12),String(out).slice(0,700).replace(/s+/g,' '));return out;}}).init();
const t0=Date.now();await d.run('manual',new AbortController().signal);
const r=d.data.runs[0];console.log(r.status,r.summary,r.error||'',`${((Date.now()-t0)/1000).toFixed(0)}s rejected=${r.rejected}`);
for(const l of d.data.lessons)console.log(` [${l.status}] ${l.kind}/${l.scope} (${l.confidence}) ${l.text}\n     "${l.sources[0].quote.slice(0,80)}" — ${l.sources[0].title}`);
