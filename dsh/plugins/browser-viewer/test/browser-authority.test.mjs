import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {BrowserController,buildTools} from '../lib/index.js';
import {WorkAuthority} from '../lib/work-authority.js';
import {authorizeBrowserAction,executeBrowserAction} from '../lib/work-browser-authority.js';

test('browser socket publishes exact approval bindings and rejects missing or stale decisions',async t=>{
  class Socket extends EventEmitter {readyState=1;messages=[];send(message){this.messages.push(JSON.parse(message));}terminate(){this.emit('close');}}
  const grants=[],c=new BrowserController({intervalMs:400,authority:{grant:async(...args)=>grants.push(args),reject:async()=>{}}}),ws=new Socket();
  t.after(()=>c.close());c.addClient(ws);
  const approval=await c.requestApproval({proposalId:'proposal-current',fingerprint:'exact-payload',sessionId:'task',host:'notes.example',label:'Save note',intent:{payload:{fields:[{name:'note',value:'private body'}]}}});
  const visible=ws.messages.at(-1).approval;
  assert.equal(visible.proposalId,'proposal-current');assert.equal(visible.fingerprint,'exact-payload');assert.equal(visible.intent,undefined,'The public binding does not expose the proposed body.');
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  ws.emit('message',Buffer.from(JSON.stringify({type:'approve'})));await settle();assert.equal(c.approval,approval);assert.equal(grants.length,0);assert.match(c.status.error,/Refresh/);
  ws.emit('message',Buffer.from(JSON.stringify({type:'approve',proposalId:'proposal-old',fingerprint:'exact-payload'})));await settle();assert.equal(c.approval,approval);assert.equal(grants.length,0);
  ws.emit('message',Buffer.from(JSON.stringify({type:'reject',proposalId:visible.proposalId,fingerprint:'changed-payload'})));await settle();assert.equal(c.approval,approval);
  ws.emit('message',Buffer.from(JSON.stringify({type:'approve',proposalId:visible.proposalId,fingerprint:visible.fingerprint,scope:'once'})));await settle();assert.equal(c.approval,null);assert.deepEqual(grants,[['proposal-current',{scope:'once'}]]);
});

