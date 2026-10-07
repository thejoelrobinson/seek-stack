// Outbound link from this computer to a Seek server. Pairing trades a one-time code for a device
// key; the link is one authenticated WebSocket that Seek uses to reach this computer's own local
// bridge API (same sessions, leases and checks as a local agent). Seek can also ask for control:
// the request shows here to Allow or Deny, and, if the user opted in when pairing, can be approved
// from Seek itself (the phone). Nothing here bypasses the local takeover shortcut or Stop.
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';

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
  constructor({file,encrypt=s=>s,decrypt=s=>s,WebSocketImpl,fetchImpl=globalThis.fetch,info,localRequest,grant,onChange=()=>{},log=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
    Object.assign(this,{file,encrypt,decrypt,WebSocketImpl,fetchImpl,info,localRequest,grantLocal:grant,onChange,log,setTimer,clearTimer});
    this.config=null;this.ws=null;this.online=false;this.asks=new Map();this.backoff=1000;this.lastError=null;this.stopped=false;
  }
  async load(){try{this.config=JSON.parse(await readFile(this.file,'utf8'));}catch{this.config=null;}if(this.config?.deviceId)this.connect();this.changed();return this.status();}
  async save(){await mkdir(dirname(this.file),{recursive:true});await writeFile(this.file,JSON.stringify(this.config),{mode:0o600});}
  status(){return {defaultName:this.info?.().name||'',paired:!!this.config?.deviceId,server:this.config?.server||null,name:this.config?.name||null,remoteGrant:!!this.config?.remoteGrant,online:this.online,lastError:this.lastError,requests:[...this.asks.values()]};}
  changed(){try{this.onChange(this.status());}catch{}}
  /** Trades a pairing code from Seek (Settings › Computers) for this computer's own device key. */
  async pair({server,code,name,remoteGrant=true}){
    const origin=normalizeServer(server),pairing=String(code||'').trim().toUpperCase();
    if(!CODE.test(pairing))throw Error('Enter the 8-character code shown in Seek');
    const label=String(name||'').trim().slice(0,60)||this.info().name;
    const res=await this.fetchImpl(origin+'/work/desktop/pair',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({...this.info(),code:pairing.replace('-',''),name:label,remoteGrant:!!remoteGrant}),signal:AbortSignal.timeout(15000)});
    let data={};try{data=await res.json();}catch{}
    if(!res.ok||!data.deviceId||!/^[a-f0-9]{64}$/.test(data.secret||''))throw Error(data.error||`Seek refused the pairing (${res.status})`);
    this.close();this.config={server:origin,deviceId:data.deviceId,secret:this.encrypt(data.secret),name:label,remoteGrant:!!remoteGrant,pairedAt:Date.now()};
    await this.save();this.stopped=false;this.lastError=null;this.connect();this.changed();return this.status();
  }
  async unpair(){this.stopped=true;this.close();this.config=null;this.asks.clear();await rm(this.file,{force:true});this.changed();return this.status();}
  async setRemoteGrant(value){if(!this.config)throw Error('Pair with Seek first');this.config.remoteGrant=!!value;await this.save();this.send({type:'hello',...this.info(),remoteGrant:this.config.remoteGrant});this.changed();return this.status();}
  connect(){
    if(!this.config?.deviceId||this.stopped||this.ws)return;
    let secret;try{secret=this.decrypt(this.config.secret);}catch{this.lastError='The saved Seek key could not be read. Pair again.';this.changed();return;}
    const url=this.config.server.replace(/^http/,'ws')+'/work/desktop/link';
    const ws=new this.WebSocketImpl(url,{headers:{Authorization:`Bearer ${this.config.deviceId}.${secret}`},handshakeTimeout:15000,maxPayload:256*1024});
    this.ws=ws;
    ws.on('open',()=>{this.online=true;this.backoff=1000;this.lastError=null;this.send({type:'hello',...this.info(),name:this.config?.name||this.info().name,remoteGrant:!!this.config?.remoteGrant});this.changed();});
    ws.on('message',raw=>{let msg;try{msg=JSON.parse(String(raw));}catch{return;}void this.handle(msg).catch(e=>this.log('link message failed: '+e.message));});
    ws.on('unexpected-response',(_req,res)=>{if(res.statusCode===401||res.statusCode===403){this.lastError='This computer was removed from Seek. Pair it again.';this.stopped=true;}});
    ws.on('error',e=>{this.lastError=this.lastError||`Can't reach Seek: ${e.message}`;});
    ws.on('close',code=>{
      if(this.ws===ws)this.ws=null;this.online=false;
      if(code===4401){this.lastError='This computer was removed from Seek. Pair it again.';this.stopped=true;}
      for(const ask of this.asks.values())ask.stale=true;
      this.changed();
      if(!this.stopped&&this.config){this.timer=this.setTimer(()=>this.connect(),this.backoff);this.backoff=Math.min(this.backoff*2,30000);}
    });
  }
  close(){this.clearTimer(this.timer);const ws=this.ws;this.ws=null;this.online=false;try{ws?.close(1000);}catch{}}
  send(msg){if(this.ws&&this.ws.readyState===1)this.ws.send(JSON.stringify(msg));}
  sendState(s){this.send({type:'state',state:s.state,taskId:s.taskId||null,activity:s.activity||''});}
  async handle(msg){
    if(msg.type==='request'){
      // Seek reaches this computer only through its own local API: same sessions, leases and checks.
      if(!['GET','POST'].includes(msg.method)||!['/status','/heartbeat','/observe','/action','/stop'].includes(msg.path)){this.send({type:'response',id:msg.id,status:404,body:{error:'Not found'}});return;}
      let out;try{out=await this.localRequest(msg.method,msg.path,msg.body);}catch(e){out={status:502,body:{error:e.message}};}
      this.send({type:'response',id:msg.id,status:out.status,body:out.body});return;
    }
    if(msg.type==='ask'){const ask={taskId:String(msg.taskId||'').slice(0,200),title:String(msg.title||'A Seek task').slice(0,200),at:Date.now()};if(ask.taskId){this.asks.set(ask.taskId,ask);this.changed();}return;}
    if(msg.type==='cancel'){if(this.asks.delete(String(msg.taskId)))this.changed();return;}
    if(msg.type==='grant'){
      // Approval from Seek itself (the phone) only when this computer opted in when pairing.
      if(!this.config?.remoteGrant){this.send({type:'grant-result',id:msg.id,ok:false,error:'This computer only accepts approval on its own screen.'});return;}
      try{await this.grantLocal(String(msg.taskId||''),String(msg.title||''));this.asks.delete(String(msg.taskId));this.changed();this.send({type:'grant-result',id:msg.id,ok:true});}
      catch(e){this.send({type:'grant-result',id:msg.id,ok:false,error:e.message});}
      return;
    }
    if(msg.type==='ping')this.send({type:'pong',at:msg.at});
  }
  /** The person at this computer answers a request from Seek. */
  async answer(taskId,allow){
    const ask=this.asks.get(taskId);if(!ask)throw Error('That request is no longer pending');
    if(allow)await this.grantLocal(taskId,ask.title);
    this.asks.delete(taskId);this.send({type:'answer',taskId,allowed:!!allow});this.changed();return this.status();
  }
}
