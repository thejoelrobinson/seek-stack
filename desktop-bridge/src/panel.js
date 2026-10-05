import './buddy.js';
let latest;
const render=s=>{
 latest=s;document.querySelector('#activity').textContent=s.activity;window.SeekBuddy.hold(s.activity==='Typing'?'type':s.state==='agent'?'think':'idle',1500);
 document.querySelector('#details').textContent=JSON.stringify(s,null,2);
 const select=document.querySelector('#display');select.replaceChildren(...(s.displays||[]).map(d=>{const o=document.createElement('option');o.value=d.id;o.textContent=`${d.label} · ${d.width} × ${d.height}`;return o;}));select.value=s.selectedId;select.disabled=s.state==='agent';
 const target=document.querySelector('#window');if(target){target.replaceChildren(new Option('Active window (shared mouse / keyboard)',''),...(s.windows||[]).map(w=>new Option(w.title,w.id)));target.value=s.selectedWindowId||'';target.disabled=s.state==='agent';target.parentElement.hidden=s.platform!=='win32'&&!s.windows?.length;}
 document.querySelector('#grant').disabled=!s.capabilities?.input||!s.capabilities?.structuredObservation||!s.shortcutReady||s.state==='agent';
 document.querySelector('#capability').textContent=s.capabilities?.input?(s.capabilities.structuredObservation?'Desktop input and text observations are available':s.capabilities.observationReason):s.capabilities?.inputReason||'Checking desktop capabilities…';
};
const error=e=>{document.querySelector('#activity').textContent=e.message;};
window.bridge.onState(render);window.bridge.status().then(render).catch(error);
document.querySelector('#grant').onclick=()=>window.bridge.grant(document.querySelector('#task').value).then(render).catch(error);
document.querySelector('#stop').onclick=()=>window.bridge.stop().then(render).catch(error);
document.querySelector('#display').onchange=e=>window.bridge.selectDisplay(e.target.value).then(render).catch(error);
document.querySelector('#show-pet').onclick=()=>window.bridge.showPet().catch(error);
const refresh=document.createElement('button');refresh.textContent='Check permissions again';refresh.onclick=()=>window.bridge.refreshCapabilities().then(render).catch(error);document.querySelector('#capability').after(refresh);
const targetLabel=document.createElement('label');targetLabel.textContent='Application window';const target=document.createElement('select');target.id='window';targetLabel.append(target);document.querySelector('#display').parentElement.after(targetLabel);target.onchange=()=>window.bridge.selectWindow(target.value||null).then(render).catch(error);window.bridge.listWindows().then(render).catch(error);
const refreshWindows=document.createElement('button');refreshWindows.textContent='Refresh application windows';refreshWindows.onclick=()=>window.bridge.listWindows().then(render).catch(error);targetLabel.append(refreshWindows);
setInterval(()=>{if(latest)window.SeekBuddy.hold(latest.activity==='Typing'?'type':latest.state==='agent'?'think':'idle',1500);},1000);
