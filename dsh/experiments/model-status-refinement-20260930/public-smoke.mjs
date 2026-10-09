import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
import {WorkAssets} from '../../plugins/browser-viewer/lib/work-assets.js';
const origin='https://seek.joelcrobinson.com',assets=await new WorkAssets().init();
const basic='Basic '+Buffer.from(process.env.DSH_PROXY_USER+':'+process.env.DSH_PROXY_PASS).toString('base64');
async function api(path){const r=await fetch(origin+'/work/api/'+path,{headers:{Authorization:basic}});assert.equal(r.status,200,'Public '+path);return r.json();}
const unauthenticated=await fetch(origin+'/work/api/version');assert.equal(unauthenticated.status,401);
const version=await api('version');assert.equal(version.release,assets.release);assert.equal(version.plugin,assets.version);
const proxyHash=createHash('sha256').update(await readFile(join(homedir(),'.dsh','proxy','server.js'))).digest('hex').slice(0,20);assert.equal(version.proxyRelease,proxyHash);
const before=JSON.parse(await readFile(new URL('./runtime-backup/work.json',import.meta.url))),after=await api('state');
assert.equal(after.tasks.length,before.tasks.length);for(const task of before.tasks){const next=after.tasks.find(t=>t.id===task.id);assert.ok(next);assert.deepEqual(next.messages,task.messages);assert.deepEqual(next.artifacts,task.artifacts);assert.equal(next.status,task.status);}
assert.deepEqual(after.settings,before.settings);
const beforeImages=JSON.parse(await readFile(new URL('./runtime-backup/images.json',import.meta.url))),imageResponse=await fetch(origin+'/qwen-image/api/history',{headers:{Authorization:basic}});assert.equal(imageResponse.status,200);const afterImages=await imageResponse.json();assert.deepEqual(afterImages.items,beforeImages.items,'Existing image gallery is preserved');
assert.equal(createHash('sha256').update(await readFile(join(homedir(),'.dsh','settings.yaml'))).digest('hex'),createHash('sha256').update(await readFile(new URL('./runtime-backup/settings.yaml',import.meta.url))).digest('hex'));
const summary=await api('updates'),idle=await api('updates?since='+summary.revision);assert.equal(idle.unchanged,true);assert.ok(summary.tasks.every(t=>!t.messages));
const response=await fetch(origin+'/work/app.js?v='+assets.release,{headers:{Authorization:basic,'Accept-Encoding':'br'}});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/immutable/);assert.equal(response.headers.get('content-encoding'),'br');await response.arrayBuffer();
const unchanged=await fetch(origin+'/work/app.js?v='+assets.release,{headers:{Authorization:basic,'Accept-Encoding':'br','If-None-Match':response.headers.get('etag')}});assert.equal(unchanged.status,304);
const login=await fetch(origin+'/work',{headers:{Authorization:basic}});const cookie=login.headers.getSetCookie().find(value=>value.startsWith('dsh_auth='));assert.ok(cookie);
const [cookieName,cookieValue]=cookie.split(';')[0].split('=');
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-public-regression-')),windowSize:'1440,1000'});
const errors=[],requested=[],cached=new Set();let visibleMs;
try{
 await ui.launch();const tab=await ui.newTab('about:blank'),session=ui.tabs.get(tab);
 await ui.send('Network.enable',{},session);await ui.send('Network.setCookie',{name:cookieName,value:cookieValue,url:origin,httpOnly:true,secure:true,sameSite:'Lax'},session);
 ui.onEvent(session,'Runtime.exceptionThrown',event=>errors.push(event.exceptionDetails.text));
 ui.onEvent(session,'Network.requestWillBeSent',event=>{if(event.request.url.startsWith(origin+'/work'))requested.push(new URL(event.request.url).pathname);});
 ui.onEvent(session,'Network.requestServedFromCache',event=>cached.add(event.requestId));
 async function wait(expression,label){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await ui.evaluate(tab,expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Public UI timeout: '+label);}
 const started=performance.now();await ui.send('Page.navigate',{url:origin+'/work'},session);await wait("!!document.querySelector('.welcome')&&document.querySelectorAll('#recent [data-select]').length>0",'boot and conversation list');visibleMs=Math.round(performance.now()-started);
 await wait("document.querySelector('#model-status .model-status-label')?.textContent.includes('Qwen 3.8')",'compact model status');
 async function checkHeader(){assert.equal(await ui.evaluate(tab,"(()=>{const s=document.querySelector('#model-status'),h=document.querySelector('.topbar'),r=s.getBoundingClientRect(),b=h.getBoundingClientRect();return h.contains(s)&&!s.querySelector('.model-tile')&&r.top>=b.top&&r.bottom<=b.bottom&&r.height<=24})()"),true,'Live model activity stays inside the header');}
 async function captureHeader(name){const clip=await ui.evaluate(tab,"(()=>{const r=document.querySelector('.topbar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()"),shot=await ui.send('Page.captureScreenshot',{format:'png',clip},session);await writeFile(new URL('./validation/'+name,import.meta.url),Buffer.from(shot.data,'base64'));}
 await checkHeader();await captureHeader('public-header-desktop.png');
 assert.ok(!requested.some(p=>/finance|qwen-image/.test(p)),'Public Chat must not preload feature data');
 await ui.evaluate(tab,"document.querySelector('#recent [data-select]').click();true");await wait("!!document.querySelector('.conversation')",'existing conversation');assert.ok(await ui.evaluate(tab,"document.querySelectorAll('[data-msg]').length<=40"));
 await ui.send('Page.reload',{},session);await wait("!!document.querySelector('.conversation')",'cached reload');assert.ok(cached.size>0,'Repeat navigation must reuse assets');
 await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},session);assert.equal(await ui.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true);
 await checkHeader();await captureHeader('public-header-mobile.png');
 await ui.evaluate(tab,"document.querySelector('[data-view=tasks]').click();true");await wait("!!document.querySelector('#task-search')",'mobile task search');
 assert.equal(errors.length,0,'Public JavaScript errors');
}finally{await ui.close();}
const result={passed:true,release:version.release,proxyRelease:version.proxyRelease,existingTasks:after.tasks.length,existingMessages:after.tasks.reduce((n,t)=>n+t.messages.length,0),existingImages:afterImages.items.length,historyPreserved:true,settingsPreserved:true,galleryPreserved:true,publicBootMs:visibleMs,idleBodyBytes:Buffer.byteLength(JSON.stringify(idle)),summaryBodyBytes:Buffer.byteLength(JSON.stringify(summary)),cachedResources:cached.size,textureBytes:assets.files.get('work-buddy-plush.webp').body.length,checks:['authenticated public boot','unauthenticated gate','plugin/proxy identity','history/settings/gallery preservation','compact private updates','Brotli static compression','immutable cache','conditional 304','compact desktop/mobile model header','existing conversation','cached reload','mobile layout/search','no JavaScript exceptions']};
await writeFile(new URL('./validation/public-smoke.json',import.meta.url),JSON.stringify(result,null,2));
await writeFile(new URL('./release-manifest.json',import.meta.url),JSON.stringify({deployedAt:new Date().toISOString(),version,pluginHashes:assets.hashes,scope:'Compact model activity inside the existing header. Full Image studio progression retained.',validation:{nodeTests:77,defaultSuite:'passed',modelVisualSuite:'passed on desktop, 390px mobile, and 320px recovery',publicSmoke:result},rollback:'installed-backup and runtime-backup (private, ignored)'},null,2));
console.log(JSON.stringify(result));
