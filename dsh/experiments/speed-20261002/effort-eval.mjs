// Fixed real-model task set with checkable answers, run at several reasoning efforts on a Work
// instance. Usage: node effort-eval.mjs <base=http://127.0.0.1:3091> <workRoot> <effort...>
import {readFile,appendFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [base='http://127.0.0.1:3091',workRoot,...efforts]=process.argv.slice(2);
const here=dirname(fileURLToPath(import.meta.url)),run=Date.now().toString(36);
// Same catalog formula as shop-fixture.mjs.
const items=Array.from({length:45},(_,i)=>({name:`Item ${String(i+1).padStart(2,'0')}`,price:Math.round((((i*37)%89)+5+((i*13)%100)/100)*100)/100}));
const cheapest=[...items].sort((a,b)=>a.price-b.price).slice(0,5),under20=items.filter(x=>x.price<20).length;
const csv='date,category,amount\n2026-09-01,groceries,54.20\n2026-09-02,fuel,38.10\n2026-09-03,groceries,23.75\n2026-09-05,dining,41.00\n2026-09-08,fuel,40.65\n2026-09-11,dining,18.50\n2026-09-14,groceries,61.05\n2026-09-20,utilities,120.00\n';
const totals={groceries:139,fuel:78.75,dining:59.5,utilities:120};
const read=async(id,name)=>{try{return await readFile(join(workRoot,'tasks',id,name),'utf8');}catch{return '';}};
const tasks=[
 {key:'browse-cheapest',body:{objective:'Open http://127.0.0.1:18877/shop in the browser. The catalog has several pages. Find the 5 cheapest items across all pages and save them to cheapest-items.md as a table (name, price), cheapest first.',mode:'task'},
  check:async t=>{const s=await read(t.id,'cheapest-items.md');const prices=[...s.matchAll(/\$?(\d+\.\d\d)/g)].map(m=>Number(m[1]));return cheapest.every((c,i)=>prices[i]===c.price);}},
 {key:'browse-count',body:{objective:'Open http://127.0.0.1:18877/shop. Across all catalog pages, how many items cost less than $20.00? Save just the number to count.txt.',mode:'task'},
  check:async t=>(await read(t.id,'count.txt')).trim()===String(under20)},
 {key:'code-run',body:{objective:'Write fib.py that prints the 30th Fibonacci number (F(1)=1, F(2)=1). Run it and save the printed output to fib.txt.',mode:'task'},
  check:async t=>/\b832040\b/.test(await read(t.id,'fib.txt'))},
 {key:'data-totals',body:{objective:'The attached expenses.csv has date, category and amount columns. Compute the total amount per category and save it to totals.json as an object mapping category to total (numbers).',mode:'task',files:[{name:'expenses.csv',data:Buffer.from(csv).toString('base64')}]},
  check:async t=>{try{const j=JSON.parse(await read(t.id,'totals.json'));return Object.entries(totals).every(([k,v])=>Math.abs(Number(j[k])-v)<0.005)&&Object.keys(j).length===4;}catch{return false;}}},
 {key:'chat-reason',body:{objective:'A recipe needs 3 eggs for every 2 cakes. How many whole eggs do I need to bake 7 cakes if I can only use whole eggs? Answer with the number and one short sentence.',mode:'chat'},
  check:async t=>/\b11\b/.test(t.result||'')},
 {key:'write-note',body:{objective:'Write a warm 120 to 160 word thank-you note to a local bakery for a great birthday cake and save it to note.md.',mode:'task'},
  check:async t=>{const s=await read(t.id,'note.md');const words=s.replace(/[#*_>-]/g,' ').split(/\s+/).filter(Boolean).length;return /thank/i.test(s)&&words>=100&&words<=200;}},
];
const api=async(path,body)=>{const r=await fetch(base+'/work/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j;};
for(const effort of efforts)for(const task of tasks){
  const created=await api('task',{...task.body,objective:`[Eval ${effort}] `+task.body.objective,effort,requestId:`eval-${run}-${effort}-${task.key}`});
  let t;const deadline=Date.now()+15*60000;
  do{await new Promise(r=>setTimeout(r,4000));t=await api('task?id='+created.id);}while(!['complete','attention','stopped','waiting'].includes(t.status)&&Date.now()<deadline);
  const ok=t.status==='complete'&&await task.check(t);
  const row={run,effort,task:task.key,status:t.status,correct:ok,seconds:t.completedAt&&t.startedAt?Math.round((t.completedAt-t.startedAt)/1000):null,steps:(t.events||[]).length};
  console.log(JSON.stringify(row));await appendFile(join(here,'effort-eval.jsonl'),JSON.stringify(row)+'\n');
  if(t.status==='waiting'||t.status==='attention')await api('control',{id:t.id,action:'stop'}).catch(()=>{});
}
