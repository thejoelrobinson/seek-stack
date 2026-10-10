import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,objectSchema,validate,jsonValue} from '../lib/work-capabilities.js';
import {validateRecipe,bind} from '../lib/work-workflows.js';
import {registerWorkflowCapabilities,workflowText} from '../lib/work-workflow-service.js';
import {availability,groceryPlan} from '../lib/work-routines.js';
import {workflowInput,BUILTIN_TEMPLATES,templateForm} from '../lib/work-product.js';
const registry=registerWorkflowCapabilities(new CapabilityRegistry(),{calendar:{zone:'UTC',range:()=>({events:[],todos:[]})}});
const schema=objectSchema({values:{type:'array',items:{type:'integer'},maxItems:100}},['values']);
const recipe=()=>({id:'sum_values',version:1,title:'Sum amounts',input:schema,steps:[{id:'sum',capability:'data.sum_cents',version:1,input:{values:{$ref:'input.values'}}}],result:'sum'});
test('recipe hashes are stable and typed bindings work',()=>{const a=validateRecipe(recipe(),registry);assert.equal(a.hash,validateRecipe({...recipe(),title:'Sum amounts'},registry).hash);assert.deepEqual(bind(recipe().steps[0].input,{values:[1,2]},{}),{values:[1,2]});});
test('reject unknown capabilities, forward references and cycles before executing',()=>{for(const change of [r=>r.steps[0].capability='shell.eval',r=>r.steps[0].input.values={$ref:'steps.sum.totalCents'},r=>r.steps[0].version=99]){const r=recipe();change(r);assert.throws(()=>validateRecipe(r,registry));}});
test('reject wrong reference types, duplicate steps, arbitrary source and unsupported schema keywords',()=>{
 let r=recipe();r.steps[0].input.values={$ref:'input'};assert.throws(()=>validateRecipe(r,registry));
 r=recipe();r.steps.push(r.steps[0]);assert.throws(()=>validateRecipe(r,registry));
 r=recipe();r.code='process.exit()';assert.throws(()=>validateRecipe(r,registry));
 r=recipe();r.input.properties.values.pattern='.*';assert.throws(()=>validateRecipe(r,registry));
});
test('JSON boundary rejects unsafe keys, nonfinite numbers, deep and oversized values',()=>{assert.throws(()=>jsonValue(JSON.parse('{"__proto__":{}}')));assert.throws(()=>jsonValue({n:Infinity}));assert.throws(()=>jsonValue('x'.repeat(100),{maxBytes:10}));let x=0;for(let i=0;i<22;i++)x={x};assert.throws(()=>jsonValue(x));});
test('schema validation rejects unknown inputs and fractional cents',()=>{assert.throws(()=>validate(schema,{values:[0.2]}));assert.throws(()=>validate(schema,{values:[],other:1}));assert.throws(()=>validate(schema,{}));});
test('calendar rejects impossible dates and daylight-saving gaps',()=>{const calendar={zone:'America/Chicago',range:()=>({events:[],todos:[]})};for(const from of ['2026-02-30T09:00','2026-13-01','2026-03-08T02:30','2026-10-09T25:00'])assert.throws(()=>availability(calendar,{from,to:'2026-10-10T10:00'}));});
test('calendar free intervals use real elapsed time over daylight saving',()=>{const calendar={zone:'America/Chicago',range:()=>({events:[],todos:[]})};assert.equal(availability(calendar,{from:'2026-03-08T01:00',to:'2026-03-08T04:00'}).free[0].minutes,120);});
test('full-cart budget includes unrelated existing items and flags unknown prices',()=>{
 const input={items:[{productId:'milk',quantity:1}],catalog:[{productId:'milk',priceCents:300,available:true},{productId:'eggs',priceCents:500,available:true}],cart:[{productId:'eggs',quantity:2}],budgetCents:1000};const r=groceryPlan(input);assert.equal(r.subtotalCents,300);assert.equal(r.cartSubtotalCents,1300);assert.equal(r.ready,false);
 const unknown=groceryPlan({...input,catalog:input.catalog.slice(0,1)});assert.equal(unknown.cartSubtotalCents,null);assert.ok(unknown.exceptions.some(x=>x.reason.includes('unknown')));
});
test('aggregate quantities cannot bypass per-product caps',()=>{assert.throws(()=>groceryPlan({items:[{productId:'x',quantity:9000},{productId:'x',quantity:9000}],catalog:[]}));});
test('grocery UI uses supplied prices and validates duplicate prices',()=>{
 const t=BUILTIN_TEMPLATES.find(t=>t.id==='cpu-groceries');const input=workflowInput(t,{shopping:'Milk | 3 | 3.99',pantry:'Milk | 1',cart:'Milk | 1',budget:'15'});assert.equal(input.catalog[0].priceCents,399);assert.equal(groceryPlan(input).lines[0].addQuantity,1);
 assert.throws(()=>workflowInput(t,{shopping:'Milk | 1 | 3.99\nMilk | 1 | 4.99'}));assert.throws(()=>workflowInput(t,{shopping:'Milk | 1 | 3.999'}));
});
test('structured grocery inputs account for pantry and cart and identify invalid fields',()=>{
 const t=BUILTIN_TEMPLATES.find(t=>t.id==='cpu-groceries');
 const input=workflowInput(t,{products:[{name:'Milk',quantity:'4',price:'3.99',pantry:'1',cart:'1'}],budget:'12'});
 const result=groceryPlan(input);assert.equal(result.lines[0].addQuantity,2);assert.equal(result.subtotalCents,798);assert.equal(result.cartSubtotalCents,1197);
 for(const [field,value] of [['name',''],['price','3.999'],['quantity','-1'],['pantry','10001']])assert.throws(()=>workflowInput(t,{products:[{name:'Milk',quantity:'1',price:'3.99',[field]:value}]}),error=>error.field==='product-0-'+field);
 assert.throws(()=>workflowInput(t,{products:[]}),/at least one/);assert.throws(()=>workflowInput(t,{products:[{name:'Milk',price:'3.99'}],budget:'10001'}),error=>error.field==='budget');
});
test('calendar form defaults to the shared zone, validates ordering and produces readable results',()=>{
 const t=BUILTIN_TEMPLATES.find(t=>t.id==='cpu-calendar'),form=templateForm(t,{zone:'America/Chicago',now:Date.parse('2026-10-10T02:00:00Z')});
 assert.match(form,/type="datetime-local"/);assert.match(form,/2026-10-09T09:00/);assert.match(form,/America\/Chicago/);
 assert.throws(()=>workflowInput(t,{from:'2026-10-10T17:00',to:'2026-10-10T09:00'}),error=>error.field==='to');
 assert.deepEqual(workflowInput(t,{from:'2026-10-10T09:00',to:'2026-10-10T17:00',minutes:'60'}),{from:'2026-10-10T09:00',to:'2026-10-10T17:00',minutes:60});
 const result=availability({zone:'America/Chicago',range:()=>({events:[],todos:[]})},{from:'2026-10-10T09:00',to:'2026-10-10T17:00'}),text=workflowText({workflow:'calendar_availability',result});
 assert.match(text,/9:00 AM – 5:00 PM/);assert.match(text,/480 minutes free/);assert.doesNotMatch(text,/T14:00/);
});
test('seeded grocery invariants: no duplicate additions when rerun against resulting cart',()=>{
 let seed=7123;const rand=()=>{seed=(seed*16807)%2147483647;return seed%20;};
 for(let i=0;i<200;i++){const wanted=rand(),owned=rand(),existing=rand(),p={productId:'p',quantity:wanted};const input={items:[p],pantry:[{...p,quantity:owned}],cart:[{...p,quantity:existing}],catalog:[{productId:'p',available:true,priceCents:199}]};const r=groceryPlan(input),target=Math.max(existing,wanted-owned);assert.equal(r.subtotalCents,Math.max(0,target-existing)*199);assert.equal(groceryPlan({...input,cart:[{...p,quantity:target}]}).lines.length,0);}
});
test('capability versions cannot be silently replaced',()=>{assert.throws(()=>registry.register({...registry.get('data.count',1)}));});
