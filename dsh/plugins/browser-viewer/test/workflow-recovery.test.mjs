import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const worker=fileURLToPath(new URL('./workflow-crash-worker.mjs',import.meta.url));
const child=(dir,phase)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[worker,dir,phase],{windowsHide:true});let output='';p.stdout.on('data',d=>output+=d);p.on('error',reject);p.on('exit',code=>resolve({code,output}));});
for(const phase of ['before-dispatch','before-provider','provider-committed','after-return','after-checkpoint'])test('process exit and durable recovery at '+phase,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seek-wf-crash-'));assert.equal((await child(dir,phase)).code,17);const resumed=await child(dir,'none');assert.equal(resumed.code,0);const result=JSON.parse(resumed.output.trim());
 if(['before-dispatch','before-provider'].includes(phase)){assert.equal(result.state,'uncertain');assert.equal(result.provider.writes,0);}else{assert.equal(result.state,'succeeded');assert.equal(result.provider.writes,1);assert.equal(result.provider.target,3);}
});
