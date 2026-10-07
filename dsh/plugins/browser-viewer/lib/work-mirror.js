import {allowedTag,isSVGTag,sanitizeAttrs,sanitizeCSS,stateCSS,pictureCSS,editSpan,FRAME_CSP,isSecretField,treeDiff,updateWireTree} from '/work/mirror-shape.js';
const SVG='http://www.w3.org/2000/svg';
const KEYS={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34};
const mods=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
const textValue=n=>n.isContentEditable?n.textContent:n.value;
export class MirrorView{
  constructor(stage,{send,onFallback,onLoading,onRelay,onDiagnostics,onCommand,onLink,onMenu}={}){
    this.stage=stage;this.send=send;this.onFallback=onFallback;this.onLoading=onLoading;this.onRelay=onRelay;this.onDiagnostics=onDiagnostics;this.onCommand=onCommand;this.onLink=onLink;this.onMenu=onMenu;this.nodes=new Map();this.ids=new WeakMap();this.states=new WeakMap();this.epoch=0;this.active=false;this.seq=0;this.reuse=new Map();this.styles=[];this.styleNodes=new Map();this.diagnostics={state:'loading',fonts:0,images:0,drift:0};
    this.frame=document.createElement('iframe');this.frame.className='bv-mirror';this.frame.title='Native browser view';this.frame.tabIndex=0;this.frame.sandbox='allow-same-origin allow-scripts';this.frame.referrerPolicy='no-referrer';this.frame.hidden=true;this.frame.src='/work/mirror-frame';stage.append(this.frame);
    this.stageResize=new ResizeObserver(()=>{if(this.viewport)this.size(this.viewport);});this.stageResize.observe(stage);
    this.ready=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Native frame could not be checked')),6000);
      this.frame.addEventListener('load',async()=>{clearTimeout(timeout);try{const d=this.frame.contentDocument;if(!d)throw new Error('Native frame is unavailable');let blocked=false;const violation=e=>{if(/script-src|default-src/.test(e.effectiveDirective))blocked=true;};d.addEventListener('securitypolicyviolation',violation);
        const canary=d.createElement('script');canary.textContent='window.__seekMirrorCanary=true';d.body.append(canary);await new Promise(r=>setTimeout(r,80));canary.remove();d.removeEventListener('securitypolicyviolation',violation);
        if(d.defaultView.__seekMirrorCanary||!blocked)throw new Error('Native frame policy could not be checked');this.doc=d;this.listen(d);resolve();}catch(e){reject(e);}
      },{once:true});
    });this.ready.catch(()=>this.fallback('security'));
  }
  show(on){const was=this.active;this.active=on;this.frame.hidden=!on;this.stage.classList.toggle('native',on);if(!on){if(was)for(const n of [...this.nodes.values(),this.focusRestore].filter(Boolean)){const s=this.states.get(n);if(s){s.inFlight=false;s.commands=[];}if(s?.secret){if(s.rich)n.textContent='';else if('value'in n)n.value='';s.before='';s.pending=0;s.ack=0;}}this.focusRestore=null;this.reuse.clear();this.onLoading?.(false);this.onRelay?.(false);}}
  expectLoad(){if(!this.active)return;this.loading=true;this.onLoading?.(true);clearTimeout(this.expectTimer);this.expectTimer=setTimeout(()=>{if(this.loading&&this.awaitingLoad){this.loading=false;this.onLoading?.(false);}this.awaitingLoad=false;},6000);this.awaitingLoad=true;}
  fallback(reason){this.show(false);this.onFallback?.(reason);}
  emit(obj){if(this.active)this.send?.({...obj,epoch:this.epoch});}
  message(m){this.queue=(this.queue||Promise.resolve()).then(()=>this.receive(m));return this.queue;}
  async receive(m){
    if(m.type==='mirror-off'){this.fallback(m.reason);return;}
    if(m.type==='mirror-loading'){this.awaitingLoad=false;this.epoch=m.epoch;this.loading=true;this.onLoading?.(true);return;}
    if(m.type==='mirror-reset'){this.awaitingLoad=false;
      try{await this.ready;if(!this.active)return;const same=this.epoch===m.epoch&&this.tree;if(same)for(const n of this.nodes.values()){const s=this.states.get(n);if(s){s.pending=0;s.ack=0;s.inFlight=false;}}this.epoch=m.epoch;this.loading=true;this.onLoading?.(true);if(!same){this.assetRetry=0;this.diagnostics={state:'loading',fonts:0,images:0,drift:0};}this.reset(m,same);/* Built and clickable now; like Chrome, fonts may finish after the first click. */this.loading=false;this.onLoading?.(false);await this.waitAssets();}catch{this.fallback('security');}return;
    }
    if(m.epoch!==this.epoch||this.loading||!this.active)return;
    try{
      if(m.type==='mirror-ops'){this.applyOps(m.ops||[]);this.tree=updateWireTree(this.tree,m.ops||[]);}
      else if(m.type==='mirror-ack'){const n=this.nodes.get(m.id),s=n&&this.states.get(n);if(s)s.ack=Math.max(s.ack||0,m.seq);}
      else if(m.type==='mirror-islands')await this.islands(m);
      else if(m.type==='mirror-state')this.transient(m);
      else if(m.type==='mirror-layout')this.compareLayout(m.rows||[]);
      else if(m.type==='mirror-rich')this.rich(m.node,m.selection);
    }catch{this.fallback('render');}
  }
  applyOps(ops){let active=this.doc.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;const selection=active?.isContentEditable&&!this.states.get(active)?.composing?this.selection(active):null;this.reuse.clear();this.pendingDetach=[];for(const op of ops)this.apply(op);for(const n of this.pendingDetach)if(this.nodes.get(this.ids.get(n))!==n)n.remove();this.pendingDetach=[];this.reuse.clear();if(selection&&active.isConnected)this.setSelection(active,selection);this.observeIslands();}
  reset(m,same){
    if(same)this.applyOps(treeDiff(this.tree,m.tree));else{
      this.observer?.disconnect();this.nodes.clear();this.ids=new WeakMap();this.styles=[];this.styleNodes.clear();this.reuse.clear();
      const html=(m.tree.c||[]).find(n=>n.t==='html');if(!html)throw new Error('No document');
      this.doc.documentElement.replaceWith(this.build(html,this.doc));this.nodes.set(m.tree.i,this.doc);this.ids.set(this.doc,m.tree.i);
      const meta=this.doc.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=FRAME_CSP;this.doc.head?.prepend(meta);
    }this.tree=m.tree;
    this.finishFrames();this.setSheets(m.sheets);this.top(m.top||[]);
    this.size(m.viewport);
    if(m.scroll&&!same)this.doc.defaultView.scrollTo(m.scroll.x||0,m.scroll.y||0);this.observeIslands();
  }
  size(viewport){this.viewport=viewport;const sw=this.stage.clientWidth,sh=this.stage.clientHeight;if(!sw||!sh)return;const w=Math.max(1,viewport?.w||sw),scale=Math.min(1,sw/w);
    this.frame.style.width=w+'px';this.frame.style.height=sh/scale+'px';this.frame.style.transform=`scale(${scale})`;this.frame.style.transformOrigin='top left';
  }
  fieldKey(n,parent){const a=new Map(n.a||[]);return [parent,n.t,a.get('type')||'',a.get('name')||'',a.get('id')||''].join('|');}
  build(n,d,parent=0){
    if(!n||!Number.isSafeInteger(n.i)||!allowedTag(n.t))throw new Error('Invalid wire node');
    let el;if(n.t==='#text')el=d.createTextNode(String(n.v||''));else if(n.t==='#document')el=d.createDocumentFragment();else{
      const tag=n.island&&n.t!=='canvas'?'div':n.t,key=this.fieldKey(n,parent),old=['input','textarea','select'].includes(n.t)&&this.reuse.get(key);
      el=old||(isSVGTag(tag)?d.createElementNS(SVG,tag):d.createElement(tag));
      const safeAttrs=sanitizeAttrs(n.t,n.a,location.origin,undefined,n.secret);
      if(old){this.reuse.delete(key);const names=new Set(safeAttrs.map(a=>a[0]));for(const a of [...el.attributes])if(!names.has(a.name))el.removeAttribute(a.name);while(el.firstChild)el.firstChild.remove();}
      for(const [name,value]of safeAttrs)try{if(el.getAttribute(name)!==value)el.setAttribute(name,value);}catch{}
      if(n.island){el.classList.add('seek-mirror-island');el.dataset.seekTag=n.t;el.style.overflow='hidden';el.style.minWidth='1px';el.style.minHeight='1px';el.dataset.island='';if(!el.hasAttribute('tabindex'))el.tabIndex=0;this.states.set(el,{island:n.island});if(tag!=='canvas'){const canvas=d.createElement('canvas');canvas.setAttribute('aria-hidden','true');canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';el.append(canvas);}}
      else for(const child of n.c||[])el.append(this.build(child,d,n.i));
      if(n.s?.length){const root=el.shadowRoot||el.attachShadow({mode:'open'});for(const r of n.s){this.nodes.set(r.i,root);this.ids.set(root,r.i);for(const c of r.c||[])root.append(this.build(c,d,r.i));}}
      if(n.d){this.pendingFrames||=[];this.pendingFrames.push({el,tree:n.d});}
      if(n.relay){el.dataset.relay='';el.tabIndex=0;const s=this.states.get(el)||{before:el.textContent||'',pending:0,ack:0};s.rich=true;s.secret=!!n.secret;this.states.set(el,s);}
      if(['input','textarea','select'].includes(n.t)&&(n.secret||isSecretField(n.a))){const s=this.states.get(el)||{before:el.value||'',pending:0,ack:0};s.secret=true;this.states.set(el,s);}this.value(el,n);
      if(old&&this.focusRestore===old&&this.mayFocus()){old.focus({preventScroll:true});try{old.setSelectionRange(...this.restoreSelection);}catch{}}
    }
    this.nodes.set(n.i,el);this.ids.set(el,n.i);return el;
  }
  finishFrames(){for(const {el,tree}of this.pendingFrames||[]){const d=el.contentDocument;if(!d)continue;const html=(tree.c||[]).find(n=>n.t==='html');if(html)d.documentElement.replaceWith(this.build(html,d));this.nodes.set(tree.i,d);this.ids.set(d,tree.i);this.listen(d);}this.pendingFrames=[];}
  value(el,n){if(!el||el.nodeType!==1)return;const s=this.states.get(el);if(n.secret){if(s)s.secret=true;el.removeAttribute('value');}
    if(s?.island&&n.size){s.size=n.size;this.islandSize(el,s);}
    if(s?.composing)return;
    if(s?.secret&&n.len!==undefined&&(!s.pending||s.pending<=s.ack)&&textValue(el).length!==n.len){if(s.rich)el.textContent='•'.repeat(Math.min(100000,Math.max(0,n.len)));else el.value='•'.repeat(Math.min(100000,Math.max(0,n.len)));s.before=textValue(el);}
    if(n.v!==undefined&&n.v!==null&&!s?.secret&&(!s||s.pending<=s.ack)&&'value'in el){const a=el.selectionStart,b=el.selectionEnd;el.value=String(n.v);if(s)s.before=el.value;if(el===el.ownerDocument.activeElement&&a!==null)try{el.setSelectionRange(Math.min(a,el.value.length),Math.min(b,el.value.length));}catch{}}
    if(n.checked!==undefined&&'checked'in el)el.checked=!!n.checked;if(n.selected!==undefined&&'selected'in el)el.selected=!!n.selected;
  }
  forget(n){if(!n)return;const id=this.ids.get(n);if(id&&this.nodes.get(id)===n)this.nodes.delete(id);for(const c of [...(n.childNodes||[])])this.forget(c);if(n.shadowRoot)this.forget(n.shadowRoot);}
  apply(op){
    const n=this.nodes.get(op.id);
    if(op.op==='remove'||op.op==='replace'){
      if(n&&['INPUT','TEXTAREA','SELECT'].includes(n.tagName)){const attrs=[...n.attributes].map(a=>[a.name,a.value]),key=this.fieldKey({t:n.localName,a:attrs},this.ids.get(n.parentNode));this.reuse.set(key,n);if(n===n.ownerDocument.activeElement){this.focusRestore=n;this.restoreSelection=[n.selectionStart,n.selectionEnd];}}
      if(op.op==='replace'){const replacement=this.build(op.node,n.ownerDocument,this.ids.get(n.parentNode));if(replacement!==n){n.replaceWith(replacement);this.forget(n);this.finishFrames();}}else{this.forget(n);if(n===this.focusRestore)(this.pendingDetach||=[]).push(n);else n?.remove?.();}return;
    }
    if(op.op==='insert'){const parent=this.nodes.get(op.parent);if(!parent)return;const node=this.build(op.node,parent.ownerDocument||this.doc,op.parent),before=this.nodes.get(op.before)?.parentNode===parent?this.nodes.get(op.before):null;if(node.parentNode!==parent||node.nextSibling!==before)parent.insertBefore(node,before);this.finishFrames();if(this.focusRestore?.isConnected&&this.mayFocus())this.focusRestore.focus({preventScroll:true});return;}
    if(op.op==='text'&&n?.nodeType===3&&n.textContent!==String(op.value||''))n.textContent=String(op.value||'');
    else if(op.op==='attr'&&n?.nodeType===1){if(op.value===null)n.removeAttribute(op.name);else{const safe=sanitizeAttrs(n.localName,[[op.name,op.value]],location.origin,undefined,this.states.get(n)?.secret);if(safe.length)n.setAttribute(...safe[0]);}const state=this.states.get(n);if(state?.island)this.islandSize(n,state);}
    else if(op.op==='value')this.value(n,op);
    else if(op.op==='order'&&n){let previous=null;for(const id of op.ids){const child=this.nodes.get(id);if(child?.parentNode!==n)continue;const expected=previous?previous.nextSibling:n.firstChild;if(child!==expected)n.insertBefore(child,expected);previous=child;}}
    else if(op.op==='sheets')this.setSheets(op.sheets);
    else if(op.op==='computed'&&n?.nodeType===1){for(const [key,value]of Object.entries(op.style||{}))if(/^(font-(family|size|weight|style|stretch|variation-settings|feature-settings)|line-height|letter-spacing|word-spacing|white-space|text-transform|box-sizing|padding-(top|right|bottom|left)|margin-(top|right|bottom|left))$/.test(key)){const safe=sanitizeCSS(key+':'+value,location.origin);if(safe.startsWith(key+':'))n.style.setProperty(key,safe.slice(key.length+1),'important');}}
    else if(op.op==='viewport')this.size(op.viewport);
    else if(op.op==='top')this.top(op.ids);
    else if(op.op==='scroll'){if(Date.now()-(this.userScrollAt||0)<700)return;this.suppressScrollUntil=Date.now()+150;const anchor=this.nodes.get(op.id);if(anchor?.getBoundingClientRect)this.doc.defaultView.scrollBy(0,anchor.getBoundingClientRect().top-(op.offset||0));else this.doc.defaultView.scrollTo(op.x||0,op.y||0);}
  }
  setSheets(sheets){
    this.lastSheets=sheets||[];const keep=new Set(),groups=new Map();
    for(const [index,s]of this.lastSheets.entries()){
      const owner=this.nodes.get(s.owner),parent=this.nodes.get(s.parent),target=parent?.nodeType===1||parent?.nodeType===11?parent:owner?.nodeType===9?owner.head:owner?.nodeType===11?owner:this.doc.head;if(!target)continue;
      const key=String(s.id??index),el=this.styleNodes.get(key)||target.ownerDocument.createElement('style');keep.add(key);this.styleNodes.set(key,el);
      let text=stateCSS(pictureCSS(sanitizeCSS(s.text,location.origin)));if(this.assetRetry)text=text.replace(/(\/work\/mirror-res\?[^"')\s]+)/g,'$1&r='+this.assetRetry);
      if(el.textContent!==text)el.textContent=text;el.disabled=!!s.disabled;
      const before=this.nodes.get(s.before),anchor=before?.parentNode===target?before:null;let targets=groups.get(target);if(!targets)groups.set(target,targets=new Map());let rows=targets.get(anchor);if(!rows)targets.set(anchor,rows=[]);rows.push(el);
    }
    for(const [key,el]of this.styleNodes)if(!keep.has(key)){el.remove();this.styleNodes.delete(key);}
    for(const [target,anchors]of groups)for(const [anchor,rows]of anchors){const members=new Set(rows);let reference=[...target.childNodes].find(n=>members.has(n))||anchor;for(const el of rows){if(el!==reference)target.insertBefore(el,reference);reference=el.nextSibling;} }
    this.styles=[...this.styleNodes.values()];if(!this.mobileStyle?.isConnected){this.mobileStyle=this.doc.createElement('style');this.mobileStyle.textContent='@media(pointer:coarse){input:not([type=checkbox]):not([type=radio]),textarea,select{font-size:max(16px,1em)!important}}a[href]{-webkit-touch-callout:none}';this.doc.head?.append(this.mobileStyle);}
    this.styles.push(this.mobileStyle);
  }
  diagnostic(values){Object.assign(this.diagnostics,values);this.onDiagnostics?.({...this.diagnostics});}
  rich(node,selection){const n=this.nodes.get(node.i),s=n&&this.states.get(n);if(!s?.rich)return;if(s.secret){this.value(n,node);s.inFlight=false;if(s.commands?.length)this.sendRich(n,this.nextRich(s));return;}if(s.composing)return;for(const c of [...n.childNodes])this.forget(c);n.replaceChildren(...(node.c||[]).map(c=>this.build(c,n.ownerDocument,node.i)));s.before=textValue(n);this.tree=updateWireTree(this.tree,[{op:'replace',id:node.i,node}]);this.finishFrames();s.inFlight=false;if(selection)this.restoreRichSelection(n,selection);s.selectionSig=JSON.stringify(this.selection(n));if(s.commands?.length)this.sendRich(n,this.nextRich(s));}
  islandSize(el,s){const size=s.size;if(!size)return;el.style.position=size.position&&size.position!=='static'?size.position:'relative';if(el.localName!=='canvas'){el.style.boxSizing='border-box';el.style.width=Math.max(1,size.w)+'px';el.style.height=Math.max(1,size.h)+'px';el.style.display=size.display==='inline'?'inline-block':size.display||'inline-block';}}
  compareLayout(rows){const ids=[];let max=0;this.repaired||=new Set();for(const r of rows){const n=this.nodes.get(r.id);if(!n?.getBoundingClientRect||n.dataset.island!==undefined)continue;const a=n.getBoundingClientRect(),error=Math.max(Math.abs(a.left-r.x),Math.abs(a.top-r.y),Math.abs(a.width-r.w),Math.abs(a.height-r.h));if(error>3){max=Math.max(max,error);if(!this.repaired.has(r.id)){this.repaired.add(r.id);ids.push(r.id);}}}this.diagnostic({drift:Math.round(max)});if(ids.length)this.emit({type:'mlayout',ids:ids.slice(0,40)});}
  transient(m){this.stateGroups||=new Map();const group=m.frame||'main',previous=this.stateGroups.get(group)||new Set(),next=new Set();for(const r of m.rows||[]){const n=this.nodes.get(r.id);if(!n?.setAttribute)continue;next.add(r.id);for(const [field,key]of [['hover','hover'],['focus','focus'],['within','focus-within'],['visible','focus-visible'],['active','active'],['invalid','invalid']])n.toggleAttribute('data-seek-state-'+key,!!r[field]);const s=this.states.get(n);if(r.focus&&!s?.composing&&(!s||!s.pending||s.pending<=s.ack)&&!(n.shadowRoot?.activeElement)&&this.mayFocus()){this.suppressSelection=true;n.focus?.({preventScroll:true});if(Number.isInteger(r.start)&&Number.isInteger(r.end))try{n.setSelectionRange(r.start,r.end,r.direction);}catch{}else if(r.anchorId){const a=this.nodes.get(r.anchorId),f=this.nodes.get(r.focusId);if(n.contains(a)&&n.contains(f))try{n.ownerDocument.getSelection().setBaseAndExtent(a,r.anchorOffset,f,r.focusOffset);}catch{}}setTimeout(()=>{this.suppressSelection=false;},50);}}for(const id of previous)if(!next.has(id)){const n=this.nodes.get(id);for(const key of ['hover','focus','focus-within','focus-visible','active','invalid'])n?.removeAttribute?.('data-seek-state-'+key);}this.stateGroups.set(group,next);if(group==='main'&&'selection'in m)this.pageSelection(m.selection);}
  pageSelection(sel){const d=this.doc,active=d?.activeElement,local=d?.getSelection();if(!local||active&&(active.isContentEditable||/^(input|textarea)$/.test(active.localName)))return;
    const a=sel&&this.nodes.get(sel.anchorId),f=sel&&this.nodes.get(sel.focusId),at=(x,o)=>Math.min(o,x.nodeType===3?x.length:x.childNodes.length);
    if(a&&f&&a.ownerDocument===d&&f.ownerDocument===d){this.suppressSelection=true;try{local.setBaseAndExtent(a,at(a,sel.anchorOffset),f,at(f,sel.focusOffset));this.hostSelection=true;}catch{}setTimeout(()=>{this.suppressSelection=false;},50);}
    else if(!sel&&this.hostSelection){this.hostSelection=false;local.removeAllRanges();}}
  async waitAssets(){
    const docs=new Set([this.doc,...[...this.nodes.values()].filter(n=>n.nodeType===9)]);for(const d of docs)d.body?.getBoundingClientRect();
    let settled=false;await Promise.race([Promise.all([...docs].map(d=>d.fonts.ready)).then(()=>{settled=true;}),new Promise(r=>setTimeout(r,800))]);
    const failed=[...docs].flatMap(d=>[...d.fonts]).filter(f=>f.status==='error').length;
    this.diagnostic({state:failed?'degraded':settled?'ready':'loading',fonts:failed});
    if(failed&&this.active){if(!this.assetRetry){this.assetRetry=1;this.setSheets(this.lastSheets);await this.waitAssets();}else this.fallback('fonts');}
  }
  retryAssets(){this.assetRetry=Math.min(2,(this.assetRetry||0)+1);this.setSheets(this.lastSheets);for(const n of this.nodes.values())if(n.localName==='img'&&!n.complete||n.localName==='img'&&!n.naturalWidth){const src=n.getAttribute('src');if(src?.startsWith('/work/mirror-res?'))n.src=src+'&r='+this.assetRetry;}return this.waitAssets();}
  top(ids){const set=new Set(ids);for(const [id,n]of this.nodes){if(n.nodeType!==1)continue;try{if(n.localName==='dialog'){if(set.has(id)&&!n.matches(':modal')){if(n.open)n.close();n.showModal();}else if(!set.has(id)&&n.matches(':modal'))n.close();}else if(n.hasAttribute('popover')){if(set.has(id))n.showPopover();else n.hidePopover();}}catch{}}}
  mayFocus(){const a=this.frame.ownerDocument.activeElement;return !a||a===this.frame||a===this.frame.ownerDocument.body;}
  nearest(e){for(const n of e.composedPath()){const id=this.ids.get(n);if(id&&n.nodeType===1)return {n,id};}return {};}
  listen(d){
    if(this.listened?.has(d))return;(this.listened||=new WeakSet()).add(d);
    d.addEventListener('error',e=>{if(e.target.localName==='img'){this.failedImages||=new Set();this.failedImages.add(e.target);this.diagnostic({images:this.failedImages.size,state:'degraded'});}},true);
    d.addEventListener('load',e=>{if(e.target.localName==='img'&&this.failedImages?.delete(e.target))this.diagnostic({images:this.failedImages.size});},true);
    d.fonts?.addEventListener('loadingdone',()=>{if(this.active&&!this.loading)void this.waitAssets();});
    d.fonts?.addEventListener('loadingerror',()=>{if(this.active&&!this.loading)void this.waitAssets();});
    const field=n=>n?.isContentEditable||n?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]),textarea');
    d.addEventListener('focusin',e=>{if(this.loading)return;const {n,id}=this.nearest(e);if(field(n)){const s=this.states.get(n)||{before:textValue(n),pending:0,ack:0};s.secret||=isSecretField([...n.attributes].map(a=>[a.name,a.value]));s.rich=n.isContentEditable;this.states.set(n,s);this.emit({type:'mfocus',id});this.onRelay?.(false);}else if(n?.dataset.island!==undefined){this.emit({type:'mfocus',id});this.onRelay?.(true);}},true);
    d.addEventListener('click',e=>{if(!this.active)return;if(this.loading){e.preventDefault();return;}const {n,id}=this.nearest(e);if(!id)return;if(n.localName==='select'||n.localName==='option')return;if(!field(n))e.preventDefault();if(!e.isTrusted||Date.now()>(this.pointerClickUntil||0)){const r=n.getBoundingClientRect();this.emit({type:'mtap',id,rx:(e.clientX-r.left)/r.width,ry:(e.clientY-r.top)/r.height});}if(n.dataset.island!==undefined)this.onRelay?.(true);},true);
    d.addEventListener('compositionstart',e=>{const s=this.states.get(e.target);if(s){s.composing=true;const selection=this.selection(e.target);this.emit({type:'mcomposition',id:this.ids.get(e.target),phase:'start',text:'',...selection});}},true);
    d.addEventListener('compositionupdate',e=>{if(this.states.get(e.target)?.composing)this.emit({type:'mcomposition',id:this.ids.get(e.target),phase:'update',text:e.data||''});},true);
    d.addEventListener('compositionend',e=>{const s=this.states.get(e.target);if(s){s.composing=false;s.before=textValue(e.target);this.emit({type:'mcomposition',id:this.ids.get(e.target),phase:'end',text:e.data||''});}},true);
    d.addEventListener('beforeinput',e=>{const s=this.states.get(e.target);if(!s?.rich||e.isComposing||s.composing)return;if(!['insertText','insertFromPaste','insertParagraph','insertLineBreak','deleteContentBackward','deleteContentForward','deleteByCut'].includes(e.inputType)){if(e.cancelable)e.preventDefault();return;}e.preventDefault();this.richInput(e.target,e.inputType,e.data||'');},true);
    d.addEventListener('input',e=>{const s=this.states.get(e.target);if(s?.skipLine){s.skipLine=false;s.before=textValue(e.target);return;}if(!e.isComposing&&!s?.rich)this.input(e.target);},true);
    d.addEventListener('paste',e=>{const s=this.states.get(e.target);if(!s?.rich)return;e.preventDefault();this.richInput(e.target,'insertFromPaste',e.clipboardData?.getData('text/plain')||'');},true);
    d.addEventListener('change',e=>{if(e.target.localName==='select')this.emit({type:'mselect',id:this.ids.get(e.target),value:e.target.value});},true);
    d.addEventListener('keydown',e=>{if(!this.active||e.isComposing)return;const k=e.key.length===1?e.key.toLowerCase():e.key,command=k==='F5'&&!e.altKey?'reload':(e.ctrlKey||e.metaKey)&&!e.altKey?(/^[1-9]$/.test(k)?'tab-'+k:{l:'address',t:'new-tab',w:'close-tab',r:'reload',Tab:e.shiftKey?'previous-tab':'next-tab',PageDown:'next-tab',PageUp:'previous-tab'}[k]):e.altKey&&!e.ctrlKey&&!e.metaKey?{ArrowLeft:'back',ArrowRight:'forward'}[k]:null;if(command&&this.onCommand){e.preventDefault();this.onCommand(command);return;}if(this.loading)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f')return;const edit=field(e.target),rich=e.target.isContentEditable,shortcut=(e.ctrlKey||e.metaKey)&&/^[zybiu]$/i.test(e.key),modifiedDelete=(e.ctrlKey||e.metaKey||e.altKey)&&['Backspace','Delete'].includes(e.key);if(rich&&(e.key==='Enter'||['Backspace','Delete'].includes(e.key)&&!modifiedDelete))return;
      // A plain field deletes locally and sends the span as minput; also sending the key would delete twice. Only a no-op delete (caret at the edge) goes as a key, for sites that watch it.
      if(edit&&!rich&&['Backspace','Delete'].includes(e.key)){const t=e.target,a=t.selectionStart,b=t.selectionEnd;if(a===null||a!==b||(e.key==='Backspace'?a>0:b<textValue(t).length))return;}if(edit&&e.key.length===1&&!shortcut)return;if(!KEYS[e.key]&&!shortcut&&edit)return;if(e.key==='Enter'&&!edit||e.key==='Escape'||shortcut||rich&&modifiedDelete)e.preventDefault();if(edit&&!rich)this.input(e.target);if(e.key==='Enter'&&e.target.localName==='textarea'){const s=this.states.get(e.target);if(s)s.skipLine=true;}const id=this.ids.get(e.target)||this.ids.get(d.activeElement)||0;for(const event of ['keyDown','keyUp'])this.emit({type:'mkey',id,event,key:e.key,code:e.code,windowsVirtualKeyCode:e.keyCode||KEYS[e.key],modifiers:mods(e),...(edit?{selection:this.selection(e.target)}:{})});},true);
    let selectionTimer;d.addEventListener('selectionchange',()=>{if(this.suppressSelection||this.loading)return;clearTimeout(selectionTimer);selectionTimer=setTimeout(()=>{let n=d.activeElement;while(n?.shadowRoot?.activeElement)n=n.shadowRoot.activeElement;if(!field(n))return;const selection=this.selection(n),st=this.states.get(n);if(st?.rich){/* Rich edits don't move the local caret until the host's copy returns: only a caret the user moved is news. */const sig=JSON.stringify(selection);if(st.inFlight||st.commands?.length||sig===st.selectionSig)return;st.selectionSig=sig;}this.emit({type:'mselection',id:this.ids.get(n),...selection});},40);});
    let pointer=null,hover=0,lastClick={};const point=(e,n)=>{const r=n.getBoundingClientRect();return {rx:(e.clientX-r.left)/Math.max(1,r.width),ry:(e.clientY-r.top)/Math.max(1,r.height)};};
    // Mouse back/forward buttons drive the remote history, never Seek's own. Chrome moves the page's history
    // unless mouseup is cancelled, so pointerdown must not be cancelled for them (that would suppress mouseup).
    const historyButton=e=>e.button===3||e.button===4,stopHistory=e=>{if(historyButton(e)){e.preventDefault();e.stopPropagation();}};
    for(const type of ['mousedown','mouseup','auxclick'])d.addEventListener(type,stopHistory,true);
    d.addEventListener('pointerdown',e=>{if(!this.active)return;if(historyButton(e)){e.stopPropagation();this.onCommand?.(e.button===3?'back':'forward');return;}if(this.loading)return;if(e.pointerType==='touch'){const {n,id}=this.nearest(e);if(!id||pointer||!e.composedPath().some(x=>x.nodeType===1&&d.defaultView.getComputedStyle(x).touchAction==='none'))return;pointer={n,id,button:'left',clickCount:1,touch:true};this.emit({type:'mpointer',event:'down',id,...point(e,n),button:'left',buttons:1,clickCount:1,modifiers:0,touch:true});return;}const {n,id}=this.nearest(e);if(!id||n.localName==='select'||n.localName==='option')return;
      // Default focus handling is cancelled below, so move keyboard focus the way a click would: off the old field and into this page.
      if(!field(n)){const a=d.activeElement;if(a&&a!==d.body&&a!==n&&!a.contains(n))a.blur();}const button=e.button===2?'right':e.button===1?'middle':'left',clickCount=lastClick.id===id&&Date.now()-lastClick.at<400?Math.min(3,(lastClick.count||1)+1):1;lastClick={id,at:Date.now(),count:clickCount};pointer={n,id,button,clickCount};if(!field(n)){e.preventDefault();n.focus?.({preventScroll:true});if(!d.hasFocus())d.defaultView.focus();n.setPointerCapture?.(e.pointerId);}this.emit({type:'mpointer',event:'down',id,...point(e,n),button,buttons:e.buttons,clickCount,modifiers:mods(e)});},true);
    d.addEventListener('pointermove',e=>{if(e.pointerType==='touch'&&!pointer?.touch||Date.now()-hover<(pointer?.touch?16:30))return;hover=Date.now();const {n,id}=pointer||this.nearest(e);if(!id)return;if(pointer)this.emit({type:'mpointer',event:'move',id,...point(e,n),button:pointer.button,buttons:e.buttons||1,clickCount:pointer.clickCount,modifiers:mods(e),...(pointer.touch?{touch:true}:{})});else this.emit({type:'mhover',id,...point(e,n)});},true);
    const release=e=>{if(!pointer)return;const p=pointer;pointer=null;this.pointerClickUntil=Date.now()+300;this.emit({type:'mpointer',event:e.type==='pointercancel'?'cancel':'up',id:p.id,...point(e,p.n),button:p.button,buttons:0,clickCount:p.clickCount,modifiers:mods(e),...(p.touch?{touch:true}:{})});};d.addEventListener('pointerup',release,true);d.addEventListener('pointercancel',release,true);
    d.addEventListener('pointerdown',()=>this.onMenu?.(null),true);
    d.addEventListener('pointerover',e=>{if(e.pointerType!=='touch')this.onLink?.(e.target.closest?.('a[data-seek-href]')?.dataset.seekHref||'');},true);
    d.addEventListener('contextmenu',e=>{e.preventDefault();if(!this.active||this.loading)return;const href=e.target.closest?.('a[data-seek-href]')?.dataset.seekHref||'',text=d.getSelection()?.toString()||'';if(!href&&!text)return;let x=e.clientX,y=e.clientY,w=d.defaultView;while(w.frameElement){const r=w.frameElement.getBoundingClientRect(),k=r.width/(w.frameElement.offsetWidth||r.width);x=r.left+x*k;y=r.top+y*k;w=w.parent;}this.onMenu?.({x,y,href,text:text.slice(0,100000)});},true);
    // Leaving the page ends hover on the host too, so menus opened by hover close.
    d.addEventListener('mouseout',e=>{if(e.relatedTarget||d!==this.doc)return;this.onLink?.('');if(!pointer&&this.active&&!this.loading)this.emit({type:'mhover',id:0,leave:true});},true);
    // The wheel scrolls Native locally when it can (instant); otherwise it goes to the host: canvas/maps/pictures, scroll-jacked pages, pinch/ctrl-zoom.
    let wheel=null;const scrolls=(x,e)=>{const el=x.nodeType===9?x.scrollingElement:x;if(!el||x.nodeType!==9&&(x===d.documentElement||x===d.body))return false;const style=y=>d.defaultView.getComputedStyle(y),dy=Math.abs(e.deltaY)>=Math.abs(e.deltaX),axis=dy?'overflowY':'overflowX';
      if(x.nodeType===9){if([d.documentElement,d.body].some(y=>y&&/hidden|clip/.test(style(y)[axis])))return false;}else if(!/auto|scroll|overlay/.test(style(el)[axis]))return false;
      return dy?(e.deltaY>0?el.scrollTop+el.clientHeight<el.scrollHeight-1:el.scrollTop>0):(e.deltaX>0?el.scrollLeft+el.clientWidth<el.scrollWidth-1:el.scrollLeft>0);};
    d.addEventListener('wheel',e=>{if(!this.active||this.loading)return;const {n,id}=this.nearest(e),path=e.composedPath();if(!id)return;if(!e.ctrlKey&&!path.some(x=>x.dataset?.island!==undefined)&&path.some(x=>(x.nodeType===1||x.nodeType===9)&&scrolls(x,e)))return;
      e.preventDefault();const k=e.deltaMode===1?16:e.deltaMode===2?d.defaultView.innerHeight:1;if(wheel?.id!==id){if(wheel)this.emit(wheel.msg);wheel={id,msg:{type:'mwheel',id,...point(e,n),dx:0,dy:0,modifiers:mods(e)}};setTimeout(()=>{if(wheel){this.emit(wheel.msg);wheel=null;}},32);}wheel.msg.dx+=e.deltaX*k;wheel.msg.dy+=e.deltaY*k;},{capture:true,passive:false});
    let scroll;d.addEventListener('scroll',e=>{if(Date.now()<(this.suppressScrollUntil||0)||this.loading)return;this.userScrollAt=Date.now();clearTimeout(scroll);scroll=setTimeout(()=>{
      if(e.target.nodeType===9){const height=d.defaultView.innerHeight;let anchor=[...this.nodes.values()].find(n=>{if(n.ownerDocument!==d||n.nodeType!==1||n.children.length)return false;const r=n.getBoundingClientRect(),s=d.defaultView.getComputedStyle(n);return r.bottom>0&&r.top<height/2&&r.height>0&&r.height<height/2&&r.width>0&&!/fixed|sticky/.test(s.position);});this.emit({type:'mscroll',id:0,anchor:this.ids.get(anchor)||0,offset:anchor?.getBoundingClientRect().top||0,x:d.defaultView.scrollX,y:d.defaultView.scrollY});}
      else this.emit({type:'mscroll',id:this.ids.get(e.target),x:e.target.scrollLeft,y:e.target.scrollTop});
    },100);},true);
    d.addEventListener('submit',e=>e.preventDefault(),true);
  }
  restoreRichSelection(n,s){const a=this.nodes.get(s.anchorId),f=this.nodes.get(s.focusId);if(!n.contains(a)||!n.contains(f))return;this.suppressSelection=true;try{n.ownerDocument.getSelection().setBaseAndExtent(a,s.anchorOffset,f,s.focusOffset);}catch{}setTimeout(()=>{this.suppressSelection=false;},50);}
  richInput(n,inputType,text){const s=this.states.get(n),selection=this.selection(n),sig=JSON.stringify(selection),command={inputType,text,...(sig!==s.selectionSig?{selection}:{})};s.selectionSig=sig;if(s.inFlight){s.commands||=[];if(s.commands.length>=100){this.fallback('input');return;}s.commands.push(command);return;}this.sendRich(n,command);}
  nextRich(s){let next=s.commands.shift();while(next.inputType==='insertText'&&s.commands[0]?.inputType==='insertText'&&!s.commands[0].selection&&next.text.length<5000)next={...next,text:next.text+s.commands.shift().text};return next;}
  sendRich(n,command){const s=this.states.get(n);s.inFlight=true;s.selectionSig=JSON.stringify(this.selection(n));s.pending=++this.seq;this.emit({type:'mrich',id:this.ids.get(n),seq:s.pending,...command});}
  selection(n){if(!n.isContentEditable)return {start:n.selectionStart||0,end:n.selectionEnd||0,direction:n.selectionDirection||'none'};const s=n.ownerDocument.getSelection();if(!s.rangeCount||!n.contains(s.anchorNode)||!n.contains(s.focusNode))return {start:0,end:0};const offset=(node,index)=>{const r=n.ownerDocument.createRange();r.selectNodeContents(n);r.setEnd(node,index);return r.toString().length;};const a=offset(s.anchorNode,s.anchorOffset),b=offset(s.focusNode,s.focusOffset);return {start:Math.min(a,b),end:Math.max(a,b),direction:a>b?'backward':'forward',anchorId:this.ids.get(s.anchorNode)||0,anchorOffset:s.anchorOffset,focusId:this.ids.get(s.focusNode)||0,focusOffset:s.focusOffset};}
  setSelection(n,{start,end,direction}){const walker=n.ownerDocument.createTreeWalker(n,4),points=[];let t,total=0;while(t=walker.nextNode()){points.push({t,start:total,end:total+t.length});total+=t.length;}if(!points.length)return;const at=x=>{const p=points.find(p=>x<=p.end)||points.at(-1);return [p.t,Math.max(0,Math.min(p.t.length,x-p.start))]};const a=at(start),b=at(end);this.suppressSelection=true;n.ownerDocument.getSelection().setBaseAndExtent(...(direction==='backward'?b:a),...(direction==='backward'?a:b));setTimeout(()=>{this.suppressSelection=false;},50);}
  input(n){const id=this.ids.get(n),s=this.states.get(n),value=textValue(n);if(!id||!s||s.composing||!this.active||this.loading||s.before===value)return;const edit=editSpan(s.before,value);s.before=value;s.pending=++this.seq;this.emit({type:'minput',id,seq:s.pending,...edit,...(!s.secret?{value}:{})});}
  observeIslands(){this.observer?.disconnect();this.visible=new Set();this.observer=new IntersectionObserver(entries=>{for(const e of entries){const id=this.ids.get(e.target);if(e.isIntersecting)this.visible.add(id);else this.visible.delete(id);}this.emit({type:'mvisible',ids:[...this.visible]});},{root:this.doc});for(const n of this.nodes.values())if(n.dataset?.island!==undefined)this.observer.observe(n);}
  async islands(m){const crop=m.crop||{x:0,y:0,w:m.viewport.w,h:m.viewport.h},bmp=await createImageBitmap(new Blob([Uint8Array.from(atob(m.data||m.jpeg),c=>c.charCodeAt(0))],{type:m.mime||'image/jpeg'}));try{for(const r of m.rects){const n=this.nodes.get(r.id),canvas=n?.localName==='canvas'?n:n?.querySelector('canvas');if(!canvas)continue;const kx=bmp.width/crop.w,ky=bmp.height/crop.h,w=Math.max(1,Math.round(r.full.w*kx)),h=Math.max(1,Math.round(r.full.h*ky));if(canvas===n){canvas.style.width=r.full.w+'px';canvas.style.height=r.full.h+'px';}if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}const ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);ctx.drawImage(bmp,(r.x-crop.x)*kx,(r.y-crop.y)*ky,r.w*kx,r.h*ky,(r.x-r.full.x)*kx,(r.y-r.full.y)*ky,r.w*kx,r.h*ky);}}finally{bmp.close();}}
  destroy(){this.active=false;this.observer?.disconnect();this.stageResize.disconnect();this.frame.remove();this.nodes.clear();this.stage.classList.remove('native');}
}

