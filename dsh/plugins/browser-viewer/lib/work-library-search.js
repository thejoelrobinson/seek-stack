// Searches the text inside Library artifacts. Reads only files already
// recorded as task artifacts, through the engine's workspace path check.
import {readFile,stat} from 'node:fs/promises';
import {extname} from 'node:path';

const TEXT=new Set(['.md','.txt','.csv','.tsv','.json','.html','.htm','.xml','.yaml','.yml','.log','.js','.mjs','.ts','.py','.ps1','.css','.svg']);
const MAX_BYTES=2*1024*1024,MAX_FILES=2000,MAX_HITS=200;

export function artifactText(raw,type){
  let text=String(raw||'');
  if(['.html','.htm','.svg','.xml'].includes(type))text=text.replace(/<(script|style)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  return text.replace(/\s+/g,' ').trim();
}

export function excerpt(text,query,width=180){
  const at=text.toLowerCase().indexOf(query);if(at<0)return '';
  const start=Math.max(0,at-Math.floor((width-query.length)/2)),end=Math.min(text.length,start+width);
  return (start?'…':'')+text.slice(start,end).trim()+(end<text.length?'…':'');
}

export class LibrarySearch {
  constructor(engine){this.engine=engine;this.cache=new Map();}
  async text(t,a){
    const type=extname(a.path||a.filename||'').toLowerCase();if(!TEXT.has(type))return '';
    let file;try{file=await this.engine.file(t,a.path);}catch{return '';}
    const info=await stat(file.full),key=t.id+'\0'+a.id,cached=this.cache.get(key);
    if(cached&&cached.mtime===info.mtimeMs&&cached.size===info.size)return cached.text;
    if(info.size>MAX_BYTES){this.cache.set(key,{mtime:info.mtimeMs,size:info.size,text:''});return '';}
    const text=artifactText(await readFile(file.full,'utf8'),type);
    this.cache.set(key,{mtime:info.mtimeMs,size:info.size,text});return text;
  }
  async search(query){
    const q=String(query||'').trim().toLowerCase().slice(0,200);if(q.length<2)return {query:q,hits:[]};
    const hits=[];let scanned=0;
    for(const t of this.engine.store.tasks.filter(t=>!t.eval)){
      for(const a of t.artifacts||[]){
        if(hits.length>=MAX_HITS||scanned>=MAX_FILES)return {query:q,hits,truncated:true};
        scanned++;const text=await this.text(t,a).catch(()=>'');const found=excerpt(text,q);
        if(found)hits.push({taskId:t.id,id:a.id,excerpt:found});
      }
    }
    return {query:q,hits};
  }
}
