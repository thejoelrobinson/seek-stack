import {allowedTag,sanitizeAttrs,sanitizeCSS,isSecretField,treeDiff} from './mirror-shape.js';
export {treeDiff} from './mirror-shape.js';
import {MirrorResources} from './mirror-resource.js';
import {GATE_JS} from './fastlane.js';
import {readMirrorSheets} from './mirror-styles.js';
import {MirrorFrames} from './mirror-frames.js';
import {extendedInput,selectionFunction} from './mirror-input.js';
import {measureLayout,repairLayout,transientState,richSelection} from './mirror-layout.js';
import {captureIslands} from './mirror-regions.js';
const pairs=a=>{const out=[];for(let i=0;i<(a||[]).length;i+=2)out.push([a[i],a[i+1]]);return out;};
let nextEpoch=0;
const MAX_BUFFER=1024*1024,MAX_BYTES=8*1024*1024;
// Native date/time/color pickers return a whole value, as the host's own picker would; set it and announce it the same way.
const PICKER_VALUE='function(v){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(this,v);this.dispatchEvent(new Event("input",{bubbles:true,composed:true}));this.dispatchEvent(new Event("change",{bubbles:true}))}';
function flatten(tree){const map=new Map();function visit(n,parent=0){map.set(n.i,{n,parent});for(const c of n.c||[])visit(c,n.i);for(const c of n.s||[])visit(c,n.i);if(n.d)visit(n.d,n.i);}if(tree)visit(tree);return map;}
export class MirrorSession{
  constructor(controller){this.controller=controller;this.cdp=controller.cdp;this.session=null;this.live=false;this.ready=false;this.epoch=0;this.nodes=new Map();this.sheets=new Map();this.frames=new Map();this.resourceTypes=new Map();this.secretIds=new Set();this.redactions=new Set();this.secretValues=new Map();this.values=new Map();this.clients=new Map();this.offs=[];this.serial=Promise.resolve();this.dirty=false;this.resources=new MirrorResources(this);this.visible=new Set();this.lastIslandAt=0;this.lastGateAt=0;this.lastSeq=new Map();}
  send(ws,obj,compress=true){if(ws.readyState!==1)return false;if(ws.bufferedAmount>MAX_BUFFER){this.clients.set(ws,true);return false;}ws.send(JSON.stringify(obj),{compress});return true;}
  broadcast(obj,compress=true){if(!this.live||!this.controller.paused)return;for(const ws of this.clients.keys())if(!this.clients.get(ws))this.send(ws,obj,compress);}
  async add(ws){this.clients.set(ws,false);if(this.ready)this.send(ws,this.resetMessage());}
  remove(ws){this.clients.delete(ws);}
  sequences(client){if(!client)return this.lastSeq;this.clientSeq||=new WeakMap();let seq=this.clientSeq.get(client);if(!seq)this.clientSeq.set(client,seq=new Map());return seq;}
  ack(msg,client){const root=this.parent||this,obj={type:'mirror-ack',epoch:root.epoch,id:this.parent?this.frameBridge.id(this,msg.id):msg.id,seq:msg.seq};if(client)root.send(client,obj);else this.broadcast(obj);}
  queueRich(id){(this.richSync||=new Set()).add(id);this.richDue=Date.now()+75;}
  enqueue(job){this.serial=this.serial.then(()=>{if(this.live&&this.controller.paused)return job();}).catch(()=>this.off('error'));return this.serial;}
  rawIndex(n,parent=null){if(!n)return;this.nodes.set(n.nodeId,{node:n,parent});for(const c of n.children||[])this.rawIndex(c,n.nodeId);for(const c of n.shadowRoots||[])this.rawIndex(c,n.nodeId);if(n.contentDocument)this.rawIndex(n.contentDocument,n.nodeId);}
  rawRemove(id){this.expanding?.delete(id);const r=this.nodes.get(id);if(!r)return;const p=this.nodes.get(r.parent)?.node;if(p){p.children=(p.children||[]).filter(n=>n.nodeId!==id);p.shadowRoots=(p.shadowRoots||[]).filter(n=>n.nodeId!==id);if(p.contentDocument?.nodeId===id)delete p.contentDocument;}for(const c of r.node.children||[])this.rawRemove(c.nodeId);for(const c of r.node.shadowRoots||[])this.rawRemove(c.nodeId);if(r.node.contentDocument)this.rawRemove(r.node.contentDocument.nodeId);this.nodes.delete(id);}
  async start(tab){
    this.tab=tab;this.session=this.cdp.tabs.get(tab);this.live=true;this.epoch=++nextEpoch;this.broadcast({type:'mirror-loading',epoch:this.epoch});
    const on=(name,fn)=>this.offs.push(this.cdp.onEvent(this.session,name,p=>{if(this.live)this.enqueue(async()=>{await fn(p);this.schedule();});}));
    // Chrome replaces the document in a quick burst while a page commits: rebuild once, from the last one,
    // so the first click on the new page is not dropped by a second rebuild.
    this.offs.push(this.cdp.onEvent(this.session,'DOM.documentUpdated',()=>{if(this.live){this.ready=false;this.resetSoon();}}));
    on('Page.frameNavigated',p=>{if(!p.frame.parentId){this.ready=false;this.epoch=++nextEpoch;this.broadcast({type:'mirror-loading',epoch:this.epoch});this.resetSoon();}});
    on('DOM.setChildNodes',async p=>{this.expanding?.delete(p.parentId);const parent=this.nodes.get(p.parentId)?.node;if(!parent)return;
      const hydrate=n=>{const old=this.nodes.get(n.nodeId)?.node;if(old){if(n.childNodeCount&&!n.children&&old.children)n.children=old.children;if(!n.shadowRoots&&old.shadowRoots)n.shadowRoots=old.shadowRoots;if(!n.contentDocument&&old.contentDocument)n.contentDocument=old.contentDocument;}for(const c of n.children||[])hydrate(c);};
      for(const n of p.nodes)hydrate(n);const next=structuredClone(p.nodes);for(const n of [...parent.children||[]])this.rawRemove(n.nodeId);parent.children=next;for(const n of next){this.rawIndex(n,p.parentId);await this.expand(n);}
    });
    on('DOM.childNodeInserted',async p=>{this.sheetDirty=true;const parent=this.nodes.get(p.parentNodeId)?.node;if(!parent)return;const c=parent.children||=[];c.splice(p.previousNodeId?c.findIndex(n=>n.nodeId===p.previousNodeId)+1:0,0,p.node);this.rawIndex(p.node,p.parentNodeId);await this.expand(p.node);});
    on('DOM.childNodeRemoved',p=>{this.sheetDirty=true;this.rawRemove(p.nodeId);});
    on('DOM.childNodeCountUpdated',p=>{const n=this.nodes.get(p.nodeId)?.node;if(n){n.childNodeCount=p.childNodeCount;return this.expand(n);}});
    on('DOM.characterDataModified',p=>{const n=this.nodes.get(p.nodeId)?.node;if(n)n.nodeValue=p.characterData;});
    on('DOM.attributeModified',p=>{const n=this.nodes.get(p.nodeId)?.node;if(!n)return;if(['style','link'].includes(n.localName))this.sheetDirty=true;const a=new Map(pairs(n.attributes));a.set(p.name,p.value);n.attributes=[...a].flat();if(['input','textarea','select'].includes(n.localName)&&isSecretField([...a]))this.secretIds.add(n.backendNodeId);});
    on('DOM.attributeRemoved',p=>{const n=this.nodes.get(p.nodeId)?.node;if(n)n.attributes=pairs(n.attributes).filter(a=>a[0]!==p.name).flat();});
    on('DOM.inlineStyleInvalidated',async p=>{for(const id of p.nodeIds){const n=this.nodes.get(id)?.node;if(!n)continue;const r=await this.call('DOM.getAttributes',{nodeId:id}).catch(e=>{if(this.live&&/Could not find node/.test(e.message))return null;throw e;});if(r)n.attributes=r.attributes;}});
    on('DOM.shadowRootPushed',async p=>{const n=this.nodes.get(p.hostId)?.node;if(n){(n.shadowRoots||=[]).push(p.root);this.rawIndex(p.root,p.hostId);await this.expand(p.root);}});
    on('DOM.shadowRootPopped',p=>this.rawRemove(p.rootId));
    on('DOM.adoptedStyleSheetsModified',p=>{const n=this.nodes.get(p.nodeId)?.node;if(n)n.adoptedStyleSheets=p.adoptedStyleSheets;this.sheetDirty=true;});
    on('DOM.topLayerElementsUpdated',()=>this.topLayer());
    // Sheet discovery must run during CSS.enable, before the initial snapshot reads sheets.
    for(const [name,fn]of [['CSS.styleSheetAdded',p=>this.sheets.set(p.header.styleSheetId,{...p.header,dirty:true})],['CSS.styleSheetChanged',p=>{const h=this.sheets.get(p.styleSheetId);if(h)h.dirty=true;}],['CSS.styleSheetRemoved',p=>this.sheets.delete(p.styleSheetId)]])this.offs.push(this.cdp.onEvent(this.session,name,p=>{if(this.live){fn(p);this.sheetDirty=true;this.schedule();}}));
    if(!this.parent){this.frameBridge=new MirrorFrames(this,MirrorSession);await this.frameBridge.start(this.session);}
    const boot=this.serial.then(async()=>{if(this.parent)await this.call('Network.enable',{maxTotalBufferSize:10*1024*1024,maxResourceBufferSize:10*1024*1024});await this.call('DOM.enable');await this.call('CSS.enable');await this.reset();});this.serial=boot;await boot;
    if(!this.live)return;
    this.timer=setInterval(()=>{if(!this.cdp.alive){this.stop();return;}if(this.ticking)return;this.ticking=true;this.enqueue(()=>this.tick()).finally(()=>this.ticking=false);},50);
  }
  resetSoon(){clearTimeout(this.resetTimer);this.resetTimer=setTimeout(()=>{if(this.live)this.enqueue(async()=>{await this.reset();this.schedule();});},40);}
  call(method,params){if(!this.live||!this.controller.paused)return Promise.reject(new Error('Mirror stopped'));if(this.parent&&method.startsWith('Input.'))return this.parent.call(method,params);return this.cdp.send(method,params,this.session);}
  async expand(n){if(n?.childNodeCount&&!n.children?.length){this.expanding||=new Map();if(this.expanding.has(n.nodeId))return;this.expanding.set(n.nodeId,Date.now());await this.call('DOM.requestChildNodes',{nodeId:n.nodeId,depth:-1,pierce:true}).catch(e=>{if(!this.live||!/Could not find node/.test(e.message))throw e;this.expanding.delete(n.nodeId);});}}
  async local(n,fn,args=[]){
    const frame=this.frameFor(n.nodeId),context=this.contexts.get(frame);if(!context)return undefined;
    const {object}=await this.call('DOM.resolveNode',{backendNodeId:n.backendNodeId,executionContextId:context});
    try{const r=await this.call('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:fn,arguments:args.map(value=>({value})),returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error('Mirror read failed');return r.result?.value;}finally{await this.call('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}
  }
  async refNode(n,fn){const context=this.contexts.get(this.frameFor(n.nodeId)),objects=[];try{const {object}=await this.call('DOM.resolveNode',{backendNodeId:n.backendNodeId,executionContextId:context});objects.push(object.objectId);const r=await this.call('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:fn,returnByValue:false});if(!r.result?.objectId)return 0;objects.push(r.result.objectId);return (await this.call('DOM.requestNode',{objectId:r.result.objectId})).nodeId;}finally{for(const objectId of objects)await this.call('Runtime.releaseObject',{objectId}).catch(()=>{});}}
  async selectNodes(n,s){const a=this.nodes.get(s.anchorId)?.node,f=this.nodes.get(s.focusId)?.node;if(!a||!f||this.frameFor(a.nodeId)!==this.frameFor(n.nodeId)||this.frameFor(f.nodeId)!==this.frameFor(n.nodeId)||![s.anchorOffset,s.focusOffset].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=100000))return false;const objects=[],context=this.contexts.get(this.frameFor(n.nodeId));try{for(const node of [n,a,f]){const {object}=await this.call('DOM.resolveNode',{backendNodeId:node.backendNodeId,executionContextId:context});objects.push(object.objectId);}const r=await this.call('Runtime.callFunctionOn',{objectId:objects[0],functionDeclaration:'function(a,ao,f,fo){if(!this.contains(a)||!this.contains(f))return false;try{this.ownerDocument.getSelection().setBaseAndExtent(a,ao,f,fo);return true}catch{return false}}',arguments:[{objectId:objects[1]},{value:s.anchorOffset},{objectId:objects[2]},{value:s.focusOffset}],returnByValue:true});return !!r.result?.value;}finally{for(const objectId of objects)await this.call('Runtime.releaseObject',{objectId}).catch(()=>{});}}
  frameFor(id){let r=this.nodes.get(id);while(r){const p=this.nodes.get(r.parent);if(r.node.nodeType===9&&(r.node.frameId||p?.node.frameId))return r.node.frameId||p.node.frameId;r=p;}return this.mainFrame;}
  nativeFrame(n){if(this.frameBridge?.child(n?.frameId))return true;if(!n?.contentDocument)return false;try{return ['http:','https:','about:'].includes(new URL(n.contentDocument.documentURL||'about:blank').protocol);}catch{return false;}}
  async reset(){
    if(!this.live||!this.controller.paused)return;this.ready=false;this.sheetDirty=true;this.epoch=++nextEpoch;this.lastSeq.clear();this.clientSeq=new WeakMap();this.expanding?.clear();
    const {frameTree}=await this.call('Page.getFrameTree');this.mainFrame=frameTree.frame.id;this.frames.clear();this.frameOrigins=new Map();this.frameBases=new Map();this.contexts=new Map();
    const gather=t=>{this.frames.set(t.frame.id,t.frame.url);this.frameOrigins.set(t.frame.id,t.frame.securityOrigin);for(const c of t.childFrames||[])gather(c);};gather(frameTree);
    const {root}=await this.call('DOM.getDocument',{depth:-1,pierce:true});this.root=root;this.nodes.clear();this.rawIndex(root);this.tree=null;
    const nativeFrames=new Set([this.mainFrame]);for(const {node,parent}of this.nodes.values())if(node.nodeType===9&&(!parent||this.nativeFrame(this.nodes.get(parent)?.node)))nativeFrames.add(this.frameFor(node.nodeId));
    for(const id of nativeFrames)try{const {executionContextId}=await this.call('Page.createIsolatedWorld',{frameId:id,worldName:'seek-native-mirror'});this.contexts.set(id,executionContextId);}catch{}
    await this.syncValues();await this.readSheets();await this.readResources();await this.topLayer();
    if(await this.gated()){this.off('captcha');return;}
    this.viewport=await this.readViewport();
    this.scroll=await this.readScroll();this.tree=this.serialize();if(!this.live)return;this.ready=true;this.dirty=false;this.sheetSig=JSON.stringify(this.wireSheets);const reset=this.resetMessage();if(Buffer.byteLength(JSON.stringify(reset))>MAX_BYTES){this.off('too-big');return;}this.broadcast(reset);
  }
  async readResources(frame){const session=this.frameSessions?.get(frame),{frameTree}=session&&session!==this.session?await this.cdp.send('Page.getResourceTree',{},session):await this.call('Page.getResourceTree');const visit=t=>{this.frames.set(t.frame.id,t.frame.url);this.frameOrigins?.set(t.frame.id,t.frame.securityOrigin);for(const r of t.resources||[])this.resourceTypes.set(r.url,r.mimeType);for(const c of t.childFrames||[])visit(c);};visit(frameTree);}
  async syncValues(){
    if(!this.live)return;const snap=await this.call('DOMSnapshot.captureSnapshot',{computedStyles:['position','display','box-sizing']}),strings=snap.strings;this.boxes=new Map();for(const d of snap.documents)for(let i=0;i<d.layout.nodeIndex.length;i++){const at=d.layout.nodeIndex[i],r=d.layout.bounds[i],style=d.layout.styles[i];this.boxes.set(d.nodes.backendNodeId[at],{w:r[2],h:r[3],position:strings[style?.[0]],display:strings[style?.[1]],sizing:strings[style?.[2]]});}
    for(const {node}of this.nodes.values())if(isSecretField(pairs(node.attributes)))this.secretIds.add(node.backendNodeId);
    // Snapshot secrets are read only into a private redaction set. They are never put in the wire
    // model. This also removes values reflected into text/attributes by page scripts.
    for(const d of snap.documents){const n=d.nodes;for(let i=0;i<n.backendNodeId.length;i++){const id=n.backendNodeId[i],v={};
      const field=n.inputValue?.index?.indexOf(i);if(field>=0){const value=strings[n.inputValue.value[field]]||'';if(this.secretIds.has(id)){v.len=value.length;this.secretValues.set(id,value);if(value)this.redactions.add(value);}else v.v=value;}
      if(n.inputChecked?.index?.includes(i))v.checked=true;else if(this.nodes.size)v.checked=false;
      v.selected=!!n.optionSelected?.index?.includes(i);
      this.values.set(id,v);
    }}
    for(const {node}of this.nodes.values())if(this.secretIds.has(node.backendNodeId)&&pairs(node.attributes).some(([k,v])=>k==='contenteditable'&&v!=='false')){const value=await this.local(node,'function(){return this.textContent||""}').catch(()=>null);if(value!==null){this.secretValues.set(node.backendNodeId,value);if(value)this.redactions.add(value);this.values.set(node.backendNodeId,{len:value.length});}}
  }
  redact(text,key){let s=String(text??'');const bridge=this.frameBridge,all=[this,...bridge?.children.values()||[],...(this.parent?[this.parent]:[])];for(const v of new Set(all.flatMap(m=>[...m.redactions,...m.secretValues.values()])))if(v)for(const variant of new Set([v,encodeURIComponent(v),JSON.stringify(v).slice(1,-1)]))s=s.split(variant).join('');return s;}
  serialize(){
    let count=0;const convert=(n,base)=>{
      if(![1,3,9,11].includes(n.nodeType))return null;
      if(++count>25000)throw new Error('too-big');const tag=n.nodeType===9||n.nodeType===11?'#document':n.nodeType===3?'#text':n.localName||n.nodeName.toLowerCase();
      if(!allowedTag(tag))return null;const frame=this.frameFor(n.nodeId);base=n.baseURL||(n.nodeType===9?n.documentURL||this.frames.get(frame)||base:base);if(n.nodeType===9)this.frameBases?.set(frame,base);
      const secret=this.secretIds.has(n.backendNodeId),v=this.values.get(n.backendNodeId)||{},r={i:n.nodeId,t:tag};
      if(tag==='#text'){r.v=this.redact(n.nodeValue,'text:'+n.backendNodeId);return r;}
      r.a=sanitizeAttrs(tag,pairs(n.attributes).map(([k,value])=>[k,secret&&k==='value'?'':this.redact(value,'attr:'+n.backendNodeId+':'+k)]),base,u=>this.resources.sign(u,frame),secret);
      if(secret){r.secret=true;r.len=v.len||0;}else if(v.v!==undefined)r.v=this.redact(v.v,'value:'+n.backendNodeId);
      if(pairs(n.attributes).some(a=>a[0]==='contenteditable'&&a[1]!=='false'))r.relay=true;
      if(tag==='input'&&pairs(n.attributes).some(a=>a[0]==='type'&&/checkbox|radio/.test(a[1])))r.checked=!!v.checked;
      if(tag==='option')r.selected=!!v.selected;
      if(['canvas','video','object','embed'].includes(tag)||tag==='img'&&new Map(pairs(n.attributes)).get('src')?.startsWith('blob:')||tag==='iframe'&&!this.nativeFrame(n)){r.island=tag;r.size=this.boxes.get(n.backendNodeId);return r;}
      r.c=(n.children||[]).map(c=>convert(c,base)).filter(Boolean);
      if(secret&&(tag==='textarea'||r.relay))r.c=[];
      r.s=(n.shadowRoots||[]).filter(s=>s.shadowRootType!=='user-agent').map(s=>convert(s,base)).filter(Boolean);
      const child=tag==='iframe'&&this.frameBridge?.child(n.frameId);if(child)r.d=this.frameBridge.tree(child);else if(n.contentDocument)r.d=convert(n.contentDocument,n.contentDocument.documentURL||base);
      return r;
    };
    try{const tree=convert(this.root,this.frames.get(this.mainFrame));if(Buffer.byteLength(JSON.stringify(tree))>MAX_BYTES)throw new Error('too-big');return tree;}catch(e){this.off(e.message==='too-big'?'too-big':'error');return null;}
  }
  async readSheets(){await readMirrorSheets(this);this.wireSheets=[...(this.ownSheets||[]),...(!this.parent?this.frameBridge?.sheets()||[]:[])];}
  resetMessage(){return {type:'mirror-reset',epoch:this.epoch,url:this.redact(this.frames.get(this.mainFrame),'url:'+this.mainFrame),viewport:this.viewport,tree:this.tree,sheets:this.wireSheets,scroll:this.scroll,top:this.top||[]};}
  schedule(){this.dirty=true;}
  async readViewport(){const v=await this.local(this.root,'function(){const w=this.defaultView;return {w:w.innerWidth,h:w.innerHeight,scrollbar:w.innerWidth-this.documentElement.clientWidth,dpr:w.devicePixelRatio}}').catch(()=>null);if(v)return v;const m=(await this.call('Page.getLayoutMetrics')).cssLayoutViewport;return {w:m.clientWidth,h:m.clientHeight};}
  async resize(){if(!this.ready)return;this.viewport=await this.readViewport();this.broadcast({type:'mirror-ops',epoch:this.epoch,ops:[{op:'viewport',viewport:this.viewport}]});this.schedule();}
  async flush(){
    if(!this.ready||!this.dirty||this.expanding?.size)return;this.dirty=false;await this.syncValues();await this.readSheets();const tree=this.serialize();if(!this.live)return;const ops=treeDiff(this.tree,tree);this.tree=tree;
    const sheetSig=JSON.stringify(this.wireSheets);if(this.sheetSig!==sheetSig){ops.push({op:'sheets',sheets:this.wireSheets});this.sheetSig=sheetSig;}
    if(ops.length)this.broadcast({type:'mirror-ops',epoch:this.epoch,ops});
    if(this.richSync?.size&&Date.now()>=this.richDue){const map=flatten(this.tree);for(const id of this.richSync){const node=map.get(id)?.n;if(node)this.broadcast({type:'mirror-rich',epoch:this.epoch,id,node,selection:await richSelection(this,this.nodes.get(id)?.node)});}this.richSync.clear();this.stateSig=null;}
  }
  async gated(){if(this.controller.handoff?.reason==='captcha')return true;const r=await this.call('Runtime.evaluate',{contextId:this.contexts.get(this.mainFrame),expression:`(${GATE_JS})==='captcha'||/robot or human|verify.*human|security check/i.test(document.title)`,returnByValue:true});if(r.exceptionDetails)throw new Error('Gate check failed');return !!r.result?.value;}
  async topLayer(){const r=await this.call('DOM.getTopLayerElements').catch(()=>({nodeIds:[]}));this.top=r.nodeIds||[];if(this.ready)this.broadcast({type:'mirror-ops',epoch:this.epoch,ops:[{op:'top',ids:this.top}]});}
  async readScroll(){const n=this.root;if(!n)return null;return this.local(n,'function(){const d=this.nodeType===9?this:this.ownerDocument,w=d.defaultView;let anchor=null;for(const e of d.elementsFromPoint(8,8)){if(e!==d.documentElement&&e!==d.body){anchor=e;break;}}return {x:w.scrollX,y:w.scrollY,backend:null,selector:null,offset:anchor?anchor.getBoundingClientRect().top:0}}');}
  async tick(){
    if(this.expanding?.size&&[...this.expanding.values()].some(at=>Date.now()-at>3000)){this.off('error');return;}
    // A page dialog blocks the page; reads would stall until it is answered in the sheet.
    if(!this.ready||(this.parent||this).controller.dialog)return;if(this.richSync?.size&&Date.now()>=this.richDue)this.schedule();await this.flush();for(const [ws,behind]of this.clients)if(behind&&ws.bufferedAmount<MAX_BUFFER/2){this.clients.set(ws,false);this.send(ws,this.resetMessage());this.stateSig=null;this.lastStateAt=0;}
    if(Date.now()-(this.lastStateAt||0)>500){this.lastStateAt=Date.now();await transientState(this);}
    if(Date.now()-(this.lastLayoutAt||0)>2000){this.lastLayoutAt=Date.now();await measureLayout(this);}
    if(Date.now()-this.lastGateAt>2000){this.lastGateAt=Date.now();if(await this.gated()){this.off('captcha');return;}}
    if(this.valueDue&&Date.now()>=this.valueDue){this.valueDue=0;await this.syncValues();this.schedule();const scroll=await this.hostScroll();this.broadcast({type:'mirror-ops',epoch:this.epoch,ops:[{op:'scroll',...scroll}]});}
    if(Date.now()-(this.lastScrollAt||0)>200){this.lastScrollAt=Date.now();const v=(await this.call('Page.getLayoutMetrics')).cssVisualViewport,key=v.pageX+':'+v.pageY;if(key!==this.lastScroll){this.lastScroll=key;const scroll=await this.hostScroll();this.scroll=scroll;this.broadcast({type:'mirror-ops',epoch:this.epoch,ops:[{op:'scroll',...scroll}]});}}
    if(Date.now()-this.lastIslandAt>180&&this.visible.size){this.lastIslandAt=Date.now();await this.islands();}
  }
  async hostScroll(){
    const {result:object}=await this.call('Runtime.evaluate',{contextId:this.contexts.get(this.mainFrame),expression:'[...document.querySelectorAll("*")].find(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.bottom>0&&r.top<innerHeight/2&&r.height>0&&r.height<innerHeight/2&&r.width>0&&!/fixed|sticky/.test(s.position)&&!e.children.length})',returnByValue:false});
    let id=0,offset=0;try{if(object?.objectId){id=(await this.call('DOM.requestNode',{objectId:object.objectId})).nodeId;const n=this.nodes.get(id)?.node;if(n)offset=await this.local(n,'function(){return this.getBoundingClientRect().top}');}}finally{if(object?.objectId)await this.call('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}
    const metrics=await this.call('Page.getLayoutMetrics');return {id,offset,x:metrics.cssVisualViewport.pageX,y:metrics.cssVisualViewport.pageY};
  }
  async quad(n){const r=await this.call('DOM.getBoxModel',{backendNodeId:n.backendNodeId}).catch(()=>null);if(r?.model?.border)return r.model.border;const {quads}=await this.call('DOM.getContentQuads',{backendNodeId:n.backendNodeId});return quads?.[0];}
  async point(n,rx=.5,ry=.5,drag=false){
    if(this.parent)await this.call('DOM.scrollIntoViewIfNeeded',{backendNodeId:n.backendNodeId});
    let q=await this.quad(n);if(!q)throw new Error('No box');const v=(await this.call('Page.getLayoutMetrics')).cssVisualViewport;
    if(q[2]<0||q[0]>v.clientWidth||q[5]<0||q[1]>v.clientHeight){await this.call('DOM.scrollIntoViewIfNeeded',{backendNodeId:n.backendNodeId});q=await this.quad(n);}
    rx=Math.max(drag?-20:0,Math.min(drag?20:1,Number(rx)||0));ry=Math.max(drag?-20:0,Math.min(drag?20:1,Number(ry)||0));const p={x:q[0]+(q[2]-q[0])*rx+(q[6]-q[0])*ry,y:q[1]+(q[3]-q[1])*rx+(q[7]-q[1])*ry};return this.parent?(await this.frameBridge.geometry(this,true)).point(p.x,p.y):p;
  }
  async input(msg,client){
    if(!this.live||!this.ready||!this.controller.paused||this.controller.dialog||msg.epoch!==this.epoch)return;
    if(!this.parent&&this.frameBridge&&await this.frameBridge.input(msg,client))return;
    if(msg.type==='mlayout'){await repairLayout(this,msg);return;}
    if(msg.type==='key'){await extendedInput(this,msg,undefined,client);return;}
    if(msg.type==='mvisible'){this.visible=new Set((msg.ids||[]).slice(0,40).filter(id=>flatten(this.tree).get(id)?.n.island));return;}
    if(msg.type==='mscroll'&&msg.id===0){const n=this.nodes.get(msg.anchor)?.node;if(n)await this.local(n,'function(offset){this.ownerDocument.defaultView.scrollBy({top:this.getBoundingClientRect().top-offset,behavior:"instant"})}',[Number(msg.offset)||0]);else await this.local(this.root,'function(x,y){this.defaultView.scrollTo({left:x,top:y,behavior:"instant"})}',[Number(msg.x)||0,Number(msg.y)||0]);
      // Your own scroll is not news: remember where it left the host so the next tick does not send it back mid-fling.
      const v=(await this.call('Page.getLayoutMetrics')).cssVisualViewport;this.lastScroll=v.pageX+':'+v.pageY;this.scroll={...this.scroll,x:v.pageX,y:v.pageY};return;}
    if(msg.type==='mhover'&&msg.leave){if(this.controller.viewportMode!=='mobile')await this.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:-1,y:-1,button:'none'});return;}
    const n=this.nodes.get(msg.id)?.node;if(!n||!flatten(this.tree).has(msg.id))return;
    if(await extendedInput(this,msg,n,client))return;
    switch(msg.type){
      case 'mtap':{const p=await this.point(n,msg.rx,msg.ry);const hit=await this.call('DOM.getNodeForLocation',{x:Math.round(p.x),y:Math.round(p.y),includeUserAgentShadowDOM:true,ignorePointerEventsNone:false}).catch(()=>null);
        if(hit?.backendNodeId!==n.backendNodeId&&!flatten(this.tree).get(msg.id)?.n.island){let node=hit?.nodeId;while(node&&node!==msg.id)node=this.nodes.get(node)?.parent;if(!node){const center=await this.point(n,.5,.5);p.x=center.x;p.y=center.y;}}
        if(this.controller.viewportMode==='mobile'){await this.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,radiusX:1,radiusY:1,force:1}]});await this.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}else{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await this.call('Input.dispatchMouseEvent',{type,...p,button:type==='mouseMoved'?'none':'left',clickCount:1});}break;}
      case 'mhover':{if(this.controller.viewportMode!=='mobile'){const p=await this.point(n,msg.rx,msg.ry);await this.call('Input.dispatchMouseEvent',{type:'mouseMoved',...p,button:'none'});}return;}
      case 'mfocus':await this.call('DOM.focus',{backendNodeId:n.backendNodeId}).catch(()=>{});break;
      case 'minput':{
        const rich=pairs(n.attributes).some(([k,v])=>k==='contenteditable'&&v!=='false');
        if(!(['input','textarea'].includes(n.localName)||rich)||typeof msg.ins!=='string'||msg.ins.length>50000||!Number.isSafeInteger(msg.seq)||msg.seq<=(this.sequences(client).get(n.backendNodeId)||0))return;
        if(!Number.isSafeInteger(msg.at)||!Number.isSafeInteger(msg.del)||msg.at<0||msg.del<0||msg.at>100000||msg.del>100000)return;
        this.sequences(client).set(n.backendNodeId,msg.seq);await this.call('DOM.focus',{backendNodeId:n.backendNodeId});
        const type=new Map(pairs(n.attributes)).get('type');if(!this.secretIds.has(n.backendNodeId)&&['range','color','date','datetime-local','time','month','week'].includes(type)&&typeof msg.value==='string'){
          const pick=async()=>{if(msg.value.length>64)return;await this.local(n,PICKER_VALUE,[msg.value]);await this.syncValues();this.ack(msg,client);};if(type!=='range'){await pick();break;}const spec=await this.local(n,'function(){return {min:Number(this.min||0),max:Number(this.max||100),step:Number(this.step||1)}}'),steps=Math.round((Number(msg.value)-spec.min)/(spec.step||1));if(!Number.isFinite(steps)||steps<0||steps>500){await pick();break;}for(const key of ['Home',...Array(steps).fill('ArrowRight')])for(const event of ['keyDown','keyUp'])await this.call('Input.dispatchKeyEvent',{type:event,key,code:key,windowsVirtualKeyCode:key==='Home'?36:39});await this.syncValues();this.ack(msg,client);break;
        }
        const selected=await this.local(n,selectionFunction,[msg.at,msg.at+msg.del]);
        if(!selected){if(this.secretIds.has(n.backendNodeId)||typeof msg.value!=='string'||msg.value.length>50000){this.off('unsupported-input');return;}await this.local(n,'function(){this.select()}');await this.call('Input.insertText',{text:msg.value});}
        else if(msg.ins.length===1&&msg.del===0){await this.call('Input.dispatchKeyEvent',{type:'keyDown',key:msg.ins,text:msg.ins});await this.call('Input.dispatchKeyEvent',{type:'keyUp',key:msg.ins});}
        else if(msg.ins)await this.call('Input.insertText',{text:msg.ins});
        else if(msg.del){await this.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',windowsVirtualKeyCode:8});await this.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',windowsVirtualKeyCode:8});}
        // Sync before any queued DOM mutations may be emitted, to redact reflected secrets.
        await this.syncValues();this.ack(msg,client);break;
      }
      case 'mselect':if(n.localName==='select'&&typeof msg.value==='string'){const index=await this.local(n,'function(value){return [...this.options].findIndex(o=>o.value===value&&!o.disabled)}',[msg.value]);if(index>=0&&index<1000){await this.call('DOM.focus',{backendNodeId:n.backendNodeId});for(const key of ['Home',...Array(index).fill('ArrowDown'),'Enter'])for(const type of ['keyDown','keyUp'])await this.call('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:{Home:36,ArrowDown:40,Enter:13}[key]});}}break;
      case 'mscroll':await this.local(n,'function(x,y){this.scrollTo({left:x,top:y,behavior:"instant"})}',[Number(msg.x)||0,Number(msg.y)||0]);return;
      default:return;
    }this.valueDue=Date.now()+150;this.schedule();
  }
  async islands(){await captureIslands(this);}

  off(reason){if(!this.live)return;const message=JSON.stringify({type:'mirror-off',epoch:this.epoch,reason:['captcha','too-big','islands','unsupported-input'].includes(reason)?reason:'error'});for(const ws of this.clients.keys())if(ws.readyState===1)ws.send(message);this.ready=false;this.failed=true;this.stop(false);}
  stop(clear=true){
    if(!this.parent&&this.session&&this.cdp.alive)void this.cdp.send('Target.setAutoAttach',{autoAttach:false,waitForDebuggerOnStart:false,flatten:true},this.session).catch(()=>{});
    this.live=false;this.ready=false;clearInterval(this.timer);clearTimeout(this.resetTimer);for(const off of this.offs)off();this.offs=[];if(!this.parent)this.frameBridge?.stop();this.expanding?.clear();this.nodes.clear();this.values.clear();this.secretIds.clear();this.redactions.clear();this.secretValues.clear();this.redactedStrings?.clear();if(!this.parent)this.resources.clear();this.root=null;this.tree=null;this.sheets.clear();this.ownSheets=[];this.wireSheets=[];this.frames.clear();this.frameOrigins?.clear();this.frameBases?.clear();this.frameSessions?.clear();this.contexts?.clear();this.boxes?.clear();this.measurements?.clear();this.richSync?.clear();this.lastSeq.clear();this.clientSeq=new WeakMap();
    if(clear)this.clients.clear();if(this.cdp.alive&&this.session){void this.cdp.send('CSS.disable',{},this.session).catch(()=>{});void this.cdp.send('DOM.disable',{},this.session).catch(()=>{});}
  }
}
