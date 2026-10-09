import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const baseline=JSON.parse(await readFile(new URL('coding-baseline.json',import.meta.url),'utf8'));
assert.equal(require('./coding-baseline.cjs').parseCents('-70'),-7000);
const corrected={...baseline,fixtureCorrection:'The initial scorer incorrectly expected -700 cents for -70. Correct expected value is -7000. Original artifact retained. The generated code was correct.',checks:baseline.checks.map(c=>c.name==='parse -70'?{name:c.name,passed:true}:c)};corrected.passed=corrected.checks.filter(c=>c.passed).length;
await writeFile(new URL('coding-baseline-regraded.json',import.meta.url),JSON.stringify(corrected,null,2));
const rows=(await readFile(new URL('data-trials.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
for(const r of rows){const numbers=(r.answer||'').match(/-?\d[\d,]*/g)||[];r.numericCorrect=numbers.some(n=>n.replaceAll(',','')===r.expected)&&numbers.every(n=>[r.expected,String(r.size)].includes(n.replaceAll(',','')));}
const summary={rubric:'Original exact-string scores remain in data-trials.jsonl. Numeric correctness accepts only the expected total, optionally accompanied by the known row count and formatting; strict format is reported separately.',arms:{}};
for(const arm of ['current','saved']){const group=rows.filter(r=>r.arm===arm);summary.arms[arm]={trials:group.length,numericCorrect:group.filter(r=>r.numericCorrect).length,strictFormatCorrect:group.filter(r=>r.correct).length};}
await writeFile(new URL('data-numeric-scores.json',import.meta.url),JSON.stringify(summary,null,2));console.log({coding:corrected.passed+'/'+corrected.total,data:summary.arms});
