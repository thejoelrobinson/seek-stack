// Release-only, CPU/filesystem tooling. Never calls generation or model load APIs.
import {readFile,writeFile,mkdir,readdir,copyFile,stat,realpath,rename,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,relative,isAbsolute,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const [operation,...args]=process.argv.slice(2);
const inside=(base,path)=>{const rel=relative(resolve(base),resolve(path));if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new Error('Path escapes its declared release root.');return resolve(path);};
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
async function hashFile(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function optionalJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
async function store(root){
  const path=join(root,'work.sqlite');
  try{await stat(path);}catch(error){if(error.code==='ENOENT')return JSON.parse(await readFile(join(root,'work.json'),'utf8'));throw error;}
  const db=new DatabaseSync(path,{readOnly:true});try{
    const schema=db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if(!schema)return JSON.parse(await readFile(join(root,'work.json'),'utf8'));
    if(schema.value!=='1')throw new Error('Unknown Work database schema; preserved.');
    const globals=JSON.parse(db.prepare("SELECT value FROM meta WHERE key='globals'").get().value);
    return {...globals,tasks:db.prepare('SELECT * FROM tasks ORDER BY ordinal').all().map(row=>({...JSON.parse(row.data),messages:db.prepare('SELECT data FROM messages WHERE task_id=? ORDER BY ordinal').all(row.id).map(item=>JSON.parse(item.data))}))};
  }finally{db.close();}
}
async function inventory(root,{originalRoot=null}={}){
  root=await realpath(root);if(originalRoot)originalRoot=await realpath(originalRoot);const work=await store(root),gallery=await optionalJson(join(root,'images','images.json'),{items:[]});
  if(!Array.isArray(work.tasks)||!Array.isArray(gallery.items))throw new Error('Invalid release history.');
  const tasks=[];for(const task of work.tasks){
    let cwd=task.cwd||join(originalRoot||root,'tasks',task.id);
    if(originalRoot){const canonical=inside(originalRoot,await realpath(cwd));cwd=inside(root,join(root,relative(originalRoot,canonical)));}
    const artifacts=[];for(const artifact of task.artifacts||[]){let path=resolve(cwd,artifact.path);if(originalRoot&&isAbsolute(artifact.path)){const canonical=inside(originalRoot,await realpath(artifact.path));path=inside(root,join(root,relative(originalRoot,canonical)));}const real=inside(root,await realpath(path));artifacts.push({id:artifact.id,path:artifact.path,sha256:await hashFile(real),bytes:(await stat(real)).size});}
    tasks.push({id:task.id,title:task.title,objective:task.objective,messageCount:(task.messages||[]).length,messagesHash:digest(task.messages||[]),artifacts});
  }
  const images=[];for(const item of gallery.items){const path=inside(join(root,'images','outputs'),join(root,'images','outputs',item.file));const real=inside(join(root,'images','outputs'),await realpath(path));images.push({id:item.id,file:item.file,sha256:await hashFile(real),bytes:(await stat(real)).size,prompt:item.prompt,recovered:!!item.recovered,settings:{ratio:item.ratio,transparent:item.transparent,steps:item.steps,width:item.width,height:item.height,seed:item.seed}});}
  const indexed=new Set(images.map(item=>item.file)),unindexedImages=[];
  for(const name of await readdir(join(root,'images','outputs'))){if(indexed.has(name)||!/^[-_a-zA-Z0-9]+\.png$/i.test(name))continue;const path=inside(join(root,'images','outputs'),await realpath(join(root,'images','outputs',name))),info=await stat(path);if(!info.isFile()||info.size<100)continue;const handle=await open(path,'r'),header=Buffer.alloc(24);try{await handle.read(header,0,24,0);}finally{await handle.close();}if(header.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')continue;unindexedImages.push({file:name,bytes:info.size,sha256:await hashFile(path),width:header.readUInt32BE(16),height:header.readUInt32BE(20)});}
  return {schema:1,at:Date.now(),taskCount:tasks.length,imageCount:images.length,artifactCount:tasks.reduce((sum,t)=>sum+t.artifacts.length,0),tasks,images,unindexedImages};
}
async function snapshot(source,destination,{excludeBackups=false}={}){
  source=await realpath(source);destination=resolve(destination);let ancestor=destination,missing=[];for(;;){try{destination=join(await realpath(ancestor),...missing);break;}catch(error){if(error.code!=='ENOENT')throw error;missing.unshift(basename(ancestor));ancestor=dirname(ancestor);}}
  const separation=relative(source,destination);if(!separation||separation!=='..'&&!separation.startsWith('..\\')&&!separation.startsWith('../')&&!isAbsolute(separation))throw new Error('Snapshot must be outside its source.');await mkdir(destination,{recursive:true});const records=[];
  async function walk(base,prefix=''){for(const entry of await readdir(base,{withFileTypes:true})){
    if(!prefix&&excludeBackups&&entry.name==='backups'||entry.name.endsWith('-wal')||entry.name.endsWith('-shm')||entry.name.endsWith('.tmp')||entry.name==='SingletonLock'||entry.name==='SingletonCookie'||entry.name==='SingletonSocket')continue;
    if(entry.isSymbolicLink())throw new Error('Release backup refuses a symbolic link: '+prefix+entry.name);
    const input=join(base,entry.name),name=prefix+entry.name,output=inside(destination,join(destination,name));
    if(entry.isDirectory()){await mkdir(output,{recursive:true});await walk(input,name+'/');continue;}if(!entry.isFile())throw new Error('Unsupported backup entry: '+name);
    if(entry.name.endsWith('.sqlite')){const db=new DatabaseSync(input,{readOnly:true});try{db.exec("PRAGMA busy_timeout=5000; VACUUM INTO '"+output.replace(/'/g,"''")+"'");}finally{db.close();}}
    else await copyFile(input,output);
    records.push({path:name,bytes:(await stat(output)).size,sha256:await hashFile(output),sqliteSnapshot:entry.name.endsWith('.sqlite')});
  }}await walk(source);await writeFile(join(destination,'.release-files.json'),JSON.stringify(records,null,2),{flag:'wx',mode:0o600});return {files:records.length,bytes:records.reduce((sum,item)=>sum+item.bytes,0)};
}
async function verifySnapshot(directory){const files=JSON.parse(await readFile(join(directory,'.release-files.json'),'utf8'));for(const file of files){const path=inside(directory,join(directory,file.path));if((await stat(path)).size!==file.bytes||await hashFile(path)!==file.sha256)throw new Error('Release backup hash failed: '+file.path);}return {verified:true,files:files.length};}
async function compare(beforePath,root,originalRoot=null,evidenceRoot=null){
  const before=JSON.parse(await readFile(beforePath,'utf8')),after=await inventory(root,{originalRoot});
  for(const key of ['taskCount','artifactCount'])if(before[key]!==after[key])throw new Error('Release changed '+key+'. Keep the front door closed and preserve all current data.');
  if(digest(before.tasks)!==digest(after.tasks))throw new Error('Release changed protected tasks content or file hashes. Keep the front door closed.');
  const comparable=item=>{const {recovered,...content}=item;return content;},current=new Map(after.images.map(item=>[item.id,item]));
  if(current.size!==after.images.length||before.images.some(item=>!current.has(item.id)||digest(comparable(item))!==digest(comparable(current.get(item.id)))))throw new Error('Release changed protected images content or file hashes. Keep the front door closed.');
  const known=new Set(before.images.map(item=>item.id)),added=after.images.filter(item=>!known.has(item.id));
  if(added.length&&!evidenceRoot)throw new Error('Release changed imageCount. Strict comparison requires the same gallery records.');
  let evidence=new Map((before.unindexedImages||[]).map(item=>[item.file,item]));
  if(evidenceRoot){
    evidenceRoot=await realpath(evidenceRoot);const files=JSON.parse(await readFile(join(evidenceRoot,'.release-files.json'),'utf8'));
    for(const file of files){if(!file.path.startsWith('images/outputs/')||file.path.slice('images/outputs/'.length).includes('/'))continue;const name=file.path.slice('images/outputs/'.length),path=inside(evidenceRoot,await realpath(join(evidenceRoot,file.path))),info=await stat(path);
      if(info.size!==file.bytes||await hashFile(path)!==file.sha256)throw new Error('Recovery evidence hash failed.');const handle=await open(path,'r'),header=Buffer.alloc(24);try{await handle.read(header,0,24,0);}finally{await handle.close();}
      if(info.size>=100&&header.subarray(0,8).toString('hex')==='89504e470d0a1a0a')evidence.set(name,{file:name,bytes:file.bytes,sha256:file.sha256,width:header.readUInt32BE(16),height:header.readUInt32BE(20)});
    }
  }
  for(const item of added){const proof=evidence.get(item.file);if(!item.recovered||!proof||proof.sha256!==item.sha256||proof.bytes!==item.bytes||proof.width!==item.settings.width||proof.height!==item.settings.height)throw new Error('Release added an image without proven pre-release recovery evidence. Keep the front door closed.');}
  return {verified:true,taskCount:after.taskCount,imageCount:after.imageCount,preservedImageCount:before.imageCount,recoveredImageCount:added.length,artifactCount:after.artifactCount,at:after.at};
}
async function closeBrowser(profile,output){
  const [port,path]=String(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);if(!/^\d+$/.test(port)||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path))throw new Error('Invalid owned-browser debug endpoint.');
  const pages=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(5000)}).then(response=>response.json());await writeFile(output,JSON.stringify(pages.filter(t=>t.type==='page').map(t=>({url:t.url,title:t.title})),null,2),{flag:'wx',mode:0o600});
  const socket=new WebSocket('ws://127.0.0.1:'+port+path);await new Promise((ok,no)=>{const timer=setTimeout(()=>no(new Error('Browser connection timed out.')),5000);socket.onopen=()=>{clearTimeout(timer);ok();};socket.onerror=()=>{clearTimeout(timer);no(new Error('Browser connection failed.'));};});
  await new Promise((ok,no)=>{const timer=setTimeout(()=>{socket.close();no(new Error('Owned browser did not close cleanly.'));},10000);socket.onclose=()=>{clearTimeout(timer);ok();};socket.onerror=()=>{clearTimeout(timer);no(new Error('Browser close failed.'));};socket.send(JSON.stringify({id:1,method:'Browser.close'}));});return {closed:true,pages:pages.filter(t=>t.type==='page').length};
}
let result;
if(operation==='inventory'){result=await inventory(args[0]);if(args[1])await writeFile(args[1],JSON.stringify(result,null,2),{flag:'wx',mode:0o600});result={taskCount:result.taskCount,imageCount:result.imageCount,artifactCount:result.artifactCount};}
else if(operation==='snapshot')result=await snapshot(args[0],args[1],{excludeBackups:args[2]==='exclude-backups'});
else if(operation==='verify-snapshot')result=await verifySnapshot(args[0]);
else if(operation==='compare')result=await compare(args[0],args[1]);
else if(operation==='compare-recovered'){if(!args[2])throw new Error('An explicit pre-release snapshot is required for recovered image evidence.');result=await compare(args[0],args[1],null,args[2]);}
else if(operation==='compare-restored'){if(!args[2])throw new Error('The original Work root is required for explicit restored-path relocation.');result=await compare(args[0],args[1],args[2]);}
else if(operation==='close-browser')result=await closeBrowser(args[0],args[1]);
else if(operation==='release'){const {WorkAssets}=await import(pathToFileURL(join(args[0],'dsh/plugins/browser-viewer/lib/work-assets.js')));const assets=await new WorkAssets().init();result={release:assets.release,plugin:assets.version};}
else if(operation==='portable-rollback'){
  const root=await realpath(args[0]),current=await store(root),stamp=Date.now();
  const path=join(root,'work.json'),temporary=path+'.rollback.tmp';
  await copyFile(path,path+'.rollback-preserved-'+stamp).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await writeFile(temporary,JSON.stringify(current,null,2),{flag:'wx',mode:0o600});await rename(temporary,path);
  for(const name of ['work.sqlite','work.sqlite-wal','work.sqlite-shm'])await rename(join(root,name),join(root,name+'.rollback-preserved-'+stamp)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  result={portable:true,preservedAt:stamp,tasks:current.tasks.length};
}
else throw new Error('Unknown release-data command.');
console.log(JSON.stringify(result));
