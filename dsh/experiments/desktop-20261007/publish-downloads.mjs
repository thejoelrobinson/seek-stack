// Copies Seek Desktop installers (CI artifacts) into ~/.dsh/work/downloads with a manifest that
// the Computers page reads. node publish-downloads.mjs <artifact dir> <version>
import {readdir,stat,copyFile,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {join,basename} from 'node:path';
import {homedir} from 'node:os';
const [src,version]=process.argv.slice(2);if(!src||!version)throw new Error('usage: publish-downloads.mjs <artifact dir> <version>');
const out=join(process.env.DSH_WORK_HOME||join(homedir(),'.dsh','work'),'downloads');await mkdir(out,{recursive:true});
const walk=async d=>(await Promise.all((await readdir(d,{withFileTypes:true})).map(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]))).flat();
const sha=file=>new Promise((res,rej)=>{const h=createHash('sha256');createReadStream(file).on('data',c=>h.update(c)).on('end',()=>res(h.digest('hex'))).on('error',rej);});
const classify=name=>{
  const os=/-win-/.test(name)?'win32':/-mac-/.test(name)?'darwin':/-linux-/.test(name)?'linux':null;
  const kind=name.endsWith('.exe')?'installer':name.endsWith('.dmg')?'dmg':name.endsWith('.AppImage')?'appimage':name.endsWith('.deb')?'deb':name.endsWith('.zip')?'zip':null;
  const arch=/universal/.test(name)?'universal':/arm64|aarch64/.test(name)?'arm64':/x64|x86_64|amd64/.test(name)?'x64':null;
  return os&&kind?{os,kind,arch:arch||'x64'}:null;
};
const files=[];
for(const file of await walk(src)){
  const name=basename(file);if(!name.includes(version))continue;const c=classify(name);if(!c)continue;
  await copyFile(file,join(out,name));files.push({name,...c,size:(await stat(file)).size,sha256:await sha(file)});console.log('published',name);
}
if(!files.length)throw new Error('No installers for version '+version+' in '+src);
// Older installers are removed once a newer manifest is in place.
const previous=JSON.parse(await readFile(join(out,'manifest.json'),'utf8').catch(()=>'{"files":[]}'));
await writeFile(join(out,'manifest.json'),JSON.stringify({version,published:Date.now(),files},null,2));
for(const f of previous.files||[])if(!files.some(x=>x.name===f.name))await rm(join(out,f.name),{force:true});
console.log(`manifest: ${files.length} files for ${version}`);
