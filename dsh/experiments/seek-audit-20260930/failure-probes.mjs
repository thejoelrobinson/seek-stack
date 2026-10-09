import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {WorkEngine} from '../../plugins/browser-viewer/lib/work-server.js';
const findings=[];
const ok=value=>({result:{ok:true,value}});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'seek-audit-failure-'));
 const sent=[];let failPrompt=false;
 const api={sessions:{list:async()=>ok({items:[{sessionId:'fixture-session',running:false}]}),history:async()=>ok({events:[],projections:{values:{}}}),prompt:async request=>{if(failPrompt)throw new Error('Synthetic transport outage');sent.push(request.payload);return ok({accepted:true});}},goals:{}};
 const engine=new WorkEngine(api,root,{warn(){}},()=>null);await engine.init();
 const task=await engine.create({objective:'Synthetic fixture objective.',mode:'chat'});task.sessionId='fixture-session';
 return {engine,task,root,sent,fail:()=>{failPrompt=true;}};
}
{
 const f=await fixture();await f.engine.control(f.task.id,'reply','First necessary detail.');await f.engine.control(f.task.id,'reply','Second necessary detail.');await f.engine.tick();
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].content[0].text,'Second necessary detail.');assert.ok(f.task.messages.some(m=>m.text==='First necessary detail.'));
 findings.push({id:'reply-overwrite',confirmed:true,description:'Two replies while queued leave both in visible history, but launch sends only the last pendingReply to the model.'});
}
{
 const f=await fixture();await f.engine.control(f.task.id,'reply','Necessary follow-up detail.');f.fail();await f.engine.tick();
 const disk=JSON.parse(await readFile(join(f.root,'work.json'),'utf8')).tasks[0];
 assert.equal(disk.status,'attention');assert.equal(disk.pendingReply,null);assert.ok(disk.messages.some(m=>m.text==='Necessary follow-up detail.'));
 findings.push({id:'reply-cleared-before-acceptance',confirmed:true,description:'A failed sessions.prompt persists pendingReply=null and attention status; the visible reply has no pending delivery record.'});
}
{
 const f=await fixture();const first=await f.engine.create({objective:'Duplicate network retry fixture.',mode:'chat',requestId:'same-client-request'});const second=await f.engine.create({objective:'Duplicate network retry fixture.',mode:'chat',requestId:'same-client-request'});
 assert.notEqual(first.id,second.id);
 findings.push({id:'task-create-not-idempotent',confirmed:true,description:'Replaying the same task creation with the same client request ID creates a second task; the engine does not consume that ID.'});
}
{
 const f=await fixture();await writeFile(join(f.root,'work.json'),'{corrupted fixture');await writeFile(join(f.root,'work.json.tmp'),JSON.stringify(f.engine.store));
 const restarted=new WorkEngine(f.engine.api,f.root,{warn(){}},()=>null);await assert.rejects(restarted.init(),SyntaxError);
 findings.push({id:'corrupt-state-no-fallback',confirmed:true,description:'A corrupt main index prevents startup even when a valid temporary index is present; there is no automatic fallback.'});
}
// Execute the real composer handler against plain fixture objects, without a browser.
const clientSource=await readFile(new URL('../../plugins/browser-viewer/lib/work-client.js',import.meta.url),'utf8');
const composerCode=clientSource.match(/\$\('#composer'\)\.onsubmit=async e=>\{[\s\S]*?\r?\n\};/)[0];
function composerFixture(){
 const elements=new Map([['#composer',{}],['#prompt',{value:'First fixture message.'}],['#send',{disabled:false}],['#mode',{value:'chat'}],['#main',{scrollTop:0,scrollHeight:0}],['#schedule-summary',{textContent:''}]]);
 const requests=[];
 const context={$:s=>elements.get(s),selected:null,imageMode:false,scheduled:null,files:[],previousSignature:'',state:{tasks:[]},render(){},renderAttachments(){},toast(){},api(path,body){if(path==='state')return Promise.resolve({tasks:[]});return new Promise(resolve=>requests.push({path,body,resolve}));}};
 vm.runInNewContext(composerCode,context);
 return {elements,requests,submit:()=>elements.get('#composer').onsubmit({preventDefault(){}})};
}
{
 const f=composerFixture(),pending=f.submit();f.elements.get('#prompt').value='New draft typed before the request finished.';f.requests[0].resolve({id:'fixture'});await pending;
 assert.equal(f.elements.get('#prompt').value,'');
 findings.push({id:'composer-erases-next-draft',confirmed:true,description:'The actual composer handler clears new text typed while the prior send request is pending. Verified against plain DOM fixture objects, not a browser.'});
}
{
 const f=composerFixture(),first=f.submit(),second=f.submit();assert.equal(f.requests.length,2);for(const request of f.requests)request.resolve({id:'fixture'});await Promise.all([first,second]);
 findings.push({id:'composer-no-inflight-guard',confirmed:true,description:'Calling the actual submit handler twice while sending produces two creation requests despite the disabled send button. The Enter handler uses requestSubmit and the submit handler has no in-flight guard.'});
}
await writeFile(new URL('failure-findings.json',import.meta.url),JSON.stringify(findings,null,2));
console.log(JSON.stringify(findings,null,2));
