import fs from 'node:fs/promises';
const input={pickup:{lineAmountsCents:[1256,994,402,1414,82,82,82,1371,430,231,164,130,447,136,408,68,94],quantities:[1,2,1,2,1,1,1,3,1,1,2,2,1,2,3,1,1],pricesIncludeAssociateDiscount:true,associateDiscountCents:881,taxCents:335,displayedTotalCents:8126},store:{lineAmountsCents:[586,478,297,387,200,387,387,853],quantities:[1,1,1,1,1,1,1,1],pricesIncludeAssociateDiscount:false,associateDiscountCents:359,taxCents:104,displayedTotalCents:3320}};
const catalog=await (await fetch('http://127.0.0.1:18798/v1/models')).json();
const model=catalog.data.find(m=>m.id==='qwen3.8-27b');
if(model?.status?.value!=='loaded')throw Error('Qwen is not loaded; no model switch performed');
const args=model.status.args,base='http://127.0.0.1:'+args[args.indexOf('--port')+1];
const expected={pickupTotalCents:8126,storeTotalCents:3320,pickupUnits:26,storeUnits:8};
const start=Date.now();
const result={expected,input,scope:'One reasoning-enabled Qwen check using numeric fields transcribed from two live receipts. Browser navigation and extraction were performed by Codex, not Qwen.'};
try{
 const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model:model.id,temperature:0,max_tokens:2048,reasoning_effort:'medium',chat_template_kwargs:{enable_thinking:true},messages:[{role:'system',content:'Compute receipt totals in integer cents and unit counts. Each lineAmount is already the extended price for its quantity, so do not multiply by quantity. Subtract the associate discount only when pricesIncludeAssociateDiscount is false. Add tax. Return JSON with pickupTotalCents, storeTotalCents, pickupUnits, storeUnits.'},{role:'user',content:JSON.stringify(input)}],response_format:{type:'json_schema',json_schema:{name:'receipt_check',strict:true,schema:{type:'object',properties:Object.fromEntries(Object.keys(expected).map(k=>[k,{type:'integer'}])),required:Object.keys(expected),additionalProperties:false}}}})});
 const b=await r.json();if(!r.ok)throw Error(JSON.stringify(b));
 result.answer=JSON.parse(b.choices[0].message.content);result.passed=Object.entries(expected).every(([k,v])=>result.answer[k]===v);result.usage=b.usage;result.timings=b.timings;
}catch(e){result.error=e.message;result.passed=false;}
result.wallMs=Date.now()-start;
await fs.writeFile(new URL('./results/walmart-model-live.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,answer:result.answer,wallMs:result.wallMs,error:result.error,usage:result.usage,timings:result.timings},null,2));
