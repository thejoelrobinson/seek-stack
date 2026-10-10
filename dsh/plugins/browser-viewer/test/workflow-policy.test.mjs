import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkAuthority} from '../lib/work-authority.js';
import {workflowWriteBroker} from '../lib/work-workflow-authority.js';
test('workflow writes use the real authority ledger, exact payload grants and verified provider receipts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-wf-auth-')),authority=await new WorkAuthority(root).init();let writes=0;
 const authorization={taskId:'task',requestId:'initial',request:'Draft a document only',autonomy:{mode:'careful',spendLimit:0}};
 const cap={intent:a=>({kind:'document.create',host:'fixture.test',target:'Fixture report',payload:a}),receipt:r=>({verified:true,providerId:r.id}),verify:r=>r.id==='fixture-1'};
 const broker=workflowWriteBroker(authority,()=>authorization),input={title:'Fixture report'},ctx={task:{id:'task',status:'running'}};
 try{await assert.rejects(broker(cap,input,async()=>{writes++;return {id:'fixture-1'};},ctx),e=>e.code==='authorization_required');assert.equal(writes,0);
  const proposal=await authority.authorize(cap.intent(input),authorization);await authority.grant(proposal.proposal.id,proposal.proposal.fingerprint);
  assert.deepEqual(await broker(cap,input,async()=>{writes++;return {id:'fixture-1'};},ctx),{id:'fixture-1'});assert.equal(writes,1);
  await assert.rejects(broker(cap,{title:'Changed report'},async()=>{writes++;return {id:'fixture-1'};},ctx),e=>e.code==='authorization_required');assert.equal(writes,1);assert.equal(authority.list({taskId:'task'}).filter(x=>x.state==='verified').length,1);
 }finally{authority.close();}
});
