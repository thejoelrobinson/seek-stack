// Settings › Computers: download Seek Desktop for this computer's OS, pair computers with a
// one-time code, and see or remove the computers Seek can use.
import {request} from '/work/runtime.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=(n,c='')=>`<svg class="ic${c?' '+c:''}" aria-hidden="true" focusable="false"><use href="#i-${n}"/></svg>`;
const api=(p,b)=>request('/work/api/'+p,b,{timeoutMs:20000});
const OS={win32:'Windows',darwin:'Mac',linux:'Linux'};
const size=b=>b>=1e6?`${(b/1e6).toFixed(0)} MB`:`${Math.round(b/1e3)} KB`;
let data=null,code=null,host=null,timer=0,detected=null;
function toast(m){const el=document.getElementById('toast');if(!el)return;el.textContent=m;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>{el.hidden=true;},3500);}

/** Which computer is this? OS from the user agent; Apple silicon vs Intel from the GPU name on Safari. */
export async function detect(){
  if(detected)return detected;
  const ua=navigator.userAgent,touchMac=/Macintosh/.test(ua)&&navigator.maxTouchPoints>1;
  let os=/iPhone|iPad|iPod|Android/.test(ua)||touchMac?'mobile':/Windows/.test(ua)?'win32':/Macintosh|Mac OS X/.test(ua)?'darwin':/Linux|X11|CrOS/.test(ua)?'linux':'unknown',arch=null;
  try{const h=await navigator.userAgentData?.getHighEntropyValues?.(['architecture','bitness']);if(h?.architecture)arch=h.architecture==='arm'?'arm64':'x64';}catch{}
  if(os==='darwin'&&!arch){try{const gl=document.createElement('canvas').getContext('webgl'),info=gl?.getExtension('WEBGL_debug_renderer_info'),gpu=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):'';arch=/Apple (M\d|GPU)/i.test(gpu)?'arm64':/Intel/i.test(gpu)?'x64':null;}catch{}}
  return detected={os,arch};
}
function pick(files,{os,arch}){
  const mine=files.filter(f=>f.os===os);
  const fits=f=>f.arch==='universal'||!arch||f.arch===arch;
  const order={win32:['installer','zip'],darwin:['dmg','zip'],linux:['appimage','deb']}[os]||[];
  return mine.filter(fits).sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind));
}
const KIND={installer:'Installer (.exe)',zip:'Portable (.zip)',dmg:'Disk image (.dmg)',appimage:'AppImage',deb:'Debian/Ubuntu (.deb)'};
const NOTE={win32:'Windows may show “Windows protected your PC” because the app isn’t signed yet: choose More info › Run anyway.',darwin:'The app isn’t notarized yet: the first time, right-click Seek Desktop in Applications and choose Open. To let Seek use apps, allow Accessibility when asked.',linux:'Make the AppImage executable (chmod +x) and run it. Seek needs an X11 session (Wayland isn’t supported yet), and so it can read apps like Chrome and VS Code, turn on accessibility once: gsettings set org.gnome.desktop.interface toolkit-accessibility true'};
function downloadCard(){
  const m=data.downloads||{files:[]},files=m.files||[],{os,arch}=detected;
  if(!files.length)return `<section class="memory dk-card"><h3>Get Seek Desktop</h3><p class="muted">Installers aren’t on this Seek yet.</p></section>`;
  const best=pick(files,detected),primary=best[0],armMacOnly=os==='darwin'&&arch==='x64'&&!files.some(f=>f.os==='darwin'&&(f.arch==='x64'||f.arch==='universal'));
  const all=Object.entries(OS).map(([k,label])=>{const list=files.filter(f=>f.os===k);return list.length?`<div class="dk-os"><b>${label}</b>${list.map(f=>`<a href="/work/downloads/${encodeURIComponent(f.name)}" download>${esc(KIND[f.kind]||f.kind)}${f.arch&&f.arch!=='x64'?` · ${f.arch==='arm64'?'Apple silicon':f.arch}`:''} <small>${size(f.size)}</small></a>`).join('')}</div>`:'';}).join('');
  const lead=os==='mobile'?`<p>Seek Desktop runs on Windows, Mac and Linux. Open this page on the computer you want Seek to use, or download it there from the list below.</p>`
    :primary&&!armMacOnly?`<div class="dk-primary"><div><strong>Seek Desktop for ${OS[os]}${os==='darwin'&&arch?` · ${arch==='arm64'?'Apple silicon':'Intel'}`:''}</strong><small>Version ${esc(m.version)} · ${esc(KIND[primary.kind]||primary.kind)} · ${size(primary.size)}</small></div><a class="button primary" href="/work/downloads/${encodeURIComponent(primary.name)}" download>${icon('download','ic-sm')}Download</a></div><p class="muted dk-note">${esc(NOTE[os]||'')}</p>`
    :armMacOnly?`<p>This Mac has an Intel processor; the current build is for Apple silicon (M1 or newer). An Intel build is coming.</p>`
    :`<p>We couldn’t tell which system this is. Pick a download below.</p>`;
  return `<section class="memory dk-card"><h3>Get Seek Desktop</h3>${lead}<details class="dk-all"${os==='mobile'||!primary?' open':''}><summary>All downloads · version ${esc(m.version)}</summary>${all}<p class="muted">SHA-256: ${files.map(f=>`<code title="${esc(f.name)}">${esc(f.sha256.slice(0,12))}…</code>`).join(' ')}</p></details></section>`;
}
function pairCard(){
  if(!code)return `<section class="memory dk-card"><h3>Pair a computer</h3><p>Install Seek Desktop, then pair it here. Each computer gets its own key you can remove any time.</p><button class="primary" data-dk-code>${icon('plus','ic-sm')}Create a pairing code</button></section>`;
  const left=Math.max(0,Math.round((code.expiresAt-Date.now())/1000));
  return `<section class="memory dk-card dk-pairing"><h3>Pair a computer</h3><p>In Seek Desktop on the computer, enter:</p><div class="dk-fields"><div><small>Seek address</small><code>${esc(host)}</code></div><div><small>Pairing code</small><code class="dk-code">${esc(code.code)}</code></div></div><p class="muted">${left?`Expires in ${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}. Works once.`:'Expired. '}<button class="link-btn" data-dk-code>${left?'New code':'Create a new code'}</button></p></section>`;
}
function computersCard(){
  const list=data.computers||[];
  const row=c=>`<li><span class="dk-ic">${icon('desktop')}</span><div><strong>${esc(c.name)}</strong><small>${OS[c.os]||'Computer'}${c.version?` · Seek Desktop ${esc(c.version)}`:''}</small><small class="${c.online?'dk-on':''}">${c.online?(c.state==='agent'?'Seek is using it now':'Online · ready'):'Offline'} · ${c.remoteGrant?'You can approve from your phone':'Approve on the computer'}</small></div><button data-dk-rename="${esc(c.id)}" data-name="${esc(c.name)}">Rename</button><button data-dk-remove="${esc(c.id)}" data-name="${esc(c.name)}">Remove</button></li>`;
  return `<section class="memory dk-card"><h3>Your computers</h3>${list.length?`<ul class="dk-list">${list.map(row).join('')}</ul>`:`<p class="muted">None yet.${data.thisPc?' Seek Desktop is running on the PC that hosts Seek: pair it to approve from your phone.':''}</p>`}</section>`;
}
export async function render(body,{settingsIntro}){
  await detect();
  try{data=await api('desktop');host=data.server||location.host;}catch(e){body.innerHTML=`${settingsIntro('computers','')}<p class="muted">${esc(e.message)}</p>`;return;}
  body.innerHTML=`${settingsIntro('computers','Let Seek use apps on your computers. You allow each task, and you can take over any time with Ctrl+Alt+Shift+S.')}<div class="dk">${downloadCard()}${pairCard()}${computersCard()}</div>`;
}
let current=null;
export function activate(body,opts){current={body,opts};clearInterval(timer);void render(body,opts);
  // While a code is showing, watch for the computer to arrive; otherwise refresh gently.
  timer=setInterval(()=>{if(!document.body.contains(body)){clearInterval(timer);return;}const before=(data?.computers||[]).length;if(code&&code.expiresAt<Date.now()-60000)code=null;void api('desktop').then(next=>{const paired=next.computers.length>before&&code;data=next;if(paired){code=null;toast('Computer paired');}void render(body,opts);}).catch(()=>{});},code?3000:15000);}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||!current)return;
  if(b.matches('[data-dk-code]')){b.disabled=true;try{code=await api('desktop/code',{});activate(current.body,current.opts);}catch(err){toast(err.message);b.disabled=false;}}
  if(b.matches('[data-dk-rename]')){const name=prompt('Name for this computer',b.dataset.name);if(!name||name===b.dataset.name)return;try{await api('desktop/device',{action:'rename',id:b.dataset.dkRename,name});toast('Renamed');await render(current.body,current.opts);}catch(err){toast(err.message);}}
  if(b.matches('[data-dk-remove]')){if(!confirm(`Remove ${b.dataset.name}? Seek can no longer use it until you pair it again.`))return;try{await api('desktop/device',{action:'remove',id:b.dataset.dkRemove});toast('Computer removed');await render(current.body,current.opts);}catch(err){toast(err.message);}}
});
