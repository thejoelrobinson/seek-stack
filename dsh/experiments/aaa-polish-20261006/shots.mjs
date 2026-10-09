// Full-resolution screenshots of every /work view through the read-only preview proxy.
// node shots.mjs <outdir> [phone] [dark]
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startProxy} from './devproxy.mjs';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const out=new URL((process.argv[2]||'shots')+'/',import.meta.url),phone=process.argv.includes('phone'),dark=process.argv.includes('dark');
const only=process.env.ONLY?new RegExp(process.env.ONLY):null;
await mkdir(out,{recursive:true});
const proxy=await startProxy(18890+Math.floor(Math.random()*90));
const browser=await chromium.launch({channel:'chrome',headless:true});
const ctx=await browser.newContext(phone?{viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,colorScheme:dark?'dark':'light'}:{viewport:{width:1440,height:900},deviceScaleFactor:1,colorScheme:dark?'dark':'light'});
const page=await ctx.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const p=phone?'p':'d',suffix=dark?'-dark':'';
async function shot(name,full=false){if(only&&!only.test(name))return;await page.waitForTimeout(700);await page.screenshot({path:decodeURIComponent(new URL(`${p}-${name}${suffix}.png`,out).pathname).replace(/^\/([A-Z]:)/i,'$1'),fullPage:full,animations:'disabled'});console.log('shot',name);}
async function view(id){await page.evaluate(id=>{const b=[...document.querySelectorAll(`[data-view="${id}"]`)].find(e=>e.offsetParent!==null)||document.querySelector(`[data-view="${id}"]`);b?.click();},id);await page.waitForTimeout(900);}
try{
 await page.goto(proxy.base+'/work');await page.waitForSelector('#composer');await page.waitForTimeout(2500);
 if(dark)await page.evaluate(()=>{try{localStorage.setItem('seek-appearance','dark');}catch{}});
 if(dark){await page.reload();await page.waitForTimeout(2500);}
 await shot('01-home');await shot('01-home-full',true);
 for(const [id,name] of [['tasks','10-tasks'],['files','12-library'],['images','11-studio'],['finance','14-finance'],['workflows','13-workflows']]){await view(id);await shot(name);}
 await view('inbox');await shot('20-inbox');await page.keyboard.press('Escape');await page.waitForTimeout(400);
 await view('settings');await shot('30-settings');
 for(const id of ['memory','connections','alerts','privacy','growth']){await view(id);await shot('3x-settings-'+id);}
 for(const [i,id] of (process.env.SEEK_AUDIT_TASK_IDS||'').split(',').map(id=>id.trim()).filter(Boolean).entries()){await page.goto(proxy.base+'/work?task='+encodeURIComponent(id));await page.waitForTimeout(3000);await shot('40-conv-'+i);}
 await page.goto(proxy.base+'/work');await page.waitForTimeout(2000);await page.keyboard.press('Control+k');await page.waitForTimeout(500);await shot('50-palette');
}finally{console.log('errors',JSON.stringify([...new Set(errors)].slice(0,20)));await browser.close();proxy.server.closeAllConnections?.();proxy.server.close();process.exit(0);}
