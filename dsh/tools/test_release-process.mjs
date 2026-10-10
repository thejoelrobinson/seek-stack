import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runDeployment} from './release-process.mjs';
test('a background service holding inherited output cannot stall publication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-release-process-')),log=join(root,'deploy.log');
 const service=JSON.stringify('setTimeout(()=>process.exit(0),10000)');
 const script=`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${service}],{detached:true,stdio:['ignore',1,2],windowsHide:true});child.unref();console.log('deployment complete');`;
 const began=Date.now();await runDeployment(process.execPath,['-e',script],log);
 assert.ok(Date.now()-began<5000,'Waited for a background service instead of the deploy process');assert.match(await readFile(log,'utf8'),/deployment complete/);
 await assert.rejects(runDeployment(process.execPath,['-e','process.exit(7)'],log),/Deployment failed \(7\)/);
});
