import {readFile,writeFile,mkdir,copyFile,rename,stat,open,unlink} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {RELEASE_REPO,verifiedRun,verifiedManifest,sourceOnMain,activeWork} from './release-policy.mjs';
import {digest} from '../../desktop-bridge/scripts/release-files.mjs';
const exec=promisify(execFile);
export async function publishDownloads(source,target,manifest){
 manifest=verifiedManifest(manifest);await mkdir(target,{recursive:true});
 const previous=await readFile(join(target,'manifest.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
 if(previous){const current=JSON.parse(previous);if(current.version===manifest.version){if(current.commit===manifest.commit)return {state:'current',version:manifest.version};throw Error('Published versions are immutable');}const parts=v=>v.split('.').map(Number),old=parts(current.version),fresh=parts(manifest.version);let newer=false;for(let i=0;i<3;i++){if(fresh[i]!==old[i]){newer=fresh[i]>old[i];break;}}if(!newer)throw Error('Refusing a release downgrade');}
 // Verify every artifact before exposing any new name in the download whitelist.
 for(const f of manifest.files){const file=join(source,f.name);if((await stat(file)).size!==f.size||await digest(file)!==f.sha256)throw Error('Downloaded installer integrity failed: '+f.name);}
 for(const f of manifest.files){const staged=join(target,f.name+'.staged');await copyFile(join(source,f.name),staged);if(await digest(staged)!==f.sha256)throw Error('Copied installer integrity failed');await rename(staged,join(target,f.name));}
 if(previous)await writeFile(join(target,'manifest-backup-'+Date.now()+'.json'),previous);
 await writeFile(join(target,'manifest.json.staged'),JSON.stringify(manifest,null,2));await rename(join(target,'manifest.json.staged'),join(target,'manifest.json'));return {state:'published',version:manifest.version,files:manifest.files.length};
}
function under(base,path){const full=resolve(path),r=relative(resolve(base),full);if(r.startsWith('..')||isAbsolute(r))throw Error('Release path escaped its cache');return full;}
async function json(file,fallback){return JSON.parse(await readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return JSON.stringify(fallback);throw e;}));}
export async function poll(config){
 const home=resolve(config.seekHome),cache=join(home,'release-cache');await mkdir(cache,{recursive:true});
 const command=async(program,args,options={})=>(await exec(program,args,{windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:5000000,...options})).stdout;
 const api=async path=>JSON.parse(await command(config.gh||'gh',['api','repos/'+RELEASE_REPO+'/'+path]));
 const stateFile=join(cache,'state.json'),state=await json(stateFile,{}),report={at:Date.now()};
 const repo=resolve(config.repoRoot),remote=(await command('git',['remote','get-url','origin'],{cwd:repo})).trim();if(remote!=='https://github.com/'+RELEASE_REPO+'.git')throw Error('Unexpected source repository');
 const main=await api('git/ref/heads/main'),sha=main.object.sha;if(!/^[0-9a-f]{40}$/.test(sha))throw Error('Invalid main commit');
 const runs=await api('actions/workflows/work-regressions.yml/runs?head_sha='+sha+'&per_page=20');
 const work=runs.workflow_runs.find(r=>verifiedRun(r,{sha,workflow:'work-regressions.yml'}));
 if(config.deployApp&&state.appCommit!==sha){
  if(!work)report.app='waiting_for_work_ci';
  else if(activeWork(await fetch('http://127.0.0.1:3080/work/api/state',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw Error('App status unavailable');return r.json();})))report.app='waiting_for_idle';
  else {
   if(await stat(join(home,'deployment.lock.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return {...report,app:'deployment_in_progress'};
   await command('git',['fetch','origin','main'],{cwd:repo});const snapshot=under(cache,join(cache,'source-'+sha));
   if(!await stat(join(snapshot,'.complete')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;})){
    await mkdir(snapshot,{recursive:true});const zip=under(cache,join(cache,sha+'.zip'));await command('git',['archive','--format=zip','--output='+zip,sha],{cwd:repo});
    // tar extracts an archive produced by our own Git, never arbitrary downloaded paths.
    await command('tar',['-xf',zip,'-C',snapshot]);await writeFile(join(snapshot,'.complete'),sha);
   }
   const pkg='dsh/plugins/browser-viewer/package.json',candidate=await json(join(snapshot,pkg),{}),installed=await json(join(home,'profiles/web/node_modules/@deepseek-ai/dsh-browser-viewer/package.json'),{});
   const dependencies=p=>JSON.stringify(Object.entries(p.dependencies||{}).sort(([a],[b])=>a.localeCompare(b)));
   if(dependencies(candidate)!==dependencies(installed))report.app='dependency_change_needs_review';
   else {
    const deploy=join(snapshot,'dsh/experiments/best-in-class-implementation-20261001/deploy.ps1');
    await command(config.powershell||'powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',deploy,'-RepoRoot',snapshot,'-SeekHome',home,'-ViewerOnly','-AllowWaitingTasks','-Apply','-RegisterSupervisor'],{timeout:360000});
    state.appCommit=sha;report.app='deployed';
   }
  }
 }else report.app=config.deployApp?'current':'disabled';
 const releases=await api('releases?per_page=20'),latest=releases.filter(r=>!r.draft&&/^bridge-v\d+\.\d+\.\d+$/.test(r.tag_name)).sort((a,b)=>b.published_at.localeCompare(a.published_at)).find(r=>r.assets.some(a=>a.name==='release.json'));
 if(latest&&state.desktopTag!==latest.tag_name){
  const staging=under(cache,join(cache,latest.tag_name));await mkdir(staging,{recursive:true});
  await command(config.gh||'gh',['release','download',latest.tag_name,'--repo',RELEASE_REPO,'--pattern','release.json','--dir',staging,'--clobber']);const manifest=verifiedManifest(await json(join(staging,'release.json'),{}));
  if(latest.tag_name!=='bridge-v'+manifest.version)throw Error('Tag and release version differ');
  const [bridge,workRun,compare,tag]=await Promise.all([api('actions/runs/'+manifest.ciRun),api('actions/runs/'+manifest.workRun),api('compare/'+manifest.commit+'...'+sha),api('git/ref/tags/'+latest.tag_name)]);
  const tagCommit=tag.object.type==='tag'?(await api('git/tags/'+tag.object.sha)).object.sha:tag.object.sha;
  if(tagCommit!==manifest.commit)throw Error('Release tag does not match its tested source');
  if(!verifiedRun(bridge,{sha:manifest.commit,workflow:'desktop-bridge.yml'})||!verifiedRun(workRun,{sha:manifest.commit,workflow:'work-regressions.yml'})||!sourceOnMain(compare))report.downloads='waiting_for_release_ci';
  else {
   const jobs=(await api('actions/runs/'+manifest.ciRun+'/jobs?per_page=100')).jobs;
   if(['windows-latest','macos-latest','ubuntu-latest'].some(os=>!jobs.some(j=>j.name==='build ('+os+')'&&j.conclusion==='success')))throw Error('A packaged platform build did not pass');
   if(await stat(join(home,'deployment.lock.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return {...report,downloads:'deployment_in_progress'};
   for(const f of manifest.files){const asset=latest.assets.find(a=>a.name===f.name);if(!asset||asset.size!==f.size)throw Error('Release asset is missing or changed');await command(config.gh||'gh',['release','download',latest.tag_name,'--repo',RELEASE_REPO,'--pattern',f.name,'--dir',staging,'--clobber']);}
   report.downloads=await publishDownloads(staging,join(home,'work/downloads'),manifest);state.desktopTag=latest.tag_name;
  }
 }else report.downloads=latest?'current':'waiting_for_release';
 await writeFile(stateFile+'.staged',JSON.stringify(state));await rename(stateFile+'.staged',stateFile);return report;
}
async function main(){
 const file=process.argv[2];if(!file)throw Error('Pass the installed publisher configuration');const config=await json(resolve(file),null);if(!config)throw Error('Publisher configuration is missing');
 const root=join(resolve(config.seekHome),'release-cache');await mkdir(root,{recursive:true});const lock=join(root,'publisher.lock');
 let handle;try{handle=await open(lock,'wx');}catch(error){if(error.code!=='EEXIST')throw error;const pid=Number(await readFile(lock,'utf8'));try{process.kill(pid,0);console.log('Another publisher is running');return;}catch(e){if(e.code!=='ESRCH')throw e;}await unlink(lock);handle=await open(lock,'wx');}
 await handle.writeFile(String(process.pid));await handle.close();
 try{const result=await poll(config);await writeFile(join(root,'status.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
 catch(error){await writeFile(join(root,'status.json'),JSON.stringify({at:Date.now(),state:'error',error:error.message},null,2));throw error;}finally{await unlink(lock);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
