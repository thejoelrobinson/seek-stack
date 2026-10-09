// Mounts the real Work server (mountWork) against a stub host and a temporary DSH_WORK_HOME, then
// serves its /work route on a local port. No live Seek data is touched.
// Usage: node --import ../../plugins/browser-viewer/test/register-profile.mjs mount.mjs [port]
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=process.env.DSH_WORK_HOME||await mkdtemp(join(tmpdir(),'seek-mount-'));process.env.DSH_WORK_HOME=home;
const {mountWork}=await import('../../plugins/browser-viewer/lib/work-server.js');
const tools=new Map(),effects=[],warnings=[];
const noop=()=>{};
const permissive=name=>new Proxy(function(){},{get:(t,k)=>k==='then'?undefined:k===Symbol.toPrimitive?()=>name:permissive(name+'.'+String(k)),apply:()=>undefined});
const services={webRuntime:{trustedHosts:['seek.example.test']}};
let route=null;const upgrades=new Map();
const ctx={
  logger:{info:noop,warn:m=>warnings.push(String(m)),error:m=>warnings.push(String(m)),debug:noop},
  get:k=>services[k],
  agents:{get:()=>null,list:()=>[]},
  tools:{guard:()=>noop,register:def=>{tools.set(def.name,def);return noop;},schemas:()=>[],get:()=>null,view:()=>({visible:new Map()})},
  webServer:{register:r=>{route=r;return noop;},registerUpgrade:u=>{upgrades.set(u.path,u.handler);return noop;}},
  systemPrompt:{section:noop,getSectionOrder:()=>0},
  effect:fn=>{effects.push(fn);},
  on:()=>noop,emit:noop
};
const controller=new Proxy({status:{url:'',running:false},paused:false,handoff:null,approval:null,vault:{list:()=>[],status:()=>({state:'missing'})},queue:Promise.resolve(),mirror:null},{get:(t,k)=>k in t?t[k]:typeof k==='string'&&/^on[A-Z]/.test(k)?noop:permissive('controller.'+String(k))});
export const ready=(async()=>{
  await mountWork(new Proxy(ctx,{get:(t,k)=>k in t?t[k]:permissive('ctx.'+String(k))}),controller,()=>true);
  const server=createServer((req,res)=>{const url=new URL(req.url,'http://local');if(url.pathname.startsWith('/work'))return route.handler(req,res);res.writeHead(404);res.end();});server.on('upgrade',(req,socket,head)=>{const h=upgrades.get(new URL(req.url,'http://local').pathname);if(h)h(req,socket,head);else socket.destroy();});
  await new Promise(r=>server.listen(Number(process.env.PORT||(process.argv[1]?.endsWith('mount.mjs')?process.argv[2]:0)||0),'127.0.0.1',r));
  return {server,base:'http://127.0.0.1:'+server.address().port,tools,home,warnings,stop:()=>{for(const fn of effects){try{fn()?.();}catch{}}server.closeAllConnections();server.close();}};
})();
if(process.argv[1]?.endsWith('mount.mjs')){const m=await ready;console.log('mounted',m.base,'home',m.home,'tools',[...m.tools.keys()].filter(n=>/^(calendar_|todo_)/.test(n)).join(','));}
