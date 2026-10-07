// Relay credentials live on the trusted host. Clients receive short-lived ICE credentials.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {iceConfiguration} from './desktop/secure-link.js';

export class DesktopRelay{
  constructor(root,{protect,fetchImpl=fetch,env=process.env}={}){this.root=root;this.file=join(root,'desktop-relay.json');Object.assign(this,{protect,fetchImpl,env});this.operations=Promise.resolve();}
  async read(){try{return JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('Desktop relay settings could not be read');}}
  async status(){
    const c=await this.read();return {configured:!!c||!!this.env.SEEK_DESKTOP_TURN_URL||!!this.env.SEEK_DESKTOP_ICE_SERVERS,provider:c?.provider||(this.env.SEEK_DESKTOP_TURN_URL||this.env.SEEK_DESKTOP_ICE_SERVERS?'environment':'none'),relayOnly:!!c?.relayOnly||this.env.SEEK_DESKTOP_RELAY_ONLY==='1'};
  }
  configure(input){const flight=this.operations.then(()=>this.save(input));this.operations=flight.catch(()=>{});return flight;}
  async save({provider,keyId,token,urls,secret,relayOnly=false}={}){
    if(typeof this.protect!=='function')throw Error('Protected credential storage is unavailable on this host');
    let c;
    if(provider==='cloudflare'){
      if(!/^[a-zA-Z0-9_-]{8,100}$/.test(keyId||'')||typeof token!=='string'||token.length<20||token.length>2000)throw Error('Enter your Cloudflare TURN key ID and API token');
      c={provider,keyId,protectedSecret:await this.protect('protect',token),relayOnly:!!relayOnly};
    }else if(provider==='coturn'){
      if(typeof secret!=='string'||secret.length<32||secret.length>1024||typeof urls!=='string'||urls.length>1000)throw Error('Enter TURN URLs and a shared secret of at least 32 characters');
      iceConfiguration({SEEK_DESKTOP_TURN_URL:urls,SEEK_DESKTOP_TURN_SECRET:secret});
      c={provider,urls,protectedSecret:await this.protect('protect',secret),relayOnly:!!relayOnly};
    }else throw Error('Choose Cloudflare or your own TURN relay');
    // Check credential issuance before replacing the working configuration.
    await this.configuration(c,{deviceId:'setup-check'});
    await mkdir(this.root,{recursive:true});const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(c),{mode:0o600});await rename(tmp,this.file);return this.status();
  }
  async ice(options={}){const c=await this.read();return c?this.configuration(c,options):iceConfiguration(this.env,options);}
  async configuration(c,{deviceId='host'}={}){
    const secret=await this.protect('unprotect',c.protectedSecret);
    if(c.provider==='coturn')return iceConfiguration({SEEK_DESKTOP_TURN_URL:c.urls,SEEK_DESKTOP_TURN_SECRET:secret,SEEK_DESKTOP_RELAY_ONLY:c.relayOnly?'1':'0'},{deviceId});
    if(c.provider!=='cloudflare')throw Error('Unknown desktop relay provider');
    let res;try{res=await this.fetchImpl('https://rtc.live.cloudflare.com/v1/turn/keys/'+encodeURIComponent(c.keyId)+'/credentials/generate-ice-servers',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({ttl:3600}),signal:AbortSignal.timeout(10000)});}catch{throw Error('Cannot reach the relay credential service');}
    if(!res.ok)throw Error('The relay service refused these credentials. Check the TURN key and API token.');
    const data=await res.json();if(!Array.isArray(data.iceServers)||data.iceServers.length>8)throw Error('Invalid relay service response');
    const iceServers=data.iceServers.map(s=>{
      const urls=(Array.isArray(s.urls)?s.urls:[s.urls]);
      if(!urls.length||urls.some(u=>typeof u!=='string'||u.length>200||!/^stun:stun\.cloudflare\.com:\d+$|^turns?:turn\.cloudflare\.com:\d+(?:\?transport=(?:udp|tcp))?$/.test(u)))throw Error('Invalid relay service response');
      const out={urls};if(urls.some(u=>/^turns?:/.test(u))){if(typeof s.username!=='string'||typeof s.credential!=='string'||s.username.length>1000||s.credential.length>1000)throw Error('Invalid relay credentials');out.username=s.username;out.credential=s.credential;}return out;
    });
    if(!iceServers.some(s=>s.urls.some(u=>/^turns?:/.test(u))))throw Error('The relay service returned no TURN server');
    return {iceServers,policy:c.relayOnly?'relay':'all'};
  }
}
