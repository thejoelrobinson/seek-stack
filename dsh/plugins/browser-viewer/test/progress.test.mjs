import test from 'node:test';
import assert from 'node:assert/strict';
import {noteAction,assessWindow,continuationDecision,taskActionLimit,resetProgress,MAX_EXTENSIONS} from '../lib/work-progress.js';

const limits={maxContextResets:2,maxTaskToolCalls:800,maxSessionToolCalls:96};
const act=(t,n,distinct=true)=>{for(let i=0;i<n;i++)noteAction(t,'viewer_navigate',{url:distinct?'https://example.com/'+i+'-'+Math.random():'https://example.com/same'});};

test('a window is productive with durable output, exploring with mostly new actions, stagnant otherwise',()=>{
 const t={artifacts:[],plan:[{status:'pending'}]};
 act(t,10);assert.equal(assessWindow(t).verdict,'exploring');
 t.windowSignatures=[];t.windowCalls=0;act(t,10,false);assert.equal(assessWindow(t).verdict,'stagnant');
 t.artifacts.push({id:'a'});assert.equal(assessWindow(t).verdict,'productive');
 const u={plan:[{status:'done'}],checkpoint:{updatedAt:5},windowStart:{artifacts:0,done:1,checkpointAt:5}};act(u,4,false);assert.equal(assessWindow(u).verdict,'stagnant','unchanged plan and checkpoint are not progress');
});

test('two stagnant windows pause early; productive windows earn bounded extensions; resume resets',()=>{
 const t={artifacts:[],plan:[]};
 act(t,20,false);assert.equal(continuationDecision(t,limits).action,'continue');
 act(t,20,false);const paused=continuationDecision(t,limits);assert.equal(paused.action,'pause');assert.match(paused.reason,/no new files/);
 resetProgress(t);assert.equal(t.stagnantWindows,0);
 const p={artifacts:[],plan:[],contextResets:2};
 for(let i=0;i<MAX_EXTENSIONS;i++){p.artifacts.push({id:'f'+i});act(p,5);assert.equal(continuationDecision(p,limits).action,'extend');p.contextResets++;}
 p.artifacts.push({id:'more'});assert.equal(continuationDecision(p,limits).action,'pause','extensions are capped');
 assert.equal(taskActionLimit(p,limits),800+MAX_EXTENSIONS*96*2);
 const e={artifacts:[],plan:[],contextResets:2};act(e,30);assert.equal(continuationDecision(e,limits).action,'pause','exploring alone does not extend past the budget');
 const w={artifacts:[{id:'x'}],plan:[]};act(w,3,false);continuationDecision(w,limits);act(w,3,false);continuationDecision(w,limits);assert.equal(w.progressWindows.length,2);assert.equal(w.progressWindows[0].verdict,'productive');assert.equal(w.progressWindows[1].verdict,'stagnant');
});
