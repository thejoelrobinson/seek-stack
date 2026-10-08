// Computers paired with Seek through the Seek Desktop companion. Pairing trades a one-time code
// for a device key (stored here only as a scrypt hash; the proxy checks the same file). Each paired
// computer uses a signed WebSocket handshake to open an authenticated WebRTC data
// channel. Only that encrypted channel carries the bridge API and task content;
// the computer's sessions, leases, Stop and takeover shortcut all apply.
// A task gets a computer only after the user allows it: on that computer, or (if the computer
// opted in when pairing) by answering "Allow on <computer>" in Seek, the Inbox or Discord.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {DesktopBridgeClient} from './desktop/client.js';
import {DesktopAgent} from './desktop/agent.js';
import {identity,publicIdentity,verificationCode,signSignal,verifySignal,challenge,iceConfiguration,createSecurePeer} from './desktop/secure-link.js';
import {invitation,verifyInvitationRequest,signInvitationResult} from './desktop/pairing.js';

const SCRYPT={N:16384,r:8,p:1};
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OS_NAMES={win32:'Windows',darwin:'macOS',linux:'Linux'};
const clean=(s,n)=>String(s??'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,n);

export class DesktopDevices{
  constructor(root){this.root=root;this.file=join(root,'desktop-devices.json');this.verified=new Map();this.operations=Promise.resolve();}
  change(fn){const flight=this.operations.then(fn);this.operations=flight.catch(()=>{});return flight;}
  async identity(){
    if(this.identityFlight)return this.identityFlight;
    this.identityFlight=(async()=>{
      await mkdir(this.root,{recursive:true});const file=join(this.root,'desktop-identity.json');
      try{await writeFile(file,JSON.stringify(identity()),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
      const key=JSON.parse(await readFile(file,'utf8'));publicIdentity(key.publicKey);
      const proof=signSignal(key.privateKey,{deviceId:'identity-check',...challenge(),kind:'ready'});
      verifySignal(key.publicKey,proof,{deviceId:'identity-check',kind:'ready'});return key;
    })();return this.identityFlight;
  }
  async read(){try{const d=JSON.parse(await readFile(this.file,'utf8'));return Array.isArray(d.devices)?d:{version:1,devices:[]};}catch(e){if(e.code==='ENOENT')return {version:1,devices:[]};throw e;}}
  async write(d){await mkdir(this.root,{recursive:true});const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(d),{mode:0o600});await rename(tmp,this.file);this.verified.clear();}
  async list(){const host=await this.identity();return (await this.read()).devices.map(({salt,hash,...d})=>({...d,verificationCode:d.publicKey?verificationCode(d.id,d.publicKey,host.publicKey):null}));}
  async create({name,os,arch,version,remoteGrant,publicKey},{verified=false}={}){
    publicIdentity(publicKey);
    return this.change(async()=>{
    const d=await this.read();if(d.devices.length>=20)throw new Error('Remove a computer before pairing another (20 at most).');
    const secret=randomBytes(32).toString('hex'),salt=randomBytes(16);
    const device={id:randomUUID(),publicKey,verified,protocol:1,name:clean(name,60)||'Computer',os:OS_NAMES[os]?os:'unknown',arch:clean(arch,12),version:clean(version,20),remoteGrant:!!remoteGrant,created:Date.now(),salt:salt.toString('hex'),hash:scryptSync(secret,salt,32,SCRYPT).toString('hex')};
    d.devices.push(device);await this.write(d);return {device:(({salt,hash,...x})=>x)(device),secret};});
  }
  async update(id,patch){return this.change(async()=>{const d=await this.read(),dev=d.devices.find(x=>x.id===id);if(!dev)return null;Object.assign(dev,patch);await this.write(d);return dev;});}
  async remove(id){return this.change(async()=>{const d=await this.read(),before=d.devices.length;d.devices=d.devices.filter(x=>x.id!==id);if(d.devices.length===before)throw new Error('That computer is already removed.');await this.write(d);});}
  /** "id.secret" → device, or null. Verified keys are cached until the file changes. */
  async verify(token){
    const m=/^([0-9a-f-]{36})\.([a-f0-9]{64})$/.exec(String(token||''));if(!m)return null;
    const fingerprint=createHash('sha256').update(token).digest('hex'),devices=(await this.read()).devices,cached=this.verified.get(fingerprint);
    if(cached&&devices.some(d=>d.id===cached))return devices.find(d=>d.id===cached);
    const dev=devices.find(d=>d.id===m[1]);if(!dev)return null;
    const a=scryptSync(m[2],Buffer.from(dev.salt,'hex'),32,SCRYPT),b=Buffer.from(dev.hash,'hex');
    if(a.length!==b.length||!timingSafeEqual(a,b))return null;
    this.verified.set(fingerprint,dev.id);return dev;
  }
}

export class DesktopHub{
  constructor({devices,log=console,now=()=>Date.now(),peerFactory=createSecurePeer,ice=()=>iceConfiguration()}){Object.assign(this,{devices,log,now,peerFactory,ice});this.links=new Map();this.codes=new Map();this.invitations=new Map();this.failures=[];this.listeners=new Set();}
  on(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  emit(event){for(const fn of this.listeners)try{fn(event);}catch(e){this.log.warn?.('Desktop event: '+e.message);}}
  /** A single-use pairing code, valid for ten minutes. */
  createCode(){
    const bytes=randomBytes(8);let code='';for(const b of bytes)code+=CODE_ALPHABET[b%CODE_ALPHABET.length];
    for(const [c,exp] of this.codes)if(exp<this.now())this.codes.delete(c);
    this.codes.set(code,this.now()+10*60000);return {code:`${code.slice(0,4)}-${code.slice(4)}`,expiresAt:this.codes.get(code)};
  }
  async createInvitation(server){
    for(const [id,v] of this.invitations)if(v.expiresAt<this.now())this.invitations.delete(id);
    if(this.invitations.size>=50)throw Error('Too many connection links. Wait for older links to expire.');
    const host=await this.devices.identity(),v=invitation(server,host.publicKey,this.now());this.invitations.set(v.id,v);
    return {url:v.url,expiresAt:v.expiresAt,id:v.id};
  }
  async pair(body={}){
    if(body.protocol!==1)throw new Error('Install the WebRTC version of Seek Desktop before pairing.');
    publicIdentity(body.publicKey);
    const now=this.now();this.failures=this.failures.filter(t=>now-t<15*60000);
    if(this.failures.length>=10)throw new Error('Too many pairing attempts. Create a new code in Seek and try again in a few minutes.');
    if(body.invitationId){
      const v=this.invitations.get(body.invitationId);
      try{if(!v||v.expiresAt<now)throw Error('This connection link is invalid or expired');verifyInvitationRequest(v.token,body);}catch(e){this.failures.push(now);throw e;}
      // Consume synchronously before any I/O so concurrent replays cannot enroll twice.
      this.invitations.delete(v.id);
      const host=await this.devices.identity(),{device,secret}=await this.devices.create(body,{verified:true});
      this.emit({type:'paired',device});
      return signInvitationResult(host.privateKey,body,{deviceId:device.id,secret,name:device.name,hostKey:host.publicKey});
    }
    const code=String(body.code||'').toUpperCase().replace(/[^A-Z0-9]/g,''),exp=this.codes.get(code);
    if(!exp||exp<now){this.failures.push(now);throw new Error('That code is wrong or expired. Create a new one in Seek › Settings › Computers.');}
    this.codes.delete(code);
    const {device,secret}=await this.devices.create(body);this.emit({type:'paired',device});
    const host=await this.devices.identity();return {deviceId:device.id,secret,name:device.name,hostKey:host.publicKey};
  }
  /** Adopts an authenticated WebSocket from a paired computer. */
  attach(ws,device){
    if(!device.publicKey||!device.verified){ws.close(4003,'Verify the security code in Seek Settings');return;}
    const old=this.links.get(device.id);if(old)try{old.ws.close(4000,'Replaced by a newer connection');}catch{}
    const link={ws,device,info:{name:device.name,os:device.os,remoteGrant:device.remoteGrant},state:{state:'idle',taskId:null,activity:'Ready'},pending:new Map(),connectedAt:this.now(),seq:0};
    this.links.set(device.id,link);
    const ping=setInterval(()=>{try{ws.ping();}catch{}},25000);ping.unref?.();
    ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw));}catch{return;}this.receiveSignal(link,m);});
    ws.on('close',()=>{clearInterval(ping);link.peer?.close();for(const p of link.pending.values()){clearTimeout(p.timer);p.reject(new Error(`${link.info.name} disconnected`));}link.pending.clear();if(this.links.get(device.id)===link){this.links.delete(device.id);this.emit({type:'offline',id:device.id});}});
    ws.on('error',()=>{});
    void this.begin(link).catch(()=>ws.close(4003,'Secure connection unavailable'));
  }
  async begin(link){
    const device=(await this.devices.read()).devices.find(d=>d.id===link.device.id);
    if(!device?.verified||device.publicKey!==link.device.publicKey){link.ws.close(4401,'Removed from Seek');return;}
    const host=await this.devices.identity();if(this.links.get(link.device.id)!==link)return;
    link.host=host;link.challenge=challenge();link.ice=await this.ice({deviceId:link.device.id});
    if(this.links.get(link.device.id)!==link)return;
    link.ws.send(JSON.stringify(signSignal(host.privateKey,{...link.challenge,deviceId:link.device.id,kind:'ready',...link.ice})));
  }
  receiveSignal(link,m){
    if(this.links.get(link.device.id)!==link||m.type!=='rtc')return;
    void this.signal(link,m).catch(()=>link.ws.close(4003,'Secure connection verification failed'));
  }
  async signal(link,m){
    if(!link.challenge||link.negotiating)throw Error('Unexpected secure offer');
    verifySignal(link.device.publicKey,m,{deviceId:link.device.id,...link.challenge,kind:'offer'});link.negotiating=true;
    const peer=await this.peerFactory({...link.ice,
      onMessage:msg=>{if(this.links.get(link.device.id)===link&&link.ready)this.receive(link,msg);},
      onOpen:()=>{if(this.links.get(link.device.id)!==link)return;link.ready=true;this.emit({type:'online',id:link.device.id});},
      onClose:()=>{link.ready=false;link.ws.close(4003,'Secure connection ended');}});
    if(this.links.get(link.device.id)!==link){peer.close();return;}link.peer=peer;
    const answer=await peer.answer({type:'offer',sdp:m.sdp});if(this.links.get(link.device.id)!==link)return;
    link.ws.send(JSON.stringify(signSignal(link.host.privateKey,{...link.challenge,deviceId:link.device.id,deviceNonce:m.deviceNonce,kind:'answer',sdp:answer.sdp,...link.ice})));
  }
  receive(link,m){
    if(!m||typeof m!=='object')return;
    if(m.type==='companion-request'){
      if(!/^ui_[a-f0-9]{32}$/.test(m.id||'')||!['list','create','get','start','reply','pause','resume'].includes(m.method)||!m.body||typeof m.body!=='object'||Array.isArray(m.body)||JSON.stringify(m.body).length>12000)return;
      const reply=out=>{if(this.links.get(link.device.id)===link&&link.ready)this.send(link.device.id,{type:'companion-result',id:m.id,...out});};
      if((link.companionFlight||0)>=8){reply({ok:false,error:'Seek is busy. Try again shortly.'});return;}
      link.companionFlight=(link.companionFlight||0)+1;
      void Promise.resolve().then(()=>{if(!this.companionHandler)throw Error('Update Seek to use companion chat.');return this.companionHandler(link.device.id,link.state,m);})
        .then(result=>reply({ok:true,result}),e=>reply({ok:false,error:clean(e.message,500)})).finally(()=>link.companionFlight--);
      return;
    }
    if(m.type==='hello'){
      // The name chosen when pairing wins over the computer's host name.
      link.info={name:link.device.name||clean(m.name,60),os:OS_NAMES[m.os]?m.os:link.device.os,arch:clean(m.arch,12),version:clean(m.version,20),remoteGrant:!!m.remoteGrant};
      if(link.info.remoteGrant!==link.device.remoteGrant||link.info.version!==link.device.version)void this.devices.update(link.device.id,{remoteGrant:link.info.remoteGrant,version:link.info.version,arch:link.info.arch}).catch(()=>{});
      this.emit({type:'online',id:link.device.id});return;
    }
    if(m.type==='state'){const before=link.state.taskId;link.state={state:clean(m.state,20),taskId:m.taskId?clean(m.taskId,200):null,activity:clean(m.activity,120)};if(link.state.taskId!==before)this.emit({type:'state',id:link.device.id,state:link.state,previousTask:before});return;}
    if((m.type==='response'||m.type==='grant-result')&&link.pending.has(m.id)){const p=link.pending.get(m.id);link.pending.delete(m.id);clearTimeout(p.timer);p.resolve(m);return;}
    if(m.type==='answer')this.emit({type:'answer',id:link.device.id,name:link.info.name,taskId:clean(m.taskId,200),allowed:!!m.allowed});
  }
  call(id,msg,timeoutMs=12000){
    const link=this.links.get(id);if(!link?.ready)return Promise.reject(new Error('That computer is offline. Open Seek Desktop and verify its security code.'));
    if(link.pending.size>=64)return Promise.reject(new Error('That computer has too many requests in progress'));
    const seq=++link.seq;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{link.pending.delete(seq);reject(new Error(`${link.info.name} did not answer in time`));},timeoutMs);link.pending.set(seq,{resolve,reject,timer});
      try{link.peer.send({...msg,id:seq});}catch(e){clearTimeout(timer);link.pending.delete(seq);reject(e);}});
  }
  send(id,msg){const link=this.links.get(id);if(link?.ready)try{link.peer.send(msg);}catch{link.ws.close(4003);}}
  /** The bridge client for a linked computer: its requests travel over the link to the computer's own local API. */
  clientFor(id){
    return new DesktopBridgeClient({endpoint:'http://127.0.0.1:1',token:'link',fetchImpl:async(url,opts)=>{
      const path=new URL(url).pathname,body=opts.body?JSON.parse(opts.body):undefined;
      const r=await this.call(id,{type:'request',method:opts.method||'GET',path,body});
      return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.body||{}};
    }});
  }
  async machines(){
    const devices=await this.devices.list();
    return devices.map(d=>{const l=this.links.get(d.id);return {...d,name:l?.info.name||d.name,remoteGrant:l?l.info.remoteGrant:d.remoteGrant,online:!!l?.ready,transport:l?.ready?'webrtc':'offline',state:l?.ready?l.state.state:'offline',taskId:l?.ready?l.state.taskId:null,activity:l?.ready?l.state.activity:'',connectedAt:l?.ready?l.connectedAt:null};});
  }
  machineFor(taskId){for(const [id,l] of this.links)if(l.ready&&l.state.state==='agent'&&l.state.taskId===taskId)return {id,name:l.info.name};return null;}
  online(){return [...this.links.entries()].filter(([,l])=>l.ready).map(([id,l])=>({id,name:l.info.name,os:l.info.os,remoteGrant:l.info.remoteGrant,busy:l.state.state==='agent'}));}
  ask(task){for(const id of this.links.keys())this.send(id,{type:'ask',taskId:task.id,title:task.title});}
  cancel(taskId){for(const id of this.links.keys())this.send(id,{type:'cancel',taskId});}
  async grant(id,task){const r=await this.call(id,{type:'grant',taskId:task.id,title:task.title},15000);if(!r.ok)throw new Error(r.error||'The computer refused.');return true;}
  async rename(id,name){const label=clean(name,60);if(!label)throw new Error('Give the computer a name.');if(!await this.devices.update(id,{name:label}))throw new Error('That computer is no longer paired.');const l=this.links.get(id);if(l){l.device.name=label;l.info.name=label;}return {renamed:true,name:label};}
  async confirm(id,code){
    const device=(await this.devices.list()).find(d=>d.id===id);if(!device?.verificationCode)throw Error('Pair this computer again with Seek Desktop 0.4 or later.');
    if(String(code||'').toUpperCase().replace(/[^A-F0-9]/g,'')!==device.verificationCode.replace(/-/g,''))throw Error('The security codes do not match. Remove this computer and pair again.');
    await this.devices.update(id,{verified:true});return {verified:true};
  }
  async remove(id){await this.devices.remove(id);const l=this.links.get(id);if(l)try{l.ws.close(4401,'Removed from Seek');}catch{}this.links.delete(id);}
  close(){for(const l of this.links.values())try{l.ws.close(1001,'Seek is restarting');}catch{}this.links.clear();}
}

