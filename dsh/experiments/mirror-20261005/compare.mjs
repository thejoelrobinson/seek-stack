// Native-vs-picture measurements with a separate unsigned-in Chrome profile.
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {deflateSync} from 'node:zlib';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
import {WorkAssets} from '../../plugins/browser-viewer/lib/work-assets.js';
import {FRAME_CSP,FRAME_HTML} from '../../plugins/browser-viewer/lib/mirror-shape.js';
const assets=await new WorkAssets().init(),out=new URL('./results/',import.meta.url);await mkdir(out,{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));let c;
const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://fixture');if(assets.serve(req,res,u))return;
 if(u.pathname==='/work/mirror-frame'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':FRAME_CSP});res.end(FRAME_HTML);return;}
 if(u.pathname==='/work/mirror-res'){try{const r=await c.mirror.resources.get(u.searchParams.get('u'),u.searchParams.get('f'),u.searchParams.get('s'));res.writeHead(200,{'Content-Type':r.type});res.end(r.data);}catch{res.writeHead(404);res.end();}return;}
 res.end(`<style>html,body{margin:0;width:393px;height:660px;overflow:hidden}#stage{width:393px;height:660px;position:relative}.bv-mirror{border:0;position:absolute;top:0;left:0}</style><div id="stage"></div><script type="module">import {MirrorView} from '/work/mirror.js';window.fail=[];window.view=new MirrorView(document.querySelector('#stage'),{send:()=>{},onFallback:r=>fail.push(r)});view.show(true);window.feed=m=>view.message(m);await view.ready;window.ready=true;</script>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
class Socket extends EventEmitter{readyState=1;bufferedAmount=0;messages=[];send(s){if(typeof s==='string')this.messages.push(JSON.parse(s));}terminate(){}}
const ws=new Socket();c=new BrowserController({headless:true,windowWidth:1366,windowHeight:900,quality:60,intervalMs:400,browserOptions:{userDataDir:await mkdtemp(join(tmpdir(),'seek-mirror-compare-'))}});
const rows=[];
try{
 await c.start('about:blank');await c.takeControl();await c.setViewport('mobile',{width:393,height:660});const host=c.activeTabId,hs=c.cdp.tabs.get(host);
 const ui=await c.cdp.newTab(base),us=c.cdp.tabs.get(ui);await c.cdp.send('Emulation.setDeviceMetricsOverride',{width:393,height:660,mobile:false,deviceScaleFactor:1},us);
 for(let i=0;i<100&&!await c.cdp.evaluate(ui,'window.ready');i++)await wait(40);
 for(const url of ['https://www.walmart.com/search?q=fresh+thyme','https://www.allrecipes.com/recipe/16354/easy-meatloaf/','https://en.wikipedia.org/wiki/Scotch_bonnet','https://accounts.google.com/ServiceLogin']){
  c._stopMirror();await c.navigate(url);await wait(2000);ws.messages=[];c.mirrorClients.add(ws);const costs={},originalSend=c.cdp.send.bind(c.cdp);c.cdp.send=(method,...args)=>{const t0=performance.now();return originalSend(method,...args).finally(()=>{const row=costs[method]||={count:0,ms:0};row.count++;row.ms+=performance.now()-t0;});};const t=performance.now();await c._syncMirror();c.cdp.send=originalSend;const reset=ws.messages.find(m=>m.type==='mirror-reset'),name=new URL(url).hostname.replace(/^www\./,'');
  if(!reset){const row={url,fallback:ws.messages.find(m=>m.type==='mirror-off')?.reason,error:c.mirror?.debugFailure,costs};rows.push(row);console.log(JSON.stringify(row));continue;}
  const raw=JSON.stringify(reset),snapMs=Math.round(performance.now()-t);const {result}=await c.cdp.send('Runtime.evaluate',{expression:'window'},us);const t0=performance.now();const render=await c.cdp.send('Runtime.callFunctionOn',{objectId:result.objectId,functionDeclaration:'function(m){view.show(true);return window.feed(m)}',arguments:[{value:reset}],awaitPromise:true,returnByValue:true},us);await c.cdp.send('Runtime.releaseObject',{objectId:result.objectId},us);
  await wait(1500);const native=await c.cdp.screenshot(ui,{format:'jpeg',quality:80}),live=await c.cdp.screenshot(host,{format:'jpeg',quality:80});await writeFile(new URL(name+'-native.jpg',out),Buffer.from(native,'base64'));await writeFile(new URL(name+'-live.jpg',out),Buffer.from(live,'base64'));
  const row={url,snapshotMs:snapMs,renderMs:Math.round(performance.now()-t0-1500),rawBytes:Buffer.byteLength(raw),deflatedBytes:deflateSync(raw).length,nodes:c.mirror.nodes.size,resourceCacheBytes:c.mirror.resources.bytes,costs:Object.entries(costs).sort((a,b)=>b[1].ms-a[1].ms).slice(0,6),client:await c.cdp.evaluate(ui,'({fail,images:[...view.doc.images].filter(i=>i.complete&&i.naturalWidth).length,imageCount:view.doc.images.length,bodyHeight:view.doc.body.scrollHeight})'),exception:!!render.exceptionDetails};rows.push(row);console.log(JSON.stringify(row));
 }
 await writeFile(new URL('compare.json',out),JSON.stringify(rows,null,2));
}finally{await c.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
