// Temporary CalDAV request log (local only, capped) to see what iOS Calendar sends.
import {readFile,writeFile} from 'node:fs/promises';
const f=new URL('../../plugins/browser-viewer/lib/work-server.js',import.meta.url);
let t=await readFile(f,'utf8');
const a=`      const out=await dav.handle(req.method,url.pathname,req.headers,body);
      res.writeHead(out.status,out.headers);res.end(out.body||undefined);return;`;
if(t.split(a).length!==2)throw new Error('anchor');
t=t.replace(a,()=>`      const began=Date.now(),out=await dav.handle(req.method,url.pathname,req.headers,body);
      // Diagnostics while CalDAV clients are being brought up: last ~2 MB of requests, on this PC only.
      void (async()=>{try{const file=join(root,'caldav-requests.jsonl');const s=await stat(file).catch(()=>null);if(s&&s.size>2*1024*1024)await rename(file,file+'.1');await writeFile(file,JSON.stringify({at:began,ms:Date.now()-began,method:req.method,path:url.pathname,depth:req.headers.depth,ua:String(req.headers['user-agent']||'').slice(0,160),via:req.headers['x-seek-dav-device']?'proxy':'local',status:out.status,req:String(body).slice(0,4000),res:String(out.body||'').slice(0,8000)})+'\\n',{flag:'a',mode:0o600});}catch{}})();
      res.writeHead(out.status,out.headers);res.end(out.body||undefined);return;`);
await writeFile(f,t);console.log('patched');
