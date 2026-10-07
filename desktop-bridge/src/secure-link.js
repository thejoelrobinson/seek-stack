// Device identity authenticates the complete WebRTC description, including its DTLS
// fingerprint. The WebSocket is signaling only; application data uses DTLS/SCTP.
import {generateKeyPairSync,createPublicKey,createPrivateKey,sign,verify,createHash,randomBytes,randomUUID,createHmac} from 'node:crypto';

export const PROTOCOL=1,CHANNEL='seek-desktop-v1',MAX_MESSAGE=256*1024;
const TOKEN=/^[a-f0-9]{32}$/;
export function identity(){
  const pair=generateKeyPairSync('ed25519');
  return {publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),privateKey:pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64')};
}
export function publicIdentity(value){
  if(typeof value!=='string'||value.length!==60)throw Error('Invalid device identity');
  const key=createPublicKey({key:Buffer.from(value,'base64'),format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ed25519'||key.export({type:'spki',format:'der'}).toString('base64')!==value)throw Error('Invalid device identity');
  return value;
}
export function verificationCode(deviceId,deviceKey,hostKey){
  publicIdentity(deviceKey);publicIdentity(hostKey);
  return createHash('sha256').update(JSON.stringify(['seek-desktop-pair-v1',deviceId,deviceKey,hostKey])).digest('hex').slice(0,16).toUpperCase().match(/.{4}/g).join('-');
}
// An array gives the signed message a single canonical representation. No task or
// desktop content belongs here. Both fresh nonces bind an answer to this connection.
function transcript(m){return JSON.stringify(['seek-desktop-signal-v1',m.deviceId,m.sessionId,m.kind,m.hostNonce,m.deviceNonce,m.at,m.sdp,m.iceServers,m.policy]);}
export function signSignal(key,fields){
  const m={type:'rtc',protocol:PROTOCOL,deviceId:fields.deviceId,sessionId:fields.sessionId,kind:fields.kind,hostNonce:fields.hostNonce,deviceNonce:fields.deviceNonce||'',at:Date.now(),sdp:fields.sdp||'',iceServers:fields.iceServers||[],policy:fields.policy||'all'};
  m.signature=sign(null,Buffer.from(transcript(m)),createPrivateKey({key:Buffer.from(key,'base64'),format:'der',type:'pkcs8'})).toString('base64');return m;
}
export function verifySignal(key,m,{deviceId,sessionId,kind,hostNonce,deviceNonce,now=Date.now()}={}){
  publicIdentity(key);
  if(!m||m.type!=='rtc'||m.protocol!==PROTOCOL||m.deviceId!==deviceId||!TOKEN.test(m.hostNonce)||!(/^[0-9a-f-]{36}$/.test(m.sessionId||''))||!['ready','offer','answer'].includes(m.kind)||!['all','relay'].includes(m.policy)||!Number.isSafeInteger(m.at)||Math.abs(now-m.at)>90000||typeof m.sdp!=='string'||m.sdp.length>65536||!Array.isArray(m.iceServers)||m.iceServers.length>8||typeof m.signature!=='string'||m.signature.length!==88)throw Error('Invalid or expired secure connection offer');
  if((sessionId&&m.sessionId!==sessionId)||(kind&&m.kind!==kind)||(hostNonce&&m.hostNonce!==hostNonce)||(deviceNonce&&m.deviceNonce!==deviceNonce)||((m.kind==='offer'||m.kind==='answer')&&!TOKEN.test(m.deviceNonce)))throw Error('Secure connection challenge did not match');
  if(m.kind!=='ready'&&!/^a=fingerprint:sha-256 [A-Fa-f0-9:]+\r?$/m.test(m.sdp))throw Error('Secure connection has no SHA-256 certificate fingerprint');
  if(!verify(null,Buffer.from(transcript(m)),createPublicKey({key:Buffer.from(key,'base64'),format:'der',type:'spki'}),Buffer.from(m.signature,'base64')))throw Error('Secure connection identity did not match');
  return m;
}
export function challenge(){return {sessionId:randomUUID(),hostNonce:randomBytes(16).toString('hex')};}
export function nonce(){return randomBytes(16).toString('hex');}

export function iceConfiguration(env=process.env,{deviceId='host',now=Date.now()}={}){
  let iceServers=[];
  if(env.SEEK_DESKTOP_ICE_SERVERS){iceServers=JSON.parse(env.SEEK_DESKTOP_ICE_SERVERS);if(!Array.isArray(iceServers)||iceServers.length>6)throw Error('Invalid SEEK_DESKTOP_ICE_SERVERS');}
  if(env.SEEK_DESKTOP_TURN_URL){
    if(!env.SEEK_DESKTOP_TURN_SECRET||env.SEEK_DESKTOP_TURN_SECRET.length<32)throw Error('Configure a strong SEEK_DESKTOP_TURN_SECRET');
    const urls=env.SEEK_DESKTOP_TURN_URL.split(',').map(s=>s.trim());
    if(urls.some(u=>!/^turns?:[^\s]+$/.test(u)))throw Error('Invalid desktop TURN URL');
    const username=`${Math.floor(now/1000)+3600}:seek-${deviceId}`;
    iceServers.push({urls,username,credential:createHmac('sha1',env.SEEK_DESKTOP_TURN_SECRET).update(username).digest('base64')});
  }
  const policy=env.SEEK_DESKTOP_RELAY_ONLY==='1'?'relay':'all';
  if(policy==='relay'&&!iceServers.some(s=>(Array.isArray(s.urls)?s.urls:[s.urls]).some(u=>/^turns?:/.test(u))))throw Error('Relay-only desktop connections require TURN');
  return {iceServers,policy};
}

// Fragment below SCTP's message limit. Bound the entire queue and reassembly, and
// close on overload rather than retaining desktop commands after their context expires.
export class SecureMessages{
  constructor(channel,{onMessage,onError=()=>{}}){this.channel=channel;this.onMessage=onMessage;this.onError=onError;this.seq=0;this.received=0;this.partial=null;this.closed=false;}
  send(message){
    if(this.closed||this.channel.readyState!=='open')throw Error('Secure desktop connection is not ready');
    const json=JSON.stringify(message);if(Buffer.byteLength(json)>MAX_MESSAGE)throw Error('Desktop message is too large');
    if(this.channel.bufferedAmount>512*1024)throw Error('Secure desktop connection is busy; control was stopped');
    const id=++this.seq,total=Math.ceil(json.length/8000);
    for(let part=0;part<total;part++)this.channel.send(JSON.stringify({id,part,total,text:json.slice(part*8000,(part+1)*8000)}));
  }
  receive(raw){
    if(this.closed)return;
    try{
      if(Buffer.byteLength(raw)>50000)throw Error('Oversized desktop fragment');
      const f=JSON.parse(String(raw));
      if(!Number.isSafeInteger(f.id)||f.id!==this.received+1||!Number.isSafeInteger(f.total)||f.total<1||f.total>33||!Number.isSafeInteger(f.part)||f.part<0||f.part>=f.total||typeof f.text!=='string'||f.text.length>8000)throw Error('Invalid desktop fragment');
      if(!this.partial){if(f.part!==0)throw Error('Out of order desktop fragment');this.partial={id:f.id,total:f.total,next:0,text:'',bytes:0};this.timer=setTimeout(()=>this.fail(Error('Incomplete desktop message')),10000);this.timer.unref?.();}
      const p=this.partial;if(f.id!==p.id||f.total!==p.total||f.part!==p.next++)throw Error('Out of order desktop fragment');
      p.bytes+=Buffer.byteLength(f.text);if(p.bytes>MAX_MESSAGE)throw Error('Desktop message is too large');p.text+=f.text;
      if(p.next===p.total){clearTimeout(this.timer);this.partial=null;this.received=f.id;this.onMessage(JSON.parse(p.text));}
    }catch(e){this.fail(e);}
  }
  fail(e){this.close();this.onError(e);}
  close(){this.closed=true;clearTimeout(this.timer);this.partial=null;}
}

export async function createSecurePeer({iceServers=[],policy='all',onMessage,onOpen=()=>{},onClose=()=>{},peerOptions={}}){
  const {RTCPeerConnection}=await import('werift');
  const pc=new RTCPeerConnection({...peerOptions,iceServers,iceTransportPolicy:policy});
  // werift has a Google STUN fallback even with an empty iceServers array. Disable
  // it explicitly unless the owner configured STUN; local connections stay local.
  const hasStun=iceServers.some(s=>(Array.isArray(s.urls)?s.urls:[s.urls]).some(u=>/^stun:/.test(u)));
  const configureIce=()=>{if(!hasStun)for(const t of pc.iceTransports)t.connection.stunServer=undefined;};
  let channel,messages,closed=false,opened=false;
  const close=()=>{if(closed)return;closed=true;clearTimeout(timeout);messages?.close();void pc.close().catch(()=>{});onClose();};
  const timeout=setTimeout(close,30000);timeout.unref?.();
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))close();};
  function bind(dc){
    if(channel||dc.label!==CHANNEL||dc.protocol!==CHANNEL||!dc.ordered||dc.maxRetransmits!==null||dc.maxPacketLifeTime!==null){close();return;}
    channel=dc;messages=new SecureMessages(dc,{onMessage,onError:close});
    dc.onopen=()=>{if(closed)return;opened=true;clearTimeout(timeout);onOpen();};dc.onclose=close;dc.onerror=close;dc.onmessage=e=>messages.receive(e.data);
  }
  pc.ondatachannel=e=>bind(e.channel);
  const description=()=>({type:pc.localDescription.type,sdp:pc.localDescription.sdp});
  return {pc,get ready(){return opened&&!closed;},
    async offer(){bind(pc.createDataChannel(CHANNEL,{ordered:true,protocol:CHANNEL}));const offer=await pc.createOffer();configureIce();await pc.setLocalDescription(offer);return description();},
    async answer(offer){await pc.setRemoteDescription(offer);configureIce();await pc.setLocalDescription(await pc.createAnswer());return description();},
    async accept(answer){await pc.setRemoteDescription(answer);},
    send(m){if(closed||!messages)throw Error('Secure desktop connection is not ready');try{messages.send(m);}catch(e){close();throw e;}},close};
}
