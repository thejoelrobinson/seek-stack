// Disposable, localhost-only coturn fixture. Exercises real relay-only ICE and
// expiring TURN credentials; no desktop observations, secrets or screens involved.
import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {createSecurePeer,iceConfiguration} from '../src/secure-link.js';
const image='coturn/coturn:4.18.0-r0',name='seek-turn-smoke-'+process.pid,secret=randomBytes(32).toString('hex');
function docker(args){return new Promise((resolve,reject)=>{const child=spawn('docker',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});child.once('error',reject);child.once('exit',code=>code===0?resolve(out.trim()):reject(Error('TURN fixture command failed: '+err.replaceAll(secret,'[redacted]'))));});}
let a,b,created=false;
try{
 await docker(['run','-d','--name',name,'-p','127.0.0.1::3478/udp',image,
  '-n','--no-tls','--fingerprint','--use-auth-secret','--static-auth-secret='+secret,'--realm=seek-smoke',
  '--external-ip=127.0.0.1','--allow-loopback-peers','--min-port=49160','--max-port=49200','--log-file=stdout']);created=true;
 const port=Number((await docker(['port',name,'3478/udp'])).split(':').at(-1));if(!port)throw Error('TURN fixture port unavailable');
 const config=iceConfiguration({SEEK_DESKTOP_TURN_URL:'turn:127.0.0.1:'+port,SEEK_DESKTOP_TURN_SECRET:secret,SEEK_DESKTOP_RELAY_ONLY:'1'});
 let receive;const arrived=new Promise(resolve=>{receive=resolve;});
 a=await createSecurePeer({...config,onMessage:()=>{}});b=await createSecurePeer({...config,onMessage:receive});
 const offer=await a.offer(),answer=await b.answer(offer);await a.accept(answer);
 if(!/typ relay/.test(offer.sdp)||!/typ relay/.test(answer.sdp)||/typ host/.test(offer.sdp+answer.sdp))throw Error('Relay-only ICE did not produce exclusively relay candidates');
 const deadline=Date.now()+20000;while(!a.ready||!b.ready){if(Date.now()>deadline)throw Error('TURN WebRTC connection failed');await new Promise(r=>setTimeout(r,20));}
 for(const peer of [a,b])peer.pc.dtlsTransports[0].verifyRemoteCertificateFingerprint();
 a.send({fixture:'encrypted relay-only WebRTC'});
 const message=await Promise.race([arrived,new Promise((_r,reject)=>setTimeout(()=>reject(Error('TURN data did not arrive')),5000))]);
 if(message.fixture!=='encrypted relay-only WebRTC')throw Error('TURN data changed');
 console.log('SEEK_BRIDGE_TURN_SMOKE_OK');
}catch(e){if(created){const logs=await docker(['logs',name]).catch(()=> '');console.error(logs.replaceAll(secret,'[redacted]').slice(-5000));}throw e;
}finally{a?.close();b?.close();if(created)await docker(['rm','-f',name]);}
