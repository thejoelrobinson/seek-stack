import test from 'node:test';
import assert from 'node:assert/strict';
import {ready} from '../../../experiments/calendar-20261006/mount.mjs';
test('real mountWork API runs CPU tasks, deduplicates submission and exports verified results',async()=>{
 const m=await ready,api=async(path,body)=>{const r=await fetch(m.base+'/work/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 try{
  const catalog=await api('workflows');assert.equal(catalog.status,200);assert.equal(catalog.data.generatedCode.enabled,false);
  const body={id:'calendar_availability',input:{from:'2026-10-09T09:00',to:'2026-10-09T17:00'},requestId:'api-calendar'};
  const task=await api('workflows/run',body),duplicate=await api('workflows/run',body);assert.equal(task.status,200);assert.equal(task.data.id,duplicate.data.id);
  let result;const deadline=Date.now()+10000;
  do{result=(await api('task?id='+task.data.id)).data;if(result.status==='complete')break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<deadline);
  assert.equal(result.status,'complete',JSON.stringify(result));assert.equal(result.sessionId,undefined);assert.equal(result.resultEvidence.status,'verified');assert.match(result.result,/minutes free/);assert.equal(result.artifacts.length,1);
  const invalid=await api('workflows/run',{...body,input:{from:'2026-10-09',to:'2026-10-10',code:'eval()'},requestId:'invalid'});assert.equal(invalid.status,400);
  const changed=await api('workflows/run',{...body,input:{from:'2026-10-08',to:'2026-10-10'}});assert.equal(changed.status,400);
  await api('workflows/state',{id:'calendar_availability',version:1,state:'disabled'});assert.equal((await api('workflows/run',{...body,requestId:'disabled'})).status,400);
  await api('workflows/state',{id:'calendar_availability',version:1,state:'enabled'});
 }finally{m.stop();}
});
