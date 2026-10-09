// Times each phase of a browser action on real, heavy pages in a separate headless Chrome:
// page load (cdp navigate), settle, snapshot, and whole tool calls — with and without ad/tracker
// blocking. Usage: node --import <register-profile> bench-browser.mjs [block]
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserController, buildTools} from '../../plugins/browser-viewer/lib/index.js';

const BLOCK=['*doubleclick.net*','*googlesyndication.com*','*googleadservices.com*','*adservice.google*','*amazon-adsystem.com*','*taboola.com*','*outbrain.com*','*criteo.*','*facebook.net*','*connect.facebook*','*google-analytics.com*','*googletagmanager.com*','*hotjar.com*','*scorecardresearch.com*','*quantserve.com*','*adsafeprotected.com*','*moatads.com*','*pubmatic.com*','*rubiconproject.com*','*openx.net*','*casalemedia.com*','*adnxs.com*','*mediavine.com*','*ezoic*','*sharethrough*','*33across*','*teads.tv*','*yieldmo*','*indexww*','*lijit*','*sovrn*','*bidswitch*','*smartadserver*','*adform*','*rlcdn.com*','*krxd.net*','*bluekai*','*demdex.net*','*omtrdc.net*','*segment.io*','*optimizely*','*newrelic*','*nr-data.net*','*clarity.ms*','*tiktok*','*pinimg.com/ct*','*snapchat*','*bing.com/bat*'];
const SITES=['https://www.africanbites.com/jamaican-curry-shrimp/','https://www.allrecipes.com/recipe/16354/easy-meatloaf/','https://www.target.com/s?searchTerm=coconut+milk'];
const block=process.argv.includes('block');
const c=new BrowserController({headless:true,windowWidth:1280,windowHeight:900,quality:50,intervalMs:400,browserOptions:{userDataDir:await mkdtemp(join(tmpdir(),'bench-browser-'))}});
const tools=new Map(buildTools(c).map(t=>[t.name,t]));
const call=async(name,args={})=>{const t0=performance.now();const r=await tools.get(name).execute(args,{});return {ms:performance.now()-t0,r};};
const ms=x=>String(Math.round(x)).padStart(6);
try{
  await call('viewer_start',{url:'about:blank'});
  if(block){const tab=await c._activeTab();await c.cdp.send('Network.enable',{},c.cdp.tabs.get(tab));await c.cdp.send('Network.setBlockedURLs',{urls:BLOCK},c.cdp.tabs.get(tab));}
  console.log(block?'WITH ad/tracker blocking':'NO blocking');
  console.log('site'.padEnd(34),'navigate','settle','snapshot','obsChars','| tool:navigate','tool:scroll','tool:snapshot');
  for(const url of SITES){
    const tab=await c._activeTab();
    let t=performance.now();await c.cdp.navigate(tab,url);const nav=performance.now()-t;
    t=performance.now();await c.settle();const settle=performance.now()-t;
    t=performance.now();const snap=await c.snapshot();const snapMs=performance.now()-t;
    const toolNav=await call('viewer_navigate',{url});
    const toolScroll=await call('viewer_scroll',{direction:'down'});
    const toolSnap=await call('viewer_snapshot');
    const chars=tools.get('viewer_navigate').output.render({},toolNav.r)[0].text.length;
    console.log(new URL(url).host.padEnd(34),ms(nav),ms(settle),ms(snapMs),String(chars).padStart(8),'|',ms(toolNav.ms),'      ',ms(toolScroll.ms),'    ',ms(toolSnap.ms),' ',snap.title?.slice(0,30));
  }
}finally{await c.stop().catch(()=>{});}
