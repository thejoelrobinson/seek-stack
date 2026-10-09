// CPU/filesystem-only, read-only Work preservation fingerprint. No contents are printed.
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=await realpath(process.argv[2]);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside=path=>{const rel=relative(root,path);if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new Error('Work fingerprint path escaped root.');return path;};
async function hash(path){const out=createHash('sha256');for await(const part of createReadStream(path))out.update(part);return out.digest('hex');}
let store;
try{await stat(join(root,'work.sqlite'));const db=new DatabaseSync(join(root,'work.sqlite'),{readOnly:true});try{
  if(db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value!=='1')throw new Error('Unknown Work schema.');
  const globals=JSON.parse(db.prepare("SELECT value FROM meta WHERE key='globals'").get().value);
  store={...globals,tasks:db.prepare('SELECT id,data FROM tasks ORDER BY ordinal').all().map(row=>({...JSON.parse(row.data),messages:db.prepare('SELECT data FROM messages WHERE task_id=? ORDER BY ordinal').all(row.id).map(m=>JSON.parse(m.data))}))};
}finally{db.close();}}catch(error){if(error.code!=='ENOENT')throw error;store=JSON.parse(await readFile(join(root,'work.json'),'utf8'));}
const artifacts=[];for(const task of store.tasks||[])for(const item of task.artifacts||[]){const path=inside(await realpath(resolve(task.cwd||join(root,'tasks',task.id),item.path)));artifacts.push([task.id,item.id,item.path,(await stat(path)).size,await hash(path)]);}
let gallery={items:[]};try{gallery=JSON.parse(await readFile(join(root,'images','images.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const outputs=[];for(const file of (await readdir(join(root,'images','outputs'))).sort()){const path=inside(await realpath(join(root,'images','outputs',file))),info=await stat(path);if(!info.isFile())throw new Error('Unexpected image output entry.');outputs.push([file,info.size,await hash(path)]);}
console.log(JSON.stringify({tasks:(store.tasks||[]).length,artifacts:artifacts.length,images:(gallery.items||[]).length,outputFiles:outputs.length,workSHA256:digest(store),artifactSHA256:digest(artifacts),gallerySHA256:digest(gallery),outputSHA256:digest(outputs)}));
