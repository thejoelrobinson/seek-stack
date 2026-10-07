// Shared, deliberately inert subset of HTML/SVG. No HTML strings are rendered.
const HTML=new Set('html head body div span p a button input textarea select option optgroup label form fieldset legend h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td main nav header footer section article aside details summary dialog hr br pre code blockquote strong em b i u s small sub sup abbr time address figure figcaption picture img source audio iframe canvas video object embed slot'.split(' '));
const SVG=new Set('svg g path rect circle ellipse line polyline polygon text tspan defs symbol use clipPath mask pattern linearGradient radialGradient stop title desc image filter feGaussianBlur feOffset feBlend feColorMatrix feComposite feFlood feMerge feMergeNode feTurbulence feDisplacementMap'.split(' '));
const ATTRS=new Set('id class style title role name type placeholder autocomplete inputmode maxlength minlength min max step pattern required readonly disabled multiple checked selected hidden open popover value width height alt loading decoding src srcset sizes poster href xlink:href target rel for form rows cols wrap dir lang tabindex accept capture colspan rowspan scope datetime start reversed download slot part exportparts xmlns xmlns:xlink viewBox preserveAspectRatio d fill fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity transform x y x1 y1 x2 y2 cx cy r rx ry points offset stop-color stop-opacity clip-path clipPathUnits maskUnits maskContentUnits patternUnits patternContentUnits patternTransform gradientUnits gradientTransform filter filterUnits in in2 result stdDeviation dx dy mode operator values type baseFrequency numOctaves seed scale xChannelSelector yChannelSelector'.split(' '));
const URL_ATTRS=new Set(['src','poster','href','xlink:href']);
for(const name of ['contenteditable','spellcheck'])ATTRS.add(name);
export const FRAME_CSP="sandbox allow-same-origin allow-scripts; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'self'";
export const FRAME_HTML=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native browser view</title><body></body>`;
export function allowedTag(tag){return HTML.has(tag)||SVG.has(tag)||/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(tag)||tag==='#text'||tag==='#document';}
export function isSVGTag(tag){return SVG.has(tag);}
export function isSecretField(attrs){
  const a=Object.fromEntries(attrs||[]),ac=String(a.autocomplete||'').toLowerCase();
  const text=['autocomplete','name','id','aria-label','placeholder','data-elements-stable-field-name'].map(k=>a[k]||'').join(' ').toLowerCase();
  return a.type?.toLowerCase()==='password'||/(?:^|\s)(?:current-password|new-password|one-time-code|cc-\S+)(?:\s|$)/.test(ac)||/password|passcode|\bpwd\b|\botp\b|card.?num|cc.?num|cardnumber|credit.?card|debit.?card|\bpan\b|\bcvv|\bcvc|\bcsc\b|security.?code|card.?code|verification.?code/.test(text);
}
export function safeURL(value,base,rewrite){
  const v=String(value||'').trim();if(!v)return '';
  if(v.startsWith('#'))return v;
  if(/^data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|font\/[a-z0-9.+-]+|application\/(?:font-woff|vnd.ms-fontobject));base64,[a-z0-9+/=\s]+$/i.test(v))return v;
  try{const u=new URL(v,base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return '';return rewrite?rewrite(u.href):u.pathname==='/work/mirror-res'?u.pathname+u.search:'';}catch{return '';}
}
function imageSets(text,base,rewrite){let count=0;const expected=(text.match(/(?:-webkit-)?image-set\s*\(/gi)||[]).length;const result=text.replace(/((?:-webkit-)?image-set)\(((?:[^()"']|"[^"\\]*"|'[^'\\]*'|url\([^()]*\)|type\([^()]*\))*)\)/gi,(_m,name,body)=>{count++;
  const candidates=body.split(/,\s*(?![^,]*;base64)/).map(value=>{const m=value.trim().match(/^(?:url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^()"'\\]*))\s*\)|"([^"\\]*)"|'([^'\\]*)')(?:\s+(\d+(?:\.\d+)?(?:x|dppx|dpi|dpcm)))?(?:\s+type\(["'](image\/[\w.+-]+)["']\))?$/i);if(!m)return '';const raw=m[1]??m[2]??m[3]??m[4]??m[5],url=safeURL(raw,base,rewrite)?raw:'';return url?'url("'+url.replace(/"/g,'%22')+'") '+(m[6]||'1x')+(m[7]?' type("'+m[7]+'")':''):'';});return candidates.length&&candidates.every(Boolean)?name+'('+candidates.join(',')+')':'';
});return count===expected?result:'';}
// CSS escapes are allowed in selectors/content, never in fetch syntax. Every
// surviving url() or image-set candidate is signed, a fragment, or safe data.
export function sanitizeCSS(text,base,rewrite){
  let css=String(text||'').replace(/\/\*[\s\S]*?\*\//g,'');
  const segment=s=>{
    const outside=s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,'');
    if(/^\s*@import\b/i.test(s)||/^\s*@[^\s]*\\/.test(s)||/\\/.test(outside)||/(?:\bimage|\bsrc|expression)\s*\(|(?:behavior|-moz-binding)\s*:/i.test(outside))return '';
    if(/image-set\s*\(/i.test(s)){s=imageSets(s,base,rewrite);if(/image-set\s*\(/i.test(s)&&!/image-set\(url\(/i.test(s))return '';}
    return s.replace(/url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^()"'\\]*))\s*\)/gi,(_m,a,b,c)=>{const url=safeURL(a??b??c,base,rewrite);return url?'url("'+url.replace(/"/g,'%22')+'")':'url("")';}).replace(/url\([^)]*\\[^)]*\)/gi,'url("")');
  };
  // Parse statement boundaries so escaped class selectors and icon content survive, while
  // escapes that could disguise fetch functions in declarations are refused.
  let result='',start=0,quote='',depth=0;
  for(let i=0;i<css.length;i++){const c=css[i];if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='('){depth++;continue;}if(c===')'){depth=Math.max(0,depth-1);continue;}if(depth)continue;
    if(c==='{'){result+=css.slice(start,i)+'{';start=i+1;}
    else if(c===';'||c==='}'){const safe=segment(css.slice(start,i));result+=safe+(c==='}'?'}':safe?';':'');start=i+1;}
  }return result+segment(css.slice(start));
}
export function sanitizeAttrs(tag,attrs,base,rewrite,secret=false){
  const out=[];for(const [name,raw] of attrs||[]){const lower=name.toLowerCase();
    if(lower.startsWith('on')||!ATTRS.has(name)&&!/^aria-[a-z-]+$|^data-[a-z0-9_-]+$|^js(?:name|controller|action|model|renderer)$/.test(name))continue;
    if(['target','download','form','capture'].includes(lower)||secret&&lower==='value'||rewrite&&lower==='data-seek-href')continue;
    let value=String(raw);
    if(lower==='type'&&tag==='input'&&['image','file'].includes(value.toLowerCase()))value='button';
    if(tag==='iframe'&&['src','srcset'].includes(lower))continue;
    if(lower==='href'&&tag==='a'){if(rewrite&&!value.startsWith('#'))try{const u=new URL(value,base);if(/^https?:$/.test(u.protocol))out.push(['data-seek-href',u.href.slice(0,2048)]);}catch{}value=value.startsWith('#')?value:'#';}
    else if(URL_ATTRS.has(lower)){value=safeURL(value,base,rewrite);if(!value)continue;}
    else if(lower==='srcset'){
      value=value.split(/,\s*(?![^,]*;base64)/).map(s=>{const m=s.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?[wx]))?$/);if(!m)return '';const u=safeURL(m[1],base,rewrite);return u?u+(m[2]?' '+m[2]:''):'';}).filter(Boolean).join(', ');if(!value)continue;
    }else if(lower==='style')value=sanitizeCSS(value,base,rewrite);
    out.push([name,value]);
  }return out;
}
export function editSpan(before,after){let at=0;while(at<before.length&&at<after.length&&before[at]===after[at])at++;let tail=0;while(tail<before.length-at&&tail<after.length-at&&before[before.length-1-tail]===after[after.length-1-tail])tail++;return {at,del:before.length-at-tail,ins:after.slice(at,after.length-tail)};}
export function stateCSS(css){let out='',start=0;const quoted=/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;const replace=s=>s.replace(/:(focus-within|focus-visible|hover|focus|active|invalid)\b/g,(_v,key)=>':is(:'+key+',[data-seek-state-'+key+'])');for(const match of css.matchAll(quoted)){out+=replace(css.slice(start,match.index))+match[0];start=match.index+match[0].length;}return out+replace(css.slice(start));}
export function pictureCSS(css){let out='',start=0,quote='';for(let i=0;i<css.length;i++){const c=css[i];if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='{'){let selector=css.slice(start,i);if(!/^\s*@/.test(selector))selector=selector.replace(/(^|[\s>+~,(])(iframe|video|object|embed|img)(?=[\s>+~.#:[\]),]|$)/g,(_m,p,t)=>p+':is('+t+',:where([data-seek-tag="'+t+'"]))');out+=selector+'{';start=i+1;}else if(c==='}'||c===';'){out+=css.slice(start,i+1);start=i+1;}}return out+css.slice(start);}
export function wireIndex(tree){const map=new Map();function visit(n,parent=0){map.set(n.i,{n,parent});for(const c of n.c||[])visit(c,n.i);for(const c of n.s||[])visit(c,n.i);if(n.d)visit(n.d,n.i);}if(tree)visit(tree);return map;}
export function treeDiff(before,after){
  const a=wireIndex(before),b=wireIndex(after),ops=[],removed=new Set(),added=new Set();
  for(const [id,r]of a)if(!b.has(id)||r.parent!==b.get(id).parent){if(!removed.has(r.parent)){ops.push({op:'remove',id});removed.add(id);}}
  for(const [id,r]of b){const old=a.get(id);if(!old||old.parent!==r.parent){if(!added.has(r.parent)){const siblings=b.get(r.parent)?.n.c||[],index=siblings.findIndex(n=>n.i===id);ops.push({op:'insert',parent:r.parent,before:siblings[index+1]?.i||0,node:r.n});}added.add(id);continue;}if(added.has(r.parent))continue;
    const n=r.n,o=old.n;if(n.t!==o.t||n.island!==o.island||n.relay!==o.relay||JSON.stringify(n.s?.map(x=>x.i))!==JSON.stringify(o.s?.map(x=>x.i))||n.d?.i!==o.d?.i){ops.push({op:'replace',id,node:n});for(const sub of wireIndex(n).keys())added.add(sub);continue;}
    if(n.t==='#text'&&n.v!==o.v)ops.push({op:'text',id,value:n.v});
    const oa=new Map(o.a||[]),na=new Map(n.a||[]);for(const [name,value]of na)if(oa.get(name)!==value)ops.push({op:'attr',id,name,value});for(const name of oa.keys())if(!na.has(name))ops.push({op:'attr',id,name,value:null});
    for(const key of ['v','checked','selected','len','secret','size'])if(n.t!=='#text'&&JSON.stringify(n[key])!==JSON.stringify(o[key]))ops.push({op:'value',id,[key]:n[key]??null});
    if(JSON.stringify((n.c||[]).map(x=>x.i))!==JSON.stringify((o.c||[]).map(x=>x.i)))ops.push({op:'order',id,ids:(n.c||[]).map(x=>x.i)});
  }return ops;
}
// Keep a sanitized client model for backpressure resets without replacing a focused document.
export function updateWireTree(tree,ops){
  for(const op of ops){const map=wireIndex(tree),r=map.get(op.id),n=r?.n,p=map.get(r?.parent)?.n;
    const detach=()=>{if(!p)return;for(const key of ['c','s'])if(p[key])p[key]=p[key].filter(c=>c.i!==op.id);if(p.d?.i===op.id)delete p.d;};
    if(op.op==='remove')detach();
    else if(op.op==='replace'){if(p){for(const key of ['c','s'])if(p[key])p[key]=p[key].map(c=>c.i===op.id?op.node:c);if(p.d?.i===op.id)p.d=op.node;}else tree=op.node;}
    else if(op.op==='insert'){const parent=map.get(op.parent)?.n;if(parent){const c=parent.c||=[];const index=c.findIndex(n=>n.i===op.before);c.splice(index<0?c.length:index,0,op.node);}}
    else if(op.op==='text'&&n)n.v=op.value;
    else if(op.op==='attr'&&n){n.a=(n.a||[]).filter(a=>a[0]!==op.name);if(op.value!==null)n.a.push([op.name,op.value]);}
    else if(op.op==='value'&&n){for(const key of ['v','checked','selected','len','secret','size'])if(key in op)n[key]=op[key];}
    else if(op.op==='order'&&n){const children=new Map((n.c||[]).map(c=>[c.i,c]));n.c=op.ids.map(id=>children.get(id)).filter(Boolean);}
  }return tree;
}

