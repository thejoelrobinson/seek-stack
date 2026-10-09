import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from './candidate/dsh/plugins/browser-viewer/lib/cdp.js';
import {WorkAssets} from './candidate/dsh/plugins/browser-viewer/lib/work-assets.js';
const base='http://127.0.0.1:3080';
const source=await new WorkAssets().init(),version=await (await fetch(base+'/work/api/version')).json();
assert.equal(version.release,source.release);
const frame=await fetch(base+'/work/mirror-frame');assert.equal(frame.status,200);assert.match(frame.headers.get('content-security-policy'),/default-src 'none'/);assert.match(frame.headers.get('content-security-policy'),/sandbox allow-same-origin allow-scripts/);
assert.equal((await fetch(base+'/work/mirror-frame',{headers:{Origin:'https://untrusted.example'}})).status,403);
assert.equal((await fetch(base+'/work/mirror-res?u=bad&f=bad&s=bad')).status,404);
for(const path of ['/work/mirror.js','/work/mirror-shape.js','/work/editorial.js','/work/editorial.css','/work/theme.js','/work/colors.css'])assert.equal((await fetch(base+path+'?v='+source.release)).status,200);
const cdp=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-mirror-live-assets-'))});
try{
  await cdp.launch();const tab=await cdp.newTab(base+'/work');
  const editorial=await cdp.evaluate(tab,`(async()=>{for(let i=0;i<100&&!document.querySelector('.welcome .buddy[data-mounted]');i++)await new Promise(r=>setTimeout(r,25));return {active:document.documentElement.dataset.experience==='editorial',mascot:document.querySelector('.home-greet .buddy')?.getBoundingClientRect().width===144,composer:document.querySelectorAll('#composer').length===1,colors:Object.keys(window.SeekBuddy?.PALETTES||{}).length,viewport:document.documentElement.scrollWidth<=innerWidth};})()`);assert.deepEqual(editorial,{active:true,mascot:true,composer:true,colors:7,viewport:true});
  const result=await cdp.evaluate(tab,`(async()=>{
    const {MirrorView}=await import('/work/mirror.js?v=${source.release}');
    const stage=document.createElement('div');stage.style.cssText='position:relative;width:393px;height:660px';document.body.append(stage);
    const out=[],fail=[];const view=new MirrorView(stage,{send:m=>out.push(m),onFallback:r=>fail.push(r)});await view.ready;view.show(true);
    await view.message({type:'mirror-reset',epoch:1,viewport:{w:393,h:660},sheets:[],tree:{i:1,t:'#document',c:[{i:2,t:'html',a:[],c:[{i:3,t:'head',a:[],c:[]},{i:4,t:'body',a:[],c:[{i:5,t:'input',a:[['id','fixture'],['type','text']],v:'native',c:[]},{i:6,t:'input',a:[['type','password']],secret:true,len:5,c:[]}]}]}]}});
    const input=view.doc.querySelector('#fixture');input.focus();input.value='native edit';input.dispatchEvent(new Event('input',{bubbles:true}));
    const checked={canaryBlocked:!view.doc.defaultView.__seekMirrorCanary,typed:out.some(m=>m.type==='minput'&&m.ins===' edit'),secretLength:view.doc.querySelector('[type=password]').value.length,failures:fail.length};view.destroy();stage.remove();return checked;
  })()`);
  assert.deepEqual(result,{canaryBlocked:true,typed:true,secretLength:5,failures:0});
  const layout=await cdp.evaluate(tab,`(async()=>{for(let n=0;n<50&&!window.SeekBrowser;n++)await new Promise(r=>setTimeout(r,20));SeekBrowser.open();for(let n=0;n<50&&!SeekBrowser.status().control;n++)await new Promise(r=>setTimeout(r,20));const main=document.querySelector('#bv-main'),s=SeekBrowser.status(),idleControlCorrect=s.control==='idle'&&main.hidden===!s.running&&main.textContent==='Take control';document.querySelector('#bv-layout').click();const e=document.querySelector('#bv-sheet'),r=e.getBoundingClientRect(),full=r.width===innerWidth&&r.height===visualViewport.height;document.querySelector('#bv-layout').click();const dock=e.getBoundingClientRect().width<innerWidth;SeekBrowser.close();return {full,dock,idleControlCorrect,browserRunning:s.running};})()`);assert.equal(layout.full,true);assert.equal(layout.dock,true);assert.equal(layout.idleControlCorrect,true);
  const row={release:source.release,headersAndFence:true,assets:true,editorial,client:result,layout,profile:'temporary; no live browser control'};
  await writeFile(new URL('./results/live-check.json',import.meta.url),JSON.stringify(row,null,2));console.log(JSON.stringify(row));
}finally{await cdp.close();}
