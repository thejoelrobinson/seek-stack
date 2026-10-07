// Copies the host-side bridge modules into the Seek Work plugin, which is what gets deployed.
// Run after changing src/client.js, agent.js, runtime.js or tools.js: node scripts/vendor-seek.mjs
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const src=new URL('../src/',import.meta.url),out=new URL('../../dsh/plugins/browser-viewer/lib/desktop/',import.meta.url);
await mkdir(out,{recursive:true});
for(const name of ['client.js','agent.js','runtime.js','tools.js']){
  const text=await readFile(new URL(name,src),'utf8');
  await writeFile(new URL(name,out),`// Vendored from seek-stack/desktop-bridge/src/${name} by scripts/vendor-seek.mjs. Edit the source, then re-run.\n${text}`);
  console.log('vendored',name);
}
