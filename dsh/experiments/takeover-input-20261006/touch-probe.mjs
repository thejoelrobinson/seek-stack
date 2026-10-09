// Does a dispatchTouchEvent swipe scroll a page (and a same-origin iframe) in this headless Chrome?
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {CdpBrowser}=await import('file:///C:/Users/Joel%20Robinson/seek-stack/dsh/plugins/browser-viewer/lib/cdp.js');
const b=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-touch-probe-'))});await b.launch();
const tab=await b.newTab('about:blank'),s=b.tabs.get(tab),wait=ms=>new Promise(r=>setTimeout(r,ms));
await b.send('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:3,mobile:true},s);await b.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},s);
await b.evaluate(tab,`document.body.innerHTML='<div style="height:3000px;background:linear-gradient(#fff,#000)">x</div>';document.body.style.margin=0;`);
const swipe=async(a,c,steps,gap)=>{await b.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]},s);for(let i=1;i<=steps;i++){await b.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+(c.x-a.x)*i/steps,y:a.y+(c.y-a.y)*i/steps}]},s);await wait(gap);}await b.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},s);};
await swipe({x:200,y:600},{x:200,y:250},8,16);await wait(800);console.log('page touch swipe scrollY',await b.evaluate(tab,'scrollY'));
await b.evaluate(tab,'scrollTo(0,0)');await b.send('Input.synthesizeScrollGesture',{x:200,y:600,yDistance:-350,gestureSourceType:'touch'},s);await wait(300);console.log('synthesizeScrollGesture scrollY',await b.evaluate(tab,'scrollY'));
await b.close();
