import {readFile,writeFile} from 'node:fs/promises';
const [port,path]=String(await readFile(process.env.SEEK_BROWSER_PORT_FILE,'utf8')).trim().split(/\r?\n/);
const socket=new WebSocket(`ws://127.0.0.1:${port}${path}`);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
await writeFile(new URL('./runtime-backup/browser-tabs.json',import.meta.url),JSON.stringify(pages.filter(t=>t.type==='page').map(t=>({url:t.url,title:t.title})),null,2));
socket.send(JSON.stringify({id:1,method:'Browser.close'}));await new Promise(resolve=>{socket.onclose=resolve;setTimeout(resolve,3000);});socket.close();console.log('Seek browser closed and its tab inventory backed up.');
