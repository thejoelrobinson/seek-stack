// The night shift: after the nightly reflection, while nobody is using Seek, run the task tests,
// learn skills from yesterday's work, try one or two tested improvements, and prepare drafts for
// what is coming up. Any task of the user's interrupts it at once; it resumes later in the window.
// Daytime: scan for heads-up cards and send the morning digest.
const STEPS=['tests','skills','improve','prepare'];
const DAY=86400000;
export const NIGHT_DEFAULTS={enabled:true,tests:true,skills:true,improve:true,prepare:true,until:'07:30',digest:'08:00'};

export class NightShift {
  constructor({engine,dreaming,growth,runner,improver,proactive,notify=()=>{},log=console,isResourceBusy=()=>false}){
    Object.assign(this,{engine,dreaming,growth,runner,improver,proactive,notify,log,isResourceBusy});
    this.flight=null;this.controller=null;this.step=null;this.stopped=false;this.lastScan=0;
  }
  settings(){return {...NIGHT_DEFAULTS,...(this.growth.get('nightshift')||{})};}
  configure(body){
    const next={...this.settings()};
    for(const k of ['enabled',...STEPS])if(typeof body[k]==='boolean')next[k]=body[k];
    for(const k of ['until','digest'])if(body[k]!==undefined){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(body[k]))throw new Error('Use a time like 07:30.');next[k]=body[k];}
    this.growth.set('nightshift',next);return this.status();
  }
  state(){const day=this.dreaming.calendar().day,s=this.growth.get('shift-state')||{};return s.day===day?s:{day,steps:{}};}
  mark(step,status,detail=null){const s=this.state();s.steps[step]={status,at:Date.now()};this.growth.set('shift-state',s);this.growth.log(s.day,step,status,detail);}
  /** The user's own work (not tests or drafts) is running, queued, or holding the browser. */
  userBusy(){return this.engine.store.tasks.some(t=>!t.eval&&!t.proactive&&(['running','queued'].includes(t.status)||(t.status==='waiting'&&(t.usesBrowser||t.handoff||t.approval))));}
  idle(){return !this.userBusy()&&!this.dreaming.flight&&!this.isResourceBusy();}
  inWindow(){const {time}=this.dreaming.calendar(),start=this.dreaming.data.settings.time,until=this.settings().until;return start<=until?time>=start&&time<until:time>=start||time<until;}
  reflectionDone(){const d=this.dreaming.data,{day,time}=this.dreaming.calendar();return !d.settings.enabled||d.lastScheduledDay===day||time>='05:00';}
  tick(now=Date.now()){
    if(this.stopped)return;
    if(now-this.lastScan>60000){this.lastScan=now;try{if(this.proactive.scan(now))void this.engine.save();}catch(e){this.log.warn?.('Heads up scan: '+e.message);}this.morningDigest(now);}
    if(this.flight){if(this.userBusy())this.controller?.abort(new Error('Paused for your work.'));return;}
    const s=this.settings();if(!s.enabled||!this.inWindow()||!this.reflectionDone()||!this.idle())return;
    const state=this.state(),next=STEPS.find(step=>s[step]&&!['done','skipped'].includes(state.steps[step]?.status)&&!(state.steps[step]?.status==='failed'&&state.steps[step].tries>=2));
    if(next)this.start(next);
  }
  morningDigest(now){
    const {day,time}=this.dreaming.calendar(now),s=this.settings();
    if(time<s.digest||time>'11:00'||this.growth.get('digest-day')===day||this.engine.store.settings.notifications===false)return;
    this.growth.set('digest-day',day);const d=this.proactive.digest(now);if(d)this.notify(d);
  }
  start(step,{manual=false,caseIds=null,attempts=1}={}){
    if(this.flight)throw new Error('The night shift is already working.');
    if(step!=='all'&&!STEPS.includes(step))throw new Error('Unknown step.');
    if(manual&&!this.idle())throw new Error('Seek is busy with your work. Try again when it is idle.');
    this.controller=new AbortController();this.step=step;this.manual=manual;this.spot=Array.isArray(caseIds)&&caseIds.length?{caseIds:caseIds.slice(0,19),attempts:Math.min(3,Math.max(1,Number(attempts)||1))}:null;
    // A spot check is journaled under its own key, so tonight's real test step still runs.
    const signal=this.controller.signal,key=this.spot?'spot':step;this.mark(key,'running');
    this.flight=this.run(step,signal).then(detail=>this.mark(key,'done',detail)).catch(e=>{
      const s=this.state(),tries=(s.steps[key]?.tries||0)+1;
      const status=signal.aborted||/preempted|aborted|paused/i.test(e.message)?'interrupted':'failed';
      s.steps[key]={status,at:Date.now(),tries:status==='failed'?tries:s.steps[key]?.tries||0};this.growth.set('shift-state',s);this.growth.log(s.day,key,status,{error:String(e.message||e).slice(0,300)});
      if(status==='failed')this.log.warn?.(`Night shift ${step}: ${e.message}`);
    }).finally(()=>{this.flight=null;this.controller=null;this.step=null;});
    return this.status();
  }
  async run(step,signal){
    // The whole shift on demand: each enabled step in order, each recorded in the journal.
    if(step==='all'){const s=this.settings(),out={};for(const k of STEPS.filter(k=>s[k])){signal.throwIfAborted();this.step=k;this.mark(k,'running');out[k]=await this.run(k,signal);this.mark(k,'done',out[k]);}return {steps:Object.keys(out)};}
    if(step==='tests'){
      // A spot check of a few tests never becomes the baseline improvements are judged against.
      if(this.spot){const run=await this.runner.run({reason:'spot',caseIds:this.spot.caseIds,attempts:this.spot.attempts,signal});return {passed:run.passed,total:run.total,spot:true};}
      const previous=this.growth.lastBaseline();
      const run=await this.runner.run({reason:this.manual?'manual':'nightly',signal});
      if(run.status!=='complete')throw new Error(run.status==='interrupted'?'Paused for your work.':'The test run did not finish.');
      const reverted=this.improver.rollbackCheck(previous,this.growth.lastBaseline());
      return {passed:run.passed,total:run.total,reverted:reverted.length};
    }
    if(step==='skills'){
      const baseline=this.growth.lastBaseline(),made=[];
      // Skills left mid-test (a restart, an interruption) are tested first.
      for(const k of this.growth.skills().filter(k=>k.status==='testing')){signal.throwIfAborted();const tested=await this.improver.testSkill(k,baseline,{signal});made.push({name:tested.name,status:tested.status});}
      for(const t of this.improver.distillCandidates().slice(0,3)){
        signal.throwIfAborted();
        let skill=await this.improver.distill(t,{signal});await this.engine.save();
        if(skill?.status==='testing')skill=await this.improver.testSkill(skill,baseline,{signal});
        if(skill)made.push({name:skill.name,status:skill.status});
      }
      return {skills:made};
    }
    if(step==='improve'){
      const baseline=this.growth.lastBaseline(),since=this.growth.get('improve-since')||Date.now()-2*DAY;
      const done=await this.improver.improve({baseline,since,limit:2,signal});
      this.growth.set('improve-since',Date.now());
      return {changes:done.map(i=>({title:i.title,status:i.status}))};
    }
    if(step==='prepare'){
      const prepared=[];
      for(const item of this.proactive.prepareCandidates().slice(0,2)){signal.throwIfAborted();const t=await this.proactive.prepare(item,{signal});prepared.push({title:item.title,status:t.status});}
      return {prepared};
    }
  }
  stop(){this.stopped=true;this.controller?.abort(new Error('Seek is shutting down.'));}
  status(){
    const baseline=this.growth.lastBaseline(),runs=this.growth.runs({limit:30});
    return {settings:this.settings(),state:this.state(),running:this.step,journal:this.growth.journal(30),
      baseline:baseline?{id:baseline.id,startedAt:baseline.startedAt,passed:baseline.passed,total:baseline.total,results:baseline.results}:null,
      history:runs.filter(r=>r.reason==='nightly'||r.reason==='manual'||r.reason==='baseline').filter(r=>!r.overlay&&r.status==='complete').slice(0,14).map(r=>{const res=this.growth.results(r.id);return {id:r.id,at:r.startedAt,passed:r.passed,total:r.total,steps:res.reduce((n,x)=>n+(x.steps||0),0),seconds:Math.round(res.reduce((n,x)=>n+(x.seconds||0),0))};}),
      trials:runs.filter(r=>r.overlay).slice(0,10),
      live:this.runner.current?{...this.runner.current,run:this.growth.run(this.runner.current.runId),results:this.growth.results(this.runner.current.runId)}:null};
  }
}
