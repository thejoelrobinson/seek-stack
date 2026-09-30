import {readFile} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ImageService} from './image-service.js';

const name='qwen-image';
const inject=['webServer','apiProxy'];
const localhost=host=>['127.0.0.1','localhost','[::1]'].includes(host);
const trusted=(req,hosts)=>{let url;try{url=new URL('http://'+(req.headers.host||''));}catch{return false;}if(localhost(url.hostname))return true;return (hosts||[]).some(entry=>{try{return new URL('https://'+entry).host===url.host;}catch{return false;}});};

async function apply(ctx){
  const root=process.env.DSH_WORK_HOME||join(homedir(),'.dsh','work');
  const idle=async()=>{try{const result=await ctx.apiProxy.sessions.list({type:'client-request',rpcId:randomUUID(),method:'sessions.list',payload:{}});return !(result.result?.value?.items||[]).some(session=>session.running);}catch{return false;}};
  const images=await new ImageService(root,{canStart:idle,log:ctx.logger}).init();
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const route={kind:'prefix',path:'/qwen-image',handler:async(req,res)=>{const hosts=ctx.get('webRuntime')?.trustedHosts||[];if(!trusted(req,hosts)){res.writeHead(403);res.end('forbidden');return;}const url=new URL(req.url,'http://local');try{
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/status'){json(res,200,await images.status());return;}
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/history'){json(res,200,images.history());return;}
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/file'){const file=images.file(url.searchParams.get('id')||''),body=await readFile(file);res.writeHead(200,{'Content-Type':extname(file).toLowerCase()==='.png'?'image/png':'application/octet-stream','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});res.end(body);return;}
    if(req.method==='POST'&&url.pathname.startsWith('/qwen-image/api/')){const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>1024*1024)throw new Error('Request is too large.');chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(url.pathname==='/qwen-image/api/generate')json(res,200,await images.generate(body));else if(url.pathname==='/qwen-image/api/delete')json(res,200,await images.remove(body.id));else json(res,404,{error:'Not found'});return;}
    json(res,404,{error:'Not found'});
  }catch(error){json(res,400,{error:error.message});}}};
  const off=ctx.webServer.register(route);ctx.effect(()=>()=>off(),'qwen-image cleanup');
}
export {name,inject,apply,ImageService};
export default {name,inject,apply};
