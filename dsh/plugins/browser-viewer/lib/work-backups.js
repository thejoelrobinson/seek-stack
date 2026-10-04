import {readFile,mkdir,rename,open} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {dpapi} from './work-finance.js';

export const BACKUP_LIMITS={maxFiles:20000,maxFileBytes:64*1024*1024,maxTotalBytes:1024*1024*1024,maxManifestBytes:1500*1024*1024,maxArchiveBytes:1500*1024*1024};
const keyId=key=>createHash('sha256').update(key).digest('hex').slice(0,16);
async function atomic(path,text){const temporary=path+'.tmp',file=await open(temporary,'w',0o600);try{await file.writeFile(text);await file.sync();}finally{await file.close();}await rename(temporary,path);}
export class WorkBackups {
  constructor(root,{key,protect=dpapi,limits={},retention=14}={}){this.root=root;this.directory=join(root,'backups');this.key=key;this.protect=protect;this.limits={...BACKUP_LIMITS,...limits};this.retention=Math.max(1,Math.min(90,Math.trunc(retention)||14));this.info={lastAt:null,lastFile:null,error:null,encrypted:true,format:2,retention:this.retention,limits:this.limits,secretRestore:'DPAPI connection credentials need reauthorization on a different Windows identity. Export the backup recovery key locally before moving encrypted archives.'};}
  async init(){
    await mkdir(this.directory,{recursive:true});for(const [name,value]of Object.entries(this.limits))if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid backup limit: '+name);
    if(!this.key){const path=join(this.directory,'key.dpapi');try{this.key=Buffer.from(await this.protect('unprotect',await readFile(path,'utf8')),'base64');}catch(error){if(error.code!=='ENOENT')throw error;this.key=randomBytes(32);await atomic(path,await this.protect('protect',this.key.toString('base64')));}}
    if(this.key.length!==32)throw new Error('Invalid backup encryption key.');this.key=Buffer.from(this.key);
    try{const value=JSON.parse(await readFile(join(this.directory,'status.json'),'utf8'));if(value&&typeof value==='object')Object.assign(this.info,{lastAt:value.lastAt,lastFile:value.lastFile,files:value.files,bytes:value.bytes,error:value.error});}catch(error){if(error.code!=='ENOENT'){await rename(join(this.directory,'status.json'),join(this.directory,'status.json.corrupt-'+Date.now()));this.info.error='An unreadable backup status record was preserved.';}}
    return this;
  }
  status(){return {...this.info,encrypted:true,keyId:keyId(this.key),canExportRecoveryKey:true,active:!!this.flight};}
  exportRecoveryKey(){return {format:'seek-backup-key-v1',key:this.key.toString('base64'),keyId:keyId(this.key),warning:'Store this recovery key separately from the encrypted archives. It decrypts your Work backup data; connected-app DPAPI credentials still need reauthorization on a different Windows identity.'};}
  worker(operation,args={}){return new Promise((resolve,reject)=>{let settled=false;const worker=new Worker(new URL('./work-backup-worker.js',import.meta.url),{workerData:{operation,root:this.root,directory:this.directory,key:this.key,limits:this.limits,retention:this.retention,...args},resourceLimits:{maxOldGenerationSizeMb:768}});worker.once('message',message=>{settled=true;message.error?reject(new Error(message.error)):resolve(message.result);});worker.once('error',reject);worker.once('exit',code=>{if(!settled)reject(new Error('Backup worker stopped before completion'+(code?' ('+code+')':'')+'.'));});});}
  async create(){if(this.flight)return this.flight;this.flight=this.capture().then(async result=>{Object.assign(this.info,{lastAt:Date.now(),lastFile:result.name,error:null,files:result.files,bytes:result.bytes,rawBytes:result.rawBytes,format:2});await atomic(join(this.directory,'status.json'),JSON.stringify(this.info));return result;}).catch(error=>{this.info.error=error.message;throw error;}).finally(()=>this.flight=null);return this.flight;}
  capture(){return this.worker('capture');}
  restore(archive,destination,{key=this.key}={}){if(this.restoring)throw new Error('Another restore is already running.');const decoded=typeof key==='string'?Buffer.from(key,'base64'):Buffer.from(key);if(decoded.length!==32)throw new Error('Invalid backup recovery key.');this.restoring=this.worker('restore',{archive,destination,key:decoded}).finally(()=>this.restoring=null);return this.restoring;}
}
