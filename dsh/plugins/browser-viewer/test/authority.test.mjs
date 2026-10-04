import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkAuthority,explicitAuthorization,actionFingerprint} from '../lib/work-authority.js';
import {isTrustedApiRequest,assertTrustedAuthority} from '../lib/work-request-fence.js';
import {removeFixture} from './fixture-cleanup.mjs';
test('explicit harmless form submission reuses exact human fields and host, while edits and checkout remain held',()=>{
 const intent={kind:'browser.unknown',host:'127.0.0.1:1234',label:'Save note',payload:{label:'Save note',checkout:false,fields:[{name:'note',value:'Background works'}]}};
 const context={request:'Open http://127.0.0.1:1234, enter exactly Background works in Note and click Save note.'};assert.equal(explicitAuthorization(intent,context),true);assert.equal(explicitAuthorization({...intent,host:'evil.example'},context),false);assert.equal(explicitAuthorization({...intent,payload:{...intent.payload,checkout:true}},context),false);assert.equal(explicitAuthorization({...intent,payload:{...intent.payload,fields:[{name:'note',value:'Changed by page'}]}},context),false);assert.equal(explicitAuthorization({...intent,unresolved:true},context),false);
});
test('unknown form authorization binds complete values to their named field and same-host form action',()=>{
 const base={kind:'browser.unknown',host:'notes.example',url:'https://notes.example/note',label:'Save note',payload:{label:'Save note',formAction:'https://notes.example/note',fields:[{name:'note',value:'Background works'}]}},request='Open https://notes.example/note, enter exactly Background works in Note and click Save note.';
 assert.equal(explicitAuthorization(base,{request}),true);
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,fields:[{name:'note',value:'Background'}]}},{request}),false,'A prefix is a changed value.');
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,fields:[{name:'other',value:'Background works'}]}},{request}),false,'A value in another field is a changed payload.');
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,fields:[{name:'note',value:'background works'}]}},{request}),false,'Exactly requested values retain their case.');
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,formAction:'https://other.example/collect'}},{request}),false);
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,formAction:'javascript:send()'}},{request}),false);
 assert.equal(explicitAuthorization(base,{request:'Open https://notes.example/note, fill Note with "Background works" then press Save note.'}),true);
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,fields:[{name:'internal-id',label:'Note',value:'Background works'}]}},{request}),true,'Visible field labels preserve normal task autonomy.');
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,fields:[{name:'note',type:'checkbox',value:'Background works',checked:true}]}},{request}),false);
 assert.equal(explicitAuthorization({...base,payload:{...base.payload,fields:[{name:'email',value:'person@example.com'}]}},{request:'Open https://notes.example/note, fill Email with "person@example.com" then press Save note.'}),false);
});

const intent={kind:'email.send',host:'mail.google.com',account:'acct',target:'a@example.com',payload:{to:['a@example.com'],cc:[],bcc:[],subject:'Report',body:'Here is the report.'}};
const context={taskId:'task',sessionId:'session',requestId:'r1',request:'Send the report to a@example.com. Do not ask again.'};
async function fixture(t,options){const root=await mkdtemp(join(tmpdir(),'seek-authority-')),broker=await new WorkAuthority(root,options).init();t.after(async()=>{broker.close();await removeFixture(root,'seek-authority-');});return {root,broker};}

