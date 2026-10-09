// Serves the repo's Work assets and proxies read-only API GETs to the live :3080, refusing writes.
import {createServer,request} from 'node:http';
import {WorkAssets} from '../../plugins/browser-viewer/lib/work-assets.js';
export async function startProxy(port=18890){
 const assets=await new WorkAssets().init();
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://local');
  if(assets.serve(req,res,url))return;
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"preview is read-only"}');return;}
  if(url.pathname.startsWith('/browser/stream')){res.writeHead(404);res.end();return;}
  const up=request({host:'127.0.0.1',port:3080,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:3080'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  up.on('error',e=>{res.writeHead(502);res.end(String(e));});req.pipe(up);
 });
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 return {server,base:'http://127.0.0.1:'+port,release:assets.release};
}
if(process.argv[1]?.endsWith('devproxy.mjs')){const p=await startProxy(Number(process.env.PORT||18890));console.log('preview',p.base,p.release);}
