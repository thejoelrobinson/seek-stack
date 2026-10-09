import {readFile,writeFile} from 'node:fs/promises';
const f=new URL('../../proxy/server.js',import.meta.url);let t=await readFile(f,'utf8');
const rep=(a,b)=>{const n=t.split(a).length-1;if(n!==1)throw new Error(`expected 1 match, found ${n}: ${a.slice(0,80)}`);t=t.replace(a,()=>b);};
const CRLF='\\r\\n',BT='`',D='$';
// End refusals gracefully so Cloudflare relays the 401 instead of reporting a 502.
rep("if (!device) { securityEvent('desktop.link_refused', req); socket.write('HTTP/1.1 401 Unauthorized"+CRLF+"Connection: close"+CRLF+CRLF+"'); return socket.destroy(); }",
    "if (!device) { securityEvent('desktop.link_refused', req); return socket.end('HTTP/1.1 401 Unauthorized"+CRLF+"Content-Length: 0"+CRLF+"Connection: close"+CRLF+CRLF+"'); }");
rep("proxyReq.on('response', r => { socket.write("+BT+"HTTP/1.1 "+D+"{r.statusCode} Refused"+CRLF+"Connection: close"+CRLF+CRLF+BT+"); socket.destroy(); });",
    "proxyReq.on('response', r => { r.resume(); socket.end("+BT+"HTTP/1.1 "+D+"{r.statusCode} Refused"+CRLF+"Content-Length: 0"+CRLF+"Connection: close"+CRLF+CRLF+BT+"); });");
await writeFile(f,t);console.log('patched');
