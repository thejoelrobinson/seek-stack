import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';import {tmpdir,homedir} from 'node:os';import {join} from 'node:path';
import {validateOperation,listFolder} from '../src/operations.js';import {DesktopAgent} from '../src/agent.js';
test('folder reads return the remote filesystem in one call, with bounded pages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seek-folder-'));try{
  await writeFile(join(dir,'report.txt'),'known content');await mkdir(join(dir,'pictures'));
  const result=await listFolder(validateOperation({kind:'list',path:dir,limit:1}));assert.equal(result.entries.length,1);assert.equal(result.nextOffset,1);
  const next=await listFolder(validateOperation({kind:'list',path:dir,offset:1,limit:1}));assert.equal(next.nextOffset,null);assert.equal(new Set([...result.entries,...next.entries].map(e=>e.name)).size,2);
  let calls=0;const agent=new DesktopAgent({taskId:'task',client:{operation:async command=>{calls++;return {result:await listFolder(command)};},observe:()=>{throw Error('Folder reads must not traverse windows');}}});
  const start=performance.now();assert.match((await agent.operation({kind:'list',path:dir})).text,/report.txt/);assert.equal(calls,1);console.log('Folder listing: one call, '+Math.round(performance.now()-start)+' ms in the fixture');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('direct operations use validated IDs/paths and bounded shortcuts',()=>{
 assert.equal(validateOperation({kind:'list',path:'Downloads'}).path,join(homedir(),'Downloads'));
 for(const command of [{kind:'list',path:'relative'},{kind:'list',path:'Downloads',limit:9999},{kind:'shortcut',key:'A',modifiers:['Meta']},{kind:'shortcut',key:'A',modifiers:['Control','Control']},{kind:'open-app',app:'bad\nID'},{kind:'menu',path:[]},{kind:'execute',source:'code'}])assert.throws(()=>validateOperation(command));
 assert.deepEqual(validateOperation({kind:'shortcut',key:'L',modifiers:['Command','Shift'],source:'ignored'}),{kind:'shortcut',key:'L',modifiers:['Command','Shift']});
});
test('navigation verifies once and an uncertain action is never repeated',async()=>{
 let writes=0,reads=0;const agent=new DesktopAgent({taskId:'task',client:{operation:async()=>{writes++;return {result:{}};},observe:async()=>{reads++;throw Error('window not ready');}}});
 const result=await agent.operation({kind:'switch',windowId:'w'});assert.equal(result.requiresObservation,true);assert.equal(writes,1);assert.equal(reads,1);
});
