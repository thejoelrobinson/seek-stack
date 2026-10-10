import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {contentHash,WorkflowError,jsonValue} from './work-capabilities.js';

export class WorkflowStore {
  constructor(root,{now=()=>Date.now()}={}){
    this.now=now;this.db=new DatabaseSync(join(root,'workflows.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflow_meta(version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_versions(id TEXT NOT NULL,version INTEGER NOT NULL,hash TEXT NOT NULL,definition TEXT NOT NULL,state TEXT NOT NULL,provenance TEXT,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,request_id TEXT NOT NULL,recipe_id TEXT NOT NULL,recipe_version INTEGER NOT NULL,input TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(task_id,request_id));
      CREATE TABLE IF NOT EXISTS workflow_steps(run_id TEXT NOT NULL,step_id TEXT NOT NULL,state TEXT NOT NULL,output TEXT,input_hash TEXT,error TEXT,PRIMARY KEY(run_id,step_id));
      CREATE TABLE IF NOT EXISTS workflow_resources(resource_key TEXT PRIMARY KEY,run_id TEXT NOT NULL,step_id TEXT NOT NULL);`);
    const meta=this.db.prepare('SELECT version FROM workflow_meta').get();if(meta&&meta.version!==1){this.db.close();throw new Error('Unsupported workflow database version.');}if(!meta)this.db.prepare('INSERT INTO workflow_meta VALUES(1)').run();
    // Reclaim only leases whose owning process has exited. Live owners retain their fence.
    for(const row of this.db.prepare("SELECT id,lease_owner FROM workflow_runs WHERE state='running' AND lease_owner IS NOT NULL").all()){
      const pid=Number(row.lease_owner.split(':')[0]);if(!Number.isInteger(pid)||pid<1)continue;
      try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')this.db.prepare('UPDATE workflow_runs SET lease_until=0 WHERE id=?').run(row.id);}
    }
  }
  put({recipe,hash},state='enabled',provenance={source:'builtin'}){
    const prior=this.definition(recipe.id,recipe.version);if(prior){if(prior.hash!==hash)throw new WorkflowError('version_conflict','A workflow version cannot be edited.');return prior;}
    this.db.prepare('INSERT INTO workflow_versions VALUES(?,?,?,?,?,?)').run(recipe.id,recipe.version,hash,JSON.stringify(recipe),state,JSON.stringify(provenance));return this.definition(recipe.id,recipe.version);
  }
  definition(id,version){const row=this.db.prepare('SELECT * FROM workflow_versions WHERE id=? AND version=?').get(id,version);return row?{...row,recipe:JSON.parse(row.definition),provenance:JSON.parse(row.provenance||'null')}:null;}
  list(){return this.db.prepare('SELECT id,version,state FROM workflow_versions ORDER BY id,version DESC').all().map(r=>this.definition(r.id,r.version));}
  setState(id,version,state){if(!['enabled','tested','disabled'].includes(state))throw new Error('Invalid workflow state.');if(!this.definition(id,version))throw new Error('Workflow not found.');this.db.prepare('UPDATE workflow_versions SET state=? WHERE id=? AND version=?').run(state,id,version);}
  create(taskId,requestId,recipe,input){
    const clean=jsonValue(input),hash=contentHash(clean),prior=this.db.prepare('SELECT id,input_hash,recipe_id,recipe_version FROM workflow_runs WHERE task_id=? AND request_id=?').get(taskId,requestId);
    if(prior){if(prior.input_hash!==hash||prior.recipe_id!==recipe.id||prior.recipe_version!==recipe.version)throw new WorkflowError('request_conflict','Run request already has different inputs.');return this.get(prior.id);}
    const id=randomUUID(),at=this.now();this.db.prepare('INSERT INTO workflow_runs(id,task_id,request_id,recipe_id,recipe_version,input,input_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,taskId,requestId,recipe.id,recipe.version,JSON.stringify(clean),hash,'ready',at,at);return this.get(id);
  }
  get(id){const r=this.db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(id);if(!r)return null;return {...r,input:JSON.parse(r.input),error:r.error?JSON.parse(r.error):null,steps:this.db.prepare('SELECT * FROM workflow_steps WHERE run_id=?').all(id).map(s=>({...s,output:s.output?JSON.parse(s.output):undefined,error:s.error?JSON.parse(s.error):null}))};}
  claim(id,owner,ttl){const at=this.now();const c=this.db.prepare("UPDATE workflow_runs SET lease_owner=?,lease_until=?,epoch=epoch+1,state='running',updated_at=? WHERE id=? AND state IN ('ready','running') AND (lease_until<=? OR lease_owner IS NULL)").run(owner,at+ttl,at,id,at);return c.changes?this.get(id):null;}
  fence(id,owner,epoch){const r=this.db.prepare('SELECT lease_owner,epoch,lease_until,state FROM workflow_runs WHERE id=?').get(id);if(!r||r.lease_owner!==owner||r.epoch!==epoch||r.lease_until<=this.now()||r.state!=='running')throw new WorkflowError('lease_lost','Workflow execution lease lost.');}
  renew(id,owner,epoch,ttl){this.fence(id,owner,epoch);this.db.prepare('UPDATE workflow_runs SET lease_until=? WHERE id=?').run(this.now()+ttl,id);}
  lock(key,runId,stepId){if(typeof key!=='string'||!key||key.length>300)throw new WorkflowError('policy_denied','Invalid external resource lock.');const prior=this.db.prepare('SELECT * FROM workflow_resources WHERE resource_key=?').get(key);if(prior&&prior.run_id!==runId)throw new WorkflowError('resource_busy','An earlier workflow owns this resource; reconcile or finish it first.');this.db.prepare('INSERT INTO workflow_resources VALUES(?,?,?) ON CONFLICT(resource_key) DO NOTHING').run(key,runId,stepId);}
  unlock(key,runId){this.db.prepare('DELETE FROM workflow_resources WHERE resource_key=? AND run_id=?').run(key,runId);}
  step(id,owner,epoch,stepId,state,{output,inputHash,error}={}){this.fence(id,owner,epoch);this.db.prepare('INSERT INTO workflow_steps VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET state=excluded.state,output=excluded.output,input_hash=excluded.input_hash,error=excluded.error').run(id,stepId,state,output===undefined?null:JSON.stringify(jsonValue(output)),inputHash||null,error?JSON.stringify(error):null);}
  batch(id,owner,epoch,steps){if(!steps.length)return;this.db.exec('BEGIN IMMEDIATE');try{for(const s of steps)this.step(id,owner,epoch,s.id,'verified',s);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  finish(id,owner,epoch,state,error=null){this.fence(id,owner,epoch);this.db.prepare('UPDATE workflow_runs SET state=?,error=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?').run(state,error?JSON.stringify(error):null,this.now(),id);return this.get(id);}
  cancel(id){this.db.prepare("UPDATE workflow_runs SET state=CASE WHEN EXISTS(SELECT 1 FROM workflow_steps WHERE run_id=? AND state='dispatched') THEN 'uncertain' ELSE 'cancelled' END,epoch=epoch+1,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND state NOT IN ('succeeded','cancelled')").run(id,this.now(),id);}
  resume(id){const r=this.get(id);if(!r||!['needs_input','failed','cancelled','uncertain'].includes(r.state))throw new Error('Workflow is not resumable.');this.db.prepare("UPDATE workflow_runs SET state='ready',error=NULL WHERE id=?").run(id);return this.get(id);}
  close(){this.db?.close();this.db=null;}
}
