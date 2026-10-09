// node probe.mjs "<path>" "<view or ->" "<selector>" ["<selector>"...]  → computed styles + matching rules' sources
import {createRequire} from 'node:module';
import {startProxy} from './devproxy.mjs';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const [path,viewId,...selectors]=process.argv.slice(2);
const proxy=await startProxy(18990+Math.floor(Math.random()*9));
const b=await chromium.launch({channel:'chrome',headless:true}),p=await b.newPage({viewport:{width:Number(process.env.W||1440),height:900}});
try{
 await p.goto(proxy.base+path);await p.waitForSelector('#composer');await p.waitForTimeout(2500);
 if(viewId&&viewId!=='-'){await p.evaluate(id=>document.querySelector(`[data-view="${id}"]`)?.click(),viewId);await p.waitForTimeout(1500);}
 for(const sel of selectors){
  const out=await p.evaluate(sel=>{const e=document.querySelector(sel);if(!e)return 'missing';const s=getComputedStyle(e),r=e.getBoundingClientRect();
   const props=['font-family','font-size','font-weight','line-height','letter-spacing','padding','margin','border','border-radius','background-color','color','box-shadow','display','grid-template-columns','gap','height','max-width'];
   const rules=[];for(const sheet of document.styleSheets){let list;try{list=sheet.cssRules;}catch{continue;}const walk=l=>{for(const rule of l){if(rule.cssRules&&!rule.selectorText){if(!rule.media||matchMedia(rule.media.mediaText).matches)walk(rule.cssRules);continue;}try{if(rule.selectorText&&e.matches(rule.selectorText))rules.push((sheet.href||'inline').split('/').pop().split('?')[0]+' :: '+rule.cssText.slice(0,220));}catch{}}};walk(list);}
   return {rect:[r.x,r.y,r.width,r.height].map(Math.round),...Object.fromEntries(props.map(k=>[k,s.getPropertyValue(k)])),rules:rules.slice(-14)};},sel);
  console.log('==',sel,JSON.stringify(out,null,1));
 }
}catch(e){console.error(e);}finally{await b.close();proxy.server.closeAllConnections?.();proxy.server.close();process.exit(0);}
