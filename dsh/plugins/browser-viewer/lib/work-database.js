import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {WorkStorage,validWorkStore} from './work-storage.js';

// Transactions are authoritative. work.json remains a periodic portable snapshot.
export class WorkDatabase {
  constructor(root,{snapshotEveryMs=60000,now=()=>Date.now()}={}){this.root=root;this.path=join(root,'work.sqlite');this.now=now;this.snapshotEveryMs=snapshotEveryMs;this.dirty=new Set();this.globalDirty=true;this.lastSnapshot=0;this.revision=0;this.recovery=null;this.db=null;this.cache=new WeakMap();this.proxies=new WeakSet();}
  async load(fallback){
    await mkdir(this.root,{recursive:true});this.db=new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task_id,ordinal)); CREATE INDEX IF NOT EXISTS messages_owner ON messages(task_id,ordinal); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(task_id UNINDEXED,title,content,tokenize="unicode61");');
    const schema=this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema');
    if(schema&&schema.value!=='1')throw new Error('Unsupported transactional Work schema; original database preserved.');
    let store;
    if(schema){const globals=JSON.parse(this.db.prepare('SELECT value FROM meta WHERE key=?').get('globals').value);store={...globals,tasks:this.db.prepare('SELECT * FROM tasks ORDER BY ordinal').all().map(row=>({...JSON.parse(row.data),messages:this.db.prepare('SELECT data FROM messages WHERE task_id=? ORDER BY ordinal').all(row.id).map(m=>JSON.parse(m.data))}))};if(!validWorkStore(store))throw new Error('Invalid transactional Work data; database preserved.');this.revision=Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('revision')?.value)||0;}
    else{const legacy=new WorkStorage(this.root);store=await legacy.load(fallback);this.recovery=legacy.recovery;await writeFile(join(this.root,'work-migration-original.json'),JSON.stringify(store,null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});}
    this.store=this.trackStore(store);if(!schema)await this.saveStore(this.store,{snapshot:true});return this.store;
  }
  mark(task){if(task?.id){task.revision=(task.revision||0)+1;this.dirty.add(task.id);}else this.globalDirty=true;}
  track(value,changed){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;if(this.cache.has(value))return this.cache.get(value);
    // A tracked value stored back (e.g. list=list.filter(...)) is already a proxy: wrapping it again adds a
    // layer on every reassignment, and hundreds of layers make every read and every API response crawl.
    if(this.proxies.has(value))return value;const proxy=new Proxy(value,{get:(target,key)=>{const descriptor=Reflect.getOwnPropertyDescriptor(target,key);if(descriptor?.configurable===false&&descriptor.writable===false)return descriptor.value;return this.track(Reflect.get(target,key),changed);},set:(target,key,next)=>{if(Reflect.get(target,key)!==next){if(!Reflect.set(target,key,next))return false;changed();}return true;},deleteProperty:(target,key)=>{if(Reflect.has(target,key)){if(!Reflect.deleteProperty(target,key))return false;changed();}return true;}});this.cache.set(value,proxy);this.proxies.add(proxy);return proxy;}
  trackTask(task){if(!task)return task;if(this.cache.has(task))return this.cache.get(task);Object.defineProperty(task,'__trackedRevision',{value:true,enumerable:false});this.dirty.add(task.id);return this.track(task,()=>this.mark(task));}
  trackStore(store){const self=this;for(const task of store.tasks)this.trackTask(task);store.tasks=new Proxy(store.tasks,{get(target,key){const value=Reflect.get(target,key);return /^\d+$/.test(String(key))?self.trackTask(value):value;},set(target,key,value){Reflect.set(target,key,value);if(/^\d+$/.test(String(key)))self.trackTask(value);self.globalDirty=true;return true;}});return new Proxy(store,{get(target,key){const value=Reflect.get(target,key);return key==='tasks'?value:self.track(value,()=>{self.globalDirty=true;});},set(target,key,value){Reflect.set(target,key,value);self.globalDirty=true;return true;}});}
  async saveStore(store,{snapshot=false}={}){
    const ids=new Set(store.tasks.map(t=>t.id)),removed=this.db.prepare('SELECT id FROM tasks').all().filter(t=>!ids.has(t.id));
    const changed=store.tasks.filter(t=>this.dirty.has(t.id));if(!changed.length&&!this.globalDirty&&!removed.length){if(snapshot)await this.snapshot(store);return String(this.revision);}
    const putMeta=this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.db.exec('BEGIN IMMEDIATE');try{
      for(const row of removed){this.db.prepare('DELETE FROM search WHERE task_id=?').run(row.id);this.db.prepare('DELETE FROM tasks WHERE id=?').run(row.id);}
      const putTask=this.db.prepare('INSERT INTO tasks(id,ordinal,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,data=excluded.data');
      const putMessage=this.db.prepare('INSERT INTO messages(task_id,ordinal,data) VALUES(?,?,?) ON CONFLICT(task_id,ordinal) DO UPDATE SET data=excluded.data WHERE data<>excluded.data');
      for(const task of changed){const {messages,...metadata}=task;putTask.run(task.id,store.tasks.findIndex(t=>t.id===task.id),JSON.stringify(metadata));const previousCount=Number(this.db.prepare('SELECT count(*) n FROM messages WHERE task_id=?').get(task.id).n);for(let i=0;i<messages.length;i++)putMessage.run(task.id,i,JSON.stringify(messages[i]));if(messages.length<previousCount)this.db.prepare('DELETE FROM messages WHERE task_id=? AND ordinal>=?').run(task.id,messages.length);this.db.prepare('DELETE FROM search WHERE task_id=?').run(task.id);this.db.prepare('INSERT INTO search(task_id,title,content) VALUES(?,?,?)').run(task.id,task.title||'',messages.map(m=>m.text||'').join('\n'));}
      const {tasks,...globals}=store;putMeta.run('globals',JSON.stringify(globals));putMeta.run('schema','1');putMeta.run('revision',String(++this.revision));this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    for(const t of changed)this.dirty.delete(t.id);this.globalDirty=false;
    if(snapshot||this.now()-this.lastSnapshot>=this.snapshotEveryMs)await this.snapshot(store);
    return String(this.revision);
  }
  async snapshot(store=this.store){const target=join(this.root,'work.json'),tmp=target+'.tmp',data=JSON.stringify(store,null,2);let old;try{old=await readFile(target);}catch(e){if(e.code!=='ENOENT')throw e;}if(old){await writeFile(target+'.bak.tmp',old);await rename(target+'.bak.tmp',target+'.bak');}await writeFile(tmp,data);await rename(tmp,target);this.lastSnapshot=this.now();return target;}
  search(query,limit=50){const terms=String(query).trim().match(/[\p{L}\p{N}_]+/gu)||[];if(!terms.length)return [];const q=terms.slice(0,12).map(t=>'"'+t.replace(/"/g,'""')+'"*').join(' AND ');return this.db.prepare('SELECT task_id id,title,snippet(search,2,\'\',\'\',\' … \',24) excerpt FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?').all(q,Math.min(100,limit));}
  async close(){if(this.store)await this.snapshot();this.db?.close();this.db=null;}
}
