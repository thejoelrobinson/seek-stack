// Passive authenticated Studio observer. The release owner starts both jobs elsewhere.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
const origin='https://seek.joelcrobinson.com',expected=process.env.SEEK_AUDIT_EXPECT_RELEASE||'eda738fa3280a75fccd8';
const out=new URL('./validation/studio-startup/',import.meta.url),hash=value=>createHash('sha256').update(String(value)).digest('hex');
const prompt='Seek release validation only: a single simple red ceramic mug on a pale plain background, no words, no people.';
const username=process.env.DSH_PROXY_USER,password=process.env.DSH_PROXY_PASS;assert.ok(username&&password,'Owner environment credentials required.');
const page=await fetch(origin+'/login?next=%2Fwork'),html=await page.text(),nonce=page.headers.getSetCookie().find(x=>x.startsWith('dsh_login_csrf='))?.split(';')[0],csrf=/<input[^>]+name="csrf"[^>]+value="([^"]+)"/.exec(html)?.[1];assert.ok(nonce&&csrf,'Sign-in form unavailable.');
const login=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:origin,Referer:origin+'/login',Cookie:nonce},body:new URLSearchParams({username,password,csrf,next:'/work'})});assert.equal(login.status,303,'Owner sign-in failed.');
const cookie=login.headers.getSetCookie().find(x=>x.startsWith('dsh_auth='))?.split(';')[0];assert.ok(cookie,'Owner session missing.');
const separator=cookie.indexOf('='),name=cookie.slice(0,separator),value=cookie.slice(separator+1);
async function read(path){const r=await fetch(origin+path,{headers:{Cookie:cookie},signal:AbortSignal.timeout(15000)});assert.ok(r.ok,'Read endpoint unavailable.');return r.json();}
const version=await read('/work/api/version');assert.equal(version.release,expected);assert.equal(version.plugin,'0.5.0');await mkdir(out,{recursive:true});
const ui=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-real-image-observer-')),windowSize:'1440,1050'}),jobs=new Map(),errors=[],samples=[],checked=new Map();let tab,session,finished=false;const privateErrors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(expression,label){const until=Date.now()+20000;while(Date.now()<until){if(await ui.evaluate(tab,expression))return;await pause(50);}throw new Error('Observer UI timeout: '+label);}
const action=code=>ui.evaluate(tab,code+';true');
async function save(){await writeFile(new URL('observer.json',out),JSON.stringify({at:new Date().toISOString(),version,jobs:[...jobs.values()],samples,javascriptExceptions:errors,finished,method:'Read-only public Studio. No model/image/task/control submissions. Only the two release red-mug jobs are recorded; existing conversations and images are masked.'},null,2));}
try{
 await ui.launch();tab=await ui.newTab('about:blank');session=ui.tabs.get(tab);await ui.send('Network.enable',{},session);await ui.send('Network.setCookie',{name,value,url:origin,httpOnly:true,secure:true,sameSite:'Lax'},session);await ui.send('Runtime.enable',{},session);
 ui.onEvent(session,'Runtime.exceptionThrown',e=>{errors.push({at:Date.now(),messageSHA256:hash(e.exceptionDetails.exception?.description||e.exceptionDetails.text),frames:e.exceptionDetails.stackTrace?.callFrames?.map(f=>({path:new URL(f.url||origin,origin).pathname,line:f.lineNumber+1}))});privateErrors.push(e.exceptionDetails)});
 await ui.send('Page.addScriptToEvaluateOnNewDocument',{source:"if(window===window.top){localStorage.setItem('seek-work-view',JSON.stringify({view:'chat',selected:null}));localStorage.setItem('seek-panel-pinned','false');}"},session);await ui.navigate(tab,origin+'/work');await wait("!!document.querySelector('.welcome')",'welcome');await action("document.querySelector('[data-view=images]').click()");await wait("!!document.querySelector('#image-create')",'Studio');
 await action(`(async()=>{const {getModels}=await import('/work/models.js?v=${expected}');window.__observerModels=getModels;window.__observerOwned={};const set=(e,t)=>{if(e.textContent!==t)e.textContent=t};const redact=()=>{document.querySelectorAll('#recent [data-select]').forEach((e,i)=>set(e,'Saved conversation '+(i+1)));document.querySelectorAll('.image-card img,.studio-trash img').forEach(e=>e.style.visibility='hidden');document.querySelectorAll('.image-card p,.studio-trash>div>span,.studio-queue p').forEach(e=>set(e,'Private image prompt hidden'));const owned=!!window.__observerOwned[getModels()?.job?.id];document.querySelectorAll('.studio-output img').forEach(e=>e.style.visibility=owned?'visible':'hidden');};new MutationObserver(redact).observe(document.body,{childList:true,subtree:true,characterData:true});redact();})()`);
 await wait("!!window.__observerModels",'read-only model observer');await save();console.log('Studio observer ready; waiting for the two release smoke jobs.');
 await pause(5000);await mkdir('C:/Users/Joel Robinson/.dsh/browser/validation/studio-startup',{recursive:true});await writeFile('C:/Users/Joel Robinson/.dsh/browser/validation/studio-startup/exceptions.json',JSON.stringify(privateErrors,null,2));await save();console.log(JSON.stringify({errors}));
}finally{await ui.close();}
