// Network options for the link, so it works where the browser does: through the system's proxy
// (as Chromium resolves it, including PAC files) and trusting certificates installed in the
// operating system (needed on networks that inspect HTTPS with their own root certificate).
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

let caCache=null;
export function trustedCertificates(){
  if(caCache)return caCache;
  let system=[];try{system=tls.getCACertificates('system');}catch{}
  return caCache=[...new Set([...tls.rootCertificates,...system])];
}
/** "PROXY host:port; DIRECT" (Chromium's format) → the first HTTP proxy, or null for direct. */
export function firstProxy(spec){
  for(const part of String(spec||'').split(';').map(s=>s.trim())){
    const m=/^(PROXY|HTTPS)\s+([^\s:]+):(\d+)$/i.exec(part);if(m)return {host:m[2],port:Number(m[3]),secure:m[1].toUpperCase()==='HTTPS'};
    if(/^DIRECT$/i.test(part))return null;
  }
  return null;
}
/** An agent that reaches the target through an HTTP CONNECT tunnel, then speaks TLS to the target. */
export class ConnectAgent extends https.Agent{
  constructor(proxy,options={}){super(options);this.proxy=proxy;}
  createConnection(options,callback){
    const target=`${options.host}:${options.port||443}`;
    const req=(this.proxy.secure?https:http).request({host:this.proxy.host,port:this.proxy.port,method:'CONNECT',path:target,headers:{Host:target},ca:options.ca,timeout:15000});
    req.once('connect',(res,socket)=>{
      if(res.statusCode!==200){socket.destroy();callback(new Error(`The network proxy refused the connection (${res.statusCode})`));return;}
      callback(null,tls.connect({socket,servername:options.servername||options.host,ca:options.ca}));
    });
    req.once('timeout',()=>req.destroy(new Error('The network proxy did not answer')));
    req.once('error',callback);req.end();
  }
}
/** WebSocket options for a wss:// URL: system certificates, plus the proxy Chromium would use. */
export async function linkOptions(url,{resolveProxy}={}){
  const u=new URL(url);if(u.protocol!=='wss:')return {};
  const ca=trustedCertificates();
  let proxy=null;try{proxy=firstProxy(await resolveProxy?.(u.href.replace(/^wss:/,'https:')));}catch{}
  return proxy?{ca,agent:new ConnectAgent(proxy,{ca})}:{ca};
}