test('real Chrome resolves coordinates, long/empty labels, keyboard commits, payload drift and task-owned tabs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seek-browser-authority-')),authority=await new WorkAuthority(join(root,'authority')).init();
  const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');
    const label=req.url==='/empty'?'':req.url==='/long'?'Please consider the report. '.repeat(12)+'Send message':'Send message';
    res.end(req.url==='/checkout'?'<title>Checkout</title><h1>Paper</h1><button id="send" onclick="window.hits++">✓</button><button id="coupon" onclick="window.coupons++">Apply coupon</button><script>window.hits=0;window.coupons=0;</script>':`<title>Compose fixture</title><style>button{min-width:150px;min-height:35px}label{display:block}</style><h1>Synthetic message</h1><form onsubmit="event.preventDefault();window.hits++"><label>To<input name="to" value="a@example.com"></label><label>Subject<input name="subject" value="Report"></label><label>Body<textarea name="body">Synthetic text</textarea></label><button id="send" type="submit">${label}</button></form><a href="/report" id="report">Read report</a><script>window.hits=0;document.querySelector('textarea').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();window.hits++;}});</script>`);
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const contexts=new Map([['a',{taskId:'task-a',requestId:'r1',request:'Research the report.'}],['b',{taskId:'task-b',requestId:'r1',request:'Research another report.'}]]);
  const c=new BrowserController({headless:true,windowWidth:1000,windowHeight:750,quality:30,browserOptions:{userDataDir:join(root,'chrome')},authority,authorizationForSession:async id=>contexts.get(id)}),tools=new Map(buildTools(c).map(tool=>[tool.name,tool]));
  const call=(name,args={},id='a')=>tools.get(name).execute(args,{agent:{id}}),evaluate=script=>c.cdp.evaluate(c.activeTabId,script),point=selector=>evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  t.after(async()=>{await c.close();authority.close();await new Promise(resolve=>server.close(resolve));if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('seek-browser-authority-'))throw new Error('Unsafe fixture cleanup.');await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
  for(const path of ['/compose','/long','/empty']){
    await call('viewer_navigate',{url:base+path});const result=await call('viewer_click',await point('#send'));assert.equal(result.approvalRequired,true,path);assert.equal(await evaluate('window.hits'),0,path);await c.decide(c.approval,'reject');
  }
  await call('viewer_navigate',{url:base+'/keyboard'});await evaluate("document.querySelector('input[name=subject]').focus()");
  await assert.rejects(call('viewer_key',{key:'a',windowsVirtualKeyCode:13}),/same key/);await assert.rejects(call('viewer_key',{key:'a',code:'Enter'}),/same key/);assert.equal(await evaluate('window.hits'),0);
  assert.equal((await call('viewer_key',{key:'Enter'})).approvalRequired,true);assert.equal(await evaluate('window.hits'),0);await c.decide(c.approval,'reject');
  await evaluate("document.querySelector('textarea').focus()");assert.equal((await call('viewer_key',{key:'Control+Enter'})).approvalRequired,true);assert.equal(await evaluate('window.hits'),0);await c.decide(c.approval,'reject');
  const newline=await call('viewer_key',{key:'Enter'});assert.equal(newline.approvalRequired,undefined);assert.equal(await evaluate('window.hits'),0);
  await call('viewer_navigate',{url:base+'/checkout'});assert.equal((await call('viewer_click',await point('#coupon'))).approvalRequired,undefined);assert.equal(await evaluate('window.coupons'),1);
  assert.equal((await call('viewer_click',await point('#send'))).approvalRequired,true);assert.equal(await evaluate('window.hits'),0);await c.decide(c.approval,'reject');
  contexts.set('a',{taskId:'task-a',requestId:'r2',request:'Send the report to a@example.com. Do not ask again.'});await call('viewer_navigate',{url:base+'/authorized'});
  const result=await call('viewer_click',await point('#send'));assert.equal(result.approvalRequired,undefined);assert.equal(result.actionReceipt.state,'observed');assert.equal(await evaluate('window.hits'),1);
  assert.equal((await call('viewer_click',await point('#send'))).duplicate,true);assert.equal(await evaluate('window.hits'),1);
  // The same meaningful submit through keyboard shares the receipt.
  await evaluate("document.querySelector('input[name=subject]').focus()");assert.equal((await call('viewer_key',{key:'Enter'})).duplicate,true);assert.equal(await evaluate('window.hits'),1);
  contexts.set('a',{taskId:'task-a',requestId:'r3',request:'Send the report to a@example.com.'});await call('viewer_navigate',{url:base+'/drift'});await c.useSession('a');
  const args=await point('#send'),decision=await authorizeBrowserAction(c,args,'a');await evaluate("document.querySelector('textarea').value='Changed after review'");
  await assert.rejects(executeBrowserAction(c,decision,args,'a',()=>c.click(args)),/changed before execution/);assert.equal(await evaluate('window.hits'),0);c.releaseSession();
  const tabA=c.activeTabId;await call('viewer_navigate',{url:base+'/task-b'},'b');const tabB=c.activeTabId;assert.notEqual(tabA,tabB);
  assert.deepEqual((await call('viewer_tabs',{},'b')).tabs.map(x=>x.id),[tabB]);await assert.rejects(call('viewer_tab',{action:'switch',tabId:tabA},'b'),/Unknown tab/);
  const statusA=await call('viewer_status',{},'a');assert.equal(statusA.url,'');assert.equal(statusA.tabs.some(tab=>tab.id===tabB),false);
  await call('viewer_snapshot',{},'a');assert.equal(c.activeTabId,tabA);await call('viewer_stop',{},'a');assert.equal(c.running,true);await call('viewer_snapshot',{},'b');assert.equal(c.activeTabId,tabB);
});
