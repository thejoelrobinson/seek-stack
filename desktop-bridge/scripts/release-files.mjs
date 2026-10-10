import {createHash} from 'node:crypto';import {createReadStream} from 'node:fs';
export const releaseFiles=[['win-x64.exe','win32','installer','x64'],['win-x64.zip','win32','zip','x64'],['mac-universal.dmg','darwin','dmg','universal'],['mac-universal.zip','darwin','zip','universal'],['linux-x86_64.AppImage','linux','appimage','x64'],['linux-amd64.deb','linux','deb','x64']];
export async function digest(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export function validateReleaseFiles(records,{version,commit}){
 if(!/^\d+\.\d+\.\d+$/.test(version)||!/^[0-9a-f]{40}$/.test(commit))throw Error('Invalid release identity');
 const all=records.flatMap(r=>{if(r.version!==version||r.commit!==commit)throw Error('Mixed release commits or versions');return r.files;});
 if(all.length!==6)throw Error('Release must contain all six platform downloads');
 return releaseFiles.map(([suffix,os,kind,arch])=>{
  const name=`seek-desktop-${version}-${suffix}`,matches=all.filter(f=>f.name===name);if(matches.length!==1)throw Error('Missing or duplicate installer '+name);const f=matches[0];
  if(f.os!==os||f.kind!==kind||f.arch!==arch||!Number.isSafeInteger(f.size)||f.size<10000000||f.size>1000000000||!/^[0-9a-f]{64}$/.test(f.sha256))throw Error('Invalid installer metadata '+name);
  if(os==='darwin'&&(!['adhoc','developer-id'].includes(f.signing)||typeof f.notarized!=='boolean'||(f.signing==='developer-id')!==f.notarized))throw Error('Invalid Mac signing metadata');
  return {name,os,kind,arch,size:f.size,sha256:f.sha256,...os==='darwin'?{signing:f.signing,notarized:f.notarized}:{}};
 });
}
