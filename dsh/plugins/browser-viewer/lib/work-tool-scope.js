// Per-task tool scope. Every tool schema is resent with every model request (75 tools ≈ 13K
// tokens before any work), which shrinks the usable context, triggers compaction sooner and
// gives a local model more ways to wander. Work tasks hide tools they never need. Hiding is a
// harness `tools.restrict` on the task's own agent, so other sessions are unaffected.

// Never used by Work tasks (measured over 80 task sessions, 6,830 calls) or replaced by a Work tool.
const ALWAYS_HIDDEN=['workflow','ralph','subagent_fork','send_message','interrupt_agent','list_agents','exit_plan_mode','create_goal','todo_write'];
const GROUPS=[
  {match:/^finance_/,when:/\b(financ\w*|money|spend\w*|spent|budget\w*|bank\w*|transaction\w*|bills?|debt|income|net worth|balance|credit card|savings|cash ?flow|expenses?)\b/i,domain:'finance'},
  {match:/^purchases_/,when:/\b(purchases?|orders?|receipts?|walmart|amazon|target|costco|retailer\w*|bought|shopping|spend\w*|spent)\b/i},
  {match:/^discord_/,when:/\bdiscord\b/i},
  {match:/^desktop_/,when:/\b(desktop|my (?:pc|computer|screen)|this (?:pc|computer)|on (?:my|the) (?:pc|computer)|windows apps?|apps? on|open (?:the )?(?:app|program)|notepad|excel|word document|outlook|powerpoint|file explorer|explorer window|settings app|control panel|lightroom|photoshop|premiere|after effects|vs ?code|spotify|teams app)\b/i},
  {match:/^(calendar_|todo_)/,when:/\b(calendars?|schedul\w*|events?|meetings?|appointments?|agenda|remind\w*|to-?dos?|due|deadlines?|tomorrow|today|tonight|this week|next week|weekend|birthdays?|anniversar\w*|plan(?:ning)? my|free time|busy|dinner|lunch|dentist|doctor|trip|vacation)\b/i},
  {match:/^apps_(send_email|create_event|create_document)$/,when:/\b(e-?mail|gmail|inbox|send|calendar|event|meeting|invite|schedule|doc(ument)?s?|google drive|sheet)\b/i}
];

// Task tests use local fixtures only: no real accounts, money, messages or the saved card.
const EVAL_DENY=/^(viewer_pay_with_card|apps_|discord_|finance_|purchases_|desktop_|mcp__)/;
// Drafts Seek prepares on its own may research and write, never pay or send.
const PREPARE_DENY=/^(viewer_pay_with_card|apps_(send|create|update|delete)|discord_send|desktop_|mcp__.*(send|create|delete|update))/;

export function hiddenTools(task,names){
  const text=`${task.objective||''} ${task.title||''}`;
  return [...names].filter(name=>ALWAYS_HIDDEN.includes(name)||GROUPS.some(g=>g.match.test(name)&&!(g.domain&&task.domain===g.domain)&&!g.when.test(text)));
}

export class WorkToolScope {
  constructor(ctx,log,coreMemory=()=>'',policyNotes=()=>''){this.ctx=ctx;this.log=log;this.coreMemory=coreMemory;this.policyNotes=policyNotes;this.applied=new WeakMap();}
  /** Idempotent: re-applies after a harness restart creates a new agent object. */
  apply(task){
    const agent=task?.sessionId&&this.ctx.agents?.get?.(task.sessionId);
    if(!agent?.ctx?.tools?.restrict||this.applied.has(agent))return null;
    const tools=this.ctx.tools,known=[];
    for(const name of [...ALWAYS_HIDDEN,...this.registered()])if(tools.get?.(name,agent)&&!known.includes(name))known.push(name);
    for(const name of this.registered())if((task.eval&&EVAL_DENY.test(name))||(task.proactive&&PREPARE_DENY.test(name)))if(!known.includes(name)&&tools.get?.(name,agent))known.push(name);
    const deny=[...new Set([...hiddenTools(task,known),...known.filter(name=>(task.eval&&EVAL_DENY.test(name))||(task.proactive&&PREPARE_DENY.test(name)))])];
    this.stablePrompt(agent,task);
    try{if(deny.length)agent.ctx.tools.restrict({deny});this.applied.set(agent,deny);task.hiddenTools=deny.length;return deny;}
    catch(error){this.applied.set(agent,[]);this.log?.warn?.('Work tool scope: '+error.message);return null;}
  }
  /**
   * The preset persona ends the system prompt with "Your working directory is <task dir>". Qwen's
   * template renders tool schemas after the system text, so that one per-task line made every task
   * start re-read ~11K tokens instead of reusing the cached prefix. Work already gives the agent its
   * workspace in the task instructions, so its sessions use an empty suffix (agent-scoped shadow).
   */
  stablePrompt(agent,task){
    const prompt=agent.ctx?.systemPrompt;if(!prompt?.section)return false;
    try{
      prompt.section({name:'deployment:persona-suffix',order:prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),text:''});
      // Always-on memory (habits + facts about the user) sits in the system prompt. It is identical for every
      // task until memory changes, so it does not cost the cached prefix; per-task recall stays in the task text.
      const core=this.coreMemory(task);if(core)prompt.section({name:'work:memory',order:prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')+50,text:core,interpolate:false});
      // Tested working notes from the improvement loop; an eval task sees the candidate it is testing.
      const notes=this.policyNotes(task);if(notes)prompt.section({name:'work:policy',order:prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')+60,text:notes,interpolate:false});
      task.stablePrompt=true;return true;
    }
    catch(error){this.log?.warn?.('Work stable prompt: '+error.message);return false;}
  }
  registered(){try{return [...(this.ctx.tools.view?.().visible?.keys()||[])];}catch{return [];}}
}
