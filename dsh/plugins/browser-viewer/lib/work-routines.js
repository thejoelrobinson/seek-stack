// Reusable CPU routines. No generated source is evaluated and no external writes occur.
import {parseWhen,localText,present} from './work-calendar-tools.js';

export function availability(calendar,{from,to,minutes=30}){
  for(const value of [from,to]){
    const m=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
    if(!m)throw new Error('Use YYYY-MM-DD or YYYY-MM-DDTHH:MM in the calendar timezone.');
    const date=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));if(date.getUTCFullYear()!==+m[1]||date.getUTCMonth()+1!==+m[2]||date.getUTCDate()!==+m[3]||+(m[4]||0)>23||+(m[5]||0)>59)throw new Error('Invalid calendar date or time.');
    const parsed=parseWhen(value,calendar.zone);if(localText(parsed.ms,calendar.zone,{dateOnly:!m[4]})!==value)throw new Error('That local time does not exist due to daylight saving. Choose another time.');
  }
  const start=parseWhen(from,calendar.zone)?.ms,end=parseWhen(to,calendar.zone)?.ms;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000)throw new Error('Provide a positive calendar window of at most 31 days.');
  if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw new Error('Duration must be 1–1440 minutes.');
  const {events,todos}=calendar.range(start,end),busy=[],conflicts=[];let conflictCount=0;
  const sorted=events.filter(e=>e.end>start&&e.start<end).sort((a,b)=>a.start-b.start);
  if(sorted.length>1000)throw new Error('Too many calendar occurrences; choose a smaller window.');
  for(let i=0;i<sorted.length;i++){
    const e=sorted[i];
    for(let j=i+1;j<sorted.length&&sorted[j].start<e.end;j++){conflictCount++;if(conflicts.length<1000)conflicts.push({first:e.id,second:sorted[j].id,start:localText(Math.max(e.start,sorted[j].start),calendar.zone),end:localText(Math.min(e.end,sorted[j].end),calendar.zone)});}
    const s=Math.max(start,e.start),t=Math.min(end,e.end),last=busy.at(-1);
    if(last&&s<=last.end)last.end=Math.max(last.end,t);else busy.push({start:s,end:t});
  }
  const free=[];let cursor=start;
  for(const b of [...busy,{start:end,end}]){if(b.start-cursor>=minutes*60000)free.push({start:localText(cursor,calendar.zone),end:localText(b.start,calendar.zone),minutes:(b.start-cursor)/60000});cursor=Math.max(cursor,b.end);}
  return {zone:calendar.zone,events:sorted.map(e=>present(e,calendar.zone)),todos:todos.filter(t=>!t.done).map(t=>present(t,calendar.zone)),conflicts,conflictCount,free};
}

export function groceryPlan({items,catalog,pantry=[],cart=[],budgetCents}){
  for(const [name,list] of Object.entries({items,catalog,pantry,cart}))if(!Array.isArray(list)||list.length>500)throw new Error(`${name} must be an array of at most 500 entries.`);
  const quantity=q=>{if(!Number.isInteger(q)||q<0||q>10000)throw new Error('Quantities must be whole packages between 0 and 10000.');return q;};
  const id=p=>{if(typeof p.productId!=='string'||!p.productId.trim()||p.productId.length>200)throw new Error('Each entry needs an exact productId.');return p.productId;};
  const aggregate=list=>{const map=new Map();for(const p of list){const k=id(p);map.set(k,quantity(quantity(p.quantity)+(map.get(k)||0)));}return map;};
  const wanted=aggregate(items),owned=aggregate(pantry),current=aggregate(cart),products=new Map(),exceptions=[],lines=[];
  for(const p of catalog){const k=id(p);if(products.has(k))throw new Error(`Duplicate catalog product: ${k}`);if(!Number.isSafeInteger(p.priceCents)||p.priceCents<0)throw new Error('Prices must be nonnegative integer cents.');products.set(k,p);}
  if(budgetCents!==undefined&&(!Number.isSafeInteger(budgetCents)||budgetCents<0))throw new Error('Budget must be nonnegative integer cents.');
  let subtotalCents=0;
  for(const [productId,requested] of wanted){const targetQuantity=Math.max(0,requested-(owned.get(productId)||0)),existingQuantity=current.get(productId)||0,addQuantity=Math.max(0,targetQuantity-existingQuantity);if(!addQuantity)continue;
    const p=products.get(productId);if(!p||p.available!==true){exceptions.push({productId,reason:p?'Availability not confirmed':'Product not in catalog'});continue;}
    const costCents=addQuantity*p.priceCents;if(!Number.isSafeInteger(costCents+subtotalCents))throw new Error('Subtotal exceeds supported range.');subtotalCents+=costCents;
    lines.push({productId,name:String(p.name||productId),targetQuantity,existingQuantity,addQuantity,priceCents:p.priceCents,costCents});
  }
  const final=new Map(current);for(const line of lines)final.set(line.productId,line.targetQuantity);
  let cartSubtotalCents=0;const unknownPriceProducts=[];
  for(const [productId,count] of final){if(!count)continue;const p=products.get(productId);if(!p){unknownPriceProducts.push(productId);continue;}const amount=count*p.priceCents;if(!Number.isSafeInteger(cartSubtotalCents+amount))throw new Error('Cart subtotal exceeds supported range.');cartSubtotalCents+=amount;}
  if(budgetCents!==undefined&&unknownPriceProducts.length)exceptions.push({reason:'Existing cart prices are unknown',products:unknownPriceProducts});
  if(budgetCents!==undefined&&cartSubtotalCents>budgetCents)exceptions.push({reason:'Budget exceeded',overCents:cartSubtotalCents-budgetCents});
  return {lines,subtotalCents,cartSubtotalCents:unknownPriceProducts.length?null:cartSubtotalCents,unknownPriceProducts,exceptions,ready:exceptions.length===0,checkout:false,externalChanges:false,pricing:'Provided catalog snapshot; excludes tax, delivery and fees',instructions:'Set each target quantity, then read back the cart before reporting success. Refresh prices and availability before writing.'};
}

export function runRoutine(calendar,name,input){
  const started=performance.now();
  const result=name==='calendar_availability'?availability(calendar,input):name==='grocery_cart_plan'?groceryPlan(input):(()=>{throw new Error('Unknown routine.');})();
  return {routine:name,version:1,execution:'cpu',modelCalls:0,durationMs:Math.round((performance.now()-started)*100)/100,result};
}

export function routineTools(calendar,register,forAgent,fileFor){
  return [register('routine_calendar_availability','Run deterministic shared-calendar recurrence expansion, conflict detection and free-window calculation in one call. Window is local to the shared calendar; no events are changed.',{from:{type:'string',required:true},to:{type:'string',required:true},minutes:{type:'integer'}},(a,e)=>{forAgent(e);return runRoutine(calendar,'calendar_availability',a);}),
    register('routine_grocery_cart_plan','Compute an exact-product grocery cart plan from a task workspace JSON file containing items, catalog, pantry and cart arrays. Entries use productId and whole-package quantity; catalog uses priceCents and available:true. No retailer is contacted or changed. Missing products require a decision; never infer substitutions.',{path:{type:'string',required:true}},async(a,e)=>{const {readFile,stat}=await import('node:fs/promises');const task=forAgent(e);const file=await fileFor(task,a.path);if((await stat(file.full)).size>1000000)throw new Error('Routine inputs must be at most 1 MB.');return runRoutine(calendar,'grocery_cart_plan',JSON.parse(await readFile(file.full,'utf8')));})];
}
