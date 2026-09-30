import {mkdir,writeFile,readFile,realpath,rename} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const REF=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const textBlocks=result=>[...(result.content||[]).filter(c=>c.type==='text'),...(result.structuredContent===undefined?[]:[{type:'text',text:JSON.stringify(result.structuredContent)}])];
const boundedText=(text,budget)=>{let value=text;while(JSON.stringify(value).length>budget)value=value.slice(0,Math.floor(value.length*.8));return value;};
function at(value,path='') {
  if(typeof path!=='string'||path.length>300)throw new Error('Invalid JSON field path.');
  for(const part of path?path.split('.'):[]) {
    if(!/^[\w-]+$/.test(part)||['__proto__','prototype','constructor'].includes(part)||value===null||typeof value!=='object'||!own(value,part))throw new Error('JSON field was not found.');
    value=value[part];
  }
  return value;
}
export function previewResult(result) {
  const blocks=textBlocks(result);
  let remaining=2400;
  const content=[];
  for(const b of blocks){const text=String(b.text||'');if(remaining<=0)break;content.push(text.slice(0,remaining));remaining-=text.length;}
  while(JSON.stringify(content).length>3500){const last=content.length-1;content[last]=content[last].slice(0,Math.floor(content[last].length*.8));if(!content[last])content.pop();}
  const truncated=blocks.reduce((n,b)=>n+String(b.text||'').length,0)>content.join('').length;
  return {content,truncated,textBlocks:blocks.length,structuredBlock:result.structuredContent===undefined?null:blocks.length-1,omittedNonTextBlocks:(result.content||[]).filter(c=>c.type!=='text').length};
}
export class WorkResultStore {
  constructor(taskRoot){this.root=taskRoot;}
  async path(ref,create=false) {
    if(!REF.test(ref))throw new Error('Invalid saved result reference.');
    const dir=join(this.root,'tool-results');if(create)await mkdir(dir,{recursive:true});
    const root=await realpath(this.root),actual=await realpath(dir),rel=relative(root,actual);
    if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Saved result must stay inside this task.');
    const file=join(actual,ref+'.json');
    if(!create){const resolved=await realpath(file),r=relative(actual,resolved);if(r.startsWith('..')||isAbsolute(r))throw new Error('Saved result must stay inside this task.');}
    return file;
  }
  async capture(result) {
    const ref=randomUUID(),body=JSON.stringify(result);
    if(Buffer.byteLength(body)>25*1024*1024)throw new Error('App result exceeds the 25 MB storage limit. Request a smaller page; no complete result was captured.');
    const file=await this.path(ref,true),temp=file+'.tmp';await writeFile(temp,body,{flag:'wx'});await rename(temp,file);
    const preview=previewResult(result);
    // Capturing one provider response is not proof that all provider pages were fetched.
    return {app:result.app,tool:result.tool,...preview,saved:{ref,path:'tool-results/'+ref+'.json',sha256:createHash('sha256').update(body).digest('hex'),bytes:Buffer.byteLength(body),captureComplete:true,providerCoverage:'not_verified'},
      next:'Read the saved response with apps_read(app="saved", tool=ref, args={operation:"read",block:0,offset:0,limit:2000}). For JSON arrays use operation="query", path to the array, and mode="count", "select", or "sum_integer". Check provider pagination separately; never sum a preview.'};
  }
  async access(ref,args={}) {
    const result=JSON.parse(await readFile(await this.path(ref),'utf8'));
    const blocks=textBlocks(result),block=args.block??0;
    if(!Number.isInteger(block)||block<0||block>=blocks.length)throw new Error('Choose a valid text block.');
    const text=String(blocks[block].text||'');
    if((args.operation||'read')==='read') {
      const offset=args.offset??0,limit=args.limit??2000;
      if(!Number.isInteger(offset)||offset<0||offset>text.length||!Number.isInteger(limit)||limit<1||limit>3000)throw new Error('Use a valid offset and a limit of 1–3000 characters.');
      const chunk=boundedText(text.slice(offset,offset+limit),5000),end=offset+chunk.length;
      return {ref,block,text:chunk,totalChars:text.length,offset,nextOffset:end<text.length?end:null,blockComplete:end===text.length&&offset===0,blocks:blocks.length,untrusted:true};
    }
    if(args.operation!=='query')throw new Error('Choose read or query.');
    let parsed;try{parsed=JSON.parse(text);}catch{throw new Error('This block is not JSON. Read it in bounded sections.');}
    const rows=at(parsed,args.path||'');if(!Array.isArray(rows))throw new Error('The selected JSON field is not an array.');
    let selected=rows;
    if(args.where){if(typeof args.where.field!=='string'||!own(args.where,'equals'))throw new Error('Filter needs field and equals.');selected=rows.filter(r=>{try{return at(r,args.where.field)===args.where.equals;}catch{return false;}});}
    const base={ref,rowCount:rows.length,matchedCount:selected.length,scope:'Only rows in this saved provider response. Check pagination separately.'};
    if(args.mode==='count')return base;
    if(args.mode==='sum_integer'){
      if(typeof args.field!=='string'||!args.field)throw new Error('Choose an integer field, such as amountCents.');
      let total=0n;for(const row of selected){const n=at(row,args.field);if(!Number.isSafeInteger(n))throw new Error('Every value must be a safe integer. Decimal amounts need a domain-specific report tool.');total+=BigInt(n);}
      return {...base,field:args.field,total:total.toString(),exact:true};
    }
    if(args.mode!=='select')throw new Error('Choose count, select or sum_integer.');
    const offset=args.offset??0,limit=args.limit??10;
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>25)throw new Error('Use a valid offset and limit of 1–25 rows.');
    const fields=args.fields;if(fields&&(!Array.isArray(fields)||fields.length>10||!fields.every(f=>typeof f==='string')))throw new Error('Select up to 10 field paths.');
    const page=[];let size=0;
    for(const row of selected.slice(offset,offset+limit)){
      const value=fields?Object.fromEntries(fields.map(f=>[f,at(row,f)])):row,encoded=JSON.stringify(value);
      if(size+encoded.length>3000){if(!page.length)throw new Error('One row exceeds the preview budget. Select fewer fields or use a bounded text read.');break;}
      page.push(value);size+=encoded.length;
    }
    return {...base,rows:page,offset,nextOffset:offset+page.length<selected.length?offset+page.length:null};
  }
}
