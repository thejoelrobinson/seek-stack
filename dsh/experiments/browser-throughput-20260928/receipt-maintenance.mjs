import {writeFile,readFile} from 'node:fs/promises';
const file=new URL('./results/browser-before-restart.json',import.meta.url);
const restore=process.argv.includes('--restore');
const saved=restore?JSON.parse(await readFile(file,'utf8')):null;
await new Promise((resolve,reject)=>{
 const ws=new WebSocket('ws://127.0.0.1:3080/browser/stream');let sent=false;
 const timer=setTimeout(()=>{ws.close();reject(Error('Browser maintenance timeout'));},30000);
 const finish=()=>{clearTimeout(timer);ws.close();resolve();};
 ws.onerror=()=>{clearTimeout(timer);reject(Error('Browser maintenance connection failed'));};
 ws.onmessage=async e=>{
  if(typeof e.data!=='string')return;
  const s=JSON.parse(e.data);if(s.type!=='status')return;
  if(!sent){
   if(s.control==='agent'){clearTimeout(timer);ws.close();reject(Error('Agent still owns browser'));return;}
   sent=true;
   if(restore){if(!saved.running||!saved.url)return finish();ws.send(JSON.stringify({type:'start',url:saved.url}));}
   else{await writeFile(file,JSON.stringify({running:s.running,url:s.url}));if(!s.running)return finish();ws.send(JSON.stringify({type:'stop'}));}
  }else if(restore?s.running:!s.running)finish();
 };
});
console.log(restore?'Browser page restored.':'Browser stopped cleanly; session profile preserved.');
