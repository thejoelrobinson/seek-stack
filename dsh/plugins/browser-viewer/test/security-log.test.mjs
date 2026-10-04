import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SecurityLog,SECURITY_FILE} from '../lib/work-security.js';

test('security log keeps safe fields only, merges proxy events, counts failed sign-ins and rotates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'seek-security-')),log=new SecurityLog(root);
 await writeFile(join(root,SECURITY_FILE),JSON.stringify({at:Date.now()-1000,source:'proxy',type:'login.failed',ip:'203.0.113.5',attempts:1})+'\nnot json\n');
 await log.record('vault.login_saved',{host:'accounts.example.com',password:'hunter2',note:'<script>'},{local:false});
 await log.record('approval.decided',{decision:'approve',scope:'task',host:'shop.example'});
 assert.throws(()=>log.record('made.up'),/Unknown security event/);
 const raw=await readFile(join(root,SECURITY_FILE),'utf8');assert.match(raw,/accounts\.example\.com/);assert.doesNotMatch(raw,/<script>/,'unsafe text is dropped');assert.doesNotMatch(raw,/hunter2|password/,'only allowlisted fields are kept');
 const {events,failedSignIns24h}=await log.read(10);
 assert.deepEqual(events.map(e=>e.type),['approval.decided','vault.login_saved','login.failed']);assert.equal(events[1].channel,'remote');assert.equal(events[2].label,'Sign-in failed');assert.equal(failedSignIns24h,1);
 await writeFile(join(root,SECURITY_FILE),'x'.repeat(1024*1024+10));await log.record('vault.locked');
 assert.ok((await stat(join(root,SECURITY_FILE+'.1'))).size>1024*1024);assert.equal((await log.read()).events[0].type,'vault.locked','reads survive rotation');
});
