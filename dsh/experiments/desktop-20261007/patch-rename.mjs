import {readFile,writeFile} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url);
async function patch(name,pairs){const f=new URL(name,lib);let t=await readFile(f,'utf8');for(const [a,b] of pairs){const n=t.split(a).length-1;if(n!==1)throw new Error(`${name}: ${n} matches for ${a.slice(0,80)}`);t=t.replace(a,()=>b);}await writeFile(f,t);console.log('patched',name);}
await patch('work-desktop.js',[[`  async remove(id){await this.devices.remove(id);`,`  async rename(id,name){const label=clean(name,60);if(!label)throw new Error('Give the computer a name.');if(!await this.devices.update(id,{name:label}))throw new Error('That computer is no longer paired.');const l=this.links.get(id);if(l){l.device.name=label;l.info.name=label;}return {renamed:true,name:label};}
  async remove(id){await this.devices.remove(id);`]]);
await patch('work-server.js',[[`        else if(url.pathname==='/work/api/desktop/device'){if(body.action!=='remove')throw new Error('Choose remove.');await desktopHub.remove(String(body.id||''));value={removed:true};}`,
`        else if(url.pathname==='/work/api/desktop/device'){if(body.action==='rename')value=await desktopHub.rename(String(body.id||''),body.name);else if(body.action==='remove'){await desktopHub.remove(String(body.id||''));value={removed:true};}else throw new Error('Choose rename or remove.');}`]]);
await patch('work-desktop-client.js',[
  [`<button data-dk-remove="\${esc(c.id)}" data-name="\${esc(c.name)}">Remove</button></li>\`;`,`<button data-dk-rename="\${esc(c.id)}" data-name="\${esc(c.name)}">Rename</button><button data-dk-remove="\${esc(c.id)}" data-name="\${esc(c.name)}">Remove</button></li>\`;`],
  [`  if(b.matches('[data-dk-remove]')){`,`  if(b.matches('[data-dk-rename]')){const name=prompt('Name for this computer',b.dataset.name);if(!name||name===b.dataset.name)return;try{await api('desktop/device',{action:'rename',id:b.dataset.dkRename,name});toast('Renamed');await render(current.body,current.opts);}catch(err){toast(err.message);}}
  if(b.matches('[data-dk-remove]')){`],
]);
