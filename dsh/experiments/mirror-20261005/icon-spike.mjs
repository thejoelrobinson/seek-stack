import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpBrowser} from '../../plugins/browser-viewer/lib/cdp.js';
import {MirrorResources} from '../../plugins/browser-viewer/lib/mirror-resource.js';
import {WorkAssets} from '../../plugins/browser-viewer/lib/work-assets.js';
import {FRAME_CSP,FRAME_HTML} from '../../plugins/browser-viewer/lib/mirror-shape.js';
import {createServer} from 'node:http';
const cdp=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-icon-spike-'))});
try{
  await cdp.launch();const tab=await cdp.newTab('about:blank'),session=cdp.tabs.get(tab),fonts=[];
  await cdp.send('Network.enable',{},session);cdp.onEvent(session,'Network.responseReceived',m=>{if(m.type==='Font'||/\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(m.response.url))fonts.push({url:m.response.url,type:m.response.mimeType,status:m.response.status});});
  await cdp.navigate(tab,'https://www.walmart.com/search?q=fresh+thyme');await new Promise(r=>setTimeout(r,2000));
  const result=await cdp.evaluate(tab,`({title:document.title,fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),icons:[...document.querySelectorAll('i,span')].filter(e=>/icon|ld-/i.test(e.className)&&e.textContent.length<8).slice(0,10).map(e=>({tag:e.tagName,classes:e.className,text:e.textContent,font:getComputedStyle(e).fontFamily,before:getComputedStyle(e,'::before').content}))})`);
  await cdp.send('DOM.enable',{},session);const sheets=[];cdp.onEvent(session,'CSS.styleSheetAdded',m=>sheets.push(m.header));await cdp.send('CSS.enable',{},session);
  const faces=[];for(const h of sheets){const {text}=await cdp.send('CSS.getStyleSheetText',{styleSheetId:h.styleSheetId},session).catch(()=>({text:''}));if(/@font-face/.test(text))faces.push({source:h.sourceURL,rules:[...text.matchAll(/@font-face\s*\{[^}]*\}/g)].map(m=>m[0])});}
  const row={...result,networkFonts:fonts,faces};
  const font=fonts.find(f=>f.url.includes('ui-icons')&&f.url.includes('.woff2'));if(!font)throw new Error('Public Walmart icon font not observed');
  const {frameTree}=await cdp.send('Page.getFrameTree',{},session),frame=frameTree.frame.id;
  const mirror={live:true,controller:{paused:true},cdp,session,mainFrame:frame,frames:new Map([[frame,frameTree.frame.url]]),resourceTypes:new Map(fonts.map(f=>[f.url,f.type])),readResources:async()=>{}};
  const resources=new MirrorResources(mirror),assets=await new WorkAssets().init();
  const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://fixture');if(assets.serve(req,res,u))return;if(u.pathname==='/work/mirror-frame'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':FRAME_CSP});res.end(FRAME_HTML);return;}if(u.pathname==='/work/mirror-res'){try{const r=await resources.get(u.searchParams.get('u'),u.searchParams.get('f'),u.searchParams.get('s'));res.writeHead(200,{'Content-Type':r.type});res.end(r.data);}catch{res.writeHead(404);res.end();}return;}res.end('<div id="stage" style="position:relative;width:393px;height:660px"></div>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const ui=await cdp.newTab('http://127.0.0.1:'+server.address().port),signed=resources.sign(font.url,frame);
    row.native=await cdp.evaluate(ui,`(async()=>{const {MirrorView}=await import('/work/mirror.js');const view=new MirrorView(document.querySelector('#stage'));await view.ready;view.show(true);await view.message({type:'mirror-reset',epoch:1,viewport:{w:393,h:660},sheets:[{owner:1,text:'@font-face{font-family:WalmartIcons;src:url("${signed}") format("woff2")}.icon{font:32px WalmartIcons}.icon::before{content:"\\\\f1ba"}'}],tree:{i:1,t:'#document',c:[{i:2,t:'html',a:[],c:[{i:3,t:'head',a:[],c:[]},{i:4,t:'body',a:[],c:[{i:5,t:'i',a:[['class','icon']],c:[]}]}]}]}});await view.doc.fonts.load('32px WalmartIcons','\\uf1ba');const ctx=view.doc.createElement('canvas').getContext('2d');ctx.font='32px WalmartIcons';return {loaded:[...view.doc.fonts].some(f=>f.family==='WalmartIcons'&&f.status==='loaded'),content:getComputedStyle(view.doc.querySelector('i'),'::before').content,width:ctx.measureText('\\uf1ba').width};})()`);
    if(!row.native.loaded)throw new Error('Native Walmart font did not load');
  }finally{resources.clear();server.closeAllConnections();await new Promise(r=>server.close(r));}
  await writeFile(new URL('./results/icon-spike.json',import.meta.url),JSON.stringify(row,null,2));console.log(JSON.stringify(row));
}finally{await cdp.close();}
