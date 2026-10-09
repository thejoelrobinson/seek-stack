// Why does Native fall back to Picture on real pages? Separate, unsigned-in Chrome instances; public pages only; read-only browsing
// (mouse moves, hovers, wheel). Records every server off() with its cause and every client fallback.
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const LIB='file:///C:/Users/Joel%20Robinson/seek-stack/dsh/plugins/browser-viewer/lib/';
const {BrowserController}=await import(LIB+'index.js');
const {CdpBrowser}=await import(LIB+'cdp.js');
const {WorkAssets}=await import(LIB+'work-assets.js');
const {FRAME_HTML,FRAME_CSP}=await import(LIB+'mirror-shape.js');
const {MirrorSession}=await import(LIB+'mirror.js');
const SITES=(process.argv[2]||'https://en.wikipedia.org/wiki/Web_browser,https://www.target.com/,https://www.walmart.com/search?q=milk,https://www.allrecipes.com/,https://news.ycombinator.com/,https://www.bbc.com/news').split(',');
const PHONE=process.env.PHONE==='1',SECS=Number(process.env.SECS||25);
const wait=ms=>new Promise(r=>setTimeout(r,ms)),t0=Date.now(),T=()=>((Date.now()-t0)/1000).toFixed(1);
const events=[];const note=(...a)=>{const line=T()+' '+a.join(' ');events.push(line);console.log(line);};
// Server-side causes.
const origOff=MirrorSession.prototype.off;MirrorSession.prototype.off=function(reason){if(this.live)note('SERVER-OFF',reason,this.parent?'(child frame)':'',(this.lastError?'cause: '+this.lastError:''),'expanding='+JSON.stringify([...(this.expanding||new Map()).values()].map(t=>Date.now()-t)),'from='+new Error().stack.split('at ').slice(2,4).map(x=>x.trim().slice(-70)).join(' < '));return origOff.call(this,reason);};
MirrorSession.prototype.enqueue=function(job){this.serial=this.serial.then(()=>{if(this.live&&this.controller.paused)return job();}).catch(e=>{this.lastError=String(e?.stack||e).split('\n').slice(0,4).join(' | ');this.off('error');});return this.serial;};
const oc=MirrorSession.prototype.call;MirrorSession.prototype.call=function(m,pr){return oc.call(this,m,pr).catch(e=>{e.message+=' ['+m+' '+JSON.stringify(pr||{}).slice(0,60)+']';e.stack=e.message;throw e;});};
const assets=await new WorkAssets().init();let c;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(assets.serve(req,res,url))return;
  if(url.pathname==='/work/mirror-frame'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':FRAME_CSP});res.end(FRAME_HTML);return;}
  if(url.pathname==='/work/mirror-res'){try{const r=await c.mirror.resources.get(url.searchParams.get('u'),url.searchParams.get('f'),url.searchParams.get('s'));res.writeHead(200,{'Content-Type':r.type});res.end(r.data);}catch{res.writeHead(404);res.end();}return;}
  res.setHeader('Content-Type','text/html');
  res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/work/style.css"><div id="toast" hidden></div><script type="module" src="/work/browser.js"></script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{c.addClient(ws);ws.on('message',d=>{try{const m=JSON.parse(d);if(m.type==='mirror')note('CLIENT-SENT mirror on='+m.on+(m.retry?' retry':''));}catch{}});const send=ws.send.bind(ws);ws.send=(data,...r)=>{if(typeof data==='string'&&data.includes('"mirror-off"'))note('TO-CLIENT',data.slice(0,120));return send(data,...r);};}));
c=new BrowserController({headless:true,windowWidth:1366,windowHeight:900,intervalMs:400,quality:40,browserOptions:{userDataDir:await mkdtemp(join(tmpdir(),'seek-bounce-host-'))}});
const viewer=new CdpBrowser({headless:true,windowSize:'1440,900',userDataDir:await mkdtemp(join(tmpdir(),'seek-bounce-viewer-'))});
const OUT=join(process.cwd(),'out','bounce');await mkdir(OUT,{recursive:true});
try{
  await viewer.launch();await c.start('about:blank');
  const sheet=await viewer.newTab(base+'/sheet'),vs=viewer.tabs.get(sheet),v=e=>viewer.evaluate(sheet,e);
  await viewer.send('Emulation.setDeviceMetricsOverride',PHONE?{width:393,height:852,deviceScaleFactor:3,mobile:true}:{width:1440,height:900,deviceScaleFactor:1,mobile:false},vs);
  if(PHONE)await viewer.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},vs);
  for(let i=0;i<100&&!(await v('!!window.SeekBrowser'));i++)await wait(100);
  await v('SeekBrowser.open({control:true})');await wait(1500);
  // Client side: watch the toast and the Native/Picture state.
  await v(`(()=>{const t=document.querySelector('#toast');new MutationObserver(()=>{if(!t.hidden)(window.__toasts||=[]).push(t.textContent)}).observe(t,{childList:true,characterData:true,subtree:true,attributes:true});})()`);
  let lastNative=null;
  const poll=async()=>{const s=JSON.parse(await v(`JSON.stringify({native:document.querySelector('#bv-stage').classList.contains('native'),chip:document.querySelector('#bv-quality')?.hidden?'':document.querySelector('#bv-quality')?.textContent,toasts:(window.__toasts||[]).splice(0)})`));if(s.native!==lastNative){note('CLIENT',s.native?'NATIVE':'PICTURE',s.chip||'');lastNative=s.native;}for(const t of s.toasts)note('TOAST',t);};
  const stage=JSON.parse(await v(`JSON.stringify((r=>({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}))(document.querySelector('#bv-stage').getBoundingClientRect()))`));
  for(const site of SITES){
    note('=== SITE',site);
    await v(`(()=>{const a=document.querySelector('#bv-addr');a.focus();a.value=${JSON.stringify(site)};a.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
    const end=Date.now()+SECS*1000;let k=0;
    while(Date.now()<end){await poll();k++;
      // Act like a person reading: move the pointer around, hover, scroll a bit, leave the page now and then.
      const x=stage.x+Math.sin(k)*stage.w*0.35,y=stage.y+Math.cos(k*0.7)*stage.h*0.35;
      if(PHONE){if(k%6===0){await viewer.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:y+120}]},vs);for(let i=1;i<=6;i++){await viewer.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+120-i*40}]},vs);await wait(16);}await viewer.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},vs);}}
      else{await viewer.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y},vs);if(k%5===0)await viewer.send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:k%10===0?-300:400},vs);if(k%13===0)await viewer.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:stage.x,y:20},vs);}
      await wait(400);}
    await poll();
    await writeFile(join(OUT,(PHONE?'phone-':'desk-')+new URL(site).host+'.jpg'),Buffer.from(await viewer.screenshot(sheet,{quality:60}),'base64'));
  }
}catch(e){note('HARNESS-ERROR',e.stack||e);}finally{
  await writeFile(join(OUT,(PHONE?'phone':'desk')+'-events.txt'),events.join('\n'));
  await viewer.close().catch(()=>{});await c.close().catch(()=>{});wss.close();server.closeAllConnections();server.close();setTimeout(()=>process.exit(0),500);
}
