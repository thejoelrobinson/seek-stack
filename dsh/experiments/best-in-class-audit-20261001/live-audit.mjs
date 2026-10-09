import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
const origin='https://seek.joelcrobinson.com',out=new URL('./validation/',import.meta.url);
await mkdir(out,{recursive:true});
const basic='Basic '+Buffer.from(process.env.DSH_PROXY_USER+':'+process.env.DSH_PROXY_PASS).toString('base64');
const version=await fetch(origin+'/work/api/version',{headers:{Authorization:basic}}).then(r=>r.json());
const login=await fetch(origin+'/work',{headers:{Authorization:basic}}),cookie=login.headers.getSetCookie().find(v=>v.startsWith('dsh_auth='));assert.ok(cookie);
const [name,value]=cookie.split(';')[0].split('='),ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-full-audit-')),windowSize:'1440,1000'});
const errors=[],loads=[],layouts=[],flows=[];let tab,session,currentView='welcome';
async function wait(expression,label=expression){const end=Date.now()+15000;while(Date.now()<end){if(await ui.evaluate(tab,expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Audit UI timeout: '+label);}
async function geometry(label){return ui.evaluate(tab,`(()=>{const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'};const rect=s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return r?{width:Math.round(r.width),height:Math.round(r.height),visible:visible(e)}:null};const controls=[...document.querySelectorAll('button,a,input,select')].filter(visible);return {label:${JSON.stringify(label)},viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,main:rect('#main'),workspace:rect('.workspace'),sidebar:rect('.sidebar'),agentPanel:rect('#agent-panel'),topbar:rect('.topbar'),composer:rect('#composer-area'),visibleControls:controls.length,controlsBelow44px:controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<44||r.height<44}).length,formElementsWithoutNames:[...document.querySelectorAll('input,select,textarea')].filter(e=>visible(e)&&!e.getAttribute('aria-label')&&!e.labels?.length&&!e.getAttribute('title')).length}})()`);}
async function screenshot(file){
 // Redact personal content only in this isolated inspection tab. Reapply after SSE renders.
 await ui.evaluate(tab,`(()=>{
   const set=(e,v)=>{if(e&&e.textContent!==v)e.textContent=v};
   const redact=()=>{
     document.querySelectorAll('#recent [data-select]').forEach((e,i)=>set(e,'Saved conversation '+(i+1)));
     document.querySelectorAll('.task-card').forEach((e,i)=>{set(e.querySelector('h3'),'Saved task '+(i+1));set(e.querySelector('p'),'Task details hidden for this audit')});
     document.querySelectorAll('.idea').forEach((e,i)=>{const title=['Research a topic with sources','Organize information into a report','Create a useful plan'][i%3];for(const n of e.childNodes)if(n.nodeType===3&&n.textContent.trim()&&n.textContent!==title)n.textContent=title;set(e.querySelector('small'),'Personalized suggestion hidden for this audit')});
     set(document.querySelector('#ap-status'),'Current task details hidden');
     document.querySelectorAll('.ap-task').forEach(e=>set(e,'Saved task'));
     document.querySelectorAll('.ap-item p,.ap-activity span').forEach(e=>set(e,'Task details hidden for this audit'));
     document.querySelectorAll('.ap-activity strong').forEach(e=>set(e,'Saved task'));
     document.querySelectorAll('.image-card img').forEach(e=>{if(e.style.visibility!=='hidden')e.style.visibility='hidden';if(e.alt!=='Existing gallery image')e.alt='Existing gallery image'});
     document.querySelectorAll('.image-card p').forEach(e=>set(e,'Existing image prompt hidden'));
     const prompt=document.querySelector('#image-create textarea');if(prompt?.value)prompt.value='';
   };
   if(!window.__auditRedactor){window.__auditRedactor=new MutationObserver(redact);window.__auditRedactor.observe(document.body,{childList:true,subtree:true,characterData:true})}redact();return true
 })()`);
 await writeFile(new URL(file,out),Buffer.from(await ui.screenshot(tab,{format:'png'}),'base64'));
}
try{
 await ui.launch();tab=await ui.newTab('about:blank');session=ui.tabs.get(tab);await ui.send('Network.enable',{},session);await ui.send('Network.setCookie',{name,value,url:origin,httpOnly:true,secure:true,sameSite:'Lax'},session);
 await ui.send('Page.addScriptToEvaluateOnNewDocument',{source:"if(window===window.top){try{localStorage.setItem('seek-work-view',JSON.stringify({view:'chat',selected:null}));}catch{}}"},session);
 ui.onEvent(session,'Runtime.exceptionThrown',event=>errors.push({view:currentView,text:event.exceptionDetails.text,description:event.exceptionDetails.exception?.description?.split('\n')[0],frames:event.exceptionDetails.stackTrace?.callFrames?.slice(0,3).map(f=>({url:f.url.split('?')[0],line:f.lineNumber+1,function:f.functionName}))}));
 for(let i=0;i<3;i++){await ui.send('Network.clearBrowserCache',{},session);const start=performance.now();await ui.send('Page.navigate',{url:origin+'/work'},session);await wait("!!document.querySelector('.welcome')&&document.querySelector('#model-status')?.textContent.includes('Ready')");loads.push(Math.round(performance.now()-start));}
 for(const width of [1440,1200,768,390,320]){await ui.send('Emulation.setDeviceMetricsOverride',{width,height:width<800?900:1000,deviceScaleFactor:1,mobile:width<640},session);layouts.push(await geometry('welcome'));if([1440,390].includes(width))await screenshot('welcome-'+width+'.png');}
 await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},session);
 for(const [view,selector] of [['tasks','#task-search'],['inbox','#main'],['files','.file-cards'],['images','#image-create'],['connections','.connections']]){
  currentView=view;const start=performance.now();await ui.evaluate(tab,`document.querySelector('nav [data-view=${view}]').click();true`);
  if(view==='connections'){await wait("document.querySelector('#page-title')?.textContent==='Connections'");await new Promise(r=>setTimeout(r,500));}else if(view==='files'){await wait("document.querySelector('#page-title')?.textContent==='Made for you'");}else if(view==='inbox'){await wait("document.querySelector('#page-title')?.textContent==='Needs you'");}else await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
  const layout=await geometry(view);flows.push({view,visibleMs:Math.round(performance.now()-start),layout});
  if(view==='tasks'||view==='images')await screenshot(view+'-desktop.png');
  if(view==='images'){const form=await ui.evaluate(tab,"({cancelControl:!!document.querySelector('[data-image-cancel]'),queueControl:!!document.querySelector('[data-image-queue]'),editablePrompt:!!document.querySelector('#image-create textarea'),livePreviewToggle:!!document.querySelector('[name=livePreview]'),galleryActions:[...document.querySelector('.image-card')?.querySelectorAll('a,button')||[]].map(e=>e.textContent.trim()).filter(Boolean)})");flows.at(-1).imageControls=form;}
 }
 await ui.evaluate(tab,"document.querySelector('nav [data-view=chat]').click();document.querySelector('#new-task').click();true");await wait("!!document.querySelector('.welcome')");
 await ui.evaluate(tab,"document.querySelector('#schedule').click();true");await wait("document.querySelector('#schedule-dialog').open");const dialogFocus=await ui.evaluate(tab,"document.querySelector('#schedule-dialog').contains(document.activeElement)");await ui.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},session);await ui.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},session);await wait("!document.querySelector('#schedule-dialog').open");
 const result={auditedAt:new Date().toISOString(),version,method:'Authenticated public UI; isolated browser profile; no task submissions or account changes. Three Chrome-cache-cleared same-host loads with warm network connections; not field LCP or a latency percentile. Ready means welcome and model-status Ready visible. Screenshots redact saved titles, personalized ideas, task details and image content.',cacheClearedVisibleReadyMs:loads,layouts,flows,scheduleDialogFocusInside:dialogFocus,scheduleDialogEscapeCloses:true,javascriptExceptions:errors};
 await writeFile(new URL('live-audit.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify({version,loads,layouts,flowNames:flows.map(f=>f.view),exceptions:errors.length}));
}finally{await ui.close();}
