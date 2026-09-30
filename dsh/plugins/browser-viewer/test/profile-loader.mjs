import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {homedir} from 'node:os';
export async function resolve(specifier,context,nextResolve){
  try{return await nextResolve(specifier,context);}
  catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||specifier.startsWith('.')||specifier.includes(':'))throw e;
    return nextResolve(specifier,{...context,parentURL:pathToFileURL(join(homedir(),'.dsh','profiles','package.json')).href});}
}
