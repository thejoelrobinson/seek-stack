// Read-only public release check. Use an isolated profile and never submit work.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';

const origin=process.env.SEEK_AUDIT_ORIGIN||'https://seek.joelcrobinson.com';
const out=new URL('./validation/post-deploy/',import.meta.url);
const expectedVersion=process.env.SEEK_AUDIT_EXPECT_VERSION||'0.5.0';
const expectedRelease=process.env.SEEK_AUDIT_EXPECT_RELEASE;
const user=process.env.DSH_PROXY_USER,password=process.env.DSH_PROXY_PASS;
assert.ok(user&&password,'Owner authentication must be supplied in environment variables.');
const loginPage=await fetch(origin+'/login?next=%2Fwork'),loginHTML=await loginPage.text();
const loginNonce=loginPage.headers.getSetCookie().find(item=>item.startsWith('dsh_login_csrf='))?.split(';')[0];
const csrf=/<input[^>]+name="csrf"[^>]+value="([^"]+)"/.exec(loginHTML)?.[1];
assert.ok(loginNonce&&csrf,'The protected sign-in form was unavailable.');
const login=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:origin,Referer:origin+'/login',Cookie:loginNonce},body:new URLSearchParams({username:user,password,csrf,next:'/work'})});
assert.equal(login.status,303,'Owner sign-in failed.');
const cookie=login.headers.getSetCookie().find(item=>item.startsWith('dsh_auth='));
assert.ok(cookie,'Owner authentication did not return a session cookie.');
const pair=cookie.split(';')[0],separator=pair.indexOf('='),name=pair.slice(0,separator),value=pair.slice(separator+1);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function read(path){const response=await fetch(origin+path,{headers:{Cookie:pair}});assert.ok(response.ok,'Read-only endpoint failed: '+path+' HTTP '+response.status);return response.json();}
function inventory(store){
 const tasks=store.tasks||[],artifacts=tasks.flatMap(t=>(t.artifacts||[]).map(a=>[t.id,a.id,a.sha256||null,a.version||1]));
 return {tasks:tasks.length,artifacts:artifacts.length,messages:tasks.reduce((n,t)=>n+(t.messages?.length||0),0),templates:store.templates?.length||0,taskIdsSHA256:digest(tasks.map(t=>t.id).sort()),artifactsSHA256:digest(artifacts.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))),conversationsSHA256:digest(tasks.map(t=>[t.id,t.title,t.objective,t.messages]).sort((a,b)=>a[0].localeCompare(b[0]))),settingsSHA256:digest(store.settings)};
}
const version=await read('/work/api/version');
assert.equal(version.plugin,expectedVersion,'Unexpected deployed plugin version.');
if(expectedRelease)assert.equal(version.release,expectedRelease,'Unexpected deployed asset release.');
const before=inventory(await read('/work/api/state'));
await mkdir(out,{recursive:true});
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-release-audit-')),windowSize:'1440,1000'});
const result={auditedAt:new Date().toISOString(),version,before,cacheClearedReadyMs:[],layouts:[],flows:[],keyboard:[],reducedMotion:null,javascriptExceptions:[],observedImageState:null};
let tab,session,currentView='welcome';
async function wait(expression,label){const end=Date.now()+20000;while(Date.now()<end){if(await ui.evaluate(tab,expression))return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('UI audit timeout: '+label);}
const action=code=>ui.evaluate(tab,code+';true');
async function key(key,shift=false){const code=key==='Escape'?'Escape':key==='Tab'?'Tab':key,windowsVirtualKeyCode=key==='Escape'?27:key==='Tab'?9:undefined;await ui.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers:shift?8:0,windowsVirtualKeyCode},session);await ui.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers:shift?8:0,windowsVirtualKeyCode},session);}
async function viewport(width,height=900,scale=1){await ui.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:width<640},session);await action('window.dispatchEvent(new Event("resize"))');}
async function layout(label){
 return ui.evaluate(tab,`(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[inert]')};const rect=selector=>{const e=document.querySelector(selector);if(!e)return null;const r=e.getBoundingClientRect();return {visible:visible(e),width:Math.round(r.width),height:Math.round(r.height)}};const controls=[...document.querySelectorAll('button,a[href],input,select,textarea')].filter(visible);return {label:${JSON.stringify(label)},width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,model:rect('#model-status'),main:rect('#main'),composer:rect('#composer-area'),sidebar:rect('#workspace-nav'),panel:rect('#agent-panel'),visibleControls:controls.length,controlsBelow44px:controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<44||r.height<44}).length,unnamedFormControls:controls.filter(e=>/INPUT|SELECT|TEXTAREA/.test(e.tagName)&&!e.getAttribute('aria-label')&&!e.labels?.length&&!e.getAttribute('title')).length}})()`);
}
async function capture(filename){
 await action(`(()=>{
  const set=(e,text)=>{if(e&&e.textContent!==text)e.textContent=text};
  const redact=()=>{
   document.querySelectorAll('#recent [data-select]').forEach((e,i)=>set(e,'Saved conversation '+(i+1)));
   document.querySelectorAll('.task-card').forEach((e,i)=>{set(e.querySelector('h3'),'Saved task '+(i+1));set(e.querySelector('p'),'Private task details hidden')});
   document.querySelectorAll('.library-card strong').forEach(e=>set(e,'Saved output'));
   document.querySelectorAll('.library-source').forEach(e=>set(e,'Source conversation'));
   document.querySelectorAll('.library-card img,.image-card img,.studio-output img').forEach(e=>{e.style.visibility='hidden';e.alt='Private image hidden'});
   document.querySelectorAll('.image-card p,.studio-queue p,.studio-trash>div>span').forEach(e=>set(e,'Private image prompt hidden'));
   document.querySelectorAll('.studio-error').forEach(e=>set(e,'Image error details hidden'));
   document.querySelectorAll('.ap-task,.ap-activity strong').forEach(e=>set(e,'Saved task'));
   document.querySelectorAll('.ap-item p,.ap-item pre,.ap-activity span').forEach(e=>set(e,'Private task details hidden'));
   set(document.querySelector('#ap-status'),'Task details hidden');
   document.querySelectorAll('.idea').forEach((e,i)=>{const title=['Research a topic with sources','Organize a useful report','Make a practical plan'][i%3];for(const node of e.childNodes)if(node.nodeType===3&&node.textContent.trim()&&node.textContent!==title)node.textContent=title;set(e.querySelector('small'),'Personalized suggestion hidden')});
   document.querySelectorAll('.workflow-card:has([data-workflow-edit]) h3,.workflow-card:has([data-workflow-edit]) p').forEach(e=>set(e,'Saved workflow details hidden'));
   document.querySelectorAll('.ap-approval-label,.work-blocker').forEach(e=>set(e,'Private task details hidden'));
  };
  if(!window.__releaseRedactor){window.__releaseRedactor=new MutationObserver(redact);window.__releaseRedactor.observe(document.body,{childList:true,subtree:true,characterData:true})}redact();
 })()`);
 await writeFile(new URL(filename,out),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
}
async function navigate(view){
 currentView=view;await action(`document.querySelector('nav [data-view=${view}]').click()`);
 const ready={chat:'.welcome',tasks:'#task-search',images:'#image-create',files:'.library',workflows:'.workflow-grid',connections:'.connection-outcomes'}[view];
 if(ready)await wait(`!!document.querySelector(${JSON.stringify(ready)})`,'navigation '+view);
}
async function modal(selector,open,returnSelector){
 await action(`document.querySelector(${JSON.stringify(returnSelector)}).focus();${open}`);await wait(`document.querySelector(${JSON.stringify(selector)}).open`,'dialog opens');
 const initial=await ui.evaluate(tab,`document.querySelector(${JSON.stringify(selector)}).contains(document.activeElement)`);
 const probe={dialog:selector,initialFocusInside:initial,focusSamples:[]};result.keyboard.push(probe);
 for(let i=0;i<14;i++){
  await key('Tab');const focus=await ui.evaluate(tab,"({tag:document.activeElement?.tagName,id:document.activeElement?.id||null})");probe.focusSamples.push(focus);
  if(!await ui.evaluate(tab,`document.querySelector(${JSON.stringify(selector)}).contains(document.activeElement)`)){
   // Native dialogs can send Tab to Chrome's own controls, represented by BODY.
   // They must still block focus on the underlying app and cycle back next Tab.
   assert.equal(focus.tag,'BODY','Background app control received modal focus.');
   assert.equal(await ui.evaluate(tab,"(()=>{document.querySelector('#prompt').focus();return document.activeElement!==document.querySelector('#prompt')})()"),true,'Native modal allowed focus on the background composer.');
   await key('Tab');assert.equal(await ui.evaluate(tab,`document.querySelector(${JSON.stringify(selector)}).contains(document.activeElement)`),true,'Native dialog did not cycle back from Chrome controls.');probe.nativeChromeCycle=true;
  }
 }
 await key('Tab',true);await key('Escape');await wait(`!document.querySelector(${JSON.stringify(selector)}).open`,'dialog closes');
 const restored=await ui.evaluate(tab,`document.activeElement===document.querySelector(${JSON.stringify(returnSelector)})`);assert.ok(initial&&restored,'Dialog focus did not enter or restore.');
 result.keyboard.push({dialog:selector,focusInside:true,backgroundFocusBlocked:true,tabCyclesWithinPageOrChrome:true,escapeCloses:true,focusRestored:true});
}
try{
 await ui.launch();tab=await ui.newTab('about:blank');session=ui.tabs.get(tab);
 await ui.send('Network.enable',{},session);await ui.send('Network.setCookie',{name,value,url:origin,httpOnly:true,secure:true,sameSite:'Lax'},session);await ui.send('Runtime.enable',{},session);
 ui.onEvent(session,'Runtime.exceptionThrown',event=>{const d=event.exceptionDetails;result.javascriptExceptions.push({view:currentView,exceptionSHA256:digest(d.exception?.description||d.text),frames:d.stackTrace?.callFrames?.slice(0,3).map(f=>({path:new URL(f.url||origin,origin).pathname,line:f.lineNumber+1}))});});
 await ui.send('Page.addScriptToEvaluateOnNewDocument',{source:`if(window===window.top){localStorage.setItem('seek-work-view',JSON.stringify({view:'chat',selected:null}));localStorage.setItem('seek-panel-pinned','false');sessionStorage.removeItem('seek-drafts');}`},session);
 for(let i=0;i<3;i++){await ui.send('Network.clearBrowserCache',{},session);const start=performance.now();await ui.send('Page.navigate',{url:origin+'/work'},session);await wait("!!document.querySelector('.welcome')&&!!document.querySelector('#model-status .model-indicator:not(.state-checking)')",'welcome and measured model state');result.cacheClearedReadyMs.push(Math.round(performance.now()-start));}
 for(const width of [1440,1200,768,390,320]){
  await viewport(width,width<800?900:1000);
  for(const view of ['chat','tasks','images','files']){await navigate(view);const measurement=await layout(view);assert.equal(measurement.overflow,false,'Horizontal overflow: '+view+' '+width);assert.equal(measurement.unnamedFormControls,0,'Unnamed form controls: '+view+' '+width);result.layouts.push(measurement);}
  await navigate('chat');if(width===1440||width===390)await capture('welcome-'+width+'.png');
 }
 await viewport(1440,1000);
 for(const view of ['tasks','images','files','workflows','connections']){const start=performance.now();await navigate(view);result.flows.push({view,visibleMs:Math.round(performance.now()-start),layout:await layout(view)});if(['tasks','images','files'].includes(view))await capture(view+'-desktop.png');}
 await navigate('images');
 result.observedImageState=await ui.evaluate(tab,`(async()=>{const {getModels}=await import('/work/models.js?v=${encodeURIComponent(version.release)}');const model=getModels(),active=!!model?.active,job=model?.job;return {active,phase:job?.phase||null,compactHeader:!!document.querySelector('#model-status .model-indicator')&&!document.querySelector('#model-status .model-pair'),outputFirst:!!document.querySelector('.studio-output')&&document.querySelector('.studio-output').compareDocumentPosition(document.querySelector('#image-create'))===4,promptEditable:!!document.querySelector('#image-create textarea:not([disabled])'),livePreviewToggle:!!document.querySelector('#image-create [name=livePreview]'),samplingProgress:!!document.querySelector('.model-track[aria-valuenow]'),studioCharacter:!!document.querySelector('[data-buddy=studio]'),painterVisible:!!document.querySelector('[data-buddy=studio][data-s=paint],[data-buddy=studio][data-s=paint-finish]'),queueJobs:document.querySelectorAll('.studio-queue [data-image-cancel]').length,deferControls:document.querySelectorAll('.studio-queue [data-image-defer]').length,cancelControl:!!document.querySelector('.studio-progress [data-image-cancel]')}})()`);
 assert.ok(result.observedImageState.compactHeader&&result.observedImageState.outputFirst&&result.observedImageState.promptEditable&&result.observedImageState.livePreviewToggle,'Studio primary controls missing.');
 await navigate('chat');
 await modal('#schedule-dialog',"document.querySelector('#schedule').click()",'#schedule');
 await modal('#search-dialog',"document.querySelector('#search-work').click()",'#search-work');
 await viewport(390,844);await navigate('tasks');assert.equal(await ui.evaluate(tab,"getComputedStyle(document.querySelector('#buddy-top')).visibility"),'visible','Panel test needs a visible trigger.');await action("document.querySelector('#buddy-top').focus()");assert.equal(await ui.evaluate(tab,"document.activeElement.id"),'buddy-top','Visible panel trigger must receive focus.');await action("document.querySelector('#buddy-top').click()");
 const panelProbe={dialog:'mobile panel',before:await ui.evaluate(tab,"({inert:document.querySelector('.workspace').inert,role:document.querySelector('#agent-panel').getAttribute('aria-modal'),focus:document.activeElement?.id||document.activeElement?.tagName,open:document.body.classList.contains('panel-open')})")};result.keyboard.push(panelProbe);
 assert.equal(await ui.evaluate(tab,"document.querySelector('.workspace').inert&&document.querySelector('#agent-panel').getAttribute('aria-modal')==='true'"),true,'Mobile panel background is not inert.');assert.equal(await ui.evaluate(tab,"(()=>{document.querySelector('#menu').focus();return document.querySelector('#agent-panel').contains(document.activeElement)})()"),true,'Panel allowed background focus.');for(let i=0;i<20;i++){await key('Tab');assert.equal(await ui.evaluate(tab,"document.querySelector('#agent-panel').contains(document.activeElement)"),true,'Panel focus escaped.');}await key('Escape');await new Promise(resolve=>setTimeout(resolve,60));panelProbe.after=await ui.evaluate(tab,"({inert:document.querySelector('.workspace').inert,focus:document.activeElement?.id||document.activeElement?.tagName,open:document.body.classList.contains('panel-open'),buddyVisible:getComputedStyle(document.querySelector('#buddy-top')).visibility==='visible',buddyDisabled:document.querySelector('#buddy-top').disabled,openDialogs:[...document.querySelectorAll('dialog[open]')].map(x=>x.id)})");assert.equal(await ui.evaluate(tab,"!document.querySelector('.workspace').inert&&document.activeElement.id==='buddy-top'"),true,'Panel focus not restored.');
 await action("document.querySelector('#mobile-more').click()");assert.equal(await ui.evaluate(tab,"document.querySelector('#menu').getAttribute('aria-expanded')==='true'&&document.querySelector('.workspace').inert"),true,'Mobile More did not open an accessible drawer.');for(let i=0;i<20;i++){await key('Tab');assert.equal(await ui.evaluate(tab,"document.querySelector('#workspace-nav').contains(document.activeElement)"),true,'Navigation focus escaped.');}await capture('more-mobile.png');await key('Escape');assert.equal(await ui.evaluate(tab,"!document.querySelector('.workspace').inert&&document.activeElement.id==='menu'"),true,'Navigation focus not restored.');result.keyboard.push({dialog:'mobile panel and More',backgroundInert:true,tabContained:true,escapeCloses:true,focusRestored:true});
 await viewport(720,500,2);await navigate('chat');const zoom=await layout('200% equivalent reflow');assert.equal(zoom.overflow,false,'200% equivalent reflow overflows.');result.layouts.push({...zoom,method:'720 CSS pixels at device scale factor 2 for a 1440 pixel display; equivalent reflow, not browser zoom telemetry.'});
 await ui.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},session);await action('window.dispatchEvent(new Event("resize"))');result.reducedMotion=await ui.evaluate(tab,"({requested:matchMedia('(prefers-reduced-motion:reduce)').matches,mainScroll:getComputedStyle(document.querySelector('#main')).scrollBehavior})");assert.equal(result.reducedMotion.requested,true);assert.equal(result.reducedMotion.mainScroll,'auto');
 result.after=inventory(await read('/work/api/state'));result.journey='Public authenticated read-only UI with an isolated browser profile. No task/image submissions, control actions, account changes or downloads. Screenshots mask saved tasks, prompts, outputs and image pixels.';
 result.measurementLimit='Three cache-cleared same-host loads with warm network connections; not field Core Web Vitals or p95. Active painter/sampling/cancel and queue controls are recorded only if real jobs exist; their transitions are established by isolated fixture tests.';
 result.passed=result.javascriptExceptions.length===0;await writeFile(new URL('post-deploy-ui-audit.json',out),JSON.stringify(result,null,2));
 assert.equal(result.javascriptExceptions.length,0,'Unexpected JavaScript exceptions.');
 console.log(JSON.stringify({passed:result.passed,version:version.plugin,release:version.release,viewportChecks:result.layouts.length,exceptions:result.javascriptExceptions.length,counts:{before:{tasks:before.tasks,artifacts:before.artifacts},after:{tasks:result.after.tasks,artifacts:result.after.artifacts}}}));
}catch(error){result.passed=false;result.failure={view:currentView,class:error.name,messageSHA256:digest(error.message)};await writeFile(new URL('post-deploy-ui-audit.json',out),JSON.stringify(result,null,2));throw new Error('Post-deploy UI audit failed in '+currentView+'. Read the recorded counts and failure hash; private page content was not printed.');}finally{await ui.close();}
