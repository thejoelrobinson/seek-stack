// Compares the latest full task-test run with an earlier baseline, case by case: pass, steps,
// bookkeeping steps and seconds. Usage: node fastpath-compare.mjs [earlierRunIdPrefix]
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('C:/Users/Joel Robinson/.dsh/work/growth.sqlite',{readOnly:true});
const runs=db.prepare("SELECT * FROM eval_runs WHERE overlay IS NULL AND status='complete' ORDER BY started_at DESC").all();
const after=runs[0],before=process.argv[2]?runs.find(r=>r.id.startsWith(process.argv[2])):runs[1];
const BOOK=['work_progress','work_contract','work_artifact','work_verify','work_finish','get_goal','update_goal','work_checkpoint','work_suggest','todo_write'];
const rows=id=>new Map(db.prepare('SELECT * FROM eval_results WHERE run_id=?').all(id).map(r=>[r.case_id,{...r,detail:JSON.parse(r.detail)}]));
const A=rows(after.id),B=rows(before.id),book=r=>BOOK.reduce((n,k)=>n+(r?.detail?.toolCounts?.[k]||0),0);
console.log(`before ${before.id.slice(0,8)} ${new Date(before.started_at).toLocaleString()} ${before.passed}/${before.total}`);
console.log(`after  ${after.id.slice(0,8)} ${new Date(after.started_at).toLocaleString()} ${after.passed}/${after.total}\n`);
console.log('case'.padEnd(19),'pass b→a','steps b→a','bookkeeping b→a','seconds b→a');
const tot={b:{s:0,k:0,t:0},a:{s:0,k:0,t:0}};
for(const [id,a] of A){const b=B.get(id);
  console.log(id.padEnd(19),`${b?b.passed?'✓':'✗':'·'}→${a.passed?'✓':'✗'}`.padEnd(9),`${b?.steps??'-'}→${a.steps}`.padEnd(10),`${b?book(b):'-'}→${book(a)}`.padEnd(16),`${b?Math.round(b.seconds):'-'}→${Math.round(a.seconds)}`,a.passed?'':'| '+(a.detail.reason||'').slice(0,90));
  if(b){tot.b.s+=b.steps;tot.b.k+=book(b);tot.b.t+=b.seconds;tot.a.s+=a.steps;tot.a.k+=book(a);tot.a.t+=a.seconds;}}
console.log(`\nshared cases: steps ${tot.b.s}→${tot.a.s} (${Math.round((1-tot.a.s/tot.b.s)*100)}% fewer), bookkeeping ${tot.b.k}→${tot.a.k}, time ${Math.round(tot.b.t)}s→${Math.round(tot.a.t)}s (${Math.round((1-tot.a.t/tot.b.t)*100)}% faster)`);
