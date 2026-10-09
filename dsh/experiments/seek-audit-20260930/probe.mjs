import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {gzipSync,brotliCompressSync} from 'node:zlib';
const base='http://127.0.0.1:3080';
const source=join(homedir(),'seek-stack/dsh/plugins/browser-viewer/lib');
const installed=join(homedir(),'.dsh/profiles/node_modules/@deepseek-ai/dsh-browser-viewer/lib');
const metrics={observedAt:new Date().toISOString(),scope:'Read-only localhost HTTP and file inspection; no browser measurements',endpoints:[],comparisons:[]};
for(const path of ['/work','/work/api/state','/work/app.js','/work/style.css','/work/buddy.js','/work/buddy.css','/work/finance.js','/work/finance-overview.js','/work/finance.css','/work/finance-v2.css','/work/images.js','/work/images.css','/work/browser.js','/work/markdown.js','/work/dreaming.js','/work/dreaming.css','/work/plush.png','/work/api/helper-status']) {
 const samples=[];let buffer,headers,status;
 for(let n=0;n<3;n++){
  const start=performance.now();const response=await fetch(base+path,{headers:{'Accept-Encoding':'gzip, br'},signal:AbortSignal.timeout(15000)});const headerMs=performance.now()-start;buffer=Buffer.from(await response.arrayBuffer());headers=response.headers;status=response.status;samples.push({headerMs:+headerMs.toFixed(2),totalMs:+(performance.now()-start).toFixed(2)});
 }
 const row={path,status,decodedBytes:buffer.length,cacheControl:headers.get('cache-control'),contentEncoding:headers.get('content-encoding'),etag:headers.get('etag'),samples};
 if(/javascript|json|css|html/.test(headers.get('content-type')||'')){row.gzipBytes=gzipSync(buffer).length;row.brotliBytes=brotliCompressSync(buffer).length;}
 if(path==='/work/api/state'&&status===200){const state=JSON.parse(buffer);row.taskCount=state.tasks.length;row.messageCount=state.tasks.reduce((n,t)=>n+(t.messages?.length||0),0);row.eventCount=state.tasks.reduce((n,t)=>n+(t.events?.length||0),0);row.statusCounts=Object.fromEntries([...new Set(state.tasks.map(t=>t.status))].map(s=>[s,state.tasks.filter(t=>t.status===s).length]));row.estimatedHourlyBytesAt2Seconds=buffer.length*1800;row.maxTaskBytes=Math.max(0,...state.tasks.map(t=>Buffer.byteLength(JSON.stringify(t))));}
 metrics.endpoints.push(row);
}
for(const file of ['work.html','work-client.js','work-server.js','work.css','work-buddy.js','work-finance-client.js','work-images-client.js','work-results.js','work-model-queue.js','purchases.js']){
 const s=await readFile(join(source,file)),d=await readFile(join(installed,file));const hash=b=>createHash('sha256').update(b).digest('hex');metrics.comparisons.push({file,sourceBytes:s.length,installedBytes:d.length,matches:hash(s)===hash(d)});
}
await writeFile(new URL('http-metrics.json',import.meta.url),JSON.stringify(metrics,null,2));
console.log(JSON.stringify(metrics,null,2));
