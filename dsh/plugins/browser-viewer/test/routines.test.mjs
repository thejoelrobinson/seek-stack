import {test} from 'node:test';
import assert from 'node:assert/strict';
import {availability,groceryPlan,runRoutine,routineTools} from '../lib/work-routines.js';
const ms=s=>Date.parse(s+'Z');
test('nested and touching events merge; conflicts and free windows are computed',()=>{
 const calendar={zone:'UTC',range:()=>({events:[{id:'a',kind:'event',title:'A',start:ms('2026-10-09T10:00'),end:ms('2026-10-09T12:00')},{id:'b',kind:'event',title:'B',start:ms('2026-10-09T11:00'),end:ms('2026-10-09T11:30')},{id:'c',kind:'event',title:'C',start:ms('2026-10-09T12:00'),end:ms('2026-10-09T13:00')}],todos:[]})};
 const r=availability(calendar,{from:'2026-10-09T09:00',to:'2026-10-09T14:00'});assert.equal(r.conflicts.length,1);assert.deepEqual(r.free.map(f=>f.minutes),[60,60]);
 assert.throws(()=>availability(calendar,{from:'bad',to:'bad'}));
 assert.throws(()=>availability(calendar,{from:'2026-10-09',to:'2026-10-08'}));
});
test('grocery merging uses exact IDs and subtracts pantry and existing cart',()=>{
 const input={items:[{productId:'milk',quantity:3},{productId:'milk',quantity:2}],pantry:[{productId:'milk',quantity:1}],cart:[{productId:'milk',quantity:2}],catalog:[{productId:'milk',priceCents:399,available:true}]};
 const r=groceryPlan(input);assert.equal(r.lines[0].addQuantity,2);assert.equal(r.lines[0].targetQuantity,4);assert.equal(r.subtotalCents,798);assert.equal(r.externalChanges,false);
 assert.equal(groceryPlan({...input,cart:[{productId:'milk',quantity:4}]}).lines.length,0);
 assert.equal(groceryPlan({...input,budgetCents:700}).ready,false);
 assert.equal(groceryPlan({...input,catalog:[]}).ready,false);
 assert.throws(()=>groceryPlan({...input,items:[{productId:'milk',quantity:0.5}]}));
 assert.throws(()=>groceryPlan({...input,catalog:[...input.catalog,...input.catalog]}));
});
test('runner rejects unknown code and reports CPU execution',()=>{
 assert.throws(()=>runRoutine(null,'eval',{code:'process.exit()'}));
 const r=runRoutine(null,'grocery_cart_plan',{items:[],catalog:[]});assert.equal(r.modelCalls,0);assert.equal(r.execution,'cpu');
});
test('calendar tool checks task ownership before running',async()=>{
 const tools=routineTools(null,(name,description,parameters,execute)=>({name,execute}),()=>{throw new Error('No task');},()=>{});
 assert.throws(()=>tools[0].execute({},{}),/No task/);
});
