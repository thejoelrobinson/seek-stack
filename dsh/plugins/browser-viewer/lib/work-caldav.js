// CalDAV (RFC 4791 + RFC 6578 sync) for the shared calendar, so Apple Calendar shows the
// "Seek" calendar and Reminders shows "Seek To-dos", with edits flowing both ways.
// Authentication happens in front of this (the proxy's device passwords); this module speaks
// the protocol: discovery, collection properties, multiget/query/sync reports, GET/PUT/DELETE.
import {CalendarError,COLLECTIONS} from './work-calendar.js';
import {parseICS,readItem,occurrences,parseWall,zonedToUtc} from './work-ical.js';

export const DAV_BASE='/work/dav';
const NS={D:'DAV:',C:'urn:ietf:params:xml:ns:caldav',CS:'http://calendarserver.org/ns/',A:'http://apple.com/ns/ical/'};
const PREFIX=Object.fromEntries(Object.entries(NS).map(([k,v])=>[v,k]));
const SYNC_PREFIX='http://seek.local/ns/sync/';

// ── Minimal namespace-aware XML ──────────────────────────────────────────────
const ENTITIES={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};
const decode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi,(m,e)=>e[0]==='#'?String.fromCodePoint(e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):+e.slice(1)):ENTITIES[e]??m);
export const xmlEscape=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
/** Parses a request body into {ns, name, attrs, children, text}. Rejects DOCTYPEs (no entity expansion). */
export function parseXML(text){
  const src=String(text||'').replace(/^﻿/,'');if(/<!DOCTYPE/i.test(src))throw new CalendarError(400,'DOCTYPE is not allowed.');
  const root={children:[],scope:{xml:'http://www.w3.org/XML/1998/namespace'}},stack=[root];let i=0;
  const tag=/<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  while(i<src.length){
    const lt=src.indexOf('<',i);
    if(lt<0)break;
    if(lt>i&&stack.length>1)stack.at(-1).text+=decode(src.slice(i,lt));
    if(src.startsWith('<?',lt)){i=src.indexOf('?>',lt)+2;if(i<2)break;continue;}
    if(src.startsWith('<!--',lt)){i=src.indexOf('-->',lt)+3;if(i<3)break;continue;}
    if(src.startsWith('<![CDATA[',lt)){const end=src.indexOf(']]>',lt);if(stack.length>1)stack.at(-1).text+=src.slice(lt+9,end);i=end+3;continue;}
    tag.lastIndex=lt;const m=tag.exec(src);if(!m)throw new CalendarError(400,'Malformed XML.');
    i=tag.lastIndex;
    if(m[1]){const el=stack.pop();if(!el||el.qname!==m[2])throw new CalendarError(400,'Mismatched XML tags.');continue;}
    const attrs={},scope={...stack.at(-1).scope};
    for(const a of m[3].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)){const v=decode(a[2]??a[3]);if(a[1]==='xmlns')scope['']=v;else if(a[1].startsWith('xmlns:'))scope[a[1].slice(6)]=v;else attrs[a[1]]=v;}
    const [p,local]=m[2].includes(':')?m[2].split(':'):['',m[2]];
    const el={qname:m[2],ns:scope[p]??'',name:local,attrs,children:[],text:'',scope};
    stack.at(-1).children.push(el);if(!m[4])stack.push(el);
  }
  if(stack.length!==1)throw new CalendarError(400,'Unclosed XML element.');
  return root.children[0]||null;
}
const child=(el,ns,name)=>el?.children.find(c=>c.ns===ns&&c.name===name)||null;
const children=(el,ns,name)=>el?.children.filter(c=>c.ns===ns&&c.name===name)||[];
const key=(ns,name)=>`{${ns}}${name}`;

// ── Resources ────────────────────────────────────────────────────────────────
function enc(name){return encodeURIComponent(name).replace(/%40/g,'@');}
export function resolve(pathname){
  if(!pathname.startsWith(DAV_BASE))return null;
  const parts=pathname.slice(DAV_BASE.length).split('/').filter(Boolean).map(p=>{try{return decodeURIComponent(p);}catch{return p;}});
  if(!parts.length)return {type:'root',href:DAV_BASE+'/'};
  if(parts[0]==='principal'&&parts.length===1)return {type:'principal',href:DAV_BASE+'/principal/'};
  if(parts[0]!=='cal')return null;
  if(parts.length===1)return {type:'home',href:DAV_BASE+'/cal/'};
  const col=COLLECTIONS.find(c=>c.id===parts[1]);
  if(parts.length===2)return col?{type:'collection',collection:col,href:`${DAV_BASE}/cal/${col.id}/`}:null;
  if(parts.length===3&&col)return {type:'object',collection:col,name:parts[2],href:`${DAV_BASE}/cal/${col.id}/${enc(parts[2])}`};
  return null;
}
function hrefPath(href){let path=String(href||'').trim();try{path=new URL(path,'http://local').pathname;}catch{}return path;}

