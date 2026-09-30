// Run only after the user has restarted DSH; never stops or restarts a service.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
const out=resolve(process.argv[2]||'experiments/qwen-work-20260927');
const status=await fetch('http://127.0.0.1:3080/work/api/helper-status',{signal:AbortSignal.timeout(10000)});
assert.ok(status.ok&&status.headers.get('content-type')?.includes('application/json'),'Restart DSH first: the candidate helper-status endpoint is not active.');
const state=await status.json();
assert.equal(state.foregroundBusy,false,'Wait until existing foreground sessions are idle.');
const work=await(await fetch('http://127.0.0.1:3080/work/api/state',{signal:AbortSignal.timeout(10000)})).json();
assert.ok(!work.tasks.some(t=>['running','queued'].includes(t.status)),'Wait until existing Work tasks are idle.');
const protectedFiles=JSON.parse(await readFile(join(out,'coding-protection-before.json'),'utf8'));
async function verifyProtected(){
 for(const row of protectedFiles)assert.equal(createHash('sha256').update(await readFile(row.Path)).digest('hex').toUpperCase(),row.Hash,'Protected coding file changed: '+row.Path);
}
await verifyProtected();
async function run(script,args=[]){
 const child=spawn(process.execPath,[script,out,...args],{stdio:'inherit',windowsHide:true});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(script+' failed: '+(code??signal))));});
}
await run('plugins/browser-viewer/test/coding-regression.mjs',['candidate']);
await run('plugins/browser-viewer/test/work-results-live.mjs');
await verifyProtected();
const coding=JSON.parse(await readFile(join(out,'coding-candidate.json'),'utf8'));
const live=JSON.parse(await readFile(join(out,'work-live.json'),'utf8'));
const result={at:new Date().toISOString(),candidateActive:true,coding:{passed:coding.passed,total:coding.total},work:live,protectedFilesUnchanged:protectedFiles.length};
await writeFile(join(out,'final-validation.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
