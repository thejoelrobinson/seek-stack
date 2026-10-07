import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
const permittedType=type=>/^image\/|^font\/|^application\/(?:font-woff2?|vnd.ms-fontobject|x-font-ttf|x-font-opentype)$/i.test(type||'');
export function publicAddress(ip){
  const v=String(ip).toLowerCase();if(isIP(v)===6){const p=v.split(':').map(x=>parseInt(x||'0',16));return p[0]>=0x2000&&p[0]<0x4000&&p[0]!==0x2002&&!(p[0]===0x2001&&[0,0xdb8].includes(p[1]))&&!(p[0]===0x3fff&&p[1]<0x1000);}
  const p=v.split('.').map(Number);return isIP(v)===4&&![0,10,127].includes(p[0])&&!(p[0]===169&&p[1]===254)&&!(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===192&&[0,2,168].includes(p[1]))&&!(p[0]===198&&[18,19].includes(p[1]))&&!(p[0]===198&&p[1]===51&&p[2]===100)&&!(p[0]===203&&p[1]===0&&p[2]===113)&&!(p[0]===100&&p[1]>=64&&p[1]<=127)&&p[0]<224;
}
export class MirrorResources{
  constructor(mirror){this.mirror=mirror;this.key=randomBytes(32);this.cache=new Map();this.bytes=0;this.pending=new Map();this.requests=new Set();}
  sign(url,frame){const parsed=new URL(url),fragment=parsed.hash;parsed.hash='';url=parsed.href;const data=frame+'\n'+url,sig=createHmac('sha256',this.key).update(data).digest('hex');return '/work/mirror-res?f='+encodeURIComponent(frame)+'&u='+encodeURIComponent(url)+'&s='+sig+fragment;}
  valid(url,frame,sig){if(!/^[a-f0-9]{64}$/.test(sig||''))return false;const expected=createHmac('sha256',this.key).update(frame+'\n'+url).digest();return timingSafeEqual(expected,Buffer.from(sig,'hex'));}
  async get(url,frame,sig){
    const m=this.mirror;if(!m.live||!m.controller.paused||!m.frames.has(frame)||!this.valid(url,frame,sig))throw new Error('Unavailable');
    const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Unavailable');
    const key=frame+'\n'+url;if(this.cache.has(key)){const r=this.cache.get(key);this.cache.delete(key);this.cache.set(key,r);return r;}
    if(this.pending.has(key))return this.pending.get(key);
    const job=this.load(u,frame).finally(()=>this.pending.delete(key));this.pending.set(key,job);return job;
  }
  async load(u,frame){
    const m=this.mirror,cdp=m.cdp,s=m.frameSessions?.get(frame)||m.session;let data,type=m.resourceTypes.get(u.href);
    const font=cdp.fontBodies?.get(s+'\n'+frame+'\n'+u.href);if(font){data=font.data;type=font.type;}
    if(!type){await m.readResources(frame);type=m.resourceTypes.get(u.href)||cdp.resourceResponses?.get(s+'\n'+frame+'\n'+u.href)?.mimeType;}
    if(!data)try{const r=await cdp.send('Page.getResourceContent',{frameId:frame,url:u.href},s);data=Buffer.from(r.content,r.base64Encoded?'base64':'utf8');}catch{
      const response=cdp.resourceResponses?.get(s+'\n'+frame+'\n'+u.href);if(response&&permittedType(response.mimeType)){try{const r=await cdp.send('Network.getResponseBody',{requestId:response.requestId},s);data=Buffer.from(r.body,r.base64Encoded?'base64':'utf8');type=response.mimeType;}catch{}}
      if(!data){const frameURL=m.frames.get(frame),origin=m.frameOrigins?.get(frame),base=m.frameBases?.get(frame),page=new URL(/^https?:/.test(frameURL)?frameURL:/^https?:/.test(origin)?origin:base||frameURL);
      const response=await this.fetch(u,page,0,origin===undefined||origin===page.origin);data=response.data;type=response.type;}
    }
    if(!m.live||!m.controller.paused||!permittedType(type)||data.length>10*1024*1024)throw new Error('Unavailable');
    const row={data,type};this.cache.set(frame+'\n'+u.href,row);this.bytes+=data.length;
    while(this.bytes>50*1024*1024){const [key,val]=this.cache.entries().next().value;this.bytes-=val.data.length;this.cache.delete(key);}return row;
  }
  async fetch(u,page,redirects=0,allowCookies=true){
    const m=this.mirror;if(!m.live||!m.controller.paused||redirects>3||!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Unavailable');
    const host=u.hostname.replace(/^\[|\]$/g,''),addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
    if(!addresses.length||u.hostname!==page.hostname&&addresses.some(x=>!publicAddress(x.address)))throw new Error('Unavailable');
    if(!m.live||!m.controller.paused)throw new Error('Unavailable');
    // Pin the validated address for the connection and validate each redirect separately.
    // Cookies come from Chrome for this exact URL; upstream Set-Cookie never leaves the host.
    const {cookies}=await m.cdp.send('Network.getCookies',{urls:[u.href]},m.session);const headers={'User-Agent':m.cdp.userAgent||'Chrome','Accept':'image/*,font/*,*/*;q=0.1','Accept-Encoding':'identity'};
    const main=new URL(m.frames.get(m.mainFrame));
    if(allowCookies&&page.origin===main.origin&&u.origin===main.origin&&cookies.length)headers.Cookie=cookies.filter(c=>!c.partitionKey).map(c=>c.name+'='+c.value).join('; ');
    headers.Referer=page.origin+'/';
    if(!m.live||!m.controller.paused)throw new Error('Unavailable');
    const response=await new Promise((resolve,reject)=>{
      const req=(u.protocol==='https:'?httpsRequest:httpRequest)(u,{headers,lookup:(_h,opts,cb)=>{const a=addresses[0];cb(null,opts?.all?[a]:a.address,a.family);}},res=>{
        const status=res.statusCode||0;if(status>=300&&status<400&&res.headers.location){res.resume();resolve({redirect:new URL(res.headers.location,u)});return;}
        const type=String(res.headers['content-type']||'').split(';')[0];if(status!==200||!permittedType(type)){res.resume();reject(new Error('Unavailable'));return;}
        let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>10*1024*1024){req.destroy(new Error('Unavailable'));return;}chunks.push(b);});res.on('error',()=>reject(new Error('Unavailable')));res.on('end',()=>resolve({type,data:Buffer.concat(chunks)}));
      });this.requests.add(req);req.once('close',()=>this.requests.delete(req));req.setTimeout(10000,()=>req.destroy(new Error('Unavailable')));req.on('error',()=>reject(new Error('Unavailable')));req.end();
    });if(response.redirect)return this.fetch(response.redirect,page,redirects+1,allowCookies);return response;
  }
  clear(){for(const req of this.requests)req.destroy(new Error('Unavailable'));this.requests.clear();this.key.fill(0);this.cache.clear();this.bytes=0;this.pending.clear();}
}
