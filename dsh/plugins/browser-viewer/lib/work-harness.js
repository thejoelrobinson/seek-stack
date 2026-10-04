// Work's integration with the DeepSeek Harness 0.2 services. Sessions go through the
// `sessionController` service, goals through the goals service of each session's agent,
// and native approvals/questions through the scoped `approval/request` and
// `user-questions/request` waterfalls. Every call has a deadline: a hung harness call must
// not stall the Work engine's tick.
import {randomUUID} from 'node:crypto';

const DEADLINE_MS=30000;
const deadline=(label,ms=DEADLINE_MS)=>AbortSignal.timeout(ms);
async function bounded(label,work){
  let timer;const timeout=new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`The ${label} request timed out. Delivery may need verification.`)),DEADLINE_MS);});
  try{return await Promise.race([work(),timeout]);}finally{clearTimeout(timer);}
}
const refOf=view=>view?{id:view.id,revision:view.revision}:null;

export class WorkHarness {
  constructor(ctx,{onCall}={}){this.ctx=ctx;this.onCall=onCall;}
  get sessions(){const service=this.ctx.get('sessionController');if(!service)throw new Error('The harness session controller is unavailable.');return service;}
  async call(label,sessionId,work){
    const began=performance.now();let status='error';
    try{const value=await bounded(label,work);status='ok';return value;}
    catch(error){if(error?.code&&!error.rejected)error.rejected=true;throw error;}
    finally{this.onCall?.({label,sessionId,ms:performance.now()-began,status});}
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  async listSessions(){return (await this.call('session.list',null,()=>this.sessions.list({},deadline('session.list')))).items;}
  createSession({cwd}){return this.call('session.create',null,()=>this.sessions.create({cwd}));}
  /** Per-session reasoning effort on the deployment's default provider/model. */
  async selectEffort(sessionId,reasoningEffort){
    const base=this.ctx.get('agentDefaultModel')?.currentSelection?.();if(!base)throw new Error('No default model is configured.');
    return this.call('session.selectModel',sessionId,()=>this.sessions.selectModel({sessionId,provider:base.provider,model:base.model,reasoningEffort}));
  }
  renameSession(sessionId,title){return this.call('session.rename',sessionId,()=>this.sessions.rename({sessionId,title}));}
  /** mode 'queue' waits for the current turn; 'steer' injects into it. */
  prompt(sessionId,text,{mode='queue'}={}){return this.call('session.prompt',sessionId,()=>this.sessions.prompt({requestId:randomUUID(),sessionId,mode,content:[{type:'text',text}]},deadline('session.prompt')));}
  cancel(sessionId){return this.call('session.cancel',sessionId,()=>this.sessions.cancel({sessionId}));}
  /** The latest messages window plus current projections (goal state), or null for an unknown session. */
  async history(sessionId,{maxMessages=40}={}){
    return this.call('session.history',sessionId,async()=>{
      const projections=await this.sessions.projections({sessionId},deadline('session.projections'));
      if(!projections)return null;
      const page=await this.sessions.page({address:{kind:'session',sessionId},throughSeq:projections.asOfSeq,maxMessages},deadline('session.page'));
      return {events:page.records,projections:{asOfSeq:projections.asOfSeq,values:projections.values}};
    });
  }

  // ── goals (per-agent service) ────────────────────────────────────────────
  async agentFor(sessionId){
    const resolved=await this.sessions.agents.resolveAgent(sessionId);
    if(resolved&&'error' in resolved)throw resolved.error instanceof Error?resolved.error:new Error(resolved.error?.message||'Session agent is unavailable.');
    return resolved.agent;
  }
  goalsFor(agent){
    const goals=this.ctx.get('agentPresets')?.serviceFor(agent,'goals')??this.ctx.get('goals');
    if(!goals)throw new Error('The goal service is not mounted for this session.');
    return goals;
  }
  liveGoal(sessionId){
    const agent=this.ctx.agents?.get?.(sessionId);if(!agent)return null;
    try{return this.goalsFor(agent).get(agent)||null;}catch{return null;}
  }
  goal(label,sessionId,mutate){return this.call('goal.'+label,sessionId,async()=>{const agent=await this.agentFor(sessionId);return mutate(this.goalsFor(agent),agent);});}
  async createGoal(sessionId,{objective,maxGoalRounds}){return {ref:refOf(await this.goal('create',sessionId,(goals,agent)=>goals.create(agent,{objective,...(maxGoalRounds===undefined?{}:{maxGoalRounds})})))};}
  async editGoal(sessionId,ref,{objective,maxGoalRounds}={}){return {ref:refOf(await this.goal('edit',sessionId,(goals,agent)=>goals.edit(agent,ref,{...(objective===undefined?{}:{objective}),...(maxGoalRounds===undefined?{}:{maxGoalRounds})})))};}
  async pauseGoal(sessionId,ref){return {ref:refOf(await this.goal('pause',sessionId,(goals,agent)=>goals.pause(agent,ref)))};}
  async resumeGoal(sessionId,ref){return {ref:refOf(await this.goal('resume',sessionId,(goals,agent)=>goals.resume(agent,ref)))};}
  /** Hides a session from the harness's own session list (used for finished task tests). */
  archiveSession(sessionId){
    const registry=this.ctx.get?.('workspaceRegistry')||this.ctx.workspaceRegistry;
    if(!registry?.archiveSession)return Promise.resolve(null);
    return this.call('session.archive',sessionId,()=>registry.archiveSession(sessionId,{stopActivity:true}));
  }
  async completeGoal(sessionId,ref){return {ref:refOf(await this.goal('complete',sessionId,(goals,agent)=>goals.complete(agent,ref)))};}
  async clearGoal(sessionId,ref){await this.goal('clear',sessionId,(goals,agent)=>goals.clear(agent,ref));return {cleared:true};}

  // ── native approvals and questions ───────────────────────────────────────
  /**
   * Answers native harness approvals/questions for sessions Work owns. `claim(sessionId, request)`
   * returns a promise for the user's answer, or undefined to pass the request on to the next
   * answerer (the web UI). Returns a disposer.
   */
  answerFor(claim){
    // Approval/question waterfalls are dispatched scoped to the asking agent; a listener owned by this
    // plugin is outside that scope and would never be called (a task then hangs on an unseen prompt).
    // global admits it; prepend runs it before the web UI's answerer. Non-Work sessions call next().
    const options={global:true,prepend:true};
    const approval=this.ctx.on('approval/request',(request,next)=>{
      const sessionId=request.agent?.session?.id||request.agent?.id;
      const pending=sessionId&&claim(sessionId,{type:'approval/requested',approvalId:randomUUID(),sessionId,toolName:request.toolName,callId:request.callId,reason:request.reason,signal:request.signal});
      return pending?pending.then(outcome=>outcome==='allow'||outcome==='allowed-once'?'allowed-once':outcome==='cancelled'?'cancelled':'rejected'):next();
    },options);
    const question=this.ctx.on('user-questions/request',(request,next)=>{
      const sessionId=request.agent?.session?.id||request.agent?.id;
      const pending=sessionId&&claim(sessionId,{type:'question/requested',questionId:randomUUID(),sessionId,questions:request.questions,signal:request.signal});
      return pending?pending.then(answer=>({answers:answer.answers})):next();
    },options);
    return ()=>{approval();question();};
  }
}
