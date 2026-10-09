const ws=new WebSocket('ws://127.0.0.1:3080/browser/stream');
const timeout=setTimeout(()=>{console.error('Browser status unavailable');ws.close();process.exitCode=1;},5000);
ws.addEventListener('error',()=>{clearTimeout(timeout);console.error('Browser status unavailable');process.exitCode=1;});
ws.addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}if(m.type!=='status')return;clearTimeout(timeout);console.log(JSON.stringify({control:m.control,running:m.running,mirror:m.mirror,handoff:!!m.handoff,approval:!!m.approval}));if(m.control==='user'||m.control==='agent'||m.handoff||m.approval)process.exitCode=2;ws.close();});
