import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
const socket=new WebSocket('ws://127.0.0.1:3080/browser/stream');
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
const running=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Native browser start timeout')),15000);socket.onmessage=event=>{if(typeof event.data!=='string')return;const value=JSON.parse(event.data);if(value.type==='status'&&value.running){clearTimeout(timeout);assert.ok(!value.error,value.error);resolve();}};});
socket.send(JSON.stringify({type:'start',url:'about:blank'}));await running;socket.close();
// Restore the privately captured tab URLs into the same retained profile.
let saved=[];try{saved=JSON.parse(await readFile(new URL('./runtime-backup/browser-tabs.json',import.meta.url),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const [port,path]=String(await readFile(join(homedir(),'.dsh','browser','profile','DevToolsActivePort'),'utf8')).trim().split(/\r?\n/),cdp=new WebSocket(`ws://127.0.0.1:${port}${path}`),pending=new Map();let nextId=0;
await new Promise((resolve,reject)=>{cdp.onopen=resolve;cdp.onerror=reject;});
cdp.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const row=pending.get(message.id);clearTimeout(row.timer);pending.delete(message.id);message.error?row.reject(new Error(message.error.message)):row.resolve(message.result);}};
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser restore timeout'));},10000);pending.set(id,{resolve,reject,timer});cdp.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
try{
 const targets=(await send('Target.getTargets')).targetInfos.filter(t=>t.type==='page');
 if(saved.length&&targets.length){const {sessionId}=await send('Target.attachToTarget',{targetId:targets[0].targetId,flatten:true});await send('Page.navigate',{url:saved[0].url},sessionId);for(const tab of saved.slice(1))await send('Target.createTarget',{url:tab.url});await send('Target.activateTarget',{targetId:targets[0].targetId});}
}finally{cdp.close();}
const health=(await fetch('http://127.0.0.1:3080/work/api/updates').then(r=>r.json())).health.models;
assert.equal(health.active,false);assert.equal(health.recoveryRequired,false);assert.equal(health.language.state,'ready');assert.equal(health.image.state,'standby');
const result={passed:true,restoredBrowserTabs:saved.length,checks:['Native browser starts with retained profile and previous tab URLs','Chat ready','Image model on demand','No active handoff or recovery']};
await writeFile(new URL('./validation/final-health.json',import.meta.url),JSON.stringify(result,null,2));
const manifest=JSON.parse(await readFile(new URL('./release-manifest.json',import.meta.url)));manifest.validation.finalHealth=result;manifest.validation.handoff=JSON.parse(await readFile(new URL('./validation/handoff-validation.json',import.meta.url)));manifest.validation.diskRead=JSON.parse(await readFile(new URL('./validation/disk-read.json',import.meta.url)));await writeFile(new URL('./release-manifest.json',import.meta.url),JSON.stringify(manifest,null,2));console.log(JSON.stringify(result));
