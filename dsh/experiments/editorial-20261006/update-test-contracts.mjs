import {readFile,writeFile,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url)),repo=resolve(here,'../../..'),source=join(repo,'dsh/plugins/browser-viewer/test'),candidate=join(here,'candidate/dsh/plugins/browser-viewer/test');
for(const root of [source,candidate]){
 const path=join(root,'model-progression.test.mjs');let text=await readFile(path,'utf8');
 const start=text.indexOf(' async function compactHeader(tab)'),end=text.indexOf('\n try{',start);if(start<0||end<0)throw Error('Missing model header contract');
 text=text.slice(0,start)+` async function compactHeader(tab){assert.equal(await ui.evaluate(tab,"(()=>{const status=document.querySelector('#model-status'),header=document.querySelector('.topbar'),s=status.getBoundingClientRect(),h=header.getBoundingClientRect();return header.contains(status)&&!status.querySelector('.model-tile')&&(getComputedStyle(status).display==='none'?!document.body.classList.contains('model-attention'):s.top>=h.top&&s.bottom<=h.bottom+1&&s.height<=28)})()"),true,'Idle model details stay quiet; active handoffs remain compact and visible in the header');assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true);}`+text.slice(end);
 await writeFile(path,text);
 const run=join(root,'run-tests.mjs');text=await readFile(run,'utf8');if(!text.includes("'editorial-theme'"))text=text.replace("suites.push('mirror');","suites.push('mirror','editorial-theme');");await writeFile(run,text);
}
await cp(join(source,'editorial-theme.test.mjs'),join(candidate,'editorial-theme.test.mjs'));
console.log('Regression contracts include the approved quiet header and color system.');
