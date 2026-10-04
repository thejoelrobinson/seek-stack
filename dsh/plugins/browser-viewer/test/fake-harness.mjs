// In-memory stand-in for WorkHarness (lib/work-harness.js) — the DeepSeek Harness 0.2 session
// controller, per-agent goals service and native approval/question waterfalls — for engine tests.
export class FakeHarness {
  constructor({sessions}={}){
    this.sessions=sessions||new Map();// sessionId -> {sessionId, running, events, goal}
    this.calls=[];this.prompts=[];this.failure=null;this.serial=0;this.answerers=[];
  }
  session(sessionId){const s=this.sessions.get(sessionId);if(!s)throw new Error('Unknown session '+sessionId);return s;}
  add(sessionId,extra={}){const s={sessionId,running:false,events:[],goal:null,...extra};this.sessions.set(sessionId,s);return s;}
  fail(error=new Error('Transport fixture')){this.failure=error;}
  recover(){this.failure=null;}
  async listSessions(){return [...this.sessions.values()].map(({sessionId,running})=>({sessionId,running}));}
  async createSession({cwd}){const sessionId='test-'+(++this.serial);this.add(sessionId,{cwd});this.calls.push(['create',{cwd}]);return {sessionId};}
  async selectEffort(sessionId,reasoningEffort){this.calls.push(['selectEffort',{sessionId,reasoningEffort}]);return {reasoningEffort};}
  async renameSession(sessionId,title){this.calls.push(['rename',{sessionId,title}]);return {title,seq:0};}
  async prompt(sessionId,text,{mode='queue'}={}){
    if(this.failure)throw this.failure;
    const payload={sessionId,mode,content:[{type:'text',text}]};this.calls.push(['prompt',payload]);this.prompts.push(payload);return {accepted:true};
  }
  async cancel(sessionId){this.calls.push(['cancel',{sessionId}]);if(this.sessions.has(sessionId))this.session(sessionId).running=false;return {accepted:true};}
  async history(sessionId){
    const s=this.sessions.get(sessionId);if(!s)return null;
    const asOfSeq=s.asOfSeq??Math.max(-1,...s.events.map(x=>x.event?.seq).filter(Number.isInteger));
    return {events:s.events,projections:{asOfSeq,values:{goal:s.goal?{goal:s.goal,roundsStarted:s.roundsStarted||0}:null}}};
  }
  liveGoal(sessionId){return this.sessions.get(sessionId)?.goal||null;}
  goal(method,sessionId,payload,change){
    if(this.failure)throw this.failure;
    this.calls.push([method,{sessionId,...payload}]);const s=this.session(sessionId);s.goal=change(s.goal);
    return {ref:s.goal?{id:s.goal.id,revision:s.goal.revision}:null};
  }
  async createGoal(sessionId,{objective,maxGoalRounds}){return this.goal('create',sessionId,{objective,maxGoalRounds},()=>({id:'goal-'+sessionId,revision:1,phase:'active',activation:'armed',objective}));}
  async editGoal(sessionId,ref,{objective}={}){return this.goal('edit',sessionId,{ref,objective},g=>({...g,...(objective===undefined?{}:{objective}),revision:g.revision+1}));}
  async pauseGoal(sessionId,ref){return this.goal('pause',sessionId,{ref},g=>({...g,revision:g.revision+1,phase:'paused',activation:'disarmed'}));}
  async resumeGoal(sessionId,ref){return this.goal('resume',sessionId,{ref},g=>({...g,revision:g.revision+1,phase:'active',activation:'armed'}));}
  async archiveSession(sessionId){this.calls.push(['archive',{sessionId}]);this.archived=[...(this.archived||[]),sessionId];return null;}
  async completeGoal(sessionId,ref){return this.goal('complete',sessionId,{ref},g=>({...g,revision:g.revision+1,phase:'complete',activation:'disarmed'}));}
  async clearGoal(sessionId,ref){this.goal('clear',sessionId,{ref},()=>null);return {cleared:true};}
  answerFor(claim){this.answerers.push(claim);return ()=>{this.answerers=this.answerers.filter(x=>x!==claim);};}
  /** Simulates the harness offering a native approval/question to registered answerers. */
  native(sessionId,request){for(const claim of this.answerers){const pending=claim(sessionId,request);if(pending)return pending;}return undefined;}
}
