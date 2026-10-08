import './buddy.js';let latest,drag,paired=false;
const render=s=>{latest=s;document.querySelector('#label').textContent=s.state==='agent'?'Seek is working · click to pause':paired?'Talk to Seek':'Connect to Seek';document.querySelector('#label').title=s.state==='agent'?s.activity:'Click to chat';document.querySelector('#stop').disabled=s.state!=='agent';window.SeekBuddy.hold(s.activity==='Typing'?'type':s.state==='agent'?'think':'idle',1500);};
window.bridge.onState(render);window.bridge.status().then(render);setInterval(()=>{if(latest)render(latest);},1000);
window.bridge.onLink(s=>{paired=s.online;if(latest)render(latest);});window.bridge.onCompanion(d=>window.SeekBuddy.setLook(d.look));
for(const target of document.querySelectorAll('.mascot,.label,.controls')){target.onpointerenter=()=>window.bridge.interactive(true);target.onpointerleave=()=>{if(!drag)window.bridge.interactive(false);};}
document.querySelector('#chat').onclick=document.querySelector('#label').onclick=()=>window.bridge.showCompanion();
document.querySelector('#stop').onclick=()=>window.bridge.stop();document.querySelector('#hide').onclick=()=>window.bridge.hidePet();
const grip=document.querySelector('#grip');grip.onpointerdown=e=>{drag={x:e.screenX,y:e.screenY};grip.setPointerCapture(e.pointerId);};
grip.onpointermove=e=>{if(!drag)return;window.bridge.movePet({x:e.screenX-drag.x,y:e.screenY-drag.y});drag={x:e.screenX,y:e.screenY};};
grip.onpointerup=()=>{drag=null;window.bridge.interactive(false);};grip.onpointercancel=grip.onpointerup;
