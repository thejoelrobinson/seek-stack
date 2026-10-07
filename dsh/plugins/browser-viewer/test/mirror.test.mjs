import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {CdpBrowser} from '../lib/cdp.js';
import {allowedTag,sanitizeAttrs,sanitizeCSS,isSecretField,editSpan,FRAME_CSP,stateCSS} from '../lib/mirror-shape.js';
import {expandImports,importDescriptor} from '../lib/mirror-styles.js';
import {encodePNG,decodePNG,maskRegions} from '../lib/mirror-pixels.js';
import {treeDiff,MirrorSession} from '../lib/mirror.js';
import {MirrorResources,publicAddress} from '../lib/mirror-resource.js';
const base='https://fixture.example/page',rewrite=u=>'/work/mirror-res?u='+encodeURIComponent(u);
test('mirror drops executable markup, SMIL, navigation and secret attributes',()=>{
  for(const tag of ['script','noscript','template','base','meta','link','style','set','animate','foreignObject'])assert.equal(allowedTag(tag),false,tag);
  const safe=sanitizeAttrs('input',[['type','password'],['value','SECRET'],['oninput','evil()'],['srcdoc','evil'],['formaction','/send'],['nonce','unsafe'],['autofocus',''],['id','pw']],base,rewrite,true);
  assert.deepEqual(safe,[['type','password'],['id','pw']]);
  assert.equal(sanitizeAttrs('iframe',[['src','https://evil.example'],['srcdoc','evil']],base,rewrite).length,0);
  assert.deepEqual(sanitizeAttrs('a',[['href','javascript:alert(1)'],['target','_top']],base,rewrite),[['href','#']]);
  assert.equal(sanitizeAttrs('input',[['type','image']],base,rewrite)[0][1],'button');
  assert.match(FRAME_CSP,/sandbox allow-same-origin allow-scripts/);assert.match(FRAME_CSP,/default-src 'none'/);
});
test('every fetchable attribute and CSS URL uses only the resource proxy',()=>{
  const a=sanitizeAttrs('img',[['src','//images.example/x.png'],['srcset','/one.png 1x, /two.png 2x'],['style','background:url(https://evil.example/bg.png)']],base,rewrite);
  assert.ok(a.every(x=>x[1].includes('/work/mirror-res')));assert.ok(!sanitizeAttrs('img',[['src','javascript:evil()']],base,rewrite).length);
  const css=sanitizeCSS('@import "https://evil.example/style"; .x{background:image-set("https://evil.example/a" 1x); mask:url(//images.example/m.png);color:red}',base,rewrite);
  assert.ok(!css.includes('@import'));assert.ok(css.includes('image-set'));assert.ok(css.includes('color:red'));assert.ok(css.includes('/work/mirror-res'));
  assert.equal(sanitizeCSS('.x{background:u\\72l(https://evil.example)}',base,rewrite),'.x{}');
  assert.equal(sanitizeCSS('.sm\\:text{color:red}',base,rewrite),'.sm\\:text{color:red}');
  assert.equal(sanitizeAttrs('img',[['src','data:image/svg+xml;base64,PHN2Zz4=']],base,rewrite).length,0);
  const client=sanitizeAttrs('img',[['src','/work/mirror-res?u=abc&s=def']],base);assert.equal(client[0][1],'/work/mirror-res?u=abc&s=def');
});
test('imports preserve layer, supports and media at their cascade position, with cycles bounded',()=>{
  const source='@layer base,theme; @import "/active.css" layer(theme) supports(display:grid) screen and (min-width:800px); .last{color:red}';
  const out=expandImports(source,base,url=>url.endsWith('/active.css')?{text:'@import "/active.css"; .first{padding:7px}'}:null);
  assert.equal(out,'@layer base,theme; @layer theme{@supports (display:grid){@media screen and (min-width:800px){ .first{padding:7px}}}} .last{color:red}');
  assert.equal(importDescriptor('@import "javascript:evil()";',base),null);assert.equal(importDescriptor('@import "/x" screen;body{color:red}',base),null);
  assert.ok(stateCSS('.x:hover{content:":hover"}').includes(':is(:hover,[data-seek-state-hover])'));assert.ok(stateCSS('.x:hover{content:":hover"}').includes('content:":hover"'));
  const relative=expandImports('@import "/nested/fonts.css"; .root{background:url("dot.png")}',base,url=>({text:'@font-face{font-family:X;src:url("icons.woff2")}',base:url}),new Set(),(css,base)=>sanitizeCSS(css,base,url=>url));assert.ok(relative.includes('https://fixture.example/nested/icons.woff2'));assert.ok(relative.includes('https://fixture.example/dot.png'));
});
test('passwords, OTP and card identifiers are sensitive; ordinary form values stay usable',()=>{
  for(const a of [[['type','password']],[['autocomplete','section-payment cc-number']],[['name','cardNumber']],[['autocomplete','one-time-code']],[['aria-label','Security code']]])assert.ok(isSecretField(a));
  for(const a of [[['type','email']],[['name','quantity']],[['autocomplete','postal-code']]])assert.equal(isSecretField(a),false);
  assert.deepEqual(editSpan('hello','hallo'),{at:1,del:1,ins:'a'});assert.deepEqual(editSpan('hello','hell'),{at:4,del:1,ins:''});
});
test('tree diffs retain identity and include inserts, attributes, text and reorders',()=>{
  const before={i:1,t:'div',a:[['class','old']],c:[{i:2,t:'#text',v:'one'}]},after={i:1,t:'div',a:[['class','new']],c:[{i:3,t:'span',a:[],c:[]},{i:2,t:'#text',v:'two'}]};
  const ops=treeDiff(before,after);assert.ok(ops.some(o=>o.op==='insert'&&o.parent===1&&o.before===2));assert.ok(ops.some(o=>o.op==='attr'&&o.value==='new'));assert.ok(ops.some(o=>o.op==='text'&&o.value==='two'));
});
test('resource signatures bind both URL and frame and reject private addresses',()=>{
  const r=new MirrorResources({});const u=new URL(r.sign('https://fixture.example/image','frame'),'https://seek.example');assert.ok(r.valid(u.searchParams.get('u'),'frame',u.searchParams.get('s')));assert.equal(r.valid('https://evil.example','frame',u.searchParams.get('s')),false);assert.equal(r.valid(u.searchParams.get('u'),'other',u.searchParams.get('s')),false);
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','198.18.0.1','192.0.0.1','::1','fe80::1','::ffff:127.0.0.1','2001:0000::1','2001:db8::1','2002:a00:1::','2001:abcd:junk'])assert.equal(publicAddress(ip),false,ip);assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2001:4860::1'),true);r.clear();
});
test('picture-region payloads exclude union gaps and redact sensitive rectangles on the host',()=>{const rgba=Buffer.alloc(4*4*4,255),png=encodePNG(4,4,rgba),safe=maskRegions(png,{x:0,y:0,w:4,h:4},[{x:0,y:0,w:1,h:4},{x:3,y:0,w:1,h:4}],[{x:0,y:1,w:1,h:1}]),decoded=decodePNG(safe);assert.equal(decoded.rgba[3],255);assert.equal(decoded.rgba[(1*4+0)*4+3],0);assert.equal(decoded.rgba[(0*4+1)*4+3],0);assert.equal(decoded.rgba[(0*4+3)*4+3],255);});
test('mirror permits Walmart legacy WOFF2 MIME through cache and fallback, while refusing other applications',async()=>{
  const url='https://fixture.example/icons.woff2',data=Buffer.from('fixture font bytes');
  for(const fallback of [false,true])for(const type of ['application/font-woff2','application/font-woff','font/woff2','font/woff','text/html','application/javascript','application/octet-stream']){
    const m={live:true,controller:{paused:true},resourceTypes:new Map([[url,type]]),frames:new Map([['frame','https://fixture.example/']]),session:'session',cdp:{send:async()=>{if(fallback)throw new Error('Not cached');return {content:data.toString('base64'),base64Encoded:true};}}};
    const r=new MirrorResources(m);r.fetch=async()=>({data,type});
    if(['text/html','application/javascript','application/octet-stream'].includes(type))await assert.rejects(r.load(new URL(url),'frame'),/Unavailable/);
    else{const result=await r.load(new URL(url),'frame');assert.equal(result.type,type);assert.deepEqual(result.data,data);}r.clear();
  }
});
test('edit sequences and acknowledgements belong to their connection',()=>{const m=new MirrorSession({cdp:{},paused:true}),first={readyState:1,bufferedAmount:0,send:data=>first.packet=JSON.parse(data)},second={readyState:1,bufferedAmount:0,send:data=>second.packet=JSON.parse(data)};m.epoch=7;m.sequences(first).set(42,8);assert.equal(m.sequences(second).get(42),undefined);m.ack({id:42,seq:1},second);assert.equal(first.packet,undefined);assert.deepEqual(second.packet,{type:'mirror-ack',epoch:7,id:42,seq:1});});
test('font responses missing from Page cache use the exact frame and session network body',async()=>{const url='https://fixture.example/font.woff2',m={live:true,controller:{paused:true},session:'session',frames:new Map([['frame','https://fixture.example/']]),resourceTypes:new Map([[url,'font/woff2']]),cdp:{resourceResponses:new Map([['session\nframe\n'+url,{requestId:'font-request',mimeType:'font/woff2'}]]),send:async(method,params,session)=>{assert.equal(session,'session');if(method==='Network.getResponseBody'){assert.equal(params.requestId,'font-request');return {body:Buffer.from('cached-font').toString('base64'),base64Encoded:true};}throw Error('Page cache unavailable');}}},r=new MirrorResources(m);r.fetch=()=>{throw Error('Host fetch must not run');};assert.equal((await r.load(new URL(url),'frame')).data.toString(),'cached-font');r.clear();});
test('completed font bodies survive later Chrome cache eviction within a shared byte limit',async()=>{const c=new CdpBrowser();c.ws={readyState:1};c._send=async(_method,params,session)=>{assert.equal(session,'session');return {body:Buffer.alloc(params.requestId==='large'?10*1024*1024:20).toString('base64'),base64Encoded:true};};await c.cacheFont('large',{mimeType:'font/woff2',requestId:'large',sessionId:'session'});await c.cacheFont('small',{mimeType:'application/font-woff2',requestId:'small',sessionId:'session'});assert.equal(c.fontBodies.has('large'),false);assert.equal(c.fontBytes,20);await c.cacheFont('html',{mimeType:'text/html',requestId:'html',sessionId:'session'});assert.equal(c.fontBodies.has('html'),false);c.fontBodies.clear();c.ws=null;});
test('resource fallback sends main-origin cookies only for a matching frame origin',async()=>{let cookie;const server=createServer((req,res)=>{cookie=req.headers.cookie;res.writeHead(200,{'Content-Type':'image/png'});res.end('fixture image');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,url=base+'/asset';try{for(const [frameURL,origin,expected]of [[base,base,true],['about:srcdoc',base,true],['about:srcdoc','://',false],[base,base+':other',false]]){const m={live:true,controller:{paused:true},mainFrame:'main',session:'session',frames:new Map([['main',base],['frame',frameURL]]),frameBases:new Map([['frame',base]]),frameOrigins:new Map([['frame',origin]]),resourceTypes:new Map([[url,'image/png']]),cdp:{send:async method=>{if(method==='Network.getCookies')return {cookies:[{name:'fixture',value:'HOST_ONLY'}]};throw Error('Not cached');}}};const resources=new MirrorResources(m);await resources.load(new URL(url),'frame');assert.equal(cookie,expected?'fixture=HOST_ONLY':undefined);resources.clear();}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}});
