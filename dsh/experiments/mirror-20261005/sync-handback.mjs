// Joel has explicitly handed back for this release. Touch control state only.
const ws=new WebSocket('ws://127.0.0.1:3080/browser/stream');
let sent=false,finished=false;
const finish=(code,message)=>{if(finished)return;finished=true;clearTimeout(timer);console.log(message);process.exitCode=code;ws.close();};
const timer=setTimeout(()=>finish(1,'Hand-back did not reach idle state'),10000);
ws.addEventListener('error',()=>finish(1,'Browser status unavailable'));
ws.addEventListener('message',event=>{
  if(typeof event.data!=='string')return;
  let m;try{m=JSON.parse(event.data);}catch{return;}
  if(m.type!=='status')return;
  if(m.handoff||m.approval||m.control==='agent')return finish(2,'Browser has another active action; release not applied');
  if(m.control==='idle')return finish(0,'Authorized hand-back synchronized; browser idle');
  if(m.control==='user'&&!sent){sent=true;ws.send(JSON.stringify({type:'handback'}));}
});