const httpDate=ms=>new Date(ms).toUTCString();
const PRIVILEGES='<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege><D:privilege><D:write-properties/></D:privilege><D:privilege><D:write-content/></D:privilege><D:privilege><D:bind/></D:privilege><D:privilege><D:unbind/></D:privilege><D:privilege><D:read-current-user-privilege-set/></D:privilege>';
const principalHref=`<D:href>${DAV_BASE}/principal/</D:href>`;
const REPORTS={collection:['C:calendar-multiget','C:calendar-query','D:sync-collection'],other:['D:expand-property','D:principal-property-search','D:principal-search-property-set']};
const reportSet=list=>list.map(r=>`<D:supported-report><D:report><${r}/></D:report></D:supported-report>`).join('');

export class CalDAV{
  constructor(store,{owner='Seek',email=null,log=console}={}){this.store=store;this.owner=owner;this.email=email;this.log=log;}
  collectionMeta(col){return {...col,...(this.store.meta('collection:'+col.id,{}))};}
  /** Value (inner XML) of one property for a resource, or undefined when it has none. */
  property(res,ns,name,{withData=false,row=null}={}){
    const k=key(ns,name),T=res.type;
    const common={
      [key(NS.D,'current-user-principal')]:principalHref,
      [key(NS.D,'principal-URL')]:principalHref,
      [key(NS.D,'principal-collection-set')]:`<D:href>${DAV_BASE}/</D:href>`,
      [key(NS.C,'calendar-home-set')]:`<D:href>${DAV_BASE}/cal/</D:href>`,
      [key(NS.D,'owner')]:principalHref,
      [key(NS.D,'current-user-privilege-set')]:PRIVILEGES
    };
    if(T==='object'){
      row??=this.store.object(res.collection.id,res.name);if(!row)return undefined;
      return {
        [key(NS.D,'getetag')]:xmlEscape(row.etag),
        [key(NS.D,'getcontenttype')]:`text/calendar; charset=utf-8; component=${row.kind==='todo'?'VTODO':'VEVENT'}`,
        [key(NS.D,'getcontentlength')]:String(Buffer.byteLength(row.ics)),
        [key(NS.D,'getlastmodified')]:httpDate(row.modified),
        [key(NS.D,'resourcetype')]:'',
        [key(NS.D,'displayname')]:undefined,
        [key(NS.C,'calendar-data')]:withData||name==='calendar-data'?xmlEscape(row.ics):undefined,
        [key(NS.D,'current-user-privilege-set')]:PRIVILEGES,
        [key(NS.D,'owner')]:principalHref
      }[k];
    }
    if(T==='collection'){
      const col=this.collectionMeta(res.collection),ctag=this.store.ctag(col.id);
      return {
        ...common,
        [key(NS.D,'resourcetype')]:'<D:collection/><C:calendar/>',
        [key(NS.D,'displayname')]:xmlEscape(col.name),
        [key(NS.C,'calendar-description')]:xmlEscape(col.description),
        [key(NS.A,'calendar-color')]:xmlEscape(col.color),
        [key(NS.A,'calendar-order')]:String(col.order??(col.id==='seek'?1:2)),
        [key(NS.C,'supported-calendar-component-set')]:`<C:comp name="${col.kind==='todo'?'VTODO':'VEVENT'}"/>`,
        [key(NS.C,'supported-calendar-data')]:'<C:calendar-data content-type="text/calendar" version="2.0"/>',
        [key(NS.C,'max-resource-size')]:String(512*1024),
        [key(NS.C,'schedule-calendar-transp')]:col.kind==='todo'?'<C:transparent/>':'<C:opaque/>',
        [key(NS.CS,'getctag')]:`"ctag-${ctag}"`,
        [key(NS.D,'sync-token')]:SYNC_PREFIX+this.store.token,
        [key(NS.D,'supported-report-set')]:reportSet(REPORTS.collection),
        [key(NS.D,'getcontenttype')]:undefined,
        [key(NS.C,'calendar-timezone')]:undefined
      }[k];
    }
    const base={...common,[key(NS.D,'supported-report-set')]:reportSet(REPORTS.other)};
    if(T==='principal')return {...base,[key(NS.D,'resourcetype')]:'<D:collection/><D:principal/>',[key(NS.D,'displayname')]:xmlEscape(this.owner),
      [key(NS.C,'calendar-user-address-set')]:this.email?`<D:href>mailto:${xmlEscape(this.email)}</D:href><D:href>${DAV_BASE}/principal/</D:href>`:`<D:href>${DAV_BASE}/principal/</D:href>`,
      [key(NS.CS,'email-address-set')]:this.email?`<CS:email-address>${xmlEscape(this.email)}</CS:email-address>`:undefined}[k];
    if(T==='home')return {...base,[key(NS.D,'resourcetype')]:'<D:collection/>',[key(NS.D,'displayname')]:'Seek',[key(NS.CS,'getctag')]:`"ctag-${this.store.token}"`,[key(NS.D,'sync-token')]:SYNC_PREFIX+this.store.token}[k];
    return {...base,[key(NS.D,'resourcetype')]:'<D:collection/>',[key(NS.D,'displayname')]:'Seek'}[k];
  }
  /** One <D:response>: found properties under 200, missing ones under 404. */
  response(res,requested,opts={}){
    const found=[],missing=[];
    for(const {ns,name} of requested){
      const v=this.property(res,ns,name,opts);
      const pfx=PREFIX[ns];const tagName=pfx?`${pfx}:${name}`:`X:${name}`,xmlns=pfx?'':` xmlns:X="${xmlEscape(ns)}"`;
      if(v===undefined)missing.push(`<${tagName}${xmlns}/>`);else found.push(v===''?`<${tagName}${xmlns}/>`:`<${tagName}${xmlns}>${v}</${tagName}>`);
    }
    return `<D:response><D:href>${res.href}</D:href>${found.length?`<D:propstat><D:prop>${found.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`:''}${missing.length?`<D:propstat><D:prop>${missing.join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`:''}</D:response>`;
  }
  allprops(res){
    const names={object:['getetag','getcontenttype','getcontentlength','getlastmodified','resourcetype'],collection:['resourcetype','displayname','getctag','sync-token','supported-calendar-component-set','calendar-color'],principal:['resourcetype','displayname','calendar-home-set','current-user-principal'],home:['resourcetype','displayname'],root:['resourcetype','current-user-principal']}[res.type];
    const nsOf={getctag:NS.CS,'calendar-color':NS.A,'supported-calendar-component-set':NS.C,'calendar-home-set':NS.C};
    return names.map(name=>({ns:nsOf[name]||NS.D,name}));
  }
  members(res){
    if(res.type==='root')return [resolve(DAV_BASE+'/principal/'),resolve(DAV_BASE+'/cal/')];
    if(res.type==='home')return COLLECTIONS.map(c=>resolve(`${DAV_BASE}/cal/${c.id}/`));
    if(res.type==='collection')return this.store.objects(res.collection.id).map(row=>({...resolve(`${DAV_BASE}/cal/${row.collection}/${enc(row.name)}`),row}));
    return [];
  }
  multistatus(inner,extra=''){return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="${NS.C}" xmlns:CS="${NS.CS}" xmlns:A="${NS.A}">${inner}${extra}</D:multistatus>`;}
  requested(prop){return (prop?.children||[]).map(c=>({ns:c.ns,name:c.name}));}

  /** Handles one request. Returns {status, headers, body}. */
  async handle(method,pathname,headers,body){
    const res=resolve(pathname);
    const reply=(status,bodyText='',extra={})=>({status,headers:{'DAV':'1, 3, calendar-access','Cache-Control':'no-store',...(bodyText?{'Content-Type':'application/xml; charset=utf-8'}:{}),...extra},body:bodyText});
    const error=(status,condition,ns=NS.C)=>reply(status,`<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:" xmlns:C="${NS.C}"><${PREFIX[ns]}:${condition}/></D:error>`);
    if(method==='OPTIONS')return reply(200,'',{Allow:'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT','Content-Length':'0'});
    // The two calendars are fixed: making another one is refused, not "not found".
    if(['MKCALENDAR','MKCOL'].includes(method)&&pathname.startsWith(DAV_BASE))return reply(403);
    if(!res)return reply(404);
    try{
      if(method==='PROPFIND'){
        const doc=body?.trim()?parseXML(body):null;
        if(doc&&!(doc.ns===NS.D&&doc.name==='propfind'))return reply(400);
        const depth=String(headers.depth??'1')==='0'?0:1;
        if(res.type==='object'&&!this.store.object(res.collection.id,res.name))return reply(404);
        const targets=[res,...(depth?this.members(res):[])];
        const prop=child(doc,NS.D,'prop'),names=prop?this.requested(prop):null;
        if(child(doc,NS.D,'propname'))return reply(207,this.multistatus(targets.map(t=>`<D:response><D:href>${t.href}</D:href><D:propstat><D:prop>${this.allprops(t).map(p=>`<${PREFIX[p.ns]}:${p.name}/>`).join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('')));
        return reply(207,this.multistatus(targets.map(t=>this.response(t,names||this.allprops(t),{row:t.row})).join('')));
      }
      if(method==='PROPPATCH'){
        const doc=parseXML(body);const results=[];
        for(const action of doc?.children||[])for(const p of child(action,NS.D,'prop')?.children||[]){
          const ok=res.type==='collection'&&((p.ns===NS.A&&['calendar-color','calendar-order'].includes(p.name))||(p.ns===NS.D&&p.name==='displayname')||(p.ns===NS.C&&p.name==='calendar-description'));
          if(ok&&action.name==='set'){const meta=this.store.meta('collection:'+res.collection.id,{});const field={'calendar-color':'color','calendar-order':'order',displayname:'name','calendar-description':'description'}[p.name];meta[field]=field==='order'?Number(p.text)||0:p.text.trim().slice(0,120);this.store.setMeta('collection:'+res.collection.id,meta);}
          const pfx=PREFIX[p.ns],tagName=pfx?`${pfx}:${p.name}`:`X:${p.name}`,xmlns=pfx?'':` xmlns:X="${xmlEscape(p.ns)}"`;
          results.push(`<D:propstat><D:prop><${tagName}${xmlns}/></D:prop><D:status>HTTP/1.1 ${ok?'200 OK':'403 Forbidden'}</D:status></D:propstat>`);
        }
        return reply(207,this.multistatus(`<D:response><D:href>${res.href}</D:href>${results.join('')}</D:response>`));
      }
      if(method==='REPORT')return this.report(res,parseXML(body),headers,reply,error);
      if(method==='GET'||method==='HEAD'){
        if(res.type==='collection'){
          // The whole calendar as one .ics, so it can also be subscribed to or downloaded.
          const rows=this.store.objects(res.collection.id),parts=rows.map(r=>r.ics.replace(/^[\s\S]*?BEGIN:VCALENDAR\r?\n/,'').replace(/END:VCALENDAR\s*$/,'').replace(/^(?:VERSION|PRODID|CALSCALE|METHOD):.*\r?\n/gm,''));
          const text=`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Seek//Shared Calendar//EN\r\nX-WR-CALNAME:${this.collectionMeta(res.collection).name}\r\n${parts.join('')}END:VCALENDAR\r\n`;
          return {status:200,headers:{'Content-Type':'text/calendar; charset=utf-8','Cache-Control':'no-store'},body:method==='HEAD'?'':text};
        }
        if(res.type!=='object')return reply(405);
        const row=this.store.object(res.collection.id,res.name);if(!row)return reply(404);
        return {status:200,headers:{'Content-Type':'text/calendar; charset=utf-8',ETag:row.etag,'Last-Modified':httpDate(row.modified),'Cache-Control':'no-store'},body:method==='HEAD'?'':row.ics};
      }
      if(method==='PUT'){
        if(res.type!=='object')return reply(405);
        if(!/^text\/calendar\b/i.test(String(headers['content-type']||'text/calendar')))return error(415,'supported-calendar-data');
        const out=this.store.put(res.collection.id,res.name,String(body||''),{ifMatch:headers['if-match']||null,ifNoneMatch:headers['if-none-match']||null,source:'apple'});
        return reply(out.created?201:204,'',{ETag:out.etag,'Content-Length':'0'});
      }
      if(method==='DELETE'){
        if(res.type!=='object')return reply(403);
        this.store.remove(res.collection.id,res.name,{ifMatch:headers['if-match']||null,source:'apple'});
        return reply(204,'',{'Content-Length':'0'});
      }
      if(['MKCALENDAR','MKCOL','MOVE','COPY','LOCK','UNLOCK','ACL'].includes(method))return reply(403);
      return reply(405);
    }catch(e){
      if(e instanceof CalendarError){// Failed CalDAV preconditions answer 403 (409 for a UID clash) naming the condition.
        if(e.code)return error(e.status===409?409:403,e.code);return reply(e.status);}
      this.log?.warn?.('CalDAV: '+e.message);return reply(500);
    }
  }
  report(res,doc,headers,reply,error){
    if(!doc)return reply(400);
    const props=this.requested(child(doc,NS.D,'prop'));
    const withData=props.some(p=>p.ns===NS.C&&p.name==='calendar-data');
    if(doc.ns===NS.C&&doc.name==='calendar-multiget'){
      const out=children(doc,NS.D,'href').map(h=>{const path=hrefPath(h.text),r=resolve(path);const row=r?.type==='object'?this.store.object(r.collection.id,r.name):null;
        return row?this.response({...r,row},props,{withData,row}):`<D:response><D:href>${xmlEscape(h.text.trim())}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;});
      return reply(207,this.multistatus(out.join('')));
    }
    if(doc.ns===NS.C&&doc.name==='calendar-query'){
      if(res.type!=='collection')return reply(207,this.multistatus(''));
      const filter=child(doc,NS.C,'filter'),vcal=child(filter,NS.C,'comp-filter'),comp=child(vcal,NS.C,'comp-filter');
      const want=comp?.attrs.name?.toUpperCase();
      if(want&&want!==(res.collection.kind==='todo'?'VTODO':'VEVENT'))return reply(207,this.multistatus(''));
      const range=child(comp,NS.C,'time-range'),toMs=v=>{const w=parseWall(v);return w?(w.utc?Date.UTC(w.y,w.m-1,w.d,w.h||0,w.mi,w.s):zonedToUtc({...w,h:w.h||0},this.store.zone)):null;};
      const from=range?.attrs.start?toMs(range.attrs.start):-8.64e15,to=range?.attrs.end?toMs(range.attrs.end):8.64e15;
      const out=[];
      for(const row of this.store.objects(res.collection.id)){
        if(range){let item;try{item=readItem(parseICS(row.ics),this.store.zone);}catch{continue;}
          const anchor=item.kind==='todo'?(item.due||item.start):item.start;
          if(anchor&&!occurrences(item,from,to,{limit:1}).length&&!(item.kind==='todo'&&!item.done&&anchor.ms<from))continue;}
        out.push(this.response({...resolve(`${DAV_BASE}/cal/${row.collection}/${enc(row.name)}`),row},props,{withData,row}));
      }
      return reply(207,this.multistatus(out.join('')));
    }
    if(doc.ns===NS.D&&doc.name==='sync-collection'){
      if(res.type!=='collection')return error(403,'valid-sync-token',NS.D);
      const raw=child(doc,NS.D,'sync-token')?.text.trim()||'';
      let since=null;if(raw){if(!raw.startsWith(SYNC_PREFIX))return error(403,'valid-sync-token',NS.D);since=Number(raw.slice(SYNC_PREFIX.length));}
      const changes=this.store.changesSince(res.collection.id,since);if(!changes)return error(403,'valid-sync-token',NS.D);
      const out=changes.changed.map(name=>{const row=this.store.object(res.collection.id,name);return row?this.response({...resolve(`${DAV_BASE}/cal/${res.collection.id}/${enc(name)}`),row},props,{withData,row}):'';})
        .concat(changes.deleted.map(name=>`<D:response><D:href>${DAV_BASE}/cal/${res.collection.id}/${enc(name)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`));
      return reply(207,this.multistatus(out.join(''),`<D:sync-token>${SYNC_PREFIX}${changes.token}</D:sync-token>`));
    }
    // Principal searches (macOS asks): nothing to find beyond the one principal.
    if(doc.ns===NS.D&&doc.name==='principal-search-property-set')return reply(200,`<?xml version="1.0" encoding="utf-8"?>\n<D:principal-search-property-set xmlns:D="DAV:"/>`);
    if(doc.ns===NS.D&&['principal-property-search','expand-property'].includes(doc.name))return reply(207,this.multistatus(''));
    return error(403,'supported-report',NS.D);
  }
}
