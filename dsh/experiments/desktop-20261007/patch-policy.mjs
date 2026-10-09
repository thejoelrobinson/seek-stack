import {readFile,writeFile} from 'node:fs/promises';
const f=new URL('../../plugins/browser-viewer/lib/work-tool-policy.js',import.meta.url);let t=await readFile(f,'utf8');
const a=String.raw`caldav-devices\.json|calendar\.sqlite)`;if(t.split(a).length!==2)throw new Error('anchor');
await writeFile(f,t.replace(a,String.raw`caldav-devices\.json|calendar\.sqlite|agent-connection\.json)`));console.log('patched policy');
