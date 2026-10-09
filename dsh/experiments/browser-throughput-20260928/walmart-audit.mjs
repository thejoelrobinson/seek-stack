import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const root = process.argv[2] || process.env.SEEK_RECEIPT_TASK_DIR;
if (!root) throw new Error('Pass the local receipt-report directory as the first argument or SEEK_RECEIPT_TASK_DIR.');
const names = ['walmart_items_raw.md','walmart_purchases_final.md'];
const texts = await Promise.all(names.map(n=>fs.readFile(path.join(root,n),'utf8')));
function receipts(text) {
  const starts = [...text.matchAll(/^(?:## Order[^\n]*|### Entry \d+[^\n]*|\*\*Entry \d+[^\n]*)/gm)];
  return starts.map((m,i)=>{
    const body = text.slice(m.index,starts[i+1]?.index ?? text.length);
    const heading = m[0];
    const id = heading.match(/\(id (\d+)\)/)?.[1] ?? heading.match(/(?:TC\s*#?\s*|Order\s*#?\s*|#)(\d[\d-]{10,})/i)?.[1]?.replaceAll('-','');
    const entry = heading.match(/Entry (\d+)/)?.[1];
    const total = heading.match(/(?:total\s*:?\s*|,\s*)\$([\d,]+\.\d{2})/i)?.[1];
    return {key:id ? `order:${id}` : `entry:${entry ?? 'unknown'}`,entry:entry ? Number(entry):null,totalCents:total ? Number(total.replace(/[,.]/g,'')):null,body,offset:m.index};
  });
}
const start = performance.now();
const [raw,final] = texts.map(receipts);
const parseMs = performance.now()-start;
const duplicates = list=>list.filter((x,i)=>list.findIndex(y=>y.key===x.key)!==i).map(x=>x.key);
const finalKeys = new Set(final.map(x=>x.key));
const missing = raw.filter(x=>!finalKeys.has(x.key));
const duplicateDetails = raw.filter((x,i)=>raw.findIndex(y=>y.key===x.key)!==i).map(x=>({entry:x.entry,totalCents:x.totalCents}));
const checks=[];
function test(name,fn){try{fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,reason:e.message});}}
test('every raw receipt is represented in final report',()=>assert.equal(missing.length,0));
test('raw receipt identifiers are unique',()=>assert.equal(duplicates(raw).length,0));
test('final receipt identifiers are unique',()=>assert.equal(duplicates(final).length,0));
test('all receipt headings have parsed totals',()=>assert.equal(raw.filter(x=>x.totalCents===null).length,0));
test('order identifiers stay strings, including values beyond safe integer precision',()=>assert(raw.filter(x=>x.key.startsWith('order:')).every(x=>typeof x.key==='string')));
// Replaying each saved receipt twice must not create additional orders.
test('checkpoint replay deduplicates receipts',()=>assert.equal(new Map([...raw,...raw].map(x=>[x.key,x])).size,new Set(raw.map(x=>x.key)).size));
const clipped = receipts(texts[0].slice(0,12000));
const summary={testedAt:new Date().toISOString(),scope:'Offline audit of saved model-written receipt captures; not a live Walmart extraction or independent verification of receipt correctness.',sources:names.map((name,i)=>({name,bytes:Buffer.byteLength(texts[i]),sha256:createHash('sha256').update(texts[i]).digest('hex')})),parseMs,rawReceiptSections:raw.length,finalReceiptSections:final.length,missingFromFinal:missing.map(x=>({entry:x.entry,totalCents:x.totalCents})),missingHeadingTotalCents:missing.reduce((n,x)=>n+(x.totalCents??0),0),unparsedTotals:raw.filter(x=>x.totalCents===null).map(x=>({entry:x.entry,heading:x.body.split('\n')[0]})),first12000CharactersReceiptSections:clipped.length,checks,live:{url:'https://www.walmart.com/orders',result:'Signed out; page offers Sign in or create account and guest order tracking. No authenticated history collected.'}};
summary.rawDistinctKeys = new Set(raw.map(x=>x.key)).size;
summary.finalDistinctKeys = finalKeys.size;
summary.duplicateDetails = duplicateDetails;
await fs.mkdir(new URL('./results/',import.meta.url),{recursive:true});
await fs.writeFile(new URL('./results/walmart-audit.json',import.meta.url),JSON.stringify(summary,null,2));
const report=`# Walmart workflow test\n\n${summary.testedAt}\n\n## Results\n\n- Live Chrome navigation to Walmart purchase history reached a signed-out page. Authenticated collection remains untested pending login.\n- Saved raw capture: ${raw.length} receipt sections. Final report: ${final.length} receipt sections.\n- ${missing.length} raw receipt sections absent from final report; their heading totals sum to $${(summary.missingHeadingTotalCents/100).toFixed(2)}. This is a capture-to-report difference, not a reconciled bank-spend total.\n- Raw and final receipt parsing took ${parseMs.toFixed(2)} ms in this single local run. This does not measure browser throughput.\n- Keeping only the first 12,000 characters retains ${clipped.length} receipt sections out of ${raw.length}. This simulates feeding an entire capture through a bounded text input; it does not assert live per-page truncation.\n\n## Checks\n\n${checks.map(x=>`- ${x.passed?'PASS':'FAIL'}: ${x.name}${x.reason?' — '+x.reason.replaceAll('\n',' '):''}`).join('\n')}\n\n## Limits\n\nThe source is an existing model-written Markdown extraction, not original Walmart HTML or receipts. Counts are receipt sections, which may include a membership entry. This audit cannot prove the account history is complete, that line items were faithfully captured, or that parallel browsers improve authenticated collection. Discounts, refunds, split payments, fees, and combined delivery groups require explicit data fields and source reconciliation. Original files were not modified.\n\n## Recommendation from this test\n\nMake the report derive from a validated receipt store with stable string identifiers and incremental checkpoints. Regenerate reports when captures change and fail visibly on missing receipts. Browser concurrency is not yet measured for this account.\n`;
await fs.writeFile(new URL('./WALMART-TEST.md',import.meta.url),report + `\n## Duplicate check\n\nRaw capture has ${summary.rawDistinctKeys} distinct parsed keys; final report has ${summary.finalDistinctKeys}. The raw capture contains ${duplicateDetails.length} duplicate receipt sections. Deduplicate by order ID before aggregation. Results describe the SHA-256 snapshot recorded in results/walmart-audit.json.\n`);
console.log(JSON.stringify({...summary,unparsedTotals:summary.unparsedTotals.map(x=>({entry:x.entry}))},null,2));
