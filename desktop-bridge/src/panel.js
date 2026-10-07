import './buddy.js';
const $=s=>document.querySelector(s);
const el=(tag,props={},...kids)=>{const n=Object.assign(document.createElement(tag),props);n.append(...kids);return n;};
let latest,linkState;
const error=e=>{$('#activity').textContent=e.message;};
const linkError=e=>{const p=$('#link-error');p.textContent=e?.message||'';p.hidden=!e;};
const render=s=>{
 latest=s;$('#activity').textContent=s.activity;window.SeekBuddy.hold(s.activity==='Typing'?'type':s.state==='agent'?'think':'idle',1500);
 $('#details').textContent=JSON.stringify({...s,windows:undefined},null,2);
 const select=$('#display');select.replaceChildren(...(s.displays||[]).map(d=>new Option(`${d.label} · ${d.width} × ${d.height}`,d.id)));select.value=s.selectedId;select.disabled=s.state==='agent';
 const target=$('#window');if(target){target.replaceChildren(new Option('Active window (shared mouse and keyboard)',''),...(s.windows||[]).map(w=>new Option(w.title,w.id)));target.value=s.selectedWindowId||'';target.disabled=s.state==='agent';target.parentElement.hidden=s.platform!=='win32';}
 $('#grant').disabled=!s.capabilities?.input||!s.capabilities?.structuredObservation||!s.shortcutReady||s.state==='agent';
 $('#capability').textContent=s.capabilities?.input?(s.capabilities.structuredObservation?'Mouse, keyboard and readable app controls are available.':s.capabilities.observationReason):s.capabilities?.inputReason||'Checking desktop capabilities…';
};
const renderLink=s=>{
 linkState=s;const body=$('#link-body');
 if(!s.paired){
  const form=el('form',{id:'pair'});
  form.append(el('p',{textContent:'In Seek, open Settings › Computers and choose Add a computer to get a code.'}),
   el('label',{},'Seek address',el('input',{name:'server',value:'https://seek.joelcrobinson.com',autocomplete:'off',required:true})),
   el('label',{},'Pairing code',el('input',{name:'code',placeholder:'ABCD-EFGH',autocomplete:'off',required:true,maxLength:9,style:'text-transform:uppercase;letter-spacing:.08em'})),
   el('label',{},'Name for this computer',el('input',{name:'name',value:s.defaultName||'',placeholder:'e.g. Studio Mac',maxLength:60})),
   el('label',{className:'check'},el('input',{type:'checkbox',name:'remote',checked:true}),el('span',{textContent:'Let me approve Seek from my phone when I’m away. You can still stop it here any time.'})),
   el('button',{className:'primary',type:'submit',textContent:'Connect'}));
  form.onsubmit=e=>{e.preventDefault();const f=new FormData(form),btn=form.querySelector('button');btn.disabled=true;linkError(null);
   window.bridge.pair({server:f.get('server'),code:f.get('code'),name:f.get('name'),remoteGrant:f.get('remote')==='on'}).then(renderLink).catch(linkError).finally(()=>{btn.disabled=false;});};
  body.replaceChildren(form);
 }else{
  const remote=el('input',{type:'checkbox',checked:s.remoteGrant});remote.onchange=()=>window.bridge.setRemoteGrant(remote.checked).then(renderLink).catch(linkError);
  const out=el('button',{type:'button',textContent:'Disconnect from Seek'});out.onclick=()=>{if(confirm('Disconnect this computer from Seek? You can pair it again with a new code.'))window.bridge.unpair().then(renderLink).catch(linkError);};
  const start=el('input',{type:'checkbox'});window.bridge.loginItem().then(v=>{start.checked=v.openAtLogin;}).catch(()=>{start.disabled=true;});start.onchange=()=>window.bridge.setLoginItem(start.checked).catch(linkError);
  body.replaceChildren(el('p',{},el('span',{className:'dot'+(s.online?' on':'')}),`${s.online?'Connected':'Reconnecting'} to ${new URL(s.server).host} as `,el('b',{textContent:s.name})),
   el('label',{className:'check'},remote,el('span',{textContent:'Let me approve Seek from my phone when I’m away'})),
   el('label',{className:'check'},start,el('span',{textContent:'Start Seek Desktop with this computer (stays hidden until Seek needs it)'})),out);
 }
 linkError(s.lastError?{message:s.lastError}:null);
 const list=$('#request-list');$('#requests').hidden=!s.requests?.length;
 list.replaceChildren(...(s.requests||[]).map(r=>{const allow=el('button',{className:'primary',type:'button',textContent:'Allow'}),deny=el('button',{type:'button',textContent:'Not now'});
  allow.onclick=()=>window.bridge.answer(r.taskId,true).then(renderLink).catch(linkError);deny.onclick=()=>window.bridge.answer(r.taskId,false).then(renderLink).catch(linkError);
  return el('div',{className:'request'},el('strong',{textContent:r.title}),el('span',{className:'small',textContent:r.stale?'Waiting for the connection to Seek…':'Seek asked just now'}),el('div',{className:'row'},allow,deny));}));
};
window.bridge.onState(render);window.bridge.onLink(renderLink);
window.bridge.status().then(render).catch(error);window.bridge.linkStatus().then(renderLink).catch(linkError);
$('#grant').onclick=()=>window.bridge.grant($('#task').value).then(render).catch(error);
$('#stop').onclick=()=>window.bridge.stop().then(render).catch(error);
$('#display').onchange=e=>window.bridge.selectDisplay(e.target.value).then(render).catch(error);
$('#show-pet').onclick=()=>window.bridge.showPet().catch(error);
const refresh=el('button',{type:'button',textContent:'Check permissions again'});refresh.onclick=()=>window.bridge.refreshCapabilities().then(render).catch(error);$('#capability').after(refresh);
const targetLabel=el('label',{},'Application window');const target=el('select',{id:'window'});targetLabel.append(target);$('#window-slot').append(targetLabel);target.onchange=()=>window.bridge.selectWindow(target.value||null).then(render).catch(error);
const refreshWindows=el('button',{type:'button',textContent:'Refresh application windows'});refreshWindows.onclick=()=>window.bridge.listWindows().then(render).catch(error);targetLabel.append(refreshWindows);
setInterval(()=>{if(latest)window.SeekBuddy.hold(latest.activity==='Typing'?'type':latest.state==='agent'?'think':'idle',1500);},1000);
