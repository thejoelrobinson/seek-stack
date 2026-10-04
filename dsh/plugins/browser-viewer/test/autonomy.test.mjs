import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkAuthority,explicitAuthorization,autonomousAuthorization,DEFAULT_AUTONOMY} from '../lib/work-authority.js';
import {removeFixture} from './fixture-cleanup.mjs';

const auto={...DEFAULT_AUTONOMY},careful={mode:'careful',spendLimit:250};
const cake='I need to order a VERY chocolaty cake for pickup 10/9 here in Northwest Arkansas.';
const datePick={kind:'browser.unknown',host:'ricksbakery.bakesmart.com',url:'https://ricksbakery.bakesmart.com/checkout',label:'Friday, October 9th, 2026',payload:{label:'Friday, October 9th, 2026',checkout:true,fields:[]}};
const placeOrder={kind:'browser.purchase',host:'ricksbakery.bakesmart.com',label:'Place order',target:'Death by Chocolate cake',payload:{label:'Place order',checkout:true,amount:48.5,currency:'$',fields:[]}};

test('autonomous mode lets ordinary form controls and requested purchases through, with limits',()=>{
 assert.equal(explicitAuthorization(datePick,{request:cake,autonomy:auto}),true,'date pickers inside checkout forms just work');
 assert.equal(explicitAuthorization(datePick,{request:cake,autonomy:careful}),false,'careful mode keeps the old hold');
 assert.equal(explicitAuthorization(placeOrder,{request:cake,autonomy:auto}),true,'the request asked to order');
 assert.equal(explicitAuthorization({...placeOrder,payload:{...placeOrder.payload,amount:900}},{request:cake,autonomy:auto}),false,'over the spending limit asks');
 assert.equal(explicitAuthorization(placeOrder,{request:'Find me a chocolate cake bakery nearby.',autonomy:auto}),false,'research requests never place orders');
 assert.equal(explicitAuthorization(placeOrder,{request:"Find a cake but don't order it.",autonomy:auto}),false,'explicit negation wins');
 assert.equal(autonomousAuthorization({kind:'browser.delete',label:'Delete account'},{allowed:true},auto),null,'deletions fall back to careful rules');
 assert.equal(autonomousAuthorization({...datePick,unresolved:true},null,auto),false,'unidentified controls inside checkout frames still ask');
 assert.equal(explicitAuthorization({kind:'email.send',host:'mail.google.com',target:'sam@example.com',payload:{to:['sam@example.com']}},{request:'Draft only, do not send the email to Sam.',autonomy:auto}),false);
 assert.equal(autonomousAuthorization(datePick,null,undefined),null,'no autonomy setting means careful behavior');
});

test('in autonomous mode an earlier approval does not make later steps of the same kind ask again',async t=>{
 const root=await mkdtemp(join(tmpdir(),'seek-autonomy-')),broker=await new WorkAuthority(root).init();t.after(async()=>{broker.close();await removeFixture(root,'seek-autonomy-');});
 const base={taskId:'task',sessionId:'s',requestId:'r1',request:cake};
 const held=await broker.authorize(datePick,{...base,autonomy:careful});assert.equal(held.allowed,false);await broker.grant(held.proposal.id);
 const approved=await broker.authorize(datePick,{...base,autonomy:careful});assert.equal(approved.allowed,true);
 const time={...datePick,label:'2:00 - 3:00',payload:{...datePick.payload,label:'2:00 - 3:00'}};
 assert.equal((await broker.authorize(time,{...base,autonomy:careful})).allowed,false,'careful: a different control asks again');
 assert.equal((await broker.authorize({...time,label:'3:00 - 4:00',payload:{...time.payload,label:'3:00 - 4:00'}},{...base,autonomy:auto})).allowed,true,'autonomous: it just proceeds');
});
