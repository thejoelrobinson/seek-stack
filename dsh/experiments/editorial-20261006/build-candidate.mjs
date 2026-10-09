import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url)),repo=resolve(here,'../../..'),live=join(process.env.USERPROFILE,'.dsh'),candidate=join(here,'candidate');
await mkdir(join(here,'results'),{recursive:true});
for(const name of ['browser-viewer','qwen-image','web-search-chrome-mcp']){
 const from=join(live,'profiles/web/node_modules/@deepseek-ai/dsh-'+name),to=join(candidate,'dsh/plugins',name);
 await mkdir(to,{recursive:true});
 for(const part of ['lib','skills','package.json','README.md'])try{await cp(join(from,part),join(to,part),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
}
await cp(join(repo,'dsh/experiments/mirror-20261005/candidate/dsh/plugins/browser-viewer/test'),join(candidate,'dsh/plugins/browser-viewer/test'),{recursive:true});
for(const [from,to]of [['tools/qwen-image-service.py','dsh/tools/qwen-image-service.py'],['proxy/server.js','dsh/proxy/server.js'],['proxy/work-session-store.cjs','dsh/proxy/work-session-store.cjs'],['proxy/summarizer-shim.js','dsh/proxy/summarizer-shim.js'],['supervise-seek.ps1','scheduled-task/supervise-seek-v2.ps1'],['register-seeksupervisor.ps1','scheduled-task/register-seeksupervisor.ps1']]){
 await mkdir(resolve(candidate,to,'..'),{recursive:true});await cp(join(live,from),join(candidate,to));
}
await cp(join(candidate,'dsh/plugins/browser-viewer/lib'),join(here,'baseline/lib'),{recursive:true});
await cp(join(candidate,'dsh/plugins/browser-viewer/package.json'),join(here,'baseline/package.json'));
const version=await (await fetch('http://127.0.0.1:3080/work/api/version')).json();
await writeFile(join(here,'results/baseline.json'),JSON.stringify({candidate,version},null,2));
console.log(JSON.stringify({candidate,baseline:version.release}));
