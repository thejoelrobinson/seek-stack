import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkDatabase} from '../lib/work-database.js';
import {WorkBackups} from '../lib/work-backups.js';
import {normalizeSchedule,nextCalendarRun,calendarParts} from '../lib/work-schedules.js';
import {taskContract,declaredContract,inspectArtifact,verifyOutcome} from '../lib/work-outcomes.js';
import {WorkEngine} from '../lib/work-server.js';
import {FakeHarness} from './fake-harness.mjs';
import {DreamingService} from '../lib/work-dreaming.js';
import {WorkTelemetry} from '../lib/work-telemetry.js';
import {assertApprovalBinding} from '../lib/work-approval-binding.js';
import {workToolDenial} from '../lib/work-tool-policy.js';

test('calendar recurrences retain wall time across DST, skip missing times and avoid duplicate fallback date',()=>{
 const daily=normalizeSchedule({kind:'calendar',frequency:'daily',time:'09:00',timeZone:'America/Chicago'});
 assert.equal(new Date(nextCalendarRun(daily,Date.parse('2026-03-07T16:00:00Z'))).toISOString(),'2026-03-08T14:00:00.000Z');
 const gap={...daily,time:'02:30'};assert.equal(calendarParts(nextCalendarRun(gap,Date.parse('2026-03-08T00:00:00Z')),gap.timeZone).date,'2026-03-09');
 const repeat={...daily,time:'01:30'};assert.equal(calendarParts(nextCalendarRun(repeat,Date.parse('2026-11-01T06:30:00Z'),'2026-11-01'),repeat.timeZone).date,'2026-11-02');
 assert.throws(()=>normalizeSchedule({...daily,timeZone:'made-up'}),/time zone/);
});
test('transactional migration, nested edits, append messages, search and restart preserve history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-db-')),legacy={version:1,settings:{name:'Seek'},tasks:[{id:'one',title:'Research report',messages:[{role:'user',text:'unusual elephant fact',time:1}],artifacts:[],events:[]}]};
 await writeFile(join(root,'work.json'),JSON.stringify(legacy));const db=new WorkDatabase(root,{snapshotEveryMs:Infinity});const store=await db.load(legacy);
 const revision=store.tasks[0].revision||0;store.tasks[0].messages.push({role:'assistant',text:'confirmed zebra evidence',time:2});store.tasks[0].messages[0].text='corrected unusual elephant fact';store.tasks[0].artifacts.push({id:'artifact',path:'report.md'});assert.ok(store.tasks[0].revision>revision);await db.saveStore(store);
 assert.equal(db.search('zebra')[0].id,'one');assert.deepEqual(JSON.parse(await readFile(join(root,'work-migration-original.json'),'utf8')),legacy);
 await db.close();const next=new WorkDatabase(root);const loaded=await next.load(legacy);assert.equal(loaded.tasks[0].messages.length,2);assert.equal(loaded.tasks[0].messages[0].text,'corrected unusual elephant fact');assert.equal(loaded.tasks[0].artifacts.length,1);await next.close();
});
test('frozen native tool arguments remain serializable in tracked task state',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-frozen-state-')),db=new WorkDatabase(root),store=await db.load({version:1,settings:{},tasks:[{id:'t',title:'Task',messages:[],artifacts:[]}]});store.tasks[0].plan=Object.freeze([Object.freeze({title:'Read the brief',status:'done'})]);store.tasks[0].goal=Object.freeze({id:'g',phase:'active'});assert.doesNotThrow(()=>JSON.stringify(store));await db.saveStore(store);await db.close();
});
test('named file requests require artifacts and outcome tool results are lossless JSON',async()=>{
 const contract=taskContract('Read the attached brief.txt, create result.txt with exactly its requested output.');assert.equal(contract.kind,'artifact');assert.equal(contract.requiresArtifact,true);
 const root=await mkdtemp(join(tmpdir(),'seek-outcome-json-'));await writeFile(join(root,'result.txt'),'VERIFIED WORK MODE');
 const task={id:'json',contract:{...contract,deliverables:['result.txt'],checks:[{kind:'contains',path:'result.txt',value:'VERIFIED WORK MODE'}]},artifacts:[{path:'result.txt'}]};
 const result=await verifyOutcome(task,{file:async(_t,path)=>({full:join(root,path)})});assert.equal(result.status,'verified');assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
 const missing=await verifyOutcome({...task,artifacts:[]},{file:async(_t,path)=>({full:join(root,path)})});assert.equal(missing.status,'needs-verification');assert.deepEqual(JSON.parse(JSON.stringify(missing)),missing);
});
test('agent contract corrections preserve user checks and a transactional follow-up starts a new contract',async()=>{
 const owner=taskContract('Create a report file',{kind:'artifact',deliverables:['report.txt'],checks:[{kind:'contains',path:'report.txt',value:'User requirement'}]});const task={objective:'Create a report file',userContract:owner};task.contract=declaredContract(task,{checks:[{kind:'min-bytes',path:'report.txt',value:999}]});const corrected=declaredContract(task,{checks:[{kind:'min-bytes',path:'report.txt',value:1}]});assert.deepEqual(corrected.deliverables,['report.txt']);assert.equal(corrected.checks[0].value,'User requirement');assert.equal(corrected.checks[1].value,1);assert.equal(corrected.kind,'artifact');
 const root=await mkdtemp(join(tmpdir(),'seek-contract-followup-')),db=new WorkDatabase(root),engine=new WorkEngine(new FakeHarness(),root,console,()=>null,{storage:db});await engine.init();const created=await engine.create({objective:'Explain this topic'});created.status='complete';await engine.control(created.id,'reply','Create a report file','followup-contract');assert.equal(created.contract.kind,'artifact');assert.equal(created.userContract.kind,'artifact');await db.close();
});
test('contracts require both requested artifacts and external receipts, with bounded valid checks',async()=>{
 const contract=taskContract('Create a report file and send an email');assert.equal(contract.requiresArtifact,true);assert.equal(contract.requiresExternal,true);
 assert.equal((await verifyOutcome({id:'both',contract,artifacts:[],result:'Done'},{receipts:[{taskId:'both',state:'verified'}]})).status,'needs-verification');
 assert.throws(()=>taskContract('Build a report',{kind:'invented'}),/contract/);assert.throws(()=>taskContract('Build a report',{checks:[{kind:'execute',path:'x'}]}),/check/);assert.throws(()=>taskContract('Build a report',{checks:[{kind:'sha256',path:'x',value:'model guess'}]}),/value/);
 assert.throws(()=>taskContract('Build a report',{deliverables:['result.txt containing exactly the requested output']}),/exact relative file/);assert.throws(()=>taskContract('Build a report',{deliverables:['Form saved and confirmation read']}),/exact relative file/);assert.equal(taskContract('Build a report',{deliverables:['Monthly Report.docx']}).deliverables[0],'Monthly Report.docx');
});
test('a crash between recurring child creation and parent acknowledgment never duplicates the occurrence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-recurrence-')),engine=new WorkEngine(new FakeHarness(),root);await engine.init();const task=await engine.create({objective:'Explain a topic',schedule:{kind:'calendar',frequency:'daily',time:'09:00',timeZone:'America/Chicago'}});task.status='complete';task.completedAt=Date.now();await engine.save();
 const create=engine.create.bind(engine);engine.create=async args=>{await create(args);throw new Error('simulated crash after child saved');};await assert.rejects(engine.scheduleNext(task),/simulated crash/);
 const recovered=new WorkEngine(new FakeHarness(),root);await recovered.init();const parent=recovered.task(task.id);await recovered.scheduleNext(parent);await recovered.scheduleNext(parent);assert.equal(recovered.store.tasks.length,2);assert.equal(parent.repeatCreated,true);assert.equal(recovered.store.tasks[1].runAt,parent.nextOccurrenceAt);
});
test('failed outcome checks repair autonomously twice, then preserve a concrete blocker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-repair-')),engine=new WorkEngine(Object.assign(new FakeHarness(),{clearGoal:async()=>({cleared:true})}),root);await engine.init();const task=await engine.create({objective:'Create a report file'});task.sessionId='s';task.goal={id:'g',revision:1,phase:'complete'};
 assert.equal(await engine.complete(task),false);assert.equal(task.status,'queued');assert.equal(task.verificationAttempts,1);assert.equal(await engine.complete(task),false);assert.equal(task.verificationAttempts,2);assert.equal(await engine.complete(task),false);assert.equal(task.status,'attention');assert.match(task.question.text,/verified/);
 await writeFile(join(task.cwd,'report.txt'),'Repaired result');await engine.artifact(task,'report.txt','Report');assert.equal(await engine.complete(task),true);assert.equal(task.resultEvidence.status,'verified');
});
test('running steering is durably acknowledged before slow model delivery and attachments deduplicate',async()=>{
 let finish;const delivered=new Promise(r=>finish=r),engine=new WorkEngine(Object.assign(new FakeHarness(),{prompt:async()=>{await delivered;return {accepted:true};}}),await mkdtemp(join(tmpdir(),'seek-ack-')));await engine.init();const task=await engine.create({objective:'Research a topic'});task.sessionId='s';task.status='running';const input={name:'brief.txt',data:Buffer.from('Additional input').toString('base64')};
 const start=performance.now();await engine.operation(()=>engine.control(task.id,'reply','Use this brief','steering_1',[input],{fastAck:true}));assert.ok(performance.now()-start<1000);assert.equal(task.deliveries.at(-1).status,'received');assert.equal(task.inputs.length,1);finish();await engine.operations;assert.equal(task.deliveries.at(-1).status,'applied');await engine.control(task.id,'reply','Use this brief','steering_1',[input]);assert.equal(task.inputs.length,1);assert.equal(task.outbox.length,1);await assert.rejects(engine.control(task.id,'reply','Changed brief','steering_1',[input]),/already used/);
});
test('scoped memory excludes other projects and people, versions corrections and honors forget',async()=>{
 const dreaming=await new DreamingService(await mkdtemp(join(tmpdir(),'seek-memory-')),{tasks:()=>[],busy:()=>false}).init();const make=(id,project,person)=>({id,key:id,text:'Use short paragraphs',scope:'general',status:'active',confirmedAt:1,updatedAt:1,sources:[],project,person});dreaming.data.lessons=[make('global',null,null),make('a','Alpha','owner'),make('b','Beta','owner'),make('other',null,'someone-else')];
 assert.deepEqual(dreaming.recall('paragraphs',{project:'Alpha',person:'owner'}).map(l=>l.id),['global','a']);assert.deepEqual(dreaming.recall('paragraphs',{project:'Beta',person:'owner'}).map(l=>l.id),['global','b']);
 await dreaming.manage({id:'a',action:'edit',text:'Use compact paragraphs',project:'Beta',person:'owner'});assert.equal(dreaming.data.lessons.find(l=>l.id==='a').revisions[0].project,'Alpha');assert.ok(!dreaming.recall('paragraphs',{project:'Alpha',person:'owner'}).some(l=>l.id==='a'));await dreaming.manage({id:'a',action:'forget'});assert.ok(!dreaming.data.lessons.some(l=>l.id==='a'));await assert.rejects(dreaming.manage({id:'b',action:'edit',text:'A normal preference',person:'model-inferred-person'}),/owner/);
});
test('Finance context stays out of the displayed objective and durable latency samples omit prompt data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-finance-context-')),engine=new WorkEngine(new FakeHarness(),root);await engine.init();const task=await engine.create({objective:'What did I spend this month?',mode:'chat',domain:'finance'});assert.equal(task.objective,'What did I spend this month?');assert.match(engine.contextInstructions(task),/This is a Finance question/);assert.match(engine.contextInstructions(task),/finance_spending_report/);
 const telemetry=new WorkTelemetry(root);telemetry.record({kind:'task',phase:'queue',ms:25,status:'started'});telemetry.record({kind:'task',phase:'queue',ms:75,status:'started'});assert.equal(telemetry.summary()[0].p95Ms,75);telemetry.close();telemetry.record({kind:'rpc',phase:'late',ms:1});
});
test('stale approval screens and missing reviewed payload bindings cannot approve a changed action',()=>{
 const current={id:'screen',proposalId:'proposal',fingerprint:'exact'};assert.throws(()=>assertApprovalBinding(current,{}),/Refresh/);assert.throws(()=>assertApprovalBinding(current,{proposalId:'old',fingerprint:'exact'}),/changed/);assert.throws(()=>assertApprovalBinding(current,{proposalId:'proposal',fingerprint:'edited'}),/changed/);assert.doesNotThrow(()=>assertApprovalBinding(current,{proposalId:'proposal',fingerprint:'exact'}));
 assert.match(workToolDenial({name:'mcp__gmail__send_email',arguments:{}},{status:'running'}),/broker/);assert.equal(workToolDenial({name:'mcp__gmail__list_emails',arguments:{}},{status:'running'}),undefined);assert.match(workToolDenial({name:'read',arguments:{path:'C:/private/key.dpapi'}},{status:'running'}),/credentials/);assert.equal(workToolDenial({name:'read',arguments:{path:'C:/private/key.dpapi'}},null),undefined);
});
test('streaming backup uses portable recovery keys, symmetric limits, retention and authenticates before commit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-stream-backup-'));await writeFile(join(root,'file.txt'),'Synthetic content');const b=await new WorkBackups(root,{key:Buffer.alloc(32,8),retention:2}).init();const one=await b.create();await b.create();await b.create();assert.equal((await readdir(join(root,'backups'))).filter(f=>f.endsWith('.seekbackup')).length,2);assert.equal((await readFile(one.path).catch(()=>Buffer.from(''))).length,0,'oldest archive retained beyond policy');
 const portable=b.exportRecoveryKey();assert.equal(portable.format,'seek-backup-key-v1');const latest=join(root,'backups',b.info.lastFile),dest=join(await mkdtemp(join(tmpdir(),'seek-portable-')),'restored');assert.equal((await b.restore(latest,dest,{key:portable.key})).verified,true);const bad=await readFile(latest);bad[20]^=1;const archive=join(root,'tampered.seekbackup');await writeFile(archive,bad);const failed=join(root,'failed');await assert.rejects(b.restore(archive,failed));assert.deepEqual(await readdir(failed),[],'unauthenticated files reached destination');
 const limited=await new WorkBackups(root,{key:Buffer.alloc(32,8),limits:{maxFileBytes:4}}).init();await assert.rejects(limited.create(),/file.*limit/);assert.equal((await readdir(join(root,'backups'))).filter(f=>f.endsWith('.tmp')||f.startsWith('.seek-backup-')).length,0);
});
test('one changed task does not rewrite unchanged message histories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-db-scale-')),db=new WorkDatabase(root,{snapshotEveryMs:Infinity});const data={version:1,settings:{name:'Seek'},tasks:Array.from({length:1000},(_,i)=>({id:'task-'+i,title:'Task '+i,messages:Array.from({length:10},(_,j)=>({role:'user',text:'Message '+j})),artifacts:[],events:[]}))};const store=await db.load(data);
 const before=db.db.prepare('SELECT total_changes() n').get().n;store.tasks[800].title='Changed';await db.saveStore(store);const writes=db.db.prepare('SELECT total_changes() n').get().n-before;assert.ok(writes<40,'Incremental update wrote '+writes+' rows, expected only changed task');await db.close();
});
test('empty and malformed files fail outcome checks; external model claims do not count as receipts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-outcomes-'));await writeFile(join(root,'empty.md'),'');await writeFile(join(root,'broken.json'),'not json');await assert.rejects(inspectArtifact(join(root,'empty.md')),/empty/);await assert.rejects(inspectArtifact(join(root,'broken.json')));
 const task={id:'t',objective:'Send an email',contract:taskContract('Send an email'),result:'Done',artifacts:[]};assert.equal((await verifyOutcome(task,{file:async(_t,p)=>({full:join(root,p)})})).status,'needs-verification');
 assert.equal((await verifyOutcome(task,{receipts:[{taskId:'t',state:'verified'}]})).status,'verified');
 const answer={...task,objective:'Explain this',contract:taskContract('Explain this')};assert.equal((await verifyOutcome(answer)).status,'partial');
});
test('artifact versions preserve previous bytes and duplicate registration is idempotent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-artifacts-')),engine=new WorkEngine(new FakeHarness(),root);await engine.init();const t=await engine.create({objective:'Create a report'});await writeFile(join(t.cwd,'report.md'),'First result');const a=await engine.artifact(t,'report.md','Report');const same=await engine.artifact(t,'report.md','Report');assert.equal(same.id,a.id);await writeFile(join(t.cwd,'report.md'),'Second result');const b=await engine.artifact(t,'report.md','Report');assert.equal(b.version,2);assert.equal(b.parentId,a.id);assert.equal(await readFile(join(t.cwd,a.path),'utf8'),'First result');assert.equal(await readFile(join(t.cwd,b.path),'utf8'),'Second result');
});
test('encrypted backup restores verified files and refuses tampering and nonempty destinations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-backup-test-'));await mkdir(join(root,'tasks'));await writeFile(join(root,'tasks','report.txt'),'Private synthetic result');const backup=await new WorkBackups(root,{key:Buffer.alloc(32,7)}).init(),archive=await backup.create();const dest=join(await mkdtemp(join(tmpdir(),'seek-restore-test-')),'restored');const result=await backup.restore(archive.path,dest);assert.equal(result.verified,true);assert.equal(await readFile(join(dest,'tasks','report.txt'),'utf8'),'Private synthetic result');await assert.rejects(backup.restore(archive.path,dest),/empty destination/);const data=await readFile(archive.path);data[data.length-1]^=1;const bad=join(root,'bad.seekbackup');await writeFile(bad,data);await assert.rejects(backup.restore(bad,join(root,'bad-restore')));assert.equal((await readdir(join(root,'backups'))).filter(x=>x.endsWith('.seekbackup')).length,1);
});
