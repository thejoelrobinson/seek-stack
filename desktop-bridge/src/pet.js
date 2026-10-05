import './buddy.js';let latest,drag;
const render=s=>{latest=s;document.querySelector('#label').textContent=s.activity;window.SeekBuddy.hold(s.activity==='Typing'?'type':s.state==='agent'?'think':'idle',1500);};
window.bridge.onState(render);window.bridge.status().then(render);setInterval(()=>{if(latest)render(latest);},1000);
const controls=document.querySelector('.controls');
controls.onpointerenter=()=>window.bridge.interactive(true);controls.onpointerleave=()=>{if(!drag)window.bridge.interactive(false);};
document.querySelector('#stop').onclick=()=>window.bridge.stop();document.querySelector('#hide').onclick=()=>window.bridge.hidePet();
const grip=document.querySelector('#grip');grip.onpointerdown=e=>{drag={x:e.screenX,y:e.screenY};grip.setPointerCapture(e.pointerId);};
grip.onpointermove=e=>{if(!drag)return;window.bridge.movePet({x:e.screenX-drag.x,y:e.screenY-drag.y});drag={x:e.screenX,y:e.screenY};};
grip.onpointerup=()=>{drag=null;window.bridge.interactive(false);};grip.onpointercancel=grip.onpointerup;