test('task authorization flows without another approval, but CC/BCC and page text are not authority',()=>{
  assert.equal(explicitAuthorization(intent,context),true);
  assert.equal(explicitAuthorization({...intent,payload:{...intent.payload,bcc:['b@example.com']}},context),false);
  assert.equal(explicitAuthorization(intent,{objective:'Research reports',pageText:context.request}),false);
  assert.equal(explicitAuthorization(intent,{request:'Draft only an email to a@example.com; do not send it.'}),false);
});
test('latest human instruction overrides draft-only and recipient corrections replace earlier recipients',()=>{
  const requests=[{text:'Draft only an email to a@example.com, without sending.'},{text:'Send now.'}];
  assert.equal(explicitAuthorization(intent,{requests}),true);
  assert.equal(explicitAuthorization(intent,{requests:[...requests,{text:'Actually send it to b@example.com instead.'}]}),false);
  assert.equal(explicitAuthorization({...intent,payload:{...intent.payload,to:['b@example.com']}},{requests:[...requests,{text:'Actually send it to b@example.com instead.'}]}),true);
});
test('names resolve only through host-verified contact provenance',()=>{
  assert.equal(explicitAuthorization(intent,{request:'Email Alice the report.',verifiedContacts:[{name:'Alice',email:'a@example.com',verified:true}]}),true);
  assert.equal(explicitAuthorization(intent,{request:'Email Alice the report.',verifiedContacts:[{name:'Alice',email:'a@example.com'}]}),false);
  assert.equal(explicitAuthorization(intent,{request:'Email Malice the report.',verifiedContacts:[{name:'Alice',email:'a@example.com',verified:true}]}),false);
  assert.equal(explicitAuthorization(intent,{request:'Email b@example.com asking about Alice.',verifiedContacts:[{name:'Alice',email:'a@example.com',verified:true}]}),false);
  assert.equal(explicitAuthorization(intent,{request:'Email Alice the report.',verifiedContacts:[{name:'Alice',email:'a@example.com',verified:true},{name:'Alice',email:'other@example.com',verified:true}]}),false);
});
test('latest spending bound applies and broad autonomy does not authorize spending',()=>{
  const purchase={kind:'browser.purchase',target:'Paper',payload:{amount:12}};
  assert.equal(explicitAuthorization(purchase,{requests:[{text:'Buy Paper with a budget $20.'},{text:'Keep the budget under $10.'}]}),false);
  assert.equal(explicitAuthorization(purchase,{request:'Be autonomous and use whatever tools you need.'}),false);
});
test('reviewed payload edits are stale and grants bind exactly to normalized parameters',async t=>{
  const {broker}=await fixture(t);const held=await broker.authorize(intent,{...context,request:'Prepare a draft.'});assert.equal(held.allowed,false);
  await broker.grant(held.proposal.id,{scope:'task'});
  const changed=await broker.authorize({...intent,payload:{...intent.payload,body:'A changed body.'}},context);
  assert.equal(changed.allowed,false);assert.equal(changed.stale,true);
  assert.equal((await broker.authorize(intent,context)).allowed,true);
});
test('revoking an exact persistent grant also invalidates an unexecuted authorization',async t=>{
  const {broker}=await fixture(t),draftContext={...context,request:'Prepare a draft.'};const held=await broker.authorize(intent,draftContext);await broker.grant(held.proposal.id,{scope:'always'});
  assert.equal((await broker.authorize(intent,{...draftContext,requestId:'later'})).allowed,true);
  assert.equal((await broker.revokeGrants({fingerprint:held.proposal.fingerprint})).revoked,1);
  assert.equal((await broker.authorize(intent,draftContext)).allowed,false);assert.equal((await broker.authorize(intent,{...draftContext,requestId:'future'})).allowed,false);
});
test('concurrent exact submissions execute once and preserve verified receipts',async t=>{
  const {broker}=await fixture(t);let writes=0;
  const perform=async()=>{writes++;await new Promise(resolve=>setTimeout(resolve,15));return {id:'provider-1'};};
  await Promise.all([broker.execute(intent,context,perform,{verify:()=>({verified:true,providerId:'provider-1'})}),broker.execute(intent,context,perform,{verify:()=>({verified:true,providerId:'provider-1'})})]);
  assert.equal(writes,1);const duplicate=await broker.execute(intent,context,perform);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.needsVerification,false);
  assert.equal(broker.list({taskId:'task'})[0].receipt.providerId,'provider-1');
});
test('uncertain timeouts and interrupted writes never blindly retry after restart',async t=>{
  const {root,broker}=await fixture(t);let writes=0;
  await assert.rejects(broker.execute(intent,context,()=>{writes++;throw new Error('Timeout after possible acceptance');}),/Timeout/);
  assert.equal((await broker.execute(intent,context,()=>{writes++;})).duplicate,true);assert.equal(writes,1);
  const next=await broker.propose({...intent,payload:{...intent.payload,body:'Another message'}},context);
  broker.db.prepare("UPDATE authority_actions SET state='executing' WHERE id=?").run(next.id);broker.close();await broker.init();
  assert.equal(broker.row(next.id).state,'uncertain');assert.equal((await broker.authorize(next.intent,context)).duplicate,true);
});
test('continue and unrelated human messages preserve prior action scope; an explicit new action starts a new scope',async t=>{
  const {broker}=await fixture(t),requests=[{id:'r1',text:context.request}];let writes=0;await broker.execute(intent,{...context,requests},()=>{writes++;return {};});
  const continuation={...context,requestId:'r2',requests:[...requests,{id:'r2',text:'Continue and show me the status.'}]};
  assert.equal((await broker.execute(intent,continuation,()=>{writes++;})).duplicate,true);assert.equal(writes,1);
  assert.equal(explicitAuthorization(intent,{...continuation,requests:[...requests,{id:'r2',text:"Don't create a calendar event."}]}),true);
  assert.equal((await broker.execute(intent,{...context,requestId:'r3',requests:[...requests,{id:'r3',text:'Send the report to a@example.com again.'}]},()=>{writes++;return {};})).allowed,true);assert.equal(writes,2);
});
test('outcome contracts can filter request scope and creation time without LIKE wildcard leaks',async t=>{
  let now=100;const {broker}=await fixture(t,{now:()=>now});await broker.propose(intent,{...context,taskId:'task_%'});now=200;
  await broker.propose(intent,{...context,taskId:'task_%',requestId:'r2'});await broker.propose(intent,{...context,taskId:'task_AA'});
  assert.equal(broker.list({taskId:'task_%'}).length,2);assert.equal(broker.list({taskId:'task_%',requestId:'r2'}).length,1);assert.equal(broker.list({taskId:'task_%',createdAfter:150}).length,1);
});
test('browser fingerprint includes page state but deduplicates equivalent mouse and keyboard commits',()=>{
  const click={...intent,kind:'browser.send',url:'https://mail.example/compose',payload:{fields:[{name:'to',value:'a@example.com'}],key:undefined}};
  assert.equal(actionFingerprint(click),actionFingerprint({...click,payload:{...click.payload,key:'Control+Enter'}}));
  assert.notEqual(actionFingerprint(click),actionFingerprint({...click,url:'https://mail.example/other'}));
});
test('shared request fence rejects cross-origin and cross-site mutation attempts while allowing same-origin and local CLI',()=>{
  const request=headers=>({headers});assertTrustedAuthority('seek.example');assert.throws(()=>assertTrustedAuthority('https://seek.example'));
  assert.equal(isTrustedApiRequest(request({host:'seek.example',origin:'https://seek.example'}),['seek.example']),true);
  assert.equal(isTrustedApiRequest(request({host:'seek.example',origin:'https://evil.example'}),['seek.example']),false);
  assert.equal(isTrustedApiRequest(request({host:'seek.example','sec-fetch-site':'cross-site'}),['seek.example']),false);
  assert.equal(isTrustedApiRequest(request({host:'127.0.0.1:3080'})),true);
  assert.equal(isTrustedApiRequest(request({host:'evil.example'}),['seek.example']),false);
});
