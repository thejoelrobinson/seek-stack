import test from 'node:test';
import assert from 'node:assert/strict';
import {hiddenTools,WorkToolScope} from '../lib/work-tool-scope.js';

const ALL=['read','pwsh','viewer_click','workflow','ralph','todo_write','work_progress','finance_transactions','finance_overview','purchases_summary','discord_channels','apps_send_email','apps_search','create_goal','update_goal'];

test('tasks hide unused tools and unrelated domains, keeping what the request needs',()=>{
 const plan=hiddenTools({objective:'Plan a birthday weekend with crafts'},ALL);
 assert.deepEqual(plan.sort(),['apps_send_email','create_goal','discord_channels','finance_overview','finance_transactions','purchases_summary','ralph','todo_write','workflow'].sort());
 const money=hiddenTools({objective:'How much did I spend on dining last month?'},ALL);
 assert.ok(!money.includes('finance_transactions')&&!money.includes('purchases_summary'),'spending questions keep finance and purchases');
 assert.ok(!hiddenTools({objective:'Explain this',domain:'finance'},ALL).includes('finance_overview'),'finance domain keeps finance tools');
 assert.ok(!hiddenTools({objective:'Email Sam the itinerary'},ALL).includes('apps_send_email'));
 for(const keep of ['read','pwsh','viewer_click','work_progress','apps_search','update_goal'])assert.ok(!plan.includes(keep),keep+' stays');
});

test('scope applies once per agent through the harness restrict API and survives a missing agent',()=>{
 const restricted=[];const agent={ctx:{tools:{restrict:f=>restricted.push(f)}}};
 const ctx={agents:new Map([['s1',agent]]),tools:{get:name=>ALL.includes(name)?{name}:undefined,view:()=>({visible:new Map(ALL.map(n=>[n,{}]))})}};
 const scope=new WorkToolScope(ctx,{warn(){}}),task={sessionId:'s1',objective:'Plan a party'};
 const deny=scope.apply(task);assert.ok(deny.includes('workflow'));assert.equal(restricted.length,1);assert.equal(task.hiddenTools,deny.length);
 assert.equal(scope.apply(task),null,'idempotent for the same agent');assert.equal(restricted.length,1);
 assert.equal(scope.apply({sessionId:'missing',objective:'x'}),null);
 const failing={ctx:{tools:{restrict:()=>{throw new Error('unknown tool');}}}};ctx.agents.set('s2',failing);
 assert.equal(scope.apply({sessionId:'s2',objective:'x'}),null,'a harness rejection never breaks the task');
});
