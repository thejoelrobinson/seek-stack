import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkAuthority} from '../lib/work-authority.js';
import {typedAction,connectorReceipt,executeTypedAction} from '../lib/work-connector-actions.js';
import {removeFixture} from './fixture-cleanup.mjs';

const email={to:['alice@example.com'],subject:'Synthetic fixture',body:'A harmless synthetic body.'};
const context={taskId:'t',requestId:'r1',request:'Send the synthetic fixture to alice@example.com.'};
const sent=()=>({id:'thread-1',messages:[{id:'message-1',labelIds:['SENT'],payload:{mimeType:'text/plain',headers:[{name:'To',value:'Alice <alice@example.com>'},{name:'Subject',value:email.subject}],body:{data:Buffer.from(email.body).toString('base64url')}}}]});
async function fixture(t,{verifyFails=false,timeout=false,accounts=[{id:'acct',app:'gmail',healthy:true}]}={}){
  const root=await mkdtemp(join(tmpdir(),'seek-connectors-')),authority=await new WorkAuthority(root).init();t.after(async()=>{authority.close();await removeFixture(root,'seek-connectors-');});
  const calls=[],connection={accounts:async()=>accounts,allTools:async()=>[{name:'gmail-send-email',inputSchema:{properties:Object.fromEntries(['to','cc','bcc','subject','body','bodyType'].map(k=>[k,{}]))}},{name:'gmail-get-thread'}],mcp:async(app,fn,options)=>{assert.equal(app,'gmail');assert.equal(options.accountId,'acct');return fn({callTool:async call=>{calls.push(call);if(call.name==='gmail-send-email'){if(timeout)throw new Error('Accepted? Timeout');return {structuredContent:{id:'message-1',threadId:'thread-1'}};}if(verifyFails)throw new Error('Read unavailable');return {structuredContent:sent()};}});}};
  return {connection,authority,calls};
}
test('typed writes reject arbitrary tools, malformed recipients and ambiguous times',()=>{
  assert.throws(()=>typedAction('custom.execute',{}),/not supported/);assert.throws(()=>typedAction('email.send',{...email,to:['bad']}),/valid recipients/);
  assert.throws(()=>typedAction('calendar.create',{title:'Meet',start:'2026-10-01T10:00:00',end:'2026-10-01T11:00:00'}),/timezone offsets/);
  assert.throws(()=>typedAction('calendar.create',{title:'Meet',start:'2026-10-01',end:'2026-10-01T11:00:00Z'}),/timezone offsets/);
  assert.deepEqual(typedAction('email.send',{...email,endpoint:'https://evil',token:'secret',extra:'data'}).args,{...email,cc:[],bcc:[],bodyType:'text'});
});
test('email commits once and verifies exact recipients, subject and body',async t=>{
  const {connection,authority,calls}=await fixture(t);const result=await executeTypedAction(connection,'email.send',email,context,{authority});
  assert.equal(result.state,'verified');assert.equal(result.receipt.providerId,'message-1');assert.deepEqual(calls.map(x=>x.name),['gmail-send-email','gmail-get-thread']);
  const again=await executeTypedAction(connection,'email.send',email,context,{authority});assert.equal(again.duplicate,true);assert.equal(calls.filter(x=>x.name==='gmail-send-email').length,1);
});
test('missing task authority holds before any provider write and reviewed edits hold',async t=>{
  const {connection,authority,calls}=await fixture(t);const held=await executeTypedAction(connection,'email.send',email,{...context,request:'Prepare a draft.'},{authority});
  assert.equal(held.allowed,false);assert.equal(calls.length,0);await authority.grant(held.proposal.id);
  assert.equal((await executeTypedAction(connection,'email.send',{...email,body:'Changed'},context,{authority})).stale,true);assert.equal(calls.length,0);
});
test('multiple connected accounts require an explicit selected account',async t=>{
  const {connection,authority,calls}=await fixture(t,{accounts:[{id:'acct',app:'gmail',healthy:true},{id:'other',app:'gmail',healthy:true}]});
  await assert.rejects(executeTypedAction(connection,'email.send',email,context,{authority}),/Choose which/);assert.equal(calls.length,0);
  assert.equal((await executeTypedAction(connection,'email.send',{...email,accountId:'acct'},context,{authority})).state,'verified');
});
test('read failures preserve a receipt, and repeating the request reconciles without resending',async t=>{
  const {connection,authority,calls}=await fixture(t,{verifyFails:true});const observed=await executeTypedAction(connection,'email.send',email,context,{authority});assert.equal(observed.state,'observed');
  const old=connection.mcp;connection.mcp=async(app,fn,options)=>old(app,client=>fn({...client,callTool:async call=>{if(call.name==='gmail-get-thread'){calls.push(call);return {structuredContent:sent()};}return client.callTool(call);}}),options);
  const result=await executeTypedAction(connection,'email.send',email,context,{authority});assert.equal(result.state,'verified');assert.equal(calls.filter(x=>x.name==='gmail-send-email').length,1);
});
test('write timeout is uncertain and is not sent a second time',async t=>{
  const {connection,authority,calls}=await fixture(t,{timeout:true});await assert.rejects(executeTypedAction(connection,'email.send',email,context,{authority}),/Timeout/);
  assert.equal((await executeTypedAction(connection,'email.send',email,context,{authority})).needsVerification,true);assert.equal(calls.filter(x=>x.name==='gmail-send-email').length,1);
});
test('provider observation cannot verify materially different email/calendar/document outcomes',()=>{
  const input=typedAction('email.send',email).intent.payload,written={id:'message-1',threadId:'thread-1'};
  assert.equal(connectorReceipt('email.send',input,written,sent()).verified,true);
  const changed=sent();changed.messages[0].payload.headers.push({name:'Cc',value:'unapproved@example.com'});assert.equal(connectorReceipt('email.send',input,written,changed).verified,false);
  assert.equal(connectorReceipt('email.send',{...input,body:'Something different'},written,sent()).verified,false);
  const event={title:'Meeting',start:'2026-10-01T10:00:00Z',end:'2026-10-01T11:00:00Z',attendees:['alice@example.com']},read={id:'event',summary:'Meeting',status:'confirmed',start:{dateTime:event.start},end:{dateTime:event.end},attendees:[{email:'alice@example.com'}]};
  assert.equal(connectorReceipt('calendar.create',event,{id:'event'},read).verified,true);assert.equal(connectorReceipt('calendar.create',event,{id:'event'},{...read,summary:'Other'}).verified,false);
  const doc={title:'Report',content:'Hello\nworld'},docRead={documentId:'doc',title:'Report',body:{content:[{paragraph:{elements:[{textRun:{content:'Hello\nworld\n'}}]}}]}};
  assert.equal(connectorReceipt('document.create',doc,{documentId:'doc'},docRead).verified,true);assert.equal(connectorReceipt('document.create',{...doc,content:'Missing'}, {documentId:'doc'},docRead).verified,false);
});
