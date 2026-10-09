import {DatabaseSync} from 'node:sqlite';
import {DreamingService} from '../../plugins/browser-viewer/lib/work-dreaming.js';
const db=new DatabaseSync('C:/Users/Joel Robinson/.dsh/work/work.sqlite',{readOnly:true});
const tasks=db.prepare('select data from tasks').all().map(r=>JSON.parse(r.data));
const d=await new DreamingService(process.argv[2],{tasks:()=>tasks,busy:()=>true}).init();
for(const q of ['the user themselves - who they are, preferences, and how they like me to work','the user','preferences','wife family','profile about me'])console.log(q,'=>',JSON.stringify(d.lookup(q,{project:null,person:'owner'})).slice(0,300));
