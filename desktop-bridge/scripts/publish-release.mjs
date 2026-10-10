import {execFileSync} from 'node:child_process';import {readFile,writeFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {digest,validateReleaseFiles} from './release-files.mjs';
const repo=process.env.GITHUB_REPOSITORY,commit=process.env.GITHUB_SHA,runId=Number(process.env.GITHUB_RUN_ID),version=JSON.parse(await readFile('package.json','utf8')).version,tag='bridge-v'+version,source=resolve('../release');
if(repo!=='thejoelrobinson/seek-stack'||!Number.isSafeInteger(runId))throw Error('Unexpected release repository/run');
const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8',maxBuffer:5000000});const api=path=>JSON.parse(gh('api','repos/'+repo+'/'+path));
// Both Work and the three packaged desktop builds must pass for this exact source commit.
let work;for(let attempt=0;attempt<30;attempt++){
 const runs=api(`actions/workflows/work-regressions.yml/runs?head_sha=${commit}&per_page=20`).workflow_runs;
 work=runs.find(r=>r.head_sha===commit&&r.head_branch==='main'&&r.event==='push');
 if(work?.status==='completed'){if(work.conclusion!=='success')throw Error('Work CI did not pass for the release commit');break;}
 await new Promise(r=>setTimeout(r,30000));
}if(work?.conclusion!=='success')throw Error('Timed out waiting for Work CI');
const records=await Promise.all(['win32','darwin','linux'].map(os=>readFile(join(source,'release-'+os+'.json'),'utf8').then(JSON.parse))),files=validateReleaseFiles(records,{version,commit});
for(const file of files)if(await digest(join(source,file.name))!==file.sha256)throw Error('Installer checksum mismatch '+file.name);
let existing;try{existing=api('releases/tags/'+tag);}catch(error){if(!String(error.stderr).includes('404'))throw error;}
if(existing){
 const metadata=api('git/ref/tags/'+tag);let sha=metadata.object.sha;if(metadata.object.type==='tag')sha=api('git/tags/'+sha).object.sha;
 if(sha!==commit)throw Error('This companion version is already published; bump desktop-bridge/package.json before releasing changes');
 if(!existing.draft){console.log('Release already published for this commit');process.exit(0);}
}
const manifest={schema:1,version,commit,ciRun:runId,workRun:work.id,published:Date.now(),files};
await writeFile(join(source,'release.json'),JSON.stringify(manifest,null,2));
const checks=[...files.map(f=>`${f.sha256}  ${f.name}`),`${await digest(join(source,'release.json'))}  release.json`].join('\n')+'\n';await writeFile(join(source,'SHA256SUMS'),checks);
const notes=resolve('../release/notes.md');await writeFile(notes,'Seek Desktop '+version+'\n\nPackaged Windows, universal Mac and Linux builds and Work regressions passed for commit '+commit+'. The companion checks for updates automatically and offers an installer download. Current previews require manual installation; connections carry forward. Mac previews are ad-hoc signed and not Apple notarized unless release.json explicitly records Developer ID signing and notarization.\n');
if(!existing)gh('release','create',tag,'--repo',repo,'--target',commit,'--draft','--prerelease','--title','Seek Desktop '+version,'--notes-file',notes);
gh('release','upload',tag,'--repo',repo,...files.map(f=>join(source,f.name)),join(source,'release.json'),join(source,'SHA256SUMS'),'--clobber');
gh('release','edit',tag,'--repo',repo,'--draft=false','--prerelease','--notes-file',notes);console.log('Published '+tag+' from '+commit);
