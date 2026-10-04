import {readFile,writeFile,mkdir,rename,open} from 'node:fs/promises';
import {join} from 'node:path';

export function validWorkStore(value) {
  return value?.version===1 && value.settings && typeof value.settings==='object' && Array.isArray(value.tasks) && value.tasks.every(t=>typeof t.id==='string'&&Array.isArray(t.messages));
}
async function atomic(path,text) {
  const temp=path+'.tmp',file=await open(temp,'w');
  try {await file.writeFile(text);await file.sync();} finally {await file.close();}
  await rename(temp,path);
}
export class WorkStorage {
  constructor(root){this.root=root;this.path=join(root,'work.json');this.last='';this.recovery=null;}
  async load(fallback) {
    await mkdir(this.root,{recursive:true});
    let original=null,missing=false;
    try {original=await readFile(this.path,'utf8');const value=JSON.parse(original);if(Number.isInteger(value?.version)&&value.version!==1){const error=new Error('Unsupported Work schema. Use a compatible release; the original history was preserved.');error.code='unsupported-schema';throw error;}if(!validWorkStore(value))throw new Error('Unsupported Work data.');this.last=original;return value;}
    catch(error){missing=error.code==='ENOENT';if(error.code==='unsupported-schema'||!missing&&original===null)throw error;}
    for(const candidate of [this.path+'.bak',this.path+'.tmp']) {
      try {
        const text=await readFile(candidate,'utf8'),value=JSON.parse(text);if(!validWorkStore(value))continue;
        if(original!==null)await writeFile(this.path+'.corrupt-'+Date.now(),original);
        this.recovery={at:Date.now(),source:candidate.endsWith('.bak')?'backup':'interrupted-save'};
        this.last=text;await atomic(this.path,text);return value;
      }catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
    if(!missing)throw new Error('Work history is unreadable and no valid recovery copy exists. The original files were preserved.');
    return fallback;
  }
  async save(payload) {
    if(payload===this.last)return;
    if(this.last)await atomic(this.path+'.bak',this.last);
    await atomic(this.path,payload);this.last=payload;
  }
}
