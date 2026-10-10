import {app,BrowserWindow,ipcMain,globalShortcut,desktopCapturer,screen,systemPreferences,powerMonitor,session as electronSession,safeStorage,Notification,net,shell} from 'electron';
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
import {Companion} from './companion.js';
import {linkOptions} from './net.js';
import {createSecurePeer} from './secure-link.js';
import {parseInvitation} from './pairing.js';
import {UpdateChecker} from './updates.js';

const root=dirname(fileURLToPath(import.meta.url));
const inputSmoke=process.argv.includes('--smoke-input');
const smoke=process.argv.includes('--smoke')||inputSmoke;
// Started with the computer: stay out of sight until Seek asks for or uses this computer.
const atLogin=process.argv.includes('--login')||(process.platform==='darwin'&&app.getLoginItemSettings().wasOpenedAtLogin);
if(inputSmoke)app.commandLine.appendSwitch('force-renderer-accessibility');
if(smoke)app.setPath('userData',join(app.getPath('temp'),'seek-bridge-smoke-'+process.pid));
let link=null;
let chat,companion,showCompanion=()=>{};
let panel,pet,cursor,server,selectedId,selectedWindowId=null,windows=[],credentialPath,shortcutReady=false,capabilities,quitting=false;
const token=randomBytes(32).toString('hex');
const helperPath=app.isPackaged?join(process.resourcesPath,'native','seek-input'):join(root,'..','native','seek-input');
const native=new NativeInput({helperPath});
function displays(){return screen.getAllDisplays().map(d=>({id:String(d.id),label:d.label||`Display ${d.id}`,...d.bounds,scaleFactor:d.scaleFactor}));}
function selected(){const d=displays().find(d=>d.id===selectedId);if(!d)throw Error('Selected display disconnected');return d;}
const control=new DesktopSession({onState:s=>{
  const full={...s,capabilities,displays:app.isReady()?displays():[],selectedId,selectedWindowId,windows,shortcutReady};
  for(const w of [panel,pet,cursor,chat])if(w&&!w.isDestroyed())w.webContents.send('state',full);
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
    return {display,windowId:view.windowId,title:view.title,elements,truncated:view.truncated,mode:'accessibility',...(view.diagnostic?{diagnostic:view.diagnostic}:{})};
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
function requireChat(event){if(event.sender!==chat?.webContents||event.senderFrame!==chat.webContents.mainFrame)throw Error('Only your local companion may start or continue tasks.');}

let pendingInvitation=null;
function presentInvitation(value){
  try{parseInvitation(value);}catch{return;}
  pendingInvitation=value;
  if(panel&&!panel.isDestroyed()){
    if(panel.isMinimized())panel.restore();panel.show();panel.focus();panel.webContents.send('invitation',value);
  }
}
app.on('open-url',(event,value)=>{event.preventDefault();presentInvitation(value);});
app.on('second-instance',(_event,args)=>{const value=args.find(s=>s.startsWith('seek-desktop://'));if(value)presentInvitation(value);else showCompanion();});
app.on('activate',()=>showCompanion());
const initialInvitation=process.argv.find(s=>s.startsWith('seek-desktop://'));if(initialInvitation)presentInvitation(initialInvitation);
if(!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(async()=>{
  if(app.isPackaged&&!smoke)app.setAsDefaultProtocolClient('seek-desktop');
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
  panel=new BrowserWindow({width:480,height:760,show:!smoke&&!!pendingInvitation,...opts});
  pet=new BrowserWindow({width:185,height:172,transparent:true,frame:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,focusable:false,show:!smoke,...opts});
  chat=new BrowserWindow({width:410,height:590,minWidth:320,minHeight:400,frame:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,show:false,backgroundColor:'#fcfaf7',...opts});
  const placeChat=()=>{const p=pet.getBounds(),a=screen.getDisplayMatching(p).workArea,w=Math.min(410,a.width-24),h=Math.min(590,a.height-100);chat.setBounds({width:w,height:h,x:Math.max(a.x+12,Math.min(a.x+a.width-w-12,p.x+p.width-w)),y:Math.max(a.y+12,Math.min(a.y+a.height-h-12,p.y-h-8))});};
  showCompanion=()=>{const id=control.taskId;if(control.state==='agent'){stop('Paused while you chat');const task=companion?.data.tasks.find(t=>t.id===id);if(task&&['running','queued'].includes(task.status))void companion.pause(id).catch(()=>{});}placeChat();pet.showInactive();chat.show();chat.focus();chat.webContents.send('companion-focus');void companion?.refresh().catch(()=>{});};
  // The mascot and its small controls accept clicks; empty space forwards them to the desktop.
  pet.setIgnoreMouseEvents(true,{forward:true});
  pet.setPosition(d.workArea.x+d.workArea.width-205,d.workArea.y+d.workArea.height-180);
  cursor=new BrowserWindow({width:40,height:40,transparent:true,frame:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,focusable:false,show:false,...opts});
  cursor.setIgnoreMouseEvents(true);for(const w of [panel,pet,cursor,chat])protect(w);
  ipcMain.handle('status',()=>status());
  const updates=new UpdateChecker({version:app.getVersion(),platform:process.platform,arch:process.arch,fetch:(url,options)=>net.fetch(url,options),onChange:s=>panel.webContents.send('updates',s)});
  ipcMain.handle('updates-status',event=>{requirePanel(event);return updates.state;});
  ipcMain.handle('updates-check',event=>{requirePanel(event);return updates.check(true);});
  ipcMain.handle('updates-open',async event=>{requirePanel(event);if(updates.state.state!=='available')throw Error('Check for an update first');await shell.openExternal(updates.state.url);});
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
  ipcMain.handle('quit',event=>{requirePanel(event);app.quit();});
  // Pairing with Seek (Settings › Computers) and requests that arrive over the link.
  const protectedStorage=safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');
  const unavailable=()=>{throw Error('Unlock your OS keychain before pairing. Seek will not save device keys without protected storage.');};
  const keyStore=protectedStorage?{encrypt:s=>safeStorage.encryptString(s).toString('base64'),decrypt:s=>safeStorage.decryptString(Buffer.from(s,'base64'))}:{encrypt:unavailable,decrypt:unavailable};
  link=new SeekLink({file:join(app.getPath('userData'),'seek-link.json'),...keyStore,WebSocketImpl:WebSocket,
    // Pairing uses Chromium's network stack; the link uses the same proxy and the system's certificates.
    fetchImpl:(url,options)=>net.fetch(url,options),prepare:url=>linkOptions(url,{resolveProxy:u=>electronSession.defaultSession.resolveProxy(u)}),
    info:()=>({name:hostname(),os:process.platform,arch:process.arch,version:app.getVersion()}),
    localRequest:async(method,path,body)=>{const r=await fetch(status().endpoint+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});return {status:r.status,body:await r.json()};},
    grant:(task,title)=>grantTask(task,title),
    onDisconnect:()=>{if(control.state==='agent')stop('Secure desktop connection lost');},
    onChange:s=>{for(const w of [panel,pet,chat])if(w&&!w.isDestroyed())w.webContents.send('link',s);if(s.online)void companion?.refresh().catch(()=>{});if(s.requests.length&&panel&&!panel.isDestroyed()&&control.state!=='agent'){if(panel.isMinimized())panel.restore();panel.showInactive();}},
    log:m=>console.warn(m)});
  companion=new Companion({link,session:control,grant:grantTask,stop,beforeGrant:()=>{chat.hide();panel.hide();},onChange:data=>{for(const w of [chat,pet,panel])if(w&&!w.isDestroyed())w.webContents.send('companion-data',data);}});
  ipcMain.handle('companion-data',event=>{requireChat(event);return companion.data;});
  ipcMain.handle('companion-select',(event,id)=>{requireChat(event);return companion.select(id);});
  ipcMain.handle('companion-submit',(event,input)=>{requireChat(event);return companion.submit(input||{});});
  ipcMain.handle('companion-reply',(event,input)=>{requireChat(event);return companion.reply(input||{});});
  ipcMain.handle('companion-resume',(event,id)=>{requireChat(event);return companion.resume(id);});
  ipcMain.handle('companion-pause',(event,id)=>{requireChat(event);return companion.pause(id);});
  ipcMain.handle('companion-hide',event=>{requireChat(event);chat.hide();});
  ipcMain.handle('companion-show',event=>{if(event.sender!==pet.webContents&&event.sender!==panel.webContents)return;showCompanion();});
  ipcMain.handle('companion-settings',event=>{requireChat(event);chat.hide();panel.restore();panel.show();panel.focus();});
  ipcMain.handle('companion-open',async(event,{id,browser=false}={})=>{requireChat(event);companion.task(id);if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw Error('Invalid conversation');const url=new URL('/work',link.config.server);url.searchParams.set('task',id);if(browser)url.searchParams.set('browser','view');await shell.openExternal(url.href);});
  // Start with the computer once paired, so Seek can reach it after a restart (Windows and macOS).
  const loginItem=()=>({openAtLogin:app.getLoginItemSettings({args:['--login']}).openAtLogin});
  ipcMain.handle('login-item',()=>loginItem());
  ipcMain.handle('set-login-item',(event,value)=>{requirePanel(event);app.setLoginItemSettings({openAtLogin:!!value,args:['--login']});return loginItem();});
  ipcMain.handle('link-status',()=>link.status());
  ipcMain.handle('link-invitation',event=>{requirePanel(event);return pendingInvitation;});
  ipcMain.handle('link-pair',async(event,input)=>{requirePanel(event);const s=await link.pair(input||{});pendingInvitation=null;if(app.isPackaged&&process.platform!=='linux')app.setLoginItemSettings({openAtLogin:true,args:['--login']});return s;});
  ipcMain.handle('link-unpair',event=>{requirePanel(event);return link.unpair();});
  ipcMain.handle('link-confirm',(event,code)=>{requirePanel(event);return link.confirm(code);});
  ipcMain.handle('link-remote-grant',(event,value)=>{requirePanel(event);return link.setRemoteGrant(!!value);});
  ipcMain.handle('link-answer',(event,{taskId,allow}={})=>{requirePanel(event);return link.answer(String(taskId||''),!!allow);});
  ipcMain.handle('select-display',(event,id)=>{requirePanel(event);if(control.state==='agent')throw Error('Take control before changing displays');if(!displays().some(d=>d.id===id))throw Error('Unknown display');selectedId=id;control.emit();return status();});
  ipcMain.handle('stop',()=>{stop();return status();});
  ipcMain.handle('pet-interactive',(event,value)=>{if(event.sender===pet.webContents)pet.setIgnoreMouseEvents(!value,{forward:true});});
  ipcMain.handle('pet-move',(event,delta)=>{if(event.sender!==pet.webContents||!Number.isFinite(delta?.x)||!Number.isFinite(delta?.y))return;const [x,y]=pet.getPosition(),a=screen.getDisplayNearestPoint({x:x+Math.round(delta.x),y:y+Math.round(delta.y)}).workArea;pet.setPosition(Math.max(a.x,Math.min(a.x+a.width-185,x+Math.max(-200,Math.min(200,Math.round(delta.x))))),Math.max(a.y,Math.min(a.y+a.height-172,y+Math.max(-200,Math.min(200,Math.round(delta.y))))));if(chat.isVisible())placeChat();});
  ipcMain.handle('pet-hide',()=>{pet.hide();});
  ipcMain.handle('pet-show',(event)=>{requirePanel(event);pet.showInactive();});
  server=createBridgeService({session:control,native,token,status,capture,stop,toNative:c=>{
    if(process.platform==='win32'&&c.x!==undefined){const p=screen.dipToScreenPoint({x:c.x,y:c.y});return {...c,x:p.x,y:p.y};}return c;
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  credentialPath=join(app.getPath('userData'),'agent-connection.json');await mkdir(dirname(credentialPath),{recursive:true});await writeFile(credentialPath,JSON.stringify({endpoint:status().endpoint,token}),{mode:0o600});
  await panel.loadFile(join(root,'panel.html'));await pet.loadFile(join(root,'pet.html'));await cursor.loadFile(join(root,'cursor.html'));await chat.loadFile(join(root,'companion.html'));
  shortcutReady=globalShortcut.register('CommandOrControl+Alt+Shift+S',()=>stop('Local takeover'));
  globalShortcut.register('CommandOrControl+Shift+Space',()=>showCompanion());
  if(!smoke)void link.load();
  if(!smoke){void updates.check();setInterval(()=>void updates.check(),6*3600000).unref();}
  if(!shortcutReady)stop('Takeover shortcut unavailable');else control.emit();
  powerMonitor.on('suspend',()=>stop('Computer sleeping'));powerMonitor.on('lock-screen',()=>stop('Computer locked'));
  // macOS reports workArea-only changes for Dock, menu bar and full-screen Space switches; those
  // move no coordinates, so only geometry changes on the selected display revoke control.
  screen.on('display-removed',()=>stop('Display configuration changed'));screen.on('display-metrics-changed',(_e,display,changed)=>{if(String(display.id)===selectedId&&changed.some(m=>m!=='workArea'))stop('Display configuration changed');});
  panel.on('close',e=>{if(!quitting){e.preventDefault();panel.hide();}});
  chat.on('close',e=>{if(!quitting){e.preventDefault();chat.hide();}});
  setInterval(()=>{if(link.online)void companion.refresh().catch(()=>{});},2000).unref();
  if(!smoke&&!atLogin&&!pendingInvitation)showCompanion();
  setInterval(()=>{if(control.state==='agent'&&Date.now()>=control.expiresAt)stop('Connection expired');},250).unref();
  if(smoke){
    try{
      const errors=[];panel.webContents.on('console-message',(_e,_level,message)=>{if(/error/i.test(message))errors.push(message);});
      const title=await panel.webContents.executeJavaScript('document.title');
      const mounted=await panel.webContents.executeJavaScript("!!document.querySelector('.buddy svg')");
      const visibleStop=await pet.webContents.executeJavaScript("(()=>{const r=document.querySelector('#stop').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()");
      const texture=await panel.webContents.executeJavaScript("new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0);image.onerror=()=>resolve(false);image.src='./plush.webp';})");
      await pet.webContents.executeJavaScript("document.querySelector('#chat').click()");
      const chatDeadline=Date.now()+3000;while(!chat.isVisible()){if(Date.now()>chatDeadline)throw Error('Mascot click did not open chat');await new Promise(r=>setTimeout(r,20));}
      const companionUi=await chat.webContents.executeJavaScript("({title:document.title,modes:[...document.querySelectorAll('.modes button')].map(b=>b.textContent),input:!!document.querySelector('#input'),connection:!document.querySelector('#connect').hidden,stop:!!document.querySelector('#stop')})");
      if(companionUi.title!=='Seek companion'||companionUi.modes.join(',')!=='Chat,Browser,This computer'||!companionUi.input||!companionUi.connection||!companionUi.stop)throw Error('Companion chat smoke failed');
      if(process.env.SEEK_BRIDGE_SMOKE_OUTPUT){await mkdir(process.env.SEEK_BRIDGE_SMOKE_OUTPUT,{recursive:true});try{await writeFile(join(process.env.SEEK_BRIDGE_SMOKE_OUTPUT,'chat-welcome.png'),(await chat.webContents.capturePage()).toPNG());}catch(e){console.warn('Optional chat screenshot unavailable: '+e.message);}}
      // Synthetic renderer data only; this never sends a task to the user's Seek host.
      chat.webContents.send('link',{online:true,paired:true});
      const smokeData={name:'Seek',look:{color:'mint'},tasks:[{id:'smoke-conversation',mode:'browser',title:'Find a good weeknight dinner',status:'complete',messages:[{role:'user',text:'Find a quick vegetarian dinner.'},{role:'assistant',text:'A lemony chickpea skillet is a good fit. It takes about 20 minutes and uses ingredients you can keep in the pantry.\n\nI found the recipe and saved the ingredients in Seek.'}],artifacts:[{title:'Recipe & shopping list'}]}]};chat.webContents.send('companion-data',smokeData);
      companion.data=smokeData;const originalHostRequest=link.requestHost;link.requestHost=async()=>companion.data.tasks[0];
      await chat.webContents.executeJavaScript("document.querySelector('#recent').value='smoke-conversation';document.querySelector('#recent').dispatchEvent(new Event('change'))");
      await new Promise(r=>setTimeout(r,100));
      if(process.env.SEEK_BRIDGE_SMOKE_OUTPUT)try{await writeFile(join(process.env.SEEK_BRIDGE_SMOKE_OUTPUT,'chat-conversation.png'),(await chat.webContents.capturePage()).toPNG());}catch(e){console.warn('Optional chat screenshot unavailable: '+e.message);}
      link.requestHost=originalHostRequest;chat.hide();
      const response=await fetch(status().endpoint+'/status',{headers:{Authorization:'Bearer '+token}});
      const blocked=await fetch(status().endpoint+'/status');
      if(title!=='Seek Desktop'||!mounted||!texture||!visibleStop||response.status!==200||blocked.status!==403)throw Error('Packaged app smoke checks failed: '+JSON.stringify({title,mounted,texture,visibleStop,status:response.status,blocked:blocked.status}));
      await native.execute({kind:'probe'});
      // The packaged Electron Node runtime must run the actual DTLS/SCTP stack.
      // Exchange synthetic content only; do not capture a screen for this check.
      let rtcA,rtcB;
      try{
        let received;const arrived=new Promise(resolve=>{received=resolve;});
        const peerOptions={iceAdditionalHostAddresses:['127.0.0.1'],iceInterfaceAddresses:{udp4:'127.0.0.1'},iceUseIpv6:false};
        rtcA=await createSecurePeer({peerOptions,onMessage:()=>{}});
        rtcB=await createSecurePeer({peerOptions,onMessage:received});
        const offer=await rtcA.offer();await rtcA.accept(await rtcB.answer(offer));
        const deadline=Date.now()+10000;while(!rtcA.ready||!rtcB.ready){if(Date.now()>deadline)throw Error('Packaged WebRTC connection failed');await new Promise(r=>setTimeout(r,20));}
        rtcA.send({fixture:'Seek encrypted desktop smoke'});
        const message=await Promise.race([arrived,new Promise((_r,reject)=>setTimeout(()=>reject(Error('Packaged WebRTC data channel did not answer')),3000))]);
        if(message.fixture!=='Seek encrypted desktop smoke')throw Error('Packaged WebRTC data changed');
        for(const peer of [rtcA,rtcB])peer.pc.dtlsTransports[0].verifyRemoteCertificateFingerprint();
        console.log('SEEK_BRIDGE_WEBRTC_SMOKE_OK');
      }finally{rtcA?.close();rtcB?.close();}
      if(inputSmoke){
        app.setAccessibilitySupportEnabled(true);
        const fixture=new BrowserWindow({width:650,height:450,show:true,...opts});protect(fixture);
        await fixture.loadFile(join(root,'fixture.html'));
        // Windows targets the fixture window directly; the Linux reader observes the focused window.
        if(process.platform==='linux'){fixture.show();fixture.focus();}else fixture.showInactive();
        if(process.platform==='win32')selectedWindowId=fixture.getNativeWindowHandle().readBigUInt64LE().toString();
        let observed,lastError=null;
        for(let attempt=0;attempt<25;attempt++){
          if(process.platform==='linux'&&!fixture.isFocused())fixture.focus();
          try{observed=await capture();lastError=null;if(observed.title==='Seek Bridge Fixture'&&observed.elements.some(e=>e.canFill))break;}catch(e){lastError=e.message;}
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        if(observed?.title!=='Seek Bridge Fixture'||!observed.elements.some(e=>e.canFill))throw Error('Own accessibility fixture is unavailable: '+JSON.stringify({error:lastError,diagnostic:observed?.diagnostic,title:observed?.title,count:observed?.elements?.length,controls:observed?.title==='Seek Bridge Fixture'?observed.elements.filter(e=>e.debug||e.canFill||e.canInvoke).map(e=>({role:e.role,name:e.name,canFill:e.canFill,canInvoke:e.canInvoke,debug:e.debug})):undefined}));
        const taskId='smoke-'+process.pid;control.grant(taskId);
        const agent=new DesktopAgent({taskId,client:new DesktopBridgeClient({endpoint:status().endpoint,token})});
        try{
          console.log('smoke: fixture observed');await agent.attach();await agent.find('Bridge smoke field');console.log('smoke: field found');
          const field=[...agent.refs].find(([_ref,id])=>agent.frame.elements.some(e=>e.id===id&&e.canFill));
          if(!field)throw Error('Accessible editable fixture field missing');
          // Linux types the text with xdotool, which remaps the keyboard for non-ASCII characters.
          const smokeText=process.platform==='linux'?'Qwen smoke ok':'Qwen smoke ✓';
          await agent.act('fill',{ref:field[0],text:smokeText});console.log('smoke: fill sent');
          if(await fixture.webContents.executeJavaScript("document.querySelector('#field').value")!==smokeText)throw Error('Native fill did not reach the own fixture');
          await agent.find('Apply fixture');console.log('smoke: button found');
          const button=[...agent.refs].find(([_ref,id])=>agent.frame.elements.some(e=>e.id===id&&e.canInvoke));
          if(!button)throw Error('Accessible fixture action missing');
          await agent.act('invoke',{ref:button[0]});
          if(await fixture.webContents.executeJavaScript("document.querySelector('#receipt').textContent")!=='Applied: '+smokeText)throw Error('Native invoke did not reach the own fixture');
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
