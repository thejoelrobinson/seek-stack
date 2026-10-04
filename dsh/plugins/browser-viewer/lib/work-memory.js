// Durable memory store: lessons (habits, preferences, facts), the people/places they are about
// (dossiers), and an append-only history of every change and every use. SQLite keeps it
// transactional and searchable; callers work on plain objects and write them back with sync().
import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

const LESSON_COLUMNS=['id','key','kind','entity','text','scope','project','person','status','confidence','origin','sources','replaces','revisions','created_at','updated_at','confirmed_at','expires_at','last_used_at','use_count','event_date','event_label'];
const JSON_FIELDS=new Set(['sources','replaces','revisions']);
const camel=c=>c.replace(/_(\w)/g,(_,x)=>x.toUpperCase());

// Words that mean "this person" in a request; dossiers are recalled when any appears.
export const RELATION_ALIASES={
  wife:['wife','spouse','partner','anniversary','date night'],husband:['husband','spouse','partner','anniversary','date night'],
  partner:['partner','spouse','girlfriend','boyfriend','date night'],girlfriend:['girlfriend','partner','date night'],boyfriend:['boyfriend','partner','date night'],
  son:['son','kid','kids','children','child'],daughter:['daughter','kid','kids','children','child'],kids:['kids','children','child','son','daughter'],
  mom:['mom','mother','mum','parents'],dad:['dad','father','parents'],parents:['parents','mom','dad'],
  'co-worker':['co-worker','coworker','colleague','work friend'],boss:['boss','manager'],dog:['dog','puppy','pet'],cat:['cat','kitten','pet']
};
export const entityId=about=>{
  const s=String(about||'').toLowerCase().replace(/^(the user'?s?|my|his|her|their)\s+/,'').trim();
  if(!s||/^(self|user|me|owner|the user|joel|i)$/.test(s))return 'self';
  return s.replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,40)||'self';
};

export class MemoryStore {
  constructor(file){this.file=file;this.written=new Map();}
  async init(){
    await mkdir(dirname(this.file),{recursive:true});
    this.db=new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,key TEXT,kind TEXT NOT NULL,entity TEXT,text TEXT NOT NULL,scope TEXT,project TEXT,person TEXT,status TEXT NOT NULL,confidence REAL,origin TEXT,sources TEXT NOT NULL DEFAULT '[]',replaces TEXT NOT NULL DEFAULT '[]',revisions TEXT NOT NULL DEFAULT '[]',created_at INTEGER,updated_at INTEGER,confirmed_at INTEGER,expires_at INTEGER,last_used_at INTEGER,use_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,aliases TEXT NOT NULL DEFAULT '[]',created_at INTEGER,updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,lesson_id TEXT,action TEXT NOT NULL,task_id TEXT,text TEXT,detail TEXT);
      CREATE INDEX IF NOT EXISTS events_lesson ON events(lesson_id,seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS lesson_search USING fts5(id UNINDEXED,text,scope,entity,tokenize='porter unicode61');`);
    // Yearly dates (birthdays, anniversaries) arrived after the first schema.
    const columns=new Set(this.db.prepare('PRAGMA table_info(lessons)').all().map(c=>c.name));
    for(const c of ['event_date','event_label'])if(!columns.has(c))this.db.exec(`ALTER TABLE lessons ADD COLUMN ${c} TEXT`);
    return this;
  }
  close(){try{this.db?.close();}catch{}}
  count(){return this.db.prepare('SELECT count(*) n FROM lessons').get().n;}
  lessons(){
    return this.db.prepare('SELECT * FROM lessons ORDER BY created_at,id').all().map(row=>{
      const lesson={};for(const c of LESSON_COLUMNS){const v=row[c];lesson[camel(c)]=JSON_FIELDS.has(c)?JSON.parse(v||'[]'):v??null;}
      lesson.useCount??=0;this.written.set(lesson.id,JSON.stringify(lesson));return lesson;
    });
  }
  /** Writes changed lessons and removes deleted ones in one transaction; keeps the search index in step. */
  sync(lessons){
    const keep=new Set(lessons.map(l=>l.id)),put=this.db.prepare(`INSERT INTO lessons(${LESSON_COLUMNS.join(',')}) VALUES(${LESSON_COLUMNS.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${LESSON_COLUMNS.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`);
    const unindex=this.db.prepare('DELETE FROM lesson_search WHERE id=?'),index=this.db.prepare('INSERT INTO lesson_search(id,text,scope,entity) VALUES(?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const id of this.db.prepare('SELECT id FROM lessons').all().map(r=>r.id))if(!keep.has(id)){this.db.prepare('DELETE FROM lessons WHERE id=?').run(id);unindex.run(id);this.written.delete(id);}
      for(const l of lessons){
        const snapshot=JSON.stringify(l);if(this.written.get(l.id)===snapshot)continue;
        const defaults={kind:'preference',status:'review',use_count:0};
        put.run(...LESSON_COLUMNS.map(c=>{const v=l[camel(c)];return JSON_FIELDS.has(c)?JSON.stringify(v||[]):v??defaults[c]??null;}));
        unindex.run(l.id);index.run(l.id,l.text,l.scope||'',l.entity||'');this.written.set(l.id,snapshot);
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');for(const l of lessons)this.written.delete(l.id);throw e;}
  }
  /** Full-text match ids, best first (porter stemming: "massage" finds "massages"). */
  search(query,limit=20){
    const terms=String(query||'').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[];if(!terms.length)return [];
    try{return this.db.prepare('SELECT id FROM lesson_search WHERE lesson_search MATCH ? ORDER BY rank LIMIT ?').all([...new Set(terms)].slice(0,24).map(t=>`"${t}"`).join(' OR '),limit).map(r=>r.id);}
    catch{return [];}
  }
  entities(){return this.db.prepare('SELECT * FROM entities ORDER BY created_at').all().map(e=>({id:e.id,name:e.name,kind:e.kind,aliases:JSON.parse(e.aliases||'[]'),createdAt:e.created_at,updatedAt:e.updated_at}));}
  putEntity(e){this.db.prepare('INSERT INTO entities(id,name,kind,aliases,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,aliases=excluded.aliases,updated_at=excluded.updated_at').run(e.id,e.name,e.kind,JSON.stringify(e.aliases||[]),e.createdAt||Date.now(),Date.now());}
  event({lessonId=null,action,taskId=null,text=null,detail=null}){this.db.prepare('INSERT INTO events(at,lesson_id,action,task_id,text,detail) VALUES(?,?,?,?,?,?)').run(Date.now(),lessonId,action,taskId,text?String(text).slice(0,400):null,detail?JSON.stringify(detail):null);}
  events({lessonId,limit=60}={}){
    const rows=lessonId?this.db.prepare('SELECT * FROM events WHERE lesson_id=? ORDER BY seq DESC LIMIT ?').all(lessonId,limit):this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit);
    return rows.map(r=>({seq:r.seq,at:r.at,lessonId:r.lesson_id,action:r.action,taskId:r.task_id,text:r.text,detail:r.detail?JSON.parse(r.detail):null}));
  }
  /** Forgetting removes the remembered words from history as well. */
  scrub(lessonId){this.db.prepare('UPDATE events SET text=NULL,detail=NULL WHERE lesson_id=?').run(lessonId);}
  usedIn(lessonId,taskId){return !!this.db.prepare("SELECT 1 FROM events WHERE lesson_id=? AND task_id=? AND action='used' LIMIT 1").get(lessonId,taskId);}
}
