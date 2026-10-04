import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOutcome,taskContract} from '../lib/work-outcomes.js';

const BS=String.fromCharCode(92);

test('deliverables match Windows paths and unregistered workspace files are recorded instead of failing',async()=>{
 const contract=taskContract('Plan',{kind:'artifact',deliverables:['birthday-weekend/master-plan.md','birthday-weekend/budget.md','missing.md']});
 const task={id:'t',objective:'Plan',contract,artifacts:[{id:'a',path:'.artifacts/a.md',originalPath:'birthday-weekend'+BS+'master-plan.md',title:'Master plan'}]};
 const registered=[];
 const file=async()=>{throw new Error('no file in fixture');};
 const register=async(t,path)=>{if(path==='missing.md')throw new Error('not found');registered.push(path);t.artifacts.push({id:'b',path:'.artifacts/b.md',originalPath:path.split('/').join(BS)});};
 const result=await verifyOutcome(task,{file,register});
 const byLabel=Object.fromEntries(result.checks.map(c=>[c.label,c]));
 assert.equal(byLabel['Deliverable: birthday-weekend/master-plan.md'].ok,true,'backslash path matches');
 assert.equal(byLabel['Deliverable: birthday-weekend/budget.md'].ok,true,'existing file is registered');assert.deepEqual(registered,['birthday-weekend/budget.md']);
 assert.equal(byLabel['Deliverable: missing.md'].ok,false);assert.match(byLabel['Deliverable: missing.md'].detail,/not a nonempty file in the task workspace/);
 const noRegister=await verifyOutcome({...task,artifacts:[]},{file});assert.match(noRegister.checks.find(c=>c.label==='Deliverable: missing.md').detail,/Call work_artifact/,'failures always explain the fix');
});
