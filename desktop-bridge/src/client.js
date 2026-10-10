// Host-side adapter. Credentials belong to the runtime, never the model context.
export class DesktopBridgeClient {
 constructor({endpoint,token,fetchImpl=fetch}){const u=new URL(endpoint);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.port==='0'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Only local bridge endpoints are supported');this.endpoint=u.origin;this.token=token;this.fetch=fetchImpl;}
 async request(path,body){const r=await this.fetch(this.endpoint+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+this.token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(path==='/script'?65000:10000)});const v=await r.json();if(!r.ok)throw Error(v.error||'Bridge request failed');return v;}
 async attach(taskId){this.close();const generation=this.generation;const s=await this.request('/status');if(generation!==this.generation)throw Error('Attachment cancelled');if(s.state!=='agent'||s.taskId!==taskId)throw Error('Grant this task desktop control in the local companion first');const auth={sessionId:s.sessionId,epoch:s.epoch};this.auth=auth;this.timer=setInterval(()=>{void this.request('/heartbeat',auth).catch(()=>{if(this.auth===auth)this.close();});},4000);this.timer.unref?.();return s;}
 observe(options={}){if(!this.auth)throw Error('Not attached');return this.request('/observe',{...options,...this.auth});}
 operation(command){if(!this.auth)throw Error('Not attached');return this.request('/operation',{...this.auth,command});}
 script(command){if(!this.auth)throw Error('Not attached');return this.request('/script',{...this.auth,command});}
 allowScripts(){if(!this.auth)throw Error('Not attached');return this.request('/script-grant',this.auth);}
 action(command){if(!this.auth)throw Error('Not attached');return this.request('/action',{...this.auth,command});}
 async stop(){const auth=this.auth;this.close();if(!auth)throw Error('Not attached');return this.request('/stop',auth);}
 close(){this.generation=(this.generation||0)+1;clearInterval(this.timer);this.timer=null;this.auth=null;}
}
