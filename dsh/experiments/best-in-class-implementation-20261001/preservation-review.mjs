// Read-only preservation review. Reports counts, opaque identifiers and hashes;
// never prints conversation contents, artifact contents or image prompts.
import {readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const [backupRoot,workRoot,reportPath]=process.argv.slice(2);
if(!backupRoot||!workRoot)throw new Error('Backup and current Work roots required.');
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const inside=(root,path)=>{const result=resolve(path),part=relative(resolve(root),result);if(part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part))throw new Error('Unsafe data path.');return result;};
async function hash(path){const value=createHash('sha256');for await(const chunk of createReadStream(path))value.update(chunk);return value.digest('hex');}
async function store(root){
  try{await stat(join(root,'work.sqlite'));}catch(error){if(error.code==='ENOENT')return JSON.parse(await readFile(join(root,'work.json'),'utf8'));throw error;}
  const db=new DatabaseSync(join(root,'work.sqlite'),{readOnly:true});try{
    if(db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value!=='1')throw new Error('Unknown database schema.');
    return {tasks:db.prepare('SELECT id,data FROM tasks ORDER BY ordinal').all().map(row=>({...JSON.parse(row.data),messages:db.prepare('SELECT data FROM messages WHERE task_id=? ORDER BY ordinal').all(row.id).map(m=>JSON.parse(m.data))}))};
  }finally{db.close();}
}
async function taskRecord(task,root,{originalRoot}={}){
  let cwd=task.cwd||join(originalRoot||root,'tasks',task.id);
  if(originalRoot)cwd=inside(root,join(root,relative(originalRoot,inside(originalRoot,await realpath(cwd)))));
  const artifacts=[];
  for(const item of task.artifacts||[]){let path=resolve(cwd,item.path);if(originalRoot&&isAbsolute(item.path))path=inside(root,join(root,relative(originalRoot,inside(originalRoot,await realpath(item.path)))));path=inside(root,await realpath(path));artifacts.push({id:item.id,path:item.path,sha256:await hash(path),bytes:(await stat(path)).size});}
  return {id:task.id,title:task.title,objective:task.objective,messageCount:(task.messages||[]).length,messagesHash:digest(task.messages||[]),artifacts};
}
async function imageRecord(item,root){const path=inside(join(root,'images','outputs'),await realpath(join(root,'images','outputs',item.file)));return {id:item.id,file:item.file,sha256:await hash(path),bytes:(await stat(path)).size,prompt:item.prompt,settings:{ratio:item.ratio,transparent:item.transparent,steps:item.steps,width:item.width,height:item.height,seed:item.seed}};}
const backup=await realpath(backupRoot),current=await realpath(workRoot),snapshot=join(backup,'work'),baseline=JSON.parse(await readFile(join(backup,'protected-inventory.json'),'utf8'));
const state=await store(current),snapshotState=await store(snapshot),gallery=JSON.parse(await readFile(join(current,'images','images.json'),'utf8')),snapshotGallery=JSON.parse(await readFile(join(snapshot,'images','images.json'),'utf8'));
const taskChecks=[];
for(const original of baseline.tasks){const live=state.tasks.find(t=>t.id===original.id),saved=snapshotState.tasks.find(t=>t.id===original.id);taskChecks.push({id:original.id,currentExact:!!live&&digest(await taskRecord(live,current))===digest(original),snapshotExact:!!saved&&digest(await taskRecord(saved,snapshot,{originalRoot:current}))===digest(original)});}
const imageChecks=[];
for(const original of baseline.images){const live=gallery.items.find(i=>i.id===original.id),saved=snapshotGallery.items.find(i=>i.id===original.id);imageChecks.push({id:original.id,currentExact:!!live&&digest(await imageRecord(live,current))===digest(original),snapshotExact:!!saved&&digest(await imageRecord(saved,snapshot))===digest(original)});}
const priorFiles=JSON.parse(await readFile(join(snapshot,'.release-files.json'),'utf8')),extra=gallery.items.filter(i=>!baseline.images.some(b=>b.id===i.id)),extraChecks=[];
for(const item of extra){const record=await imageRecord(item,current),relativePath='images/outputs/'+item.file,entry=priorFiles.find(file=>file.path.replaceAll('\\','/')===relativePath);let savedHash=null;if(entry)savedHash=await hash(inside(snapshot,join(snapshot,entry.path)));extraChecks.push({id:item.id,file:item.file,recovered:item.recovered===true,bytes:record.bytes,sha256:record.sha256,existedInPreReleaseSnapshot:!!entry,snapshotHash:savedHash,preReleaseManifestHash:entry?.sha256||null,allHashesMatch:!!entry&&record.sha256===savedHash&&savedHash===entry.sha256});}
const snapshotOutputs=priorFiles.filter(file=>/^images\/outputs\//.test(file.path.replaceAll('\\','/'))),currentOutputs=await readdir(join(current,'images','outputs'));
const report={schema:1,checkedAt:Date.now(),readOnly:true,baseline:{tasks:baseline.taskCount,images:baseline.imageCount,artifacts:baseline.artifactCount},current:{tasks:state.tasks.length,images:gallery.items.length,artifacts:state.tasks.reduce((n,t)=>n+(t.artifacts||[]).length,0)},originalTasksExact:taskChecks.every(t=>t.currentExact),originalSnapshotTasksExact:taskChecks.every(t=>t.snapshotExact),originalImagesExact:imageChecks.every(i=>i.currentExact),originalSnapshotImagesExact:imageChecks.every(i=>i.snapshotExact),changedOriginalTasks:taskChecks.filter(t=>!t.currentExact||!t.snapshotExact),changedOriginalImages:imageChecks.filter(i=>!i.currentExact||!i.snapshotExact),snapshotOutputFiles:snapshotOutputs.length,currentOutputFiles:currentOutputs.length,extraImages:extraChecks,allExtraImagesPreExistingAndUnchanged:extraChecks.every(i=>i.allHashesMatch),newTaskIds:state.tasks.filter(t=>!baseline.tasks.some(b=>b.id===t.id)).map(t=>t.id)};
if(reportPath)await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report,null,2));
