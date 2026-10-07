import {app,BrowserWindow,ipcMain,globalShortcut,desktopCapturer,screen,systemPreferences,powerMonitor,session as electronSession,safeStorage,Notification} from 'electron';
import WebSocket from 'ws';
import {hostname} from 'node:os';
import {randomBytes} from 'node:crypto';
import {writeFile,mkdir,rm,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DesktopSession} from './session.js';
import {NativeInput} from './native.js';
import {platformCapabilities,hasXdotool,hasAtspi} from './platform.js';
import {createBridgeService} from './service.js';
import {DesktopBridgeClient} from './client.js';
import {DesktopAgent} from './agent.js';
import {SeekLink} from './link.js';

const root=dirname(fileURLToPath(import.meta.url));
const inputSmoke=process.argv.includes('--smoke-input');
const smoke=process.argv.includes('--smoke')||inputSmoke;
if(inputSmoke)app.commandLine.appendSwitch('force-renderer-accessibility');
if(smoke)app.setPath('userData',join(app.getPath('temp'),'seek-bridge-smoke-'+process.pid));
let link=null;
let panel,pet,cursor,server,selectedId,selectedWindowId=null,windows=[],credentialPath,shortcutReady=false,capabilities,quitting=false;
const token=randomBytes(32).toString('hex');
const helperPath=app.isPackaged?join(process.resourcesPath,'native','seek-input'):join(root,'..','native','seek-input');
const native=new NativeInput({helperPath});
function displays(){return screen.getAllDisplays().map(d=>({id:String(d.id),label:d.label||`Display ${d.id}`,...d.bounds,scaleFactor:d.scaleFactor}));}
function selected(){const d=displays().find(d=>d.id===selectedId);if(!d)throw Error('Selected display disconnected');return d;}
const control=new DesktopSession({onState:s=>{
  const full={...s,capabilities,displays:app.isReady()?displays():[],selectedId,selectedWindowId,windows,shortcutReady};
  for(const w of [panel,pet,cursor])if(w&&!w.isDestroyed())w.webContents.send('state',full);
  link?.sendState(s);
  if(cursor&&!cursor.isDestroyed()){
    if(s.cursor&&s.state==='agent'){cursor.setPosition(s.cursor.x-3,s.cursor.y-3);cursor.showInactive();}
    else cursor.hide();
  }
}});
function stop(reason='You have control'){native.stop();control.revoke(reason);}
function status(){return {...control.snapshot(),platform:process.platform,capabilities,display:selected(),displays:displays(),selectedId,selectedWindowId,windows,shortcutReady,endpoint:server?.address()?`http://127.0.0.1:${server.address().port}`:null};}
async function capture(){
  const display=selected();
  if(['win32','darwin','linux'].includes(process.platform)){
    const {view}=await native.execute({kind:'inspect',...(process.platform==='win32'?{selectedWindowId}:{})});
    const elements=view.elements.map(e=>{
      if(process.platform!=='win32')return {...e,x:e.x-display.x,y:e.y-display.y};
      const top=screen.screenToDipPoint({x:Math.round(e.x),y:Math.round(e.y)}),bottom=screen.screenToDipPoint({x:Math.round(e.x+e.width),y:Math.round(e.y+e.height)});return {...e,x:top.x-display.x,y:top.y-display.y,width:bottom.x-top.x,height:bottom.y-top.y};
    });
    return {display,windowId:view.windowId,title:view.title,elements,truncated:view.truncated,mode:'accessibility'};
  }
  throw Error('Structured desktop observations are not implemented on this OS yet; this model cannot use screenshots');
}
async function captureScreen(){
  const display=selected();
  if(process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('screen')==='denied')throw Error('Enable Screen Recording for Seek Desktop in System Settings');
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.width*display.scaleFactor),height:Math.round(display.height*display.scaleFactor)}});
  const source=sources.find(s=>s.display_id===display.id)||(sources.length===1?sources[0]:null);
  if(!source||source.thumbnail.isEmpty())throw Error('Screen capture is unavailable; check OS permissions');
  const size=source.thumbnail.getSize();return {display,image:source.thumbnail.toDataURL(),imageWidth:size.width,imageHeight:size.height};
}
function protect(w){
  w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  w.webContents.on('will-navigate',e=>e.preventDefault());
  w.webContents.on('render-process-gone',()=>stop('Companion interrupted'));
}
function requirePanel(event){if(event.sender!==panel?.webContents||event.senderFrame!==panel.webContents.mainFrame)throw Error('Only the local control panel may grant desktop access');}