/**
 * The runtime the desktop_* tools use. Finds the computer this task was allowed on (a paired
 * computer, or this PC's local companion through its credential file) and, when none, asks the user.
 */
export class DesktopControl{
  constructor({hub,local=null,resolveOwner,requestGrant}){
    Object.assign(this,{hub,local,resolveOwner,requestGrant});this.current=null;this.attaching=false;
    this.offHub=hub.on(event=>{
      if(!this.current||this.computer?.id!==event.id)return;
      if(event.type==='offline'||(event.type==='state'&&event.state.taskId!==this.current.taskId)){
        const current=this.current;this.current=null;clearInterval(this.watchdog);current.close();
      }
    });
  }
  async owner(exec){
    const o=await this.resolveOwner(exec);
    if(!o||o.child||!o.taskId||!o.sessionId||o.sessionId!==exec?.agent?.id||!['running','waiting','queued'].includes(o.status))throw new Error('Desktop control is available only to the active parent task');
    const mode=o.execution?.mode||o.companion?.mode;
    if(mode&&mode!=='desktop')throw Error('This task was started in Chat or Seek’s browser. Start a task on a computer to use the desktop.');
    return o;
  }
  async localStatus(){try{const c=await this.local.createClient();return {client:c,status:await c.request('/status')};}catch{return null;}}
  async status(exec){
    const o=await this.owner(exec),machines=await this.hub.machines(),local=this.local?await this.localStatus():null;
    const granted=this.hub.machineFor(o.taskId)||(local?.status.state==='agent'&&local.status.taskId===o.taskId?{id:'local',name:'this PC'}:null);
    return {text:JSON.stringify({taskId:o.taskId,granted:!!granted,computer:granted?.name||null,computers:machines.map(m=>({name:m.name,os:m.os,online:m.online,inUse:m.state==='agent',remoteApproval:m.remoteGrant})),
      ...(local&&!machines.some(m=>m.online)?{thisPc:{companionRunning:true,state:local.status.state}}:{}),
      next:granted?'Use desktop_observe, then act by ref.':'Call any desktop_ action and Seek will ask the user which computer to allow; then end your turn and wait.'}),mode:'text'};
  }
  async forExecution(exec){
    exec?.signal?.throwIfAborted();const o=await this.owner(exec);
    const target=o.execution?.deviceId||o.companion?.deviceId;
    if(target&&(!o.execution?.autoRemote||o.execution.granted)&&this.hub.machineFor(o.taskId)?.id!==target)throw Error('This computer is paused. Ask the user to continue the task in Seek.');
    if(this.current&&this.current.taskId===o.taskId&&this.currentSession===o.sessionId&&this.current.client.auth)return this.current;
    if(this.attaching)throw new Error('Desktop attachment is in progress');
    this.attaching=true;
    try{
      let client=null,where=this.hub.machineFor(o.taskId);
      if(where)client=this.hub.clientFor(where.id);
      else if(this.local){const l=await this.localStatus();if(l?.status.state==='agent'&&l.status.taskId===o.taskId){client=l.client;where={id:'local',name:'this PC'};}}
      if(!client){const message=await this.requestGrant(o,exec);where=this.hub.machineFor(o.taskId);if(where&&(!target||where.id===target))client=this.hub.clientFor(where.id);else throw new Error(message);}
      this.current?.close();this.current=null;
      const agent=new DesktopAgent({client,taskId:o.taskId});
      try{await agent.attach();exec?.signal?.throwIfAborted();if(where.id!=='local'&&this.hub.machineFor(o.taskId)?.id!==where.id)throw Error('The secure desktop grant ended during attachment');}catch(e){agent.close();throw e;}
      this.current=agent;this.currentSession=o.sessionId;this.computer=where;
      clearInterval(this.watchdog);this.watchdog=setInterval(async()=>{if(this.current!==agent)return;try{await this.owner(exec);}catch{if(this.current!==agent)return;this.current=null;clearInterval(this.watchdog);try{await agent.client.stop();}catch{}finally{agent.close();}}},1000);this.watchdog.unref?.();
      return agent;
    }finally{this.attaching=false;}
  }
  close(){this.offHub?.();clearInterval(this.watchdog);const c=this.current;this.current=null;if(c?.client.auth)void c.client.stop().catch(()=>{});c?.close();}
}
