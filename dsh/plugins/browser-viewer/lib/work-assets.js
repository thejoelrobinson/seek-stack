import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync,brotliCompressSync} from 'node:zlib';

export const WORK_FILES={'/work':'work.html','/work/':'work.html','/work/app.js':'work-client.js','/work/runtime.js':'work-runtime.js','/work/style.css':'work.css','/work/finance.js':'work-finance-client.js','/work/finance-overview.js':'work-finance-overview.js','/work/finance.css':'work-finance.css','/work/finance-v2.css':'work-finance-v2.css','/work/images.js':'work-images-client.js','/work/images.css':'work-images.css','/work/browser-client.js':'client.js','/work/browser.js':'work-browser.js','/work/buddy.js':'work-buddy.js','/work/markdown.js':'work-markdown.js','/work/buddy.css':'work-buddy.css','/work/plush.png':'work-buddy-plush.png','/work/plush.webp':'work-buddy-plush.webp','/work/dreaming.js':'work-dreaming-client.js','/work/dreaming.css':'work-dreaming.css'};
Object.assign(WORK_FILES,{'/work/models.js':'work-model-client.js','/work/models.css':'work-model.css'});
Object.assign(WORK_FILES,{'/work/image-preview.js':'work-image-preview.js'});
Object.assign(WORK_FILES,{'/work/product.js':'work-product.js'});
Object.assign(WORK_FILES,{'/work/growth.js':'work-growth-client.js','/work/growth.css':'work-growth.css'});
export class WorkAssets {
  async init(){
    this.files=new Map();this.version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
    const implementation=(await readdir(new URL('.',import.meta.url))).filter(name=>name.endsWith('.js')).sort().concat(['../package.json','../skills/walmart-purchase-audit/SKILL.md','../skills/retailer-purchases/SKILL.md']);
    const hashes=[];for(const file of [...new Set([...Object.values(WORK_FILES),...implementation])]){const bytes=await readFile(new URL(file,import.meta.url));hashes.push([file,createHash('sha256').update(bytes).digest('hex')]);this.files.set(file,bytes);}
    this.release=createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0,20);
    this.hashes=hashes;
    for(const [name,bytes] of this.files) {
      let body=bytes;
      if(/\.(html|js|css)$/.test(name))body=Buffer.from(bytes.toString().replace(/(['"`(])\/work\/([a-zA-Z0-9._-]+\.(?:js|css|png|webp))(?=['"`)])/g,`$1/work/$2?v=${this.release}`));
      this.files.set(name,{body,type:name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':'text/javascript; charset=utf-8',...(/\.(html|js|css)$/.test(name)?{gzip:gzipSync(body),br:brotliCompressSync(body)}:{})});
    }
    return this;
  }
  serve(req,res,url){
    const filename=WORK_FILES[url.pathname];if(!filename||req.method!=='GET')return false;
    // Never serve an old version URL with new bytes: old tabs reload cleanly.
    if(url.searchParams.has('v')&&url.searchParams.get('v')!==this.release){res.writeHead(410,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('This app version has been replaced. Reload Seek.');return true;}
    const file=this.files.get(filename),accepted=String(req.headers['accept-encoding']||'');
    const encoding=/(?:^|,)\s*br(?:\s*,|\s*$)/.test(accepted)&&file.br?'br':/(?:^|,)\s*gzip(?:\s*,|\s*$)/.test(accepted)&&file.gzip?'gzip':null;
    const etag=`"${this.release}-${filename}-${encoding||'identity'}"`;
    const cache=filename.endsWith('.html')?'no-cache':url.searchParams.get('v')===this.release?'private, max-age=31536000, immutable':'private, max-age=0, must-revalidate';
    const headers={'Content-Type':file.type,'Cache-Control':cache,ETag:etag,Vary:'Accept-Encoding','X-Content-Type-Options':'nosniff'};
    if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return true;}
    const body=encoding?file[encoding]:file.body;res.writeHead(200,{...headers,...(encoding?{'Content-Encoding':encoding}:{}),'Content-Length':body.length});res.end(body);return true;
  }
}
