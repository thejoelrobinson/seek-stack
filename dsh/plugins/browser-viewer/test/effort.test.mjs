import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkEngine} from '../lib/work-server.js';
import {FakeHarness} from './fake-harness.mjs';

test('per-task reasoning effort is validated and applied to the new session; the Work default fills in',async()=>{
 const harness=new FakeHarness(),engine=new WorkEngine(harness,await mkdtemp(join(tmpdir(),'seek-effort-')),{warn(){}},()=>null);await engine.init();
 await assert.rejects(engine.create({objective:'x',mode:'chat',effort:'turbo'}),/low, medium or xhigh/);
 const fast=await engine.create({objective:'Quick answer.',mode:'chat',effort:'low'});await engine.tick();
 assert.deepEqual(harness.calls.find(c=>c[0]==='selectEffort'),['selectEffort',{sessionId:fast.sessionId,reasoningEffort:'low'}]);
 fast.status='complete';engine.store.settings.reasoningEffort='medium';const plain=await engine.create({objective:'Default effort.',mode:'chat'});await engine.tick();
 assert.deepEqual(harness.calls.filter(c=>c[0]==='selectEffort').at(-1),['selectEffort',{sessionId:plain.sessionId,reasoningEffort:'medium'}]);
 plain.status='complete';delete engine.store.settings.reasoningEffort;const none=await engine.create({objective:'No preference.',mode:'chat'});await engine.tick();
 assert.equal(harness.calls.filter(c=>c[0]==='selectEffort').length,2,'no effort set leaves the deployment default');
});
