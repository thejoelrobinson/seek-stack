// Outbound, mutually authenticated WebRTC link to the user's trusted Seek host.
// The WebSocket carries signed connection descriptions only; task content and the
// bridge API travel through the encrypted data channel. Seek can also ask for control:
// the request shows here to Allow or Deny, and, if the user opted in when pairing, can be approved
// from Seek itself (the phone). Nothing here bypasses the local takeover shortcut or Stop.
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {identity,publicIdentity,verificationCode,signSignal,verifySignal,nonce,createSecurePeer} from './secure-link.js';
import {parseInvitation,invitationRequest,verifyInvitationResult} from './pairing.js';

const LOCAL=['127.0.0.1','localhost','[::1]'];
export function normalizeServer(input){
  let text=String(input||'').trim();if(!text)throw Error('Enter your Seek address');
  if(!/^[a-z]+:\/\//i.test(text))text='https://'+text;
  const u=new URL(text);
  if(!['http:','https:'].includes(u.protocol))throw Error('Use an https:// address');
  if(u.protocol==='http:'&&!LOCAL.includes(u.hostname))throw Error('Use https:// for a Seek server on another computer');
  if(u.username||u.password)throw Error('Leave the user name and password out of the address');
  return u.origin;
}
const CODE=/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/;

export class SeekLink{
  constructor({file,encrypt,decrypt,WebSocketImpl,fetchImpl=globalThis.fetch,prepare=async()=>({}),info,localRequest,grant,onDisconnect=()=>{},peerFactory=createSecurePeer,onChange=()=>{},log=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
    if(typeof encrypt!=='function'||typeof decrypt!=='function')throw Error('Protected device key storage is required');
    Object.assign(this,{file,encrypt,decrypt,WebSocketImpl,fetchImpl,prepare,info,localRequest,grantLocal:grant,onDisconnect,peerFactory,onChange,log,setTimer,clearTimer});
    this.config=null;this.ws=null;this.online=false;this.asks=new Map();this.hostRequests=new Map();this.backoff=1000;this.lastError=null;this.stopped=false;
  }
  async load(){try{this.config=JSON.parse(await readFile(this.file,'utf8'));}catch{this.config=null;}if(this.config?.deviceId&&!this.config.hostKey)this.lastError='Pair this computer again to enable the secure WebRTC connection.';else if(this.config?.verified)this.connect();this.changed();return this.status();}
  async save(){await mkdir(dirname(this.file),{recursive:true});await writeFile(this.file,JSON.stringify(this.config),{mode:0o600});}
  status(){return {defaultName:this.info?.().name||'',paired:!!this.config?.deviceId,server:this.config?.server||null,name:this.config?.name||null,remoteGrant:!!this.config?.remoteGrant,online:this.online,transport:this.online?'webrtc':'offline',verified:!!this.config?.verified,verificationCode:this.config?.hostKey?verificationCode(this.config.deviceId,this.config.publicKey,this.config.hostKey):null,lastError:this.lastError,requests:[...this.asks.values()]};}
  changed(){try{this.onChange(this.status());}catch{}}
  /** Trades a pairing code from Seek (Settings › Computers) for this computer's own device key. */
  async pair({server,code,name,remoteGrant=true,invitation:link}){
    const invite=link?parseInvitation(link):null;
    const origin=invite?invite.server:normalizeServer(server),pairing=String(code||'').trim().toUpperCase();
    if(!invite&&!CODE.test(pairing))throw Error('Enter the 8-character code shown in Seek');
    if(invite&&invite.expiresAt<Date.now())throw Error('This link has expired. Create a new one in Seek › Settings › Computers.');
    const label=String(name||'').trim().slice(0,60)||this.info().name;
    const keys=identity();
    // Fail before consuming the one-time code if the keychain is unavailable.
    const protectedKey=this.encrypt(keys.privateKey);
    const fields={...this.info(),name:label,remoteGrant:!!remoteGrant,publicKey:keys.publicKey,protocol:1};
    const request=invite?invitationRequest(invite,fields):{...fields,code:pairing.replace('-','')};
    const res=await this.fetchImpl(origin+'/work/desktop/pair',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});
    let data={};try{data=await res.json();}catch{}
    if(!res.ok||!data.deviceId||!/^[a-f0-9]{64}$/.test(data.secret||''))throw Error(data.error||`Seek refused the pairing (${res.status})`);
    publicIdentity(data.hostKey);
    if(invite)verifyInvitationResult(invite,request,data);
    this.close();this.config={server:origin,deviceId:data.deviceId,secret:this.encrypt(data.secret),privateKey:protectedKey,publicKey:keys.publicKey,hostKey:data.hostKey,verified:!!invite,name:label,remoteGrant:!!remoteGrant,pairedAt:Date.now()};
    await this.save();this.stopped=false;this.lastError=null;if(invite)this.connect();this.changed();return this.status();
  }
  async confirm(code){
    if(!this.config?.hostKey)throw Error('Pair this computer again to enable WebRTC');
    if(String(code||'').toUpperCase().replace(/[^A-F0-9]/g,'')!==this.status().verificationCode.replace(/-/g,''))throw Error('The security codes do not match. Disconnect and pair again.');
    this.config.verified=true;await this.save();this.connect();this.changed();return this.status();
  }
  async unpair(){this.stopped=true;this.close();this.config=null;this.asks.clear();await rm(this.file,{force:true});this.changed();return this.status();}
  async setRemoteGrant(value){if(!this.config)throw Error('Pair with Seek first');this.config.remoteGrant=!!value;await this.save();this.send({type:'hello',...this.info(),remoteGrant:this.config.remoteGrant});this.changed();return this.status();}
  connect(){
    if(!this.config?.verified||!this.config.hostKey||this.stopped||this.ws||this.connecting)return;
    let secret;try{secret=this.decrypt(this.config.secret);}catch{this.lastError='The saved Seek key could not be read. Pair again.';this.changed();return;}
    const url=this.config.server.replace(/^http/,'ws')+'/work/desktop/link';
    // Network options (system proxy, system certificates) are resolved per connection.
    this.connecting=true;const config=this.config;
    void Promise.resolve(this.prepare(url)).catch(e=>{this.log('network setup: '+e.message);return {};}).then(extra=>{
      this.connecting=false;
      if(this.ws||this.stopped||this.config!==config||!config.verified)return;
      this.open(url,secret,extra||{});
    });
  }
  open(url,secret,extra){
    const ws=new this.WebSocketImpl(url,{...extra,headers:{Authorization:`Bearer ${this.config.deviceId}.${secret}`},handshakeTimeout:15000,maxPayload:256*1024});
    this.ws=ws;
    ws.on('open',()=>{this.lastError=null;this.changed();});
    // Never accept control, task content or observations from the signaling socket.
    ws.on('message',raw=>{let msg;try{msg=JSON.parse(String(raw));}catch{return;}if(this.ws!==ws)return;void this.signal(msg,ws).catch(()=>{this.lastError='Secure connection verification failed. Pair again if Seek’s identity changed.';ws.close(4003);});});
    ws.on('unexpected-response',(_req,res)=>{if(res.statusCode===401||res.statusCode===403){this.lastError='This computer was removed from Seek. Pair it again.';this.stopped=true;}});
    ws.on('error',e=>{this.lastError=this.lastError||`Can't reach Seek: ${e.message}`;});
    ws.on('close',(code,reason)=>{
      if(this.ws!==ws)return;this.ws=null;this.dropPeer();
      if(code===4401){this.lastError='This computer was removed from Seek. Pair it again.';this.stopped=true;}
      if(code===4003&&String(reason)==='Verify the security code in Seek Settings')this.lastError='Verify this computer’s security code in Seek › Settings › Computers.';
      this.changed();
      if(!this.stopped&&this.config){this.timer=this.setTimer(()=>this.connect(),this.backoff);this.backoff=Math.min(this.backoff*2,30000);}
    });
  }
  dropPeer(){const peer=this.peer;this.peer=null;this.negotiation=null;this.online=false;for(const p of this.hostRequests.values()){this.clearTimer(p.timer);p.reject(Error('The secure connection ended. Reconnect to Seek and try again.'));}this.hostRequests.clear();peer?.close();this.onDisconnect();this.asks.clear();}
  close(){this.clearTimer(this.timer);this.connecting=false;const ws=this.ws;this.ws=null;this.dropPeer();try{ws?.close(1000);}catch{}}
  send(msg){if(this.online&&this.peer?.ready){try{this.peer.send(msg);}catch{this.ws?.close(4003);}}}
  sendState(s){this.latestState={type:'state',state:s.state,taskId:s.taskId||null,activity:s.activity||''};this.send(this.latestState);}
  requestHost(method,body={}){
    if(!this.online||!this.peer?.ready)return Promise.reject(Error('Connect this computer to Seek first.'));
    if(this.hostRequests.size>=16)return Promise.reject(Error('Seek is busy. Try again shortly.'));
    const id='ui_'+randomBytes(16).toString('hex'),peer=this.peer;
    return new Promise((resolve,reject)=>{
      const timer=this.setTimer(()=>{this.hostRequests.delete(id);reject(Error('Seek did not answer. Your task may already be in Recent conversations.'));},15000);
      this.hostRequests.set(id,{resolve,reject,timer});
      try{peer.send({type:'companion-request',id,method,body});}catch(e){this.clearTimer(timer);this.hostRequests.delete(id);reject(e);}
    });
  }
  async signal(msg,ws){
    if(msg.type!=='rtc')return;
    const config=this.config;if(!config?.verified)return;
    if(msg.kind==='ready'){
      if(this.negotiation)throw Error('Duplicate secure negotiation');
      verifySignal(config.hostKey,msg,{deviceId:config.deviceId,kind:'ready'});
      const n={...msg,deviceNonce:nonce()};this.negotiation=n;
      const peer=await this.peerFactory({iceServers:msg.iceServers,policy:msg.policy,
        onMessage:m=>{if(this.ws===ws&&this.peer===peer&&this.online)void this.handle(m).catch(()=>{ws.close(4003);});},
        onOpen:()=>{if(this.ws!==ws||this.peer!==peer)return;this.online=true;this.backoff=1000;this.lastError=null;this.send({type:'hello',...this.info(),name:config.name,remoteGrant:!!config.remoteGrant});if(this.latestState)this.send(this.latestState);this.changed();},
        onClose:()=>{if(this.ws===ws){this.online=false;this.onDisconnect();ws.close(4003);}}});
      if(this.ws!==ws||this.negotiation!==n){peer.close();return;}this.peer=peer;
      const offer=await peer.offer();if(this.ws!==ws)return;
      ws.send(JSON.stringify(signSignal(this.decrypt(config.privateKey),{...n,kind:'offer',sdp:offer.sdp})));
    }else if(msg.kind==='answer'){
      const n=this.negotiation;if(!n||n.answered)throw Error('Unexpected secure answer');
      verifySignal(config.hostKey,msg,{deviceId:config.deviceId,sessionId:n.sessionId,kind:'answer',hostNonce:n.hostNonce,deviceNonce:n.deviceNonce});n.answered=true;
      await this.peer.accept({type:'answer',sdp:msg.sdp});
    }else throw Error('Unexpected secure signal');
  }
  async handle(msg){
    if(!msg||typeof msg!=='object')throw Error('Invalid desktop message');
    const peer=this.peer,reply=m=>{if(this.peer===peer)this.send(m);};
    if(msg.type==='companion-result'){
      const p=this.hostRequests.get(msg.id);if(!p)return;
      this.hostRequests.delete(msg.id);this.clearTimer(p.timer);
      if(msg.ok===true)p.resolve(msg.result);else p.reject(Error(String(msg.error||'Seek could not complete that action.').slice(0,500)));
      return;
    }
    if(msg.type==='request'){
      // Seek reaches this computer only through its own local API: same sessions, leases and checks.
      if(!['GET','POST'].includes(msg.method)||!['/status','/heartbeat','/observe','/action','/stop'].includes(msg.path)){reply({type:'response',id:msg.id,status:404,body:{error:'Not found'}});return;}
      if((this.inFlight||0)>=16)throw Error('Too many desktop requests');this.inFlight=(this.inFlight||0)+1;
      let out;try{out=await this.localRequest(msg.method,msg.path,msg.body);}catch(e){out={status:502,body:{error:e.message}};}finally{this.inFlight--;}
      reply({type:'response',id:msg.id,status:out.status,body:out.body});return;
    }
    if(msg.type==='ask'){const ask={taskId:String(msg.taskId||'').slice(0,200),title:String(msg.title||'A Seek task').slice(0,200),at:Date.now()};if(ask.taskId){if(this.asks.size>=64&&!this.asks.has(ask.taskId))throw Error('Too many desktop requests');this.asks.set(ask.taskId,ask);this.changed();}return;}
    if(msg.type==='cancel'){if(this.asks.delete(String(msg.taskId)))this.changed();return;}
    if(msg.type==='grant'){
      // Approval from Seek itself (the phone) only when this computer opted in when pairing.
      if(!this.config?.remoteGrant){reply({type:'grant-result',id:msg.id,ok:false,error:'This computer only accepts approval on its own screen.'});return;}
      try{await this.grantLocal(String(msg.taskId||'').slice(0,200),String(msg.title||'').slice(0,200));if(this.peer!==peer){this.onDisconnect();return;}this.asks.delete(String(msg.taskId));this.changed();reply({type:'grant-result',id:msg.id,ok:true});}
      catch(e){reply({type:'grant-result',id:msg.id,ok:false,error:e.message});}
      return;
    }
    if(msg.type==='ping')this.send({type:'pong',at:msg.at});
  }
  /** The person at this computer answers a request from Seek. */
  async answer(taskId,allow){
    const ask=this.asks.get(taskId);if(!ask)throw Error('That request is no longer pending');
    if(!this.online)throw Error('Wait for the secure connection before approving');
    const peer=this.peer;
    if(allow)await this.grantLocal(taskId,ask.title);
    if(this.peer!==peer){this.onDisconnect();throw Error('The secure connection ended before approval');}
    this.asks.delete(taskId);this.send({type:'answer',taskId,allowed:!!allow});this.changed();return this.status();
  }
}
