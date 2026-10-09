// Measures every visible text element in every view: font-size × weight histogram plus
// the elements that fall outside the type scale. node type-audit.mjs [phone]
import {createRequire} from 'node:module';
import {startProxy} from './devproxy.mjs';
const require=createRequire('C:/Users/Joel Robinson/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const phone=process.argv.includes('phone');
const SIZES=(process.env.SIZES||'12,13,14,15,17,20,28,34').split(',').map(Number),WEIGHTS=[400,500,600];
const proxy=await startProxy(18970),b=await chromium.launch({channel:'chrome',headless:true});
const page=await b.newPage(phone?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1440,height:900}});
const hist=new Map(),off=new Map();
async function collect(name){
 await page.waitForTimeout(900);
 const rows=await page.evaluate(()=>{const out=[];const skip='svg,iframe,.buddy,[data-buddy],.bv-sheet,.bv-shell,script,style,canvas,.fin-chart,.fin-donut';
  for(const el of document.querySelectorAll('body *')){
   if(el.closest(skip))continue;
   if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;
   const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;const s=getComputedStyle(el);if(s.visibility==='hidden'||s.opacity==='0')continue;
   let hidden=false;for(let p=el;p;p=p.parentElement){const ps=getComputedStyle(p);if(ps.display==='none'||ps.visibility==='hidden'){hidden=true;break;}if(p.hidden){hidden=true;break;}}if(hidden)continue;
   const path=[];for(let p=el;p&&p!==document.body&&path.length<3;p=p.parentElement)path.unshift(p.tagName.toLowerCase()+(p.id?'#'+p.id:'')+(typeof p.className==='string'&&p.className.trim()?'.'+p.className.trim().split(/\s+/).slice(0,2).join('.'):''));
   out.push({size:parseFloat(s.fontSize),weight:Number(s.fontWeight),family:s.fontFamily.split(',')[0],text:[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').slice(0,40),path:path.join(' > ')});
  }return out;});
 for(const r of rows){const key=`${r.size}px/${r.weight}`;hist.set(key,(hist.get(key)||0)+1);
  if(!SIZES.includes(Math.round(r.size*10)/10)||!WEIGHTS.includes(r.weight)){const k=key+'  '+r.path;if(!off.has(k))off.set(k,{view:name,text:r.text,n:0});off.get(k).n++;}}
}
async function view(id){await page.evaluate(id=>{const b=[...document.querySelectorAll(`[data-view="${id}"]`)].find(e=>e.offsetParent!==null)||document.querySelector(`[data-view="${id}"]`);b?.click();},id);await page.waitForTimeout(1200);}
try{
 await page.goto(proxy.base+'/work');await page.waitForSelector('#composer');await page.waitForTimeout(2500);await collect('home');
 for(const id of ['tasks','files','images','finance','workflows','ideas']){await view(id);await collect(id);}
 await view('inbox');await collect('inbox');for(const tab of ['upcoming','activity']){await page.evaluate(t=>document.querySelector(`[data-ap="${t}"]`)?.click(),tab);await collect('inbox-'+tab);}await page.keyboard.press('Escape');
 for(const id of ['settings','memory','connections','alerts','privacy','growth']){await view(id);await collect('settings-'+id);}
 for(const id of (process.env.SEEK_AUDIT_TASK_IDS||'').split(',').map(id=>id.trim()).filter(Boolean)){await page.goto(proxy.base+'/work?task='+encodeURIComponent(id));await page.waitForTimeout(3000);await collect('conv');}
 await page.keyboard.press('Control+k');await collect('palette');
}catch(e){console.error(e);}finally{
 const total=[...hist.values()].reduce((a,b)=>a+b,0),offTotal=[...off.values()].reduce((a,b)=>a+b.n,0);
 console.log(`text elements ${total}; off-scale ${offTotal}; distinct size/weight pairs ${hist.size}`);
 console.log([...hist].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  '));
 console.log('\nOFF-SCALE (most frequent first):');for(const [k,v] of [...off].sort((a,b)=>b[1].n-a[1].n).slice(0,Number(process.env.N||80)))console.log(`${String(v.n).padStart(4)}  ${k}   [${v.view}] "${v.text}"`);
 await b.close();proxy.server.closeAllConnections?.();proxy.server.close();process.exit(0);
}
