// A one-use invitation pins Seek's identity without asking users to type fingerprints.
// Its 256-bit secret is carried by the trusted invitation, never sent to the server.
import {randomBytes,createHmac,timingSafeEqual,sign,verify,createPrivateKey,createPublicKey} from 'node:crypto';
import {publicIdentity} from './secure-link.js';

export const PAIR_SCHEME='seek-desktop';
const ID=/^[a-f0-9]{32}$/,SECRET=/^[a-f0-9]{64}$/;
export function pairingOrigin(input){
  const u=new URL(input);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Use a secure Seek address');
  return u.origin;
}
export function invitation(server,hostKey,now=Date.now()){
  const value={id:randomBytes(16).toString('hex'),token:randomBytes(32).toString('hex'),hostKey:publicIdentity(hostKey),server:pairingOrigin(server),expiresAt:now+10*60000};
  const u=new URL(PAIR_SCHEME+'://pair');for(const [k,v] of Object.entries(value))u.searchParams.set(k,String(v));u.searchParams.set('v','1');
  return {...value,url:u.href};
}
export function parseInvitation(text){
  if(typeof text!=='string'||text.length>2048)throw Error('Paste a connection link from Seek › Settings › Computers');
  let u;try{u=new URL(text.trim());}catch{throw Error('Paste a connection link from Seek › Settings › Computers');}
  if(u.protocol!==PAIR_SCHEME+':'||u.hostname!=='pair'||u.username||u.password||!['','/'].includes(u.pathname)||u.hash||u.searchParams.get('v')!=='1')throw Error('This is not a Seek connection link');
  const v=Object.fromEntries(u.searchParams);
  for(const k of u.searchParams.keys())if(u.searchParams.getAll(k).length!==1||!['id','token','hostKey','server','expiresAt','v'].includes(k))throw Error('Invalid Seek connection link');
  if(!ID.test(v.id||'')||!SECRET.test(v.token||'')||!Number.isSafeInteger(Number(v.expiresAt)))throw Error('Invalid Seek connection link');
  return {id:v.id,token:v.token,hostKey:publicIdentity(v.hostKey),server:pairingOrigin(v.server),expiresAt:Number(v.expiresAt)};
}
function requestText(b){
  publicIdentity(b.publicKey);
  if(b.protocol!==1||!ID.test(b.invitationId||'')||!ID.test(b.nonce||'')||typeof b.remoteGrant!=='boolean'||['name','os','arch','version'].some(k=>typeof b[k]!=='string'||b[k].length>100))throw Error('Invalid connection request');
  return JSON.stringify(['seek-desktop-invitation-request-v1',b.invitationId,b.nonce,b.publicKey,b.name,b.os,b.arch,b.version,b.remoteGrant]);
}
export function invitationRequest(invite,fields){
  const b={...fields,protocol:1,invitationId:invite.id,nonce:randomBytes(16).toString('hex')};
  b.proof=createHmac('sha256',Buffer.from(invite.token,'hex')).update(requestText(b)).digest('hex');return b;
}
export function verifyInvitationRequest(token,b){
  const expected=createHmac('sha256',Buffer.from(token,'hex')).update(requestText(b)).digest();
  if(!SECRET.test(b.proof||'')||!timingSafeEqual(expected,Buffer.from(b.proof,'hex')))throw Error('This connection link is invalid or expired');
}
function resultText(b,r){
  if(!/^[a-f0-9-]{36}$/.test(r.deviceId||'')||!SECRET.test(r.secret||'')||typeof r.name!=='string'||r.name.length>60)throw Error('Invalid connection response');
  return JSON.stringify(['seek-desktop-invitation-result-v1',requestText(b),r.deviceId,r.secret,r.name,publicIdentity(r.hostKey)]);
}
export function signInvitationResult(privateKey,b,result){
  return {...result,signature:sign(null,Buffer.from(resultText(b,result)),createPrivateKey({key:Buffer.from(privateKey,'base64'),format:'der',type:'pkcs8'})).toString('base64')};
}
export function verifyInvitationResult(invite,b,result){
  if(result.hostKey!==invite.hostKey||typeof result.signature!=='string'||result.signature.length!==88||!verify(null,Buffer.from(resultText(b,result)),createPublicKey({key:Buffer.from(invite.hostKey,'base64'),format:'der',type:'spki'}),Buffer.from(result.signature,'base64')))throw Error('Seek’s identity could not be verified. Create a new link from your trusted Seek.');
}
