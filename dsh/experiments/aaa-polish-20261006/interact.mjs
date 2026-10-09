import {createRequire} from 'node:module';
import {startProxy} from './devproxy.mjs';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const proxy=await startProxy(18980),b=await chromium.launch({channel:'chrome',headless:true}),errors=[];
const out=n=>decodeURIComponent(new URL(`after/${n}.png`,import.meta.url).pathname).replace(/^\/([A-Z]:)/i,'$1');
try{
 const d=await b.newPage({viewport:{width:1440,height:900}});d.on('pageerror',e=>errors.push(e.message));
 await d.goto(proxy.base+'/work');await d.waitForTimeout(2500);
 await d.click('#experience-layout');await d.waitForTimeout(600);
 console.log('layout',await d.evaluate(()=>[document.documentElement.dataset.layout,document.querySelector('#experience-layout').getAttribute('aria-label'),getComputedStyle(document.querySelector('.sidebar')).width]));
 await d.screenshot({path:out('d-60-compact')});
 await d.click('#experience-layout');await d.waitForTimeout(400);
 console.log('restored',await d.evaluate(()=>document.documentElement.dataset.layout));
 await d.click('[data-view="tasks"]');await d.waitForTimeout(500);await d.hover('.task-card');await d.screenshot({path:out('d-61-task-hover')});
 const p=await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});p.on('pageerror',e=>errors.push(e.message));
 await p.goto(proxy.base+'/work');await p.waitForTimeout(2500);await p.tap('#mobile-more');await p.waitForTimeout(600);await p.screenshot({path:out('p-60-drawer')});
 console.log('overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}finally{console.log('errors',JSON.stringify(errors));await b.close();proxy.server.closeAllConnections?.();proxy.server.close();process.exit(0);}
