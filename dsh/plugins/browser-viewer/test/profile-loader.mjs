import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
// Tests resolve harness packages (@deepseek-ai/dsh-tools, cordis, ...) the way the harness
// supplies them to plugins: from the installed dsh CLI. DSH_PACKAGES_ROOT points at another
// install (e.g. a candidate under test); otherwise the global npm install is used.
const root=process.env.DSH_PACKAGES_ROOT||join(process.env.APPDATA||'','npm','node_modules','@deepseek-ai','dsh');
const parentURL=pathToFileURL(join(root,'package.json')).href;
export async function resolve(specifier,context,nextResolve){
  try{return await nextResolve(specifier,context);}
  catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||specifier.startsWith('.')||specifier.includes(':'))throw e;
    return nextResolve(specifier,{...context,parentURL});}
}