if(!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(async()=>{
  const d=screen.getPrimaryDisplay();selectedId=String(d.id);
  const macHelper=await access(helperPath).then(()=>true,()=>false);
  const refreshCapabilities=async()=>{
    let accessibility=process.platform==='darwin'&&systemPreferences.isTrustedAccessibilityClient(false);
    if(process.platform==='darwin'&&macHelper){try{accessibility=(await native.execute({kind:'probe'})).accessibility;}catch{accessibility=false;}}
    capabilities=platformCapabilities({accessibility,macHelper,xdotool:hasXdotool(),atspi:hasAtspi()});
    control.emit();return status();
  };
  await refreshCapabilities();
  electronSession.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  const opts={webPreferences:{preload:join(root,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}};
  panel=new BrowserWindow({width:480,height:760,show:!smoke,...opts});
  pet=new BrowserWindow({width:185,height:160,transparent:true,frame:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,focusable:false,show:!smoke,...opts});
  // Only the small grip accepts clicks; the character itself forwards clicks to the desktop.
  pet.setIgnoreMouseEvents(true,{forward:true});
  pet.setPosition(d.workArea.x+d.workArea.width-205,d.workArea.y+d.workArea.height-180);
  cursor=new BrowserWindow({width:40,height:40,transparent:true,frame:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,focusable:false,show:false,...opts});
  cursor.setIgnoreMouseEvents(true);for(const w of [panel,pet,cursor])protect(w);
  ipcMain.handle('status',()=>status());
  ipcMain.handle('list-windows',async event=>{requirePanel(event);if(control.state==='agent')throw Error('Take control before changing window targets');if(process.platform==='win32')windows=(await native.execute({kind:'windows'})).windows;control.emit();return status();});
  ipcMain.handle('select-window',(event,id)=>{requirePanel(event);if(control.state==='agent')throw Error('Take control before changing window targets');if(id!==null&&!windows.some(w=>w.id===id))throw Error('Unknown window');selectedWindowId=id;control.emit();return status();});
  ipcMain.handle('refresh-capabilities',async event=>{requirePanel(event);if(control.state==='agent')throw Error('Take control before refreshing permissions');return refreshCapabilities();});
  const grantTask=(task,title='')=>{
    if(!shortcutReady)throw Error('Local takeover shortcut unavailable; control is disabled');
    if(!capabilities.input)throw Error(capabilities.inputReason);
    if(!capabilities.structuredObservation)throw Error('Qwen requires structured observations; this OS reader is not implemented yet');
    if(process.platform==='linux'&&selected().scaleFactor!==1)throw Error('Linux X11 control currently requires 100% display scaling');
    selected();const granted={...control.grant(task),...status()};
    if(!pet.isVisible())pet.showInactive();if(!panel.isMinimized())panel.minimize();
    if(title&&Notification.isSupported())new Notification({title:'Seek is using this computer',body:`${title.slice(0,120)} · Press Ctrl+Alt+Shift+S to take over.`,silent:true}).show();
    return granted;
  };
  ipcMain.handle('grant',(event,task)=>{requirePanel(event);return grantTask(task);});
  // Pairing with Seek (Settings › Computers) and requests that arrive over the link.
  const keyStore=safeStorage.isEncryptionAvailable()?{encrypt:s=>safeStorage.encryptString(s).toString('base64'),decrypt:s=>safeStorage.decryptString(Buffer.from(s,'base64'))}:{encrypt:s=>s,decrypt:s=>s};
  link=new SeekLink({file:join(app.getPath('userData'),'seek-link.json'),...keyStore,WebSocketImpl:WebSocket,
    info:()=>({name:hostname(),os:process.platform,arch:process.arch,version:app.getVersion()}),
    localRequest:async(method,path,body)=>{const r=await fetch(status().endpoint+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});return {status:r.status,body:await r.json()};},
    grant:(task,title)=>grantTask(task,title),
    onChange:s=>{for(const w of [panel,pet])if(w&&!w.isDestroyed())w.webContents.send('link',s);if(s.requests.length&&panel&&!panel.isDestroyed()&&control.state!=='agent'){if(panel.isMinimized())panel.restore();panel.showInactive();}},
    log:m=>console.warn(m)});
  ipcMain.handle('link-status',()=>link.status());
  ipcMain.handle('link-pair',(event,input)=>{requirePanel(event);return link.pair(input||{});});
  ipcMain.handle('link-unpair',event=>{requirePanel(event);return link.unpair();});
  ipcMain.handle('link-remote-grant',(event,value)=>{requirePanel(event);return link.setRemoteGrant(!!value);});
  ipcMain.handle('link-answer',(event,{taskId,allow}={})=>{requirePanel(event);return link.answer(String(taskId||''),!!allow);});
  ipcMain.handle('select-display',(event,id)=>{requirePanel(event);if(control.state==='agent')throw Error('Take control before changing displays');if(!displays().some(d=>d.id===id))throw Error('Unknown display');selectedId=id;control.emit();return status();});
  ipcMain.handle('stop',()=>{stop();return status();});
  ipcMain.handle('pet-interactive',(event,value)=>{if(event.sender===pet.webContents)pet.setIgnoreMouseEvents(!value,{forward:true});});
  ipcMain.handle('pet-move',(event,delta)=>{if(event.sender!==pet.webContents||!Number.isFinite(delta?.x)||!Number.isFinite(delta?.y))return;const [x,y]=pet.getPosition();pet.setPosition(x+Math.max(-200,Math.min(200,Math.round(delta.x))),y+Math.max(-200,Math.min(200,Math.round(delta.y))));});
  ipcMain.handle('pet-hide',()=>{pet.hide();});
  ipcMain.handle('pet-show',(event)=>{requirePanel(event);pet.showInactive();});
  server=createBridgeService({session:control,native,token,status,capture,stop,toNative:c=>{
    if(process.platform==='win32'&&c.x!==undefined){const p=screen.dipToScreenPoint({x:c.x,y:c.y});return {...c,x:p.x,y:p.y};}return c;
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  credentialPath=join(app.getPath('userData'),'agent-connection.json');await mkdir(dirname(credentialPath),{recursive:true});await writeFile(credentialPath,JSON.stringify({endpoint:status().endpoint,token}),{mode:0o600});
  await panel.loadFile(join(root,'panel.html'));await pet.loadFile(join(root,'pet.html'));await cursor.loadFile(join(root,'cursor.html'));
  shortcutReady=globalShortcut.register('CommandOrControl+Alt+Shift+S',()=>stop('Local takeover'));
  if(!smoke)void link.load();
  if(!shortcutReady)stop('Takeover shortcut unavailable');else control.emit();
  powerMonitor.on('suspend',()=>stop('Computer sleeping'));powerMonitor.on('lock-screen',()=>stop('Computer locked'));
  screen.on('display-removed',()=>stop('Display configuration changed'));screen.on('display-metrics-changed',()=>stop('Display configuration changed'));
  panel.on('close',()=>app.quit());
  setInterval(()=>{if(control.state==='agent'&&Date.now()>=control.expiresAt)stop('Connection expired');},250).unref();
  if(smoke){
    try{
      const errors=[];panel.webContents.on('console-message',(_e,_level,message)=>{if(/error/i.test(message))errors.push(message);});
      const title=await panel.webContents.executeJavaScript('document.title');
      const mounted=await panel.webContents.executeJavaScript("!!document.querySelector('.buddy svg')");
      const visibleStop=await pet.webContents.executeJavaScript("(()=>{const r=document.querySelector('#stop').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()");
      const texture=await panel.webContents.executeJavaScript("new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0);image.onerror=()=>resolve(false);image.src='./plush.webp';})");
      const response=await fetch(status().endpoint+'/status',{headers:{Authorization:'Bearer '+token}});
      const blocked=await fetch(status().endpoint+'/status');
      if(title!=='Seek Desktop'||!mounted||!texture||!visibleStop||response.status!==200||blocked.status!==403)throw Error('Packaged app smoke checks failed: '+JSON.stringify({title,mounted,texture,visibleStop,status:response.status,blocked:blocked.status}));
      await native.execute({kind:'probe'});
      if(inputSmoke){
        app.setAccessibilitySupportEnabled(true);
        const fixture=new BrowserWindow({width:650,height:450,show:true,...opts});protect(fixture);
        await fixture.loadFile(join(root,'fixture.html'));
        // Windows targets the fixture window directly; the Linux reader observes the focused window.
        if(process.platform==='linux'){fixture.show();fixture.focus();}else fixture.showInactive();
        if(process.platform==='win32')selectedWindowId=fixture.getNativeWindowHandle().readBigUInt64LE().toString();
        let observed,lastError=null;
        for(let attempt=0;attempt<25;attempt++){
          try{observed=await capture();lastError=null;if(observed.title==='Seek Bridge Fixture'&&observed.elements.some(e=>e.canFill))break;}catch(e){lastError=e.message;}
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        if(observed?.title!=='Seek Bridge Fixture'||!observed.elements.some(e=>e.canFill))throw Error('Own accessibility fixture is unavailable: '+JSON.stringify({error:lastError,title:observed?.title,count:observed?.elements?.length,controls:observed?.title==='Seek Bridge Fixture'?observed.elements.map(e=>({role:e.role,name:e.name,canFill:e.canFill})):undefined}));
        const taskId='smoke-'+process.pid;control.grant(taskId);
        const agent=new DesktopAgent({taskId,client:new DesktopBridgeClient({endpoint:status().endpoint,token})});
        try{
          await agent.attach();await agent.find('Bridge smoke field');
          const field=[...agent.refs].find(([_ref,id])=>agent.frame.elements.some(e=>e.id===id&&e.canFill));
          if(!field)throw Error('Accessible editable fixture field missing');
          await agent.act('fill',{ref:field[0],text:'Qwen smoke ✓'});
          if(await fixture.webContents.executeJavaScript("document.querySelector('#field').value")!=='Qwen smoke ✓')throw Error('Native fill did not reach the own fixture');
          await agent.find('Apply fixture');
          const button=[...agent.refs].find(([_ref,id])=>agent.frame.elements.some(e=>e.id===id&&e.canInvoke));
          if(!button)throw Error('Accessible fixture action missing');
          await agent.act('invoke',{ref:button[0]});
          if(await fixture.webContents.executeJavaScript("document.querySelector('#receipt').textContent")!=='Applied: Qwen smoke ✓')throw Error('Native invoke did not reach the own fixture');
          console.log('SEEK_BRIDGE_INPUT_SMOKE_OK '+JSON.stringify({platform:process.platform,structuredObservation:true,fill:true,invoke:true}));
        }finally{agent.close();stop('Smoke finished');fixture.destroy();}
      }
      if(process.env.SEEK_BRIDGE_SMOKE_OUTPUT){await mkdir(process.env.SEEK_BRIDGE_SMOKE_OUTPUT,{recursive:true});try{await writeFile(join(process.env.SEEK_BRIDGE_SMOKE_OUTPUT,'panel.png'),(await panel.webContents.capturePage()).toPNG());await writeFile(join(process.env.SEEK_BRIDGE_SMOKE_OUTPUT,'companion.png'),(await pet.webContents.capturePage()).toPNG());}catch(e){console.warn('Smoke screenshots unavailable on this display: '+e.message);}}
      console.log('SEEK_BRIDGE_SMOKE_OK '+JSON.stringify({platform:process.platform,character:mounted,api:true,nativeProbe:process.platform==='win32'}));
      native.stop();server.close();await rm(credentialPath,{force:true});app.exit(0);
    }catch(e){console.error(e);native.stop();server?.close();if(credentialPath)await rm(credentialPath,{force:true});app.exit(1);}
  }else console.log('Seek Desktop bridge ready; agent credentials: '+credentialPath);
}).catch(e=>{console.error(e.message);app.exit(1);});
app.on('before-quit',()=>{
  if(quitting)return;quitting=true;stop('Bridge stopped');globalShortcut.unregisterAll();link?.close();server?.close();
  if(credentialPath)void rm(credentialPath,{force:true});
});
