// Shared HTTP/WebSocket fence. Authentication still belongs to the reverse proxy.
const header=(headers,name)=>headers instanceof Headers?headers.get(name)??undefined:typeof headers?.[name]==='string'?headers[name]:undefined;
const authority=value=>{try{return new URL('http://'+value);}catch{return null;}};
const canonical=(entry,url)=>{const port=url.port||new URL('https://'+entry).port;return port?url.hostname+':'+port:url.hostname;};
const loopback=host=>host==='localhost'||host==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(host)&&host.split('.').every(part=>Number(part)<=255);
export function assertTrustedAuthority(entry){const url=authority(entry);if(!url||canonical(entry,url)!==entry.toLowerCase())throw new Error('browser-viewer: trustedHosts must contain bare host[:port] authorities.');}
export function isTrustedApiRequest(request,trustedHosts=[]){
  const host=header(request.headers,'host'),url=host&&authority(host);if(!url)return false;
  if(!loopback(url.hostname)&&!trustedHosts.some(entry=>{const allowed=authority(entry);return allowed&&(canonical(entry,allowed)===allowed.hostname?allowed.hostname===url.hostname:allowed.host===url.host);}))return false;
  if(header(request.headers,'sec-fetch-site')==='cross-site')return false;
  const origin=header(request.headers,'origin');if(origin===undefined)return true;
  try{return new URL(origin).host===url.host;}catch{return false;}
}
