// Settings › Computers in the Work shell.
import {readFile,writeFile} from 'node:fs/promises';
const lib=new URL('../../plugins/browser-viewer/lib/',import.meta.url);
async function patch(name,pairs){const f=new URL(name,lib);let t=await readFile(f,'utf8');for(const [a,b] of pairs){const n=t.split(a).length-1;if(n!==1)throw new Error(`${name}: ${n} matches for ${a.slice(0,90)}`);t=t.replace(a,()=>b);}await writeFile(f,t);console.log('patched',name);}
await patch('work-assets.js',[[`'/work/ical.js':'work-ical.js'});`,`'/work/ical.js':'work-ical.js'});
Object.assign(WORK_FILES,{'/work/desktop.js':'work-desktop-client.js','/work/desktop.css':'work-desktop.css'});`]]);
await patch('work.html',[[`<symbol id="i-sidebar"`,`<symbol id="i-desktop" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2.5" style="fill:var(--ic-fill,currentColor);fill-opacity:var(--ic-duo,.14)"/><rect x="3" y="4.5" width="18" height="12" rx="2.5" fill="none"/><path fill="none" d="M9 20h6M12 16.5V20"/></symbol><symbol id="i-sidebar"`]]);
await patch('work-client.js',[
  [`['privacy','Privacy & security','shield'],`,`['privacy','Privacy & security','shield'],['computers','Computers','desktop'],`],
  [`growth:'/work/growth.js',calendar:'/work/calendar.js'}`,`growth:'/work/growth.js',calendar:'/work/calendar.js',desktop:'/work/desktop.js'}`],
  [`growth:['/work/growth.css'],calendar:['/work/calendar.css']}`,`growth:['/work/growth.css'],calendar:['/work/calendar.css'],desktop:['/work/desktop.css']}`],
  [`  else if(view==='growth')renderGrowth({api,toast});`,`  else if(view==='growth')renderGrowth({api,toast});
  else if(view==='computers'){if(body.dataset.desktop!=='1'){body.dataset.desktop='1';void ensureFeature('desktop').then(m=>{if(view==='computers')m.activate(body,{settingsIntro});}).catch(error=>toast(error.message));}}`],
]);
