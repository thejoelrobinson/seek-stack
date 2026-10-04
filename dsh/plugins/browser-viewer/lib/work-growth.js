// What Seek learns about *doing work* (as opposed to memory, which is about the user): task-test
// results, skills distilled from finished tasks, tested working notes, the improvement log and the
// night-shift journal. Everything here is data — the self-improvement loop can change notes and
// skills, never code — and every change carries the evidence that justified it.
import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const json=(v,fallback)=>{try{return v==null?fallback:JSON.parse(v);}catch{return fallback;}};
const normalize=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const stem=w=>w.length>4?w.replace(/(ies|es|s|ing|ed)$/,''):w;
const words=s=>new Set(normalize(s).split(' ').filter(w=>w.length>2).map(stem));
export const SKILL_STATUSES=['testing','trial','active','retired'];
export const MAX_NOTES=12;
// Notes and skills steer the agent; they must never carry permissions, secrets or code.
export const UNSAFE=/ignore.{0,30}(instruction|rule)|bypass|disable.{0,30}(approval|safety|security)|always.{0,15}approv|without.{0,15}(permission|approval|asking)|system prompt|\b(password|credential|api key|secret|token|card number|cvv|cvc)\b|spend.{0,20}(limit|without)|auto-?approve/i;

export class GrowthStore {
  constructor(root){this.file=join(root,'growth.sqlite');}
  async init(){
    await mkdir(join(this.file,'..'),{recursive:true});
    this.db=new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS eval_runs(id TEXT PRIMARY KEY,started_at INTEGER,finished_at INTEGER,reason TEXT,label TEXT,overlay TEXT,status TEXT,passed INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,summary TEXT);
      CREATE TABLE IF NOT EXISTS eval_results(run_id TEXT NOT NULL,case_id TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 1,passed INTEGER NOT NULL,status TEXT,seconds REAL,steps INTEGER,task_id TEXT,detail TEXT,at INTEGER,PRIMARY KEY(run_id,case_id,attempt));
      CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,category TEXT,triggers TEXT NOT NULL DEFAULT '[]',body TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,sources TEXT NOT NULL DEFAULT '[]',uses INTEGER NOT NULL DEFAULT 0,successes INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_used_at INTEGER,tests TEXT NOT NULL DEFAULT '[]',history TEXT NOT NULL DEFAULT '[]',created_at INTEGER,updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,origin TEXT,improvement_id TEXT,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS improvements(id TEXT PRIMARY KEY,at INTEGER,kind TEXT,title TEXT,rationale TEXT,change TEXT,status TEXT,signal TEXT,baseline TEXT,candidate TEXT,decided_at INTEGER,detail TEXT);
      CREATE TABLE IF NOT EXISTS shift(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,day TEXT,step TEXT,status TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT);`);
    // A restart ends any run that was in progress.
    this.db.prepare("UPDATE eval_runs SET status='interrupted',finished_at=? WHERE status='running'").run(Date.now());
    return this;
  }
  close(){try{this.db?.close();}catch{}}
  get(key,fallback=null){return json(this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value,fallback);}
  set(key,value){this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}

  // ── task tests ────────────────────────────────────────────────────────────
  startRun({reason,label='',overlay=null,total=0}){const id=randomUUID();this.db.prepare('INSERT INTO eval_runs(id,started_at,reason,label,overlay,status,total) VALUES(?,?,?,?,?,?,?)').run(id,Date.now(),reason,label,overlay?JSON.stringify(overlay):null,'running',total);return id;}
  addResult(runId,r){this.db.prepare('INSERT OR REPLACE INTO eval_results(run_id,case_id,attempt,passed,status,seconds,steps,task_id,detail,at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId,r.caseId,r.attempt||1,r.passed?1:0,r.status||null,r.seconds??null,r.steps??null,r.taskId||null,JSON.stringify(r.detail||{}),Date.now());}
  finishRun(runId,{status,summary}){
    const rows=this.results(runId),latest=new Map();for(const r of rows){const prior=latest.get(r.caseId);if(!prior||r.attempt>prior.attempt)latest.set(r.caseId,r);}
    const passed=[...latest.values()].filter(r=>r.passed).length;
    this.db.prepare('UPDATE eval_runs SET finished_at=?,status=?,passed=?,total=?,summary=? WHERE id=?').run(Date.now(),status,passed,latest.size,summary||null,runId);
    return {passed,total:latest.size};
  }
  run(id){const r=this.db.prepare('SELECT * FROM eval_runs WHERE id=?').get(id);return r?this.runView(r):null;}
  runView(r){return {id:r.id,startedAt:r.started_at,finishedAt:r.finished_at,reason:r.reason,label:r.label,overlay:json(r.overlay,null),status:r.status,passed:r.passed,total:r.total,summary:r.summary};}
  runs({limit=20,reason}={}){return (reason?this.db.prepare('SELECT * FROM eval_runs WHERE reason=? ORDER BY started_at DESC LIMIT ?').all(reason,limit):this.db.prepare('SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT ?').all(limit)).map(r=>this.runView(r));}
  results(runId){return this.db.prepare('SELECT * FROM eval_results WHERE run_id=? ORDER BY at').all(runId).map(r=>({runId:r.run_id,caseId:r.case_id,attempt:r.attempt,passed:!!r.passed,status:r.status,seconds:r.seconds,steps:r.steps,taskId:r.task_id,detail:json(r.detail,{}),at:r.at}));}
  /** Latest complete baseline (live policy, all cases) — what candidates are compared against. */
  lastBaseline(){const r=this.db.prepare("SELECT * FROM eval_runs WHERE reason IN ('nightly','baseline','manual') AND overlay IS NULL AND status='complete' ORDER BY started_at DESC LIMIT 1").get();return r?{...this.runView(r),results:this.results(r.id)}:null;}
  caseHistory(caseId,limit=14){return this.db.prepare("SELECT r.case_id,r.passed,r.seconds,r.steps,r.at,r.task_id,r.detail FROM eval_results r JOIN eval_runs u ON u.id=r.run_id WHERE r.case_id=? AND u.overlay IS NULL ORDER BY r.at DESC LIMIT ?").all(caseId,limit).map(r=>({passed:!!r.passed,seconds:r.seconds,steps:r.steps,at:r.at,taskId:r.task_id,detail:json(r.detail,{})}));}

  // ── skills ────────────────────────────────────────────────────────────────
  skillView(r){return r?{id:r.id,name:r.name,description:r.description,category:r.category,triggers:json(r.triggers,[]),body:json(r.body,{}),status:r.status,version:r.version,sources:json(r.sources,[]),uses:r.uses,successes:r.successes,failures:r.failures,lastUsedAt:r.last_used_at,tests:json(r.tests,[]),history:json(r.history,[]),createdAt:r.created_at,updatedAt:r.updated_at}:null;}
  skills({all=false}={}){return this.db.prepare(all?'SELECT * FROM skills ORDER BY updated_at DESC':"SELECT * FROM skills WHERE status<>'retired' ORDER BY updated_at DESC").all().map(r=>this.skillView(r));}
  skill(id){return this.skillView(this.db.prepare('SELECT * FROM skills WHERE id=?').get(id));}
  putSkill(s){
    const now=Date.now();
    this.db.prepare(`INSERT INTO skills(id,name,description,category,triggers,body,status,version,sources,uses,successes,failures,last_used_at,tests,history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,triggers=excluded.triggers,body=excluded.body,status=excluded.status,version=excluded.version,sources=excluded.sources,uses=excluded.uses,successes=excluded.successes,failures=excluded.failures,last_used_at=excluded.last_used_at,tests=excluded.tests,history=excluded.history,updated_at=excluded.updated_at`)
      .run(s.id,s.name,s.description||'',s.category||'other',JSON.stringify(s.triggers||[]),JSON.stringify(s.body||{}),s.status,s.version||1,JSON.stringify(s.sources||[]),s.uses||0,s.successes||0,s.failures||0,s.lastUsedAt||null,JSON.stringify(s.tests||[]),JSON.stringify((s.history||[]).slice(-20)),s.createdAt||now,now);
    return this.skill(s.id);
  }

  // ── working notes ─────────────────────────────────────────────────────────
  notes({status='active'}={}){return this.db.prepare(status==='all'?'SELECT * FROM notes ORDER BY created_at':'SELECT * FROM notes WHERE status=? ORDER BY created_at').all(...(status==='all'?[]:[status])).map(r=>({id:r.id,text:r.text,status:r.status,origin:r.origin,improvementId:r.improvement_id,createdAt:r.created_at,updatedAt:r.updated_at}));}
  addNote({text,origin='improvement',improvementId=null,status='active'}){const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO notes(id,text,status,origin,improvement_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,text,status,origin,improvementId,now,now);return id;}
  setNote(id,status){this.db.prepare('UPDATE notes SET status=?,updated_at=? WHERE id=?').run(status,Date.now(),id);}

  // ── improvements ──────────────────────────────────────────────────────────
  improvementView(r){return r?{id:r.id,at:r.at,kind:r.kind,title:r.title,rationale:r.rationale,change:json(r.change,{}),status:r.status,signal:json(r.signal,{}),baseline:json(r.baseline,null),candidate:json(r.candidate,null),decidedAt:r.decided_at,detail:json(r.detail,{})}:null;}
  improvements(limit=40){return this.db.prepare('SELECT * FROM improvements ORDER BY at DESC LIMIT ?').all(limit).map(r=>this.improvementView(r));}
  improvement(id){return this.improvementView(this.db.prepare('SELECT * FROM improvements WHERE id=?').get(id));}
  putImprovement(i){
    const id=i.id||randomUUID();
    this.db.prepare(`INSERT INTO improvements(id,at,kind,title,rationale,change,status,signal,baseline,candidate,decided_at,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,rationale=excluded.rationale,change=excluded.change,status=excluded.status,signal=excluded.signal,baseline=excluded.baseline,candidate=excluded.candidate,decided_at=excluded.decided_at,detail=excluded.detail`)
      .run(id,i.at||Date.now(),i.kind,i.title||'',i.rationale||'',JSON.stringify(i.change||{}),i.status,JSON.stringify(i.signal||{}),i.baseline?JSON.stringify(i.baseline):null,i.candidate?JSON.stringify(i.candidate):null,i.decidedAt||null,JSON.stringify(i.detail||{}));
    return this.improvement(id);
  }

  // ── night shift journal ───────────────────────────────────────────────────
  log(day,step,status,detail=null){this.db.prepare('INSERT INTO shift(at,day,step,status,detail) VALUES(?,?,?,?,?)').run(Date.now(),day,step,status,detail?JSON.stringify(detail):null);}
  journal(limit=40){return this.db.prepare('SELECT * FROM shift ORDER BY seq DESC LIMIT ?').all(limit).map(r=>({at:r.at,day:r.day,step:r.step,status:r.status,detail:json(r.detail,null)}));}
}

/**
 * The tested working policy: notes (in the system prompt of every Work session) and skills
 * (added to the instructions of tasks they match). An overlay swaps in a candidate policy for one
 * eval task, which is how changes are tested without anyone else seeing them.
 */
export class Policy {
  constructor(store){this.store=store;}
  notes(overlay=null){return overlay?.notes?overlay.notes.slice(0,MAX_NOTES):this.store.notes().map(n=>n.text);}
  notesText(overlay=null){
    const notes=this.notes(overlay);if(!notes.length)return '';
    return 'Working notes from tested experience (each one improved real results; current requests and verified data come first):\n'+notes.map(n=>'- '+n).join('\n');
  }
  skillPool(overlay=null){
    const add=new Set(overlay?.addSkills||[]),drop=new Set(overlay?.dropSkills||[]);
    return this.store.skills({all:true}).filter(s=>!drop.has(s.id)&&(add.has(s.id)||(!overlay?.onlySkills&&['trial','active'].includes(s.status))));
  }
  /** Skills whose triggers match the request: at most two, best first. */
  match(text,overlay=null){
    const t=' '+normalize(text)+' ',terms=words(text);
    return this.skillPool(overlay).map(s=>{
      const phrases=(s.triggers||[]).map(normalize).filter(Boolean);
      // A trigger matches as a phrase, or when all of its key words appear in any order
      // ("add recipe to cart" matches "look at this recipe and add it all to my cart").
      const exact=phrases.filter(p=>{if(t.includes(' '+p+' ')||t.includes(' '+p+'s '))return true;const keys=[...words(p)];return keys.length>=2&&keys.every(k=>terms.has(k));}).length;
      const shared=[...words(s.name+' '+s.description)].filter(w=>terms.has(w)).length;
      return {s,score:exact?exact*2+Math.min(shared,3):0};
    }).filter(x=>x.score>=3).sort((a,b)=>b.score-a.score||(b.s.status==='active')-(a.s.status==='active')).slice(0,2).map(x=>x.s);
  }
  skillText(skills){
    if(!skills.length)return '';
    return skills.map(s=>{const b=s.body||{};return `\nSkill from past work — "${s.name}"${s.status==='active'?'':' (still being proven: verify as you go)'}:\nUse when: ${b.when||s.description}\n${(b.steps||[]).length?'Steps:\n'+b.steps.map((x,i)=>`${i+1}. ${x}`).join('\n')+'\n':''}${(b.pitfalls||[]).length?'Pitfalls:\n'+b.pitfalls.map(x=>'- '+x).join('\n')+'\n':''}${(b.checks||[]).length?'Before finishing, check:\n'+b.checks.map(x=>'- '+x).join('\n'):''}`.trimEnd();}).join('\n');
  }
}
