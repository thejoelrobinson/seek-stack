import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
export class WorkTelemetry {
  constructor(root){this.db=new DatabaseSync(join(root,'telemetry.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,phase TEXT NOT NULL,task_id TEXT,ms REAL,status TEXT); CREATE INDEX IF NOT EXISTS samples_recent ON samples(at,kind,phase);');this.add=this.db.prepare('INSERT INTO samples(at,kind,phase,task_id,ms,status) VALUES(?,?,?,?,?,?)');}
  record({kind,phase,taskId,ms,status}){if(!this.db||!Number.isFinite(ms)||ms<0)return;this.add.run(Date.now(),String(kind).slice(0,50),String(phase).slice(0,100),taskId||null,ms,status||null);if(Math.random()<.005)this.db.prepare('DELETE FROM samples WHERE at<?').run(Date.now()-30*86400000);}
  summary(){return this.db.prepare('SELECT kind,phase,COUNT(*) count FROM samples GROUP BY kind,phase').all().map(g=>{const rows=this.db.prepare('SELECT ms,status FROM samples WHERE kind=? AND phase=? ORDER BY ms').all(g.kind,g.phase);const percentile=p=>rows[Math.max(0,Math.ceil(rows.length*p)-1)]?.ms;return {...g,p50Ms:Math.round(percentile(.5)||0),p95Ms:Math.round(percentile(.95)||0),failures:rows.filter(x=>x.status==='error').length};});}
  close(){this.db?.close();this.db=null;}
}
