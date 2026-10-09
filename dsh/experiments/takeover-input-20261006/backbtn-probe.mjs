// Which event cancellation stops Chrome's mouse Back button from navigating the top page, when pressed over a same-origin iframe?
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {CdpBrowser}=await import('file:///C:/Users/Joel%20Robinson/seek-stack/dsh/plugins/browser-viewer/lib/cdp.js');
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url.startsWith('/frame'))res.end('<body style="margin:0;height:100vh">frame</body>');else res.end('<iframe src="/frame" style="width:400px;height:300px;border:0"></iframe>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const b=new CdpBrowser({headless:true,userDataDir:await mkdtemp(join(tmpdir(),'seek-backbtn-'))});await b.launch();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
for(const mode of ['none','pointerdown','mousedown+mouseup','mouseup','pointerup','all']){
  const tab=await b.newTab(base+'/first');const s=b.tabs.get(tab);await b.navigate(tab,base+'/second');await wait(300);
  await b.evaluate(tab,`(()=>{const d=document.querySelector('iframe').contentDocument,m=${JSON.stringify(mode)},stop=e=>{if(e.button===3){e.preventDefault();}};
    const on=t=>d.addEventListener(t,stop,true);if(m==='pointerdown')on('pointerdown');if(m==='mousedown+mouseup'){on('mousedown');on('mouseup');}if(m==='mouseup')on('mouseup');if(m==='pointerup')on('pointerup');if(m==='all')['pointerdown','pointerup','mousedown','mouseup','auxclick'].forEach(on);})()`);
  for(const type of ['mousePressed','mouseReleased'])await b.send('Input.dispatchMouseEvent',{type,x:100,y:100,button:'back',buttons:type==='mousePressed'?8:0,clickCount:1},s);
  await wait(800);console.log(mode.padEnd(18),'->',await b.evaluate(tab,'location.pathname'));await b.closeTab(tab);
}
await b.close();server.close();
