// Measures whether a context window moved a task forward, so continuation budgets
// follow real progress instead of a fixed count. Signals are durable and local:
// recorded files, finished plan steps, saved checkpoints and distinct actions.
import {createHash} from 'node:crypto';

const MAX_SIGNATURES=256;
export const MAX_EXTENSIONS=3;
export const STAGNANT_LIMIT=2;

/** Remembers a short signature of each distinct action in the current window. */
export function noteAction(t,name,args){
  const sig=createHash('sha256').update(JSON.stringify([name,args||{}])).digest('hex').slice(0,10);
  const seen=t.windowSignatures||=[];if(!seen.includes(sig)&&seen.length<MAX_SIGNATURES)seen.push(sig);
  t.windowCalls=(t.windowCalls||0)+1;
}

export function snapshot(t){
  return {artifacts:(t.artifacts||[]).length,done:(t.plan||[]).filter(s=>s.status==='done').length,checkpointAt:t.checkpoint?.updatedAt||0};
}

/** productive: durable output; exploring: mostly new actions; stagnant: neither. */
export function assessWindow(t){
  const before=t.windowStart||{artifacts:0,done:0,checkpointAt:0},now=snapshot(t),calls=t.windowCalls||0,distinct=(t.windowSignatures||[]).length;
  const signals={files:Math.max(0,now.artifacts-before.artifacts),steps:Math.max(0,now.done-before.done),checkpoint:now.checkpointAt>before.checkpointAt,distinct,calls};
  const verdict=signals.files||signals.steps||signals.checkpoint?'productive':calls&&distinct/calls>=0.5?'exploring':'stagnant';
  return {verdict,signals};
}

/**
 * Called when a window ends (session rotation or a full context). Returns
 * {action:'continue'|'extend'|'pause', reason, verdict} and starts the next window.
 */
export function continuationDecision(t,{maxContextResets}){
  const {verdict,signals}=assessWindow(t);
  t.stagnantWindows=verdict==='stagnant'?(t.stagnantWindows||0)+1:0;
  (t.progressWindows||=[]).push({at:Date.now(),verdict,...signals});if(t.progressWindows.length>12)t.progressWindows.splice(0,t.progressWindows.length-12);
  t.windowStart=snapshot(t);t.windowSignatures=[];t.windowCalls=0;
  if(t.stagnantWindows>=STAGNANT_LIMIT)return {action:'pause',verdict,reason:`The last ${t.stagnantWindows} work sessions produced no new files, finished steps or saved checkpoints, and mostly repeated earlier actions. Saved work is preserved; resume with a different approach or more detail.`};
  if((t.contextResets||0)<maxContextResets)return {action:'continue',verdict};
  if(verdict==='productive'&&(t.budgetExtensions||0)<MAX_EXTENSIONS){t.budgetExtensions=(t.budgetExtensions||0)+1;return {action:'extend',verdict,reason:'Measured progress in the last session; continuing past the usual budget.'};}
  return {action:'pause',verdict,reason:'This task reached its continuation budget. Saved outputs and checkpoints are preserved.'};
}

/** Total action ceiling grows with each progress-earned extension. */
export function taskActionLimit(t,{maxTaskToolCalls,maxSessionToolCalls}){
  return maxTaskToolCalls+(t.budgetExtensions||0)*maxSessionToolCalls*2;
}

export function resetProgress(t){
  t.stagnantWindows=0;t.budgetExtensions=0;t.windowStart=snapshot(t);t.windowSignatures=[];t.windowCalls=0;
}
