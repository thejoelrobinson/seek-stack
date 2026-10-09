import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {BrowserController} from '../../plugins/browser-viewer/lib/index.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const out=new URL('./results/',import.meta.url);await mkdir(out,{recursive:true});
const policy="sandbox allow-same-origin allow-scripts; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'none'; base-uri 'none'";
const server=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html');
  if(req.url.startsWith('/frame')){res.setHeader('Content-Security-Policy',policy);res.end(`<meta http-equiv="Content-Security-Policy" content="${policy}"><input id="native"><div id="shadow"></div><iframe></iframe>`);return;}
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>.test{color:red}</style><input id="input" value="hello"><input id="pass" type="password" value="FIXTURE_SECRET"><button id="touch" onclick="window.hit=event.isTrusted">Touch</button><div id="root"></div><iframe id="old" sandbox="allow-same-origin" src="/frame"></iframe><iframe id="new" sandbox="allow-same-origin allow-scripts" src="/frame"></iframe><script>
  window.events=[];for(const id of ['old','new'])document.getElementById(id).onload=()=>{const d=document.getElementById(id).contentDocument;d.addEventListener('input',()=>events.push(id+'-input'));d.addEventListener('click',()=>events.push(id+'-click'));d.addEventListener('securitypolicyviolation',()=>events.push(id+'-blocked'));d.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<b>Shadow works</b>';const s=d.createElement('script');s.textContent='parent.events.push("'+id+'-EXECUTED")';d.body.append(s);d.querySelector('iframe').contentDocument.body.textContent='nested remains';};
  const root=document.getElementById('root').attachShadow({mode:'closed'});window.constructed=new CSSStyleSheet();constructed.replaceSync('.adopted{color:blue}');root.adoptedStyleSheets=[constructed];root.innerHTML='<b class="adopted">Adopted</b>';
  </script>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const c=new BrowserController({headless:true,windowWidth:1366,windowHeight:900,intervalMs:400,quality:60,browserOptions:{userDataDir:await mkdtemp(join(tmpdir(),'seek-mirror-spike-'))}});
const results={date:'2026-10-05',profile:'temporary, unsigned-in',chrome:null,fixture:{},sites:[]};
try{
  await c.start(base);c.paused=true;await c.setViewport('mobile',{width:393,height:660});await wait(700);
  const tab=c.activeTabId,s=c.cdp.tabs.get(tab),send=(m,p)=>c.cdp.send(m,p,s);
  results.chrome=await c.cdp.send('Browser.getVersion');
  let headers=new Map(),events={};const offs=[];
  for(const name of ['CSS.styleSheetAdded','CSS.styleSheetChanged','DOM.adoptedStyleSheetsModified','DOM.inlineStyleInvalidated','DOM.childNodeInserted','DOM.childNodeRemoved','DOM.setChildNodes','DOM.attributeModified','DOM.characterDataModified'])offs.push(c.cdp.onEvent(s,name,p=>{events[name]=(events[name]||0)+1;if(name==='CSS.styleSheetAdded')headers.set(p.header.styleSheetId,p.header);}));
  await send('DOM.enable');await send('CSS.enable');
  const {root}=await send('DOM.getDocument',{depth:-1,pierce:true});
  await c.cdp.evaluate(tab,"document.styleSheets[0].insertRule('.inserted{color:green}',0);constructed.insertRule('.late{color:purple}',0);document.querySelector('#input').style.color='orange'");await wait(200);
  const sheets=[];for(const h of headers.values())sheets.push({...h,...await send('CSS.getStyleSheetText',{styleSheetId:h.styleSheetId})});
  results.fixture.css={insertRule:sheets.some(x=>x.text.includes('.inserted')),constructed:sheets.some(x=>x.text.includes('.adopted')),constructedMutation:sheets.some(x=>x.text.includes('.late')),events,nodeAdopted:JSON.stringify(root).includes('adoptedStyleSheets')};
  const {frameTree:fixtureTree}=await send('Page.getFrameTree');
  const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:fixtureTree.frame.id,worldName:'seek-mirror-spike'});
  const resolve=await send('DOM.resolveNode',{backendNodeId:root.children.find(n=>n.nodeName==='HTML').children.find(n=>n.nodeName==='BODY').children.find(n=>n.attributes?.includes('root')).shadowRoots[0].backendNodeId,executionContextId});
  results.fixture.css.isolatedAdopted=(await send('Runtime.callFunctionOn',{objectId:resolve.object.objectId,functionDeclaration:'function(){return this.adoptedStyleSheets.map(s=>[...s.cssRules].map(r=>r.cssText).join("\\n"))}',returnByValue:true})).result.value;
  results.fixture.css.isolatedInline=(await send('Runtime.evaluate',{contextId:executionContextId,expression:'[...document.styleSheets].map(s=>[...s.cssRules].map(r=>r.cssText).join("\\n"))',returnByValue:true})).result.value;
  for(const id of ['old','new']){
    const pos=await c.cdp.evaluate(tab,`(()=>{const f=document.getElementById('${id}'),a=f.getBoundingClientRect(),b=f.contentDocument.querySelector('input').getBoundingClientRect();return {x:a.x+b.x+10,y:a.y+b.y+10}})()`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...pos,radiusX:1,radiusY:1,force:1}]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await send('Input.insertText',{text:'native'});
  }
  const p=await c.cdp.evaluate(tab,"(()=>{const r=document.getElementById('touch').getBoundingClientRect();return {x:r.x+5,y:r.y+5}})()");await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  results.fixture.frame=await c.cdp.evaluate(tab,"({events,hit:window.hit,frames:['old','new'].map(id=>{const d=document.getElementById(id).contentDocument;return {id,value:d.querySelector('input').value,shadow:d.querySelector('#shadow').shadowRoot.textContent,nested:d.querySelector('iframe').contentDocument.body.textContent}})})");
  results.fixture.snapshot=Object.keys((await send('DOMSnapshot.captureSnapshot',{computedStyles:[]})).documents[0].nodes);
  offs.forEach(f=>f());await send('CSS.disable');await send('DOM.disable');
  for(const url of ['https://www.walmart.com/search?q=fresh+thyme','https://www.target.com/s?searchTerm=coconut+milk','https://www.allrecipes.com/recipe/16354/easy-meatloaf/','https://en.wikipedia.org/wiki/Scotch_bonnet','https://accounts.google.com/ServiceLogin']){
    const row={url};results.sites.push(row);const t=performance.now();
    try{
      await c.navigate(url);await wait(2000);headers=new Map();events={};
      const off=c.cdp.onEvent(s,'CSS.styleSheetAdded',p=>headers.set(p.header.styleSheetId,p.header));await send('DOM.enable');await send('CSS.enable');
      const t0=performance.now(),doc=await send('DOM.getDocument',{depth:-1,pierce:true}),t1=performance.now();row.domMs=Math.round(t1-t0);row.rawBytes=Buffer.byteLength(JSON.stringify(doc));row.deflatedBytes=deflateSync(JSON.stringify(doc)).length;
      let nodes=0,islands=0,adopted=0;function walk(n){nodes++;if(n.nodeName==='IFRAME'&&!n.contentDocument||['CANVAS','VIDEO','OBJECT','EMBED'].includes(n.nodeName))islands++;if(n.adoptedStyleSheets?.length)adopted++;for(const x of n.children||[])walk(x);for(const x of n.shadowRoots||[])if(x.shadowRootType!=='user-agent')walk(x);if(n.contentDocument)walk(n.contentDocument);}walk(doc.root);row.nodes=nodes;row.islands=islands;row.adoptedRoots=adopted;
      const texts=await Promise.all([...headers.values()].filter(h=>h.origin!=='user-agent').map(async h=>({...h,...await send('CSS.getStyleSheetText',{styleSheetId:h.styleSheetId}).catch(()=>({text:''}))})));row.sheets=texts.length;row.cssBytes=texts.reduce((n,x)=>n+x.text.length,0);
      const tv=performance.now();const snap=await send('DOMSnapshot.captureSnapshot',{computedStyles:[]});row.valuesMs=Math.round(performance.now()-tv);row.values=snap.documents.reduce((n,d)=>n+(d.nodes.inputValue?.index?.length||0),0);
      const eventOffs=[];for(const name of ['childNodeInserted','childNodeRemoved','setChildNodes','attributeModified','characterDataModified','inlineStyleInvalidated','childNodeCountUpdated'])eventOffs.push(c.cdp.onEvent(s,'DOM.'+name,()=>events[name]=(events[name]||0)+1));
      if(new URL(url).hostname.includes('walmart')){
        const add=await c.cdp.evaluate(tab,"(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^(Add|Add to cart)$/.test(b.textContent.trim()));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
        if(add){await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[add]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(600);row.guestCartAddAttempted=true;}
      }
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:190,y:300,deltaX:0,deltaY:450});await wait(1000);row.eventsOneSecond=events;eventOffs.forEach(f=>f());
      const tc=performance.now(),image=await send('Page.captureScreenshot',{format:'jpeg',quality:60,captureBeyondViewport:false});row.captureMs=Math.round(performance.now()-tc);row.jpegBytes=Buffer.from(image.data,'base64').length;
      const {frameTree}=await send('Page.getResourceTree');const resources=(frameTree.resources||[]).filter(x=>['Image','Font'].includes(x.type)).slice(0,8);row.resourceCount=resources.length;row.resourceContentHits=0;row.networkHits=0;
      for(const r of resources){try{await send('Page.getResourceContent',{frameId:frameTree.frame.id,url:r.url});row.resourceContentHits++;}catch{try{const {resource}=await send('Network.loadNetworkResource',{frameId:frameTree.frame.id,url:r.url,options:{includeCredentials:true,disableCache:false}});if(resource.success)row.networkHits++;if(resource.stream)await send('IO.close',{handle:resource.stream});}catch{}}}
      row.title=await c.cdp.evaluate(tab,'document.title');row.metrics=(await send('Page.getLayoutMetrics')).cssLayoutViewport;row.elapsedMs=Math.round(performance.now()-t);off();await send('CSS.disable');await send('DOM.disable');
      console.log(JSON.stringify(row));
    }catch(e){row.error=e.message;console.log(JSON.stringify(row));}
  }
  await writeFile(new URL('spike.json',out),JSON.stringify(results,null,2));console.log('Fixture: '+JSON.stringify(results.fixture));
}finally{await c.stop();server.close();}
