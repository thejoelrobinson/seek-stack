import {readFile} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ImageService} from './image-service.js';
import {Service} from '@deepseek-ai/cordis';
import {isTrustedApiRequest} from '@deepseek-ai/dsh-browser-viewer';

class ImageRuntime extends Service {
  constructor(ctx,images){super(ctx,'seekImages');this.images=images;this.workBusy=()=>false;}
  get busy(){return !!this.images.active||!!this.images.pendingStart||!!this.images.recoveryRequired||!!this.images.runnerHealth?.busy;}
  snapshot(){return this.images.progress();}
  refresh(){return this.images.runnerStatus();}
}

const name='qwen-image';
const inject=['webServer','sessionController'];

async function apply(ctx){
  const root=process.env.DSH_WORK_HOME||join(homedir(),'.dsh','work');
  const idle=async()=>{try{if(ctx.get('seekImages')?.workBusy())return false;const result=await ctx.sessionController.list({},AbortSignal.timeout(10000));return !(result.items||[]).some(session=>session.running);}catch{return false;}};
  const images=await new ImageService(root,{canStart:idle,log:ctx.logger}).init();
  new ImageRuntime(ctx,images);
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const route={kind:'prefix',path:'/qwen-image',handler:async(req,res)=>{const hosts=ctx.get('webRuntime')?.trustedHosts||[];if(!isTrustedApiRequest(req,hosts)){res.writeHead(403);res.end('forbidden');return;}const url=new URL(req.url,'http://local');try{
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/status'){json(res,200,await images.status());return;}
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/history'){json(res,200,images.history());return;}
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/job'){json(res,200,images.jobStatus(url.searchParams.get('id')||''));return;}
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/preview'){const body=await images.preview(url.searchParams.get('id')||'');res.writeHead(200,{'Content-Type':'image/png','Content-Length':body.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(body);return;}
    if(req.method==='GET'&&url.pathname==='/qwen-image/api/file'){const file=images.file(url.searchParams.get('id')||''),body=await readFile(file);res.writeHead(200,{'Content-Type':extname(file).toLowerCase()==='.png'?'image/png':'application/octet-stream','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});res.end(body);return;}
    if(req.method==='POST'&&url.pathname.startsWith('/qwen-image/api/')){const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>1024*1024)throw new Error('Request is too large.');chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(url.pathname==='/qwen-image/api/start')json(res,202,await images.start(body));else if(url.pathname==='/qwen-image/api/generate')json(res,200,await images.waitFor((await images.start(body)).id));else if(url.pathname==='/qwen-image/api/restore')json(res,200,await images.retryRestore());else if(url.pathname==='/qwen-image/api/delete')json(res,200,await images.remove(body.id));else if(url.pathname==='/qwen-image/api/favorite')json(res,200,await images.favorite(body.id,body.favorite!==false));else if(url.pathname==='/qwen-image/api/undelete')json(res,200,await images.undelete(body.id));else if(url.pathname==='/qwen-image/api/cancel')json(res,200,await images.cancel(body.id));else if(url.pathname==='/qwen-image/api/defer')json(res,200,await images.defer(body.id,body.deferred!==false));else json(res,404,{error:'Not found'});return;}
    json(res,404,{error:'Not found'});
  }catch(error){json(res,400,{error:error.message});}}};
  const off=ctx.webServer.register(route);void images.resume().catch(error=>ctx.logger.warn('Image recovery: '+error.message));ctx.effect(()=>()=>{images.close();off();},'qwen-image cleanup');
}
export {name,inject,apply,ImageService};
export default {name,inject,apply};
