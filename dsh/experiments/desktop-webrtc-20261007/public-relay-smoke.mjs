// Synthetic traffic only. Read protected relay configuration without logging keys,
// SDP, candidate addresses, or desktop content.
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopRelay} from '../../plugins/browser-viewer/lib/work-desktop-relay.js';
import {dpapi} from '../../plugins/browser-viewer/lib/work-finance.js';
import {createSecurePeer,identity,challenge,nonce,signSignal,verifySignal} from '../../../desktop-bridge/src/secure-link.js';

const relay=new DesktopRelay(join(process.env.USERPROFILE,'.dsh/work'),{protect:dpapi});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function roundTrip(configuration,mode){
 let a,b;
 try{
  const config={...configuration,policy:'relay'};
  if(mode==='tls443'){
   config.iceServers=configuration.iceServers.flatMap(s=>{
    const urls=(Array.isArray(s.urls)?s.urls:[s.urls]).filter(u=>/^turns:.*:443\?transport=tcp$/.test(u));
    return urls.length?[{...s,urls}]:[];
   });
   if(!config.iceServers.length)throw Error('TLS relay endpoint unavailable');
  }
  let receive;const arrived=new Promise(resolve=>{receive=resolve;});
  a=await createSecurePeer({...config,onMessage:()=>{}});
  b=await createSecurePeer({...config,onMessage:receive});
  const ai=identity(),bi=identity(),fields={deviceId:randomUUID(),...challenge(),deviceNonce:nonce(),...config};
  const started=Date.now(),offer=await a.offer();
  const signedOffer=signSignal(ai.privateKey,{...fields,kind:'offer',sdp:offer.sdp});
  verifySignal(ai.publicKey,signedOffer,{...fields,kind:'offer'});
  const answer=await b.answer(offer);
  const signedAnswer=signSignal(bi.privateKey,{...fields,kind:'answer',sdp:answer.sdp});
  verifySignal(bi.publicKey,signedAnswer,{...fields,kind:'answer'});
  await a.accept(answer);
  const candidates=(offer.sdp+answer.sdp).split(/\r?\n/).filter(s=>s.startsWith('a=candidate:'));
  if(candidates.length<2||candidates.some(s=>!s.includes(' typ relay')))throw Error('Non-relay candidate');
  const deadline=Date.now()+20000;
  while(!a.ready||!b.ready){if(Date.now()>deadline)throw Error('Relay connection timed out');await wait(20);}
  for(const peer of [a,b])peer.pc.dtlsTransports[0].verifyRemoteCertificateFingerprint();
  const payload='Seek public relay synthetic fixture 🌐 '.repeat(1000);
  a.send({fixture:payload});
  let timeout;
  try{
   const value=await Promise.race([arrived,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Relay payload timed out')),10000);})]);
   if(value.fixture!==payload)throw Error('Relay payload changed');
  }finally{clearTimeout(timeout);}
  return {mode,relayOnly:true,certificateVerified:true,fragmentedRoundTrip:true,elapsedMs:Date.now()-started};
 }finally{a?.close();b?.close();}
}
try{
 const status=await relay.status();
 if(!status.configured){console.log(JSON.stringify({ready:false,reason:'Relay configuration pending'}));process.exit(2);}
 const configuration=await relay.ice({deviceId:'public-synthetic-check'});
 const checks=[await roundTrip(configuration,'default')];
 if(status.provider==='cloudflare')checks.push(await roundTrip(configuration,'tls443'));
 console.log(JSON.stringify({ready:true,provider:status.provider,checks}));process.exit(0);
}catch(error){console.error(JSON.stringify({ready:false,error:error.name,reason:'Public relay verification failed; credentials withheld'}));process.exit(1);}
