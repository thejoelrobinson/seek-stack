import test from 'node:test';
import assert from 'node:assert/strict';
import {FinanceService,financeTools} from '../lib/work-finance.js';
import {financeAnswers,recordFinanceEvidence} from '../lib/work-server.js';

test('finance tools report the rows an answer used, and answers carry that evidence beside the dashboard',async()=>{
 const f=new FinanceService('fixture',{warn(){}});f.items=[{id:'bank',institution:'Fixture bank',accounts:[{account_id:'acct',name:'Card',mask:'4242'}]}];f.data.updatedAt=1;
 f.data.transactions=Array.from({length:80},(_,n)=>({id:String(n),itemId:'bank',accountId:'acct',date:'2026-09-'+String(1+n%28).padStart(2,'0'),name:'Cafe '+(n%3),merchant:'Cafe '+(n%3),category:'FOOD_AND_DRINK',amount:4.5,currency:'USD',pending:false}));
 const tools=new Map(),seen=[];const ctx={tools:{register:tool=>{tools.set(tool.name,tool);return tool;}}};
 const t={id:'q1',domain:'finance',objective:'How much did I spend on coffee?',status:'complete',createdAt:2,messages:[{role:'user',text:'How much did I spend on coffee?'},{role:'assistant',text:'About **$360** across 80 visits.'}]};
 financeTools(f,ctx,{onEvidence:(exec,evidence)=>{seen.push(exec.agent.id);recordFinanceEvidence(t,evidence);}});
 const run=(name,args)=>(tools.get(name).execute||tools.get(name).handler)(args,{agent:{id:'session-1'}});
 const result=await run('finance_transactions',{query:'Cafe',limit:70});assert.equal(result.returned,70);
 await run('finance_transactions',{query:'Cafe',limit:70});
 await run('finance_spending_report',{from:'2026-09-01',to:'2026-09-30'});
 assert.deepEqual(seen,['session-1','session-1','session-1']);
 assert.equal(t.financeEvidence.rows.length,60,'evidence rows are bounded and de-duplicated');assert.equal(t.financeEvidence.queries.at(-1).matched,80);assert.deepEqual(t.financeEvidence.reports[0].from,'2026-09-01');
 assert.equal(t.financeEvidence.rows[0].account,'Card ••4242');assert.equal('id' in t.financeEvidence.rows[0],false,'provider ids are not exposed');
 const other={id:'chat',objective:'Hello',createdAt:3,messages:[]},archived={...t,id:'old',archived:true};
 const {answers}=financeAnswers([t,other,archived]);assert.deepEqual(answers.map(a=>a.id),['q1']);assert.match(answers[0].answer,/\$360/);assert.equal(answers[0].evidence.rows.length,60);
});
