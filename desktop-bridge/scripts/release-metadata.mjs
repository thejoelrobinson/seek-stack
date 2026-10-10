import {readFile,writeFile,stat} from 'node:fs/promises';import {join} from 'node:path';import {digest,releaseFiles} from './release-files.mjs';
const {version}=JSON.parse(await readFile('package.json','utf8')),commit=process.env.GITHUB_SHA;
if(!/^[0-9a-f]{40}$/.test(commit||''))throw Error('Release metadata needs the full CI commit');
const files=[];for(const [suffix,os,kind,arch] of releaseFiles.filter(f=>f[1]===process.platform)){
 const name=`seek-desktop-${version}-${suffix}`,path=join('dist',name),info=await stat(path);files.push({name,os,kind,arch,size:info.size,sha256:await digest(path),...os==='darwin'?{signing:process.env.SEEK_MAC_SIGNED_RELEASE==='1'?'developer-id':'adhoc',notarized:process.env.SEEK_MAC_SIGNED_RELEASE==='1'}:{}});
}await writeFile(`dist/release-${process.platform}.json`,JSON.stringify({version,commit,files},null,2));
