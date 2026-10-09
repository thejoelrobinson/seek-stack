import {cp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const repo=resolve(new URL('../../..',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1').replaceAll('%20',' '));
const home=process.env.USERPROFILE,live=join(home,'.dsh'),candidate=join(repo,'dsh/experiments/mirror-20261005/candidate'),plugin='dsh/plugins/browser-viewer',owned=['cdp.js','index.js','work-assets.js','work-browser.js','work-server.js','work-mirror.js','mirror.js','mirror-shape.js','mirror-resource.js','mirror-styles.js','mirror-frames.js','mirror-input.js','mirror-layout.js','mirror-pixels.js','mirror-regions.js'];
await mkdir(candidate,{recursive:true});
for(const name of ['browser-viewer','qwen-image','web-search-chrome-mcp']){const source=join(live,'profiles/web/node_modules/@deepseek-ai/dsh-'+name),target=join(candidate,'dsh/plugins',name);await mkdir(target,{recursive:true});for(const part of ['lib','skills','package.json','README.md'])try{await cp(join(source,part),join(target,part),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}}
for(const name of owned)await cp(join(repo,plugin,'lib',name),join(candidate,plugin,'lib',name));
for(const name of ['package.json','README.md','test'])await cp(join(repo,plugin,name),join(candidate,plugin,name),{recursive:true});
// Test unrelated UI against its deployed contract, without editing shared work.
await writeFile(join(candidate,plugin,'test/work-product-ui.test.mjs'),execFileSync('git',['show','HEAD:'+plugin+'/test/work-product-ui.test.mjs'],{cwd:repo}));
const css=await readFile(join(repo,plugin,'lib/work.css'),'utf8'),tabCSS=css.slice(css.indexOf('.bv-tabs{'));
if(!tabCSS.startsWith('.bv-tabs{'))throw Error('Tab CSS not found');await writeFile(join(candidate,plugin,'lib/work.css'),await readFile(join(live,'profiles/web/node_modules/@deepseek-ai/dsh-browser-viewer/lib/work.css'),'utf8')+'\n'+tabCSS);
for(const [from,to]of [['tools/qwen-image-service.py','dsh/tools/qwen-image-service.py'],['proxy/server.js','dsh/proxy/server.js'],['proxy/work-session-store.cjs','dsh/proxy/work-session-store.cjs'],['supervise-seek.ps1','scheduled-task/supervise-seek-v2.ps1'],['register-seeksupervisor.ps1','scheduled-task/register-seeksupervisor.ps1']]){await mkdir(resolve(candidate,to,'..'),{recursive:true});await cp(join(live,from),join(candidate,to));}
const differences=[];for(const file of await readdir(join(candidate,plugin,'lib'))){const bytes=await readFile(join(candidate,plugin,'lib',file));let old;try{old=await readFile(join(live,'profiles/web/node_modules/@deepseek-ai/dsh-browser-viewer/lib',file));}catch{}if(!old||!bytes.equals(old))differences.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});}
if(differences.some(d=>!owned.includes(d.file)&&d.file!=='work.css'))throw Error('Unrelated deployed code differs');
const row={candidate,differences,baselineRelease:(await (await fetch('http://127.0.0.1:3080/work/api/version')).json()).release};await writeFile(new URL('./results/candidate.json',import.meta.url),JSON.stringify(row,null,2));console.log(JSON.stringify(row));
