import {sanitizeCSS} from './mirror-shape.js';

function statementEnd(text,start){let quote='',depth=0;for(let i=start;i<text.length;i++){const c=text[i];if(quote){if(c==='\\')i++;else if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='(')depth++;else if(c===')')depth--;else if(c===';'&&!depth)return i+1;}return text.length;}
function functionValue(text,name){const m=text.match(new RegExp('^'+name+'\\s*\\(','i'));if(!m)return null;let depth=1,quote='',i=m[0].length;for(;i<text.length;i++){const c=text[i];if(quote){if(c==='\\')i++;else if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='(')depth++;else if(c===')'&&!--depth)break;}return depth?null:{value:text.slice(m[0].length,i),rest:text.slice(i+1).trim()};}
export function importDescriptor(statement,base){
  let s=statement.replace(/^@import\s+/i,'').replace(/;\s*$/,'').trim(),url;
  const quoted=s.match(/^(?:"([^"\\]*)"|'([^'\\]*)')/),fn=functionValue(s,'url');
  if(quoted){url=quoted[1]??quoted[2];s=s.slice(quoted[0].length).trim();}else if(fn){url=fn.value.trim().replace(/^(['"])(.*)\1$/,'$2');s=fn.rest;}else return null;
  try{url=new URL(url,base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;}catch{return null;}
  const wrappers=[],layer=functionValue(s,'layer');if(layer){if(!/^[\w.-]+$/.test(layer.value.trim()))return null;wrappers.push('@layer '+layer.value.trim());s=layer.rest;}else if(/^layer\b/i.test(s)){wrappers.push('@layer');s=s.replace(/^layer\b/i,'').trim();}
  const supports=functionValue(s,'supports');if(supports){wrappers.push('@supports ('+supports.value+')');s=supports.rest;}
  if(s){if(/[{};\\]/.test(s))return null;wrappers.push('@media '+s);}
  return {url:url.href,wrap:text=>wrappers.reduceRight((body,rule)=>rule+'{'+body+'}',text)};
}
export function expandImports(text,base,resolve,seen=new Set(),transform=text=>text){
  if(seen.size>16)return '';text=String(text||'').replace(/\/\*[\s\S]*?\*\//g,'');let out='',start=0,quote='',depth=0;
  for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='{')depth++;else if(c==='}')depth--;else if(!depth&&c==='@'&&/^@import\b/i.test(text.slice(i))){const end=statementEnd(text,i),d=importDescriptor(text.slice(i,end),base);out+=transform(text.slice(start,i),base);if(d&&!seen.has(d.url)){const child=resolve(d.url);if(child){const next=new Set(seen);next.add(d.url);out+=d.wrap(expandImports(child.text,child.base||d.url,resolve,next,transform));}}i=end-1;start=end;}}
  return out+transform(text.slice(start),base);
}
export async function readMirrorSheets(m){
  if(!m.sheetDirty&&m.wireSheets&&![...m.sheets.values()].some(h=>h.dirty||h.text===undefined))return;
  const nodes=[...m.nodes.values()],owners=new Map(nodes.map(r=>[r.node.backendNodeId,r.node])),order=new Map(nodes.map((r,i)=>[r.node.nodeId,i])),rows=[];
  for(const [id,h]of m.sheets){if(h.origin==='user-agent'||!m.contexts.has(h.frameId))continue;
    if(h.dirty||h.text===undefined){let text=(await m.call('CSS.getStyleSheetText',{styleSheetId:id}).catch(()=>({text:''}))).text;
      let owner=owners.get(h.ownerNode),adoptIndex=-1;if(!owner)for(const r of nodes){const index=r.node.adoptedStyleSheets?.indexOf(id);if(index>=0){owner=r.node;adoptIndex=index;break;}}
      if(owner){const live=await m.local(owner,'function(index){try{const s=index<0?this.sheet:this.adoptedStyleSheets[index];return s?{text:[...s.cssRules].map(r=>r.cssText).join("\\n"),base:s.href||this.baseURI||this.ownerDocument?.baseURI}:null}catch{return null}}',[adoptIndex]).catch(()=>null);if(live!=null){text=live.text;h.base=live.base;}}h.text=text;h.dirty=false;
    }
  }
  const byURL=new Map();for(const h of m.sheets.values())if(h.sourceURL)byURL.set(h.frameId+'\n'+h.sourceURL,h);
  for(const [id,h]of m.sheets){if(h.origin==='user-agent'||!m.contexts.has(h.frameId))continue;const n=owners.get(h.ownerNode);
    const text=expandImports(h.text,h.base||h.sourceURL||m.frames.get(h.frameId),url=>{const child=byURL.get(h.frameId+'\n'+url);return child?{text:child.text,base:child.base||child.sourceURL}:null;},new Set(),(css,base)=>sanitizeCSS(m.redact(css,'sheet:'+id),base,u=>m.resources.sign(u,h.frameId)));
    if(h.isConstructed){for(const r of nodes){const index=r.node.adoptedStyleSheets?.indexOf(id);if(index>=0)rows.push({id:id+':'+r.node.nodeId,owner:r.node.nodeId,text,order:1e9+index});}continue;}
    // Imported sheets are expanded at the import's original position and conditions.
    if(!n)continue;let p=m.nodes.get(n.nodeId),owner=0;while(p){if([9,11].includes(p.node.nodeType)){owner=p.node.nodeId;break;}p=m.nodes.get(p.parent);}
    const info=await m.local(n,'function(){const s=this.sheet;return {disabled:!!s?.disabled,media:s?.media?.mediaText||this.media||""}}').catch(()=>({}));
    const parent=m.nodes.get(n.nodeId)?.parent,siblings=m.nodes.get(parent)?.node.children||[],index=siblings.findIndex(x=>x.nodeId===n.nodeId),before=siblings.slice(index+1).find(x=>!['style','link','meta','script','base'].includes(x.localName))?.nodeId||0;
    const media=sanitizeCSS('@media '+(info?.media||'')+'{}',h.sourceURL||m.frames.get(h.frameId));
    rows.push({id,owner,parent,before,text:info?.media&&media.startsWith('@media')?'@media '+info.media+'{'+text+'}':text,disabled:!!info?.disabled,order:order.get(n.nodeId)||0});
  }
  rows.sort((a,b)=>a.owner-b.owner||a.order-b.order);m.ownSheets=rows;m.sheetDirty=false;
  if(Buffer.byteLength(JSON.stringify(rows))>8*1024*1024)m.off('too-big');
}
