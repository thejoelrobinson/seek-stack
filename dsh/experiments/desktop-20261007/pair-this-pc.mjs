// Pairs the companion running on this PC (launched with --remote-debugging-port=9333) through the
// real panel form, against the public Seek address. Screenshots the panel before and after.
import {createRequire} from 'node:module';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const out=p=>decodeURIComponent(new URL(p,import.meta.url).pathname).replace(/^\/([A-Z]:)/i,'$1');
const {code}=await (await fetch('http://127.0.0.1:3080/work/api/desktop/code',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
const browser=await chromium.connectOverCDP('http://127.0.0.1:9333');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().endsWith('panel.html'));
await page.setViewportSize({width:480,height:760}).catch(()=>{});
await page.screenshot({path:out('panel-before.png')});
await page.fill('#pair [name=server]','https://seek.joelcrobinson.com');
await page.fill('#pair [name=code]',code);
await page.fill('#pair [name=name]','Joel’s PC');
await page.click('#pair button[type=submit]');
const online=await page.waitForFunction(()=>/Connected to/.test(document.querySelector('#link-body')?.textContent||''),null,{timeout:20000}).then(()=>true,()=>false);
await page.screenshot({path:out('panel-after.png')});
console.log('online in panel:',online,'| error:',await page.textContent('#link-error').catch(()=>''));
const desk=await (await fetch('http://127.0.0.1:3080/work/api/desktop')).json();
console.log('Seek sees:',JSON.stringify(desk.computers.map(c=>({name:c.name,os:c.os,online:c.online,remote:c.remoteGrant,version:c.version}))));
await browser.close();
