import {DatabaseSync} from 'node:sqlite';
import {DreamingService} from '../../plugins/browser-viewer/lib/work-dreaming.js';
import {complete} from '../../plugins/browser-viewer/lib/work-extras.js';
const db=new DatabaseSync('C:/Users/Joel Robinson/.dsh/work/work.sqlite',{readOnly:true});
const tasks=db.prepare('select id,data from tasks order by ordinal').all().map(r=>({...JSON.parse(r.data),messages:db.prepare('select data from messages where task_id=? order by ordinal').all(r.id).map(m=>JSON.parse(m.data))}));
const d=await new DreamingService(process.argv[2],{tasks:()=>tasks,busy:()=>false,log:console,model:async(m,o)=>{const out=await complete(m,o);console.log('>>',m[0].content.slice(0,10),String(out).slice(0,900).replace(/\s+/g,' '));return out;}}).init();
console.log('sources with birthday:',d.sources().filter(s=>s.turns.some(t=>/birthday|anniversary|\bborn\b/i.test(t.user))).map(s=>s.title));
console.log('added',await d.backfillDates());
for(const l of d.data.lessons.filter(l=>l.eventDate))console.log('DATE',l.eventDate,l.eventLabel,l.text);
