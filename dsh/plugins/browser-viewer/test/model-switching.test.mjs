import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkAssets} from '../lib/work-assets.js';
import {WorkUpdates} from '../lib/work-updates.js';
import {CdpBrowser} from '../lib/cdp.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hold=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(predicate,label){
 const deadline=Date.now()+5000;while(Date.now()<deadline){if(await predicate())return;await sleep(20);}throw new Error('Model switching timeout: '+label);
}

test('reopening Images uses completed SSE handoff immediately while cached status is busy',async()=>{
 const assets=await new WorkAssets().init(),streams=new Set(),accepted=hold(),now=Date.now();
 const state={language:{name:'Qwen 3.8 · 27B',state:'loading'},image:{name:'Qwen Image 2.1',state:'standby'},active:true,recoveryRequired:false,job:{id:'restoring-fixture',phase:'restoringChat',startedAt:now-10000,phaseAt:now,imageReady:true,resumeModels:['qwen3.8-27b'],phases:[]}};
 // The slower Images status poll still describes restoration after SSE completes.
 const cachedStatus={ready:true,available:true,active:structuredClone(state.job)};
 const updates=new WorkUpdates({store:{version:1,settings:{name:'Seek'},tasks:[]}},{health:()=>({model:'ready',models:state})});
 const image={id:'new-fixture',prompt:'A small watercolor lighthouse.',url:'/fixture.png',createdAt:now,width:1024,height:1024};
 let statusRequests=0;const starts=[];
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local'),json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/work/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: revision\ndata: 1\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(url.pathname==='/work/api/updates')return json(updates.changed(url.searchParams.get('since')));
  if(url.pathname==='/qwen-image/api/status'){statusRequests++;return json(cachedStatus);}
  if(url.pathname==='/qwen-image/api/history')return json({items:[]});
  if(url.pathname==='/qwen-image/api/start'){let text='';for await(const chunk of req)text+=chunk;starts.push(JSON.parse(text));await accepted.promise;return json({id:image.id,accepted:true},202);}
  if(url.pathname==='/qwen-image/api/job')return json({job:{id:image.id,phase:'complete',imageReady:true},image});
  if(url.pathname==='/fixture.png'){res.writeHead(200,{'Content-Type':'image/png'});res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64'));return;}
  if(!assets.serve(req,res,url)){res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-switching-')),windowSize:'1440,1050'});
 let tab;const evaluate=expression=>ui.evaluate(tab,expression),wait=expression=>until(()=>evaluate(expression),expression);
 const publish=()=>{for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');};
 const submit=()=>evaluate("document.querySelector('#image-create').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));true");
 try{
  await ui.launch();tab=await ui.newTab('http://127.0.0.1:'+server.address().port+'/work');
  await wait("document.querySelector('#model-status')?.textContent.includes('Bringing chat back')");
  await evaluate("document.querySelector('[data-view=images]').click();true");
  await wait("!!document.querySelector('#image-create')");
  assert.equal(await evaluate("document.querySelector('#image-create .primary').disabled"),false,'Reopened Images can queue another image while restoration still owns the GPU');
  await evaluate("(async()=>{await SeekImages.refresh();return true})()");
  await evaluate(`document.querySelector('#image-create textarea').value=${JSON.stringify(image.prompt)};true`);
  state.active=false;state.job.phase='complete';state.job.finishedAt=Date.now();state.language.state='ready';publish();
  await wait("document.querySelector('.model-journey h3')?.textContent==='Your image is ready'&&!document.querySelector('#image-create .primary').disabled");
  assert.equal(cachedStatus.active.phase,'restoringChat','The regression retains an older busy status response');
  const submittedAt=Date.now();await submit();
  await until(()=>starts.length===1,'Immediate generation after completed handoff');
  assert.ok(Date.now()-submittedAt<2000,'Completion does not wait for the ten-second status timer');
  assert.equal(starts[0].prompt,image.prompt);
  await submit();await sleep(100);assert.equal(starts.length,1,'Pending submission still prevents a duplicate job');
  const statusAfterStart=statusRequests;accepted.resolve();
  await until(()=>statusRequests>statusAfterStart,'Completed submission refresh');
  await wait("!document.querySelector('#image-create .primary').disabled");
  assert.equal(await evaluate("document.querySelector('.images-head p').textContent.includes('An image is rendering now.')"),false,'A cached busy response cannot repaint an idle model as rendering');
  state.active=true;state.language.state='standby';state.image.state='creating';state.job={id:'busy-fixture',phase:'creating',startedAt:Date.now(),phaseAt:Date.now(),phases:[]};publish();
  await wait("document.querySelector('.model-journey h3')?.textContent==='Creating your image'&&!document.querySelector('#image-create .primary').disabled");
  await submit();await sleep(100);assert.equal(starts.length,2,'A genuine active model job allows a separate durable queue request');
  state.active=false;state.recoveryRequired=true;state.language.state='error';state.job.phase='error';publish();
  await wait("document.querySelector('#image-create .primary')?.textContent==='Restore chat to continue'");
  await submit();await sleep(100);assert.equal(starts.length,2,'A failed chat restoration remains blocked');
 }finally{
  accepted.resolve();for(const stream of streams)stream.end();await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
});

test('newer status owns Images during an SSE gap and late events cannot clear recovery',async()=>{
 const assets=await new WorkAssets().init(),streams=new Set(),now=Date.now();
 const idleJob={id:'idle-fixture',phase:'complete',startedAt:now-10000,phaseAt:now-8000,finishedAt:now-8000,imageReady:true,resumeModels:[],phases:[]};
 const state={language:{name:'Qwen 3.8 · 27B',state:'ready'},image:{name:'Qwen Image 2.1',state:'standby'},active:false,recoveryRequired:false,job:idleJob};
 const cachedStatus={ready:true,available:true,active:null,recoveryRequired:false,job:structuredClone(idleJob)};
 const updates=new WorkUpdates({store:{version:1,settings:{name:'Seek'},tasks:[]}},{health:()=>({model:'ready',models:state})});
 let starts=0;
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local'),json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/work/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: revision\ndata: 1\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
  if(url.pathname==='/work/api/updates')return json(updates.changed(url.searchParams.get('since')));
  if(url.pathname==='/qwen-image/api/status')return json(cachedStatus);
  if(url.pathname==='/qwen-image/api/history')return json({items:[]});
  if(url.pathname==='/qwen-image/api/start'){starts++;return json({error:'Fixture admission recorded.'},400);}
  if(!assets.serve(req,res,url)){res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-switching-gap-')),windowSize:'1440,1050'});
 let tab;const evaluate=expression=>ui.evaluate(tab,expression),wait=expression=>until(()=>evaluate(expression),expression);
 const publish=()=>{for(const stream of streams)stream.write('event: revision\ndata: 1\n\n');};
 const refresh=()=>evaluate("(async()=>{await SeekImages.refresh();return true})()");
 const submit=()=>evaluate("document.querySelector('#image-create').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));true");
 try{
  await ui.launch();tab=await ui.newTab('http://127.0.0.1:'+server.address().port+'/work');
  await wait("document.querySelector('#model-status')?.textContent.includes('Qwen 3.8')");
  await evaluate("document.querySelector('[data-view=images]').click();true");await wait("!!document.querySelector('#image-create')");
  await evaluate("document.querySelector('#image-create textarea').value='A quiet watercolor harbor.';true");
  const activeJob={id:'newer-fixture',phase:'creating',startedAt:now,phaseAt:now,phases:[]};
  cachedStatus.active=activeJob;cachedStatus.job=activeJob;await refresh();
  await wait("document.querySelector('.model-journey h3')?.textContent==='Creating your image'&&!document.querySelector('#image-create .primary').disabled");
  assert.equal(await evaluate("document.querySelector('.model-journey .eyebrow')?.textContent==='QWEN IMAGE 2.1'"),true,'The newer status supplies the active image model state');
  await submit();await sleep(100);assert.equal(starts,1,'A newer active job permits queuing, with GPU ownership enforced by the service');
  cachedStatus.active=null;cachedStatus.recoveryRequired=true;cachedStatus.job={...activeJob,phase:'error',phaseAt:now+1,finishedAt:now+2};await refresh();
  await wait("document.querySelector('#image-create .primary')?.textContent==='Restore chat to continue'");
  await submit();await sleep(100);assert.equal(starts,1,'An idle SSE snapshot cannot bypass a newer recovery failure');
  state.active=true;state.language.state='standby';state.image.state='creating';state.job=activeJob;publish();
  await wait("document.querySelector('#model-status')?.textContent.includes('Creating your image')");
  assert.equal(await evaluate("document.querySelector('#image-create .primary').textContent"),'Restore chat to continue','A late event cannot replace a newer recovery status');
  cachedStatus.recoveryRequired=false;cachedStatus.job={id:'restored-fixture',phase:'complete',startedAt:now+3,phaseAt:now+4,finishedAt:now+5,imageReady:false,resumeModels:['qwen3.8-27b'],phases:[]};await refresh();
  await wait("!document.querySelector('#image-create .primary').disabled");
  assert.equal(await evaluate("document.querySelector('.model-journey h3').textContent"),'Chat is ready again','A newer completed status clears the older active event');
  await submit();await until(()=>starts===2,'Generation after status confirms chat recovery');
 }finally{
  for(const stream of streams)stream.end();await ui.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
});
