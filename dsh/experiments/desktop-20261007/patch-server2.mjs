// Wires paired computers (work-desktop.js) into work-server.js.
import {readFile,writeFile} from 'node:fs/promises';
const f=new URL('../../plugins/browser-viewer/lib/work-server.js',import.meta.url);let t=await readFile(f,'utf8');
const rep=(a,b)=>{const n=t.split(a).length-1;if(n!==1)throw new Error(`expected 1 match, found ${n}: ${a.slice(0,90)}`);t=t.replace(a,()=>b);};
rep(`import {buildDesktopTools} from './desktop/tools.js';`,`import {buildDesktopTools} from './desktop/tools.js';
import {DesktopDevices,DesktopHub,DesktopControl} from './work-desktop.js';
import {WebSocketServer} from 'ws';`);
rep(`    resolveOwner:exec=>{const t=engine.store.tasks.find(x=>x.sessionId===exec?.agent?.id);if(!t||t.eval||t.proactive)return null;return {taskId:t.id,sessionId:t.sessionId,status:t.status,child:false};}});`,
`    resolveOwner:exec=>{const t=engine.store.tasks.find(x=>x.sessionId===exec?.agent?.id);if(!t||t.eval||t.proactive)return null;return {taskId:t.id,sessionId:t.sessionId,status:t.status,child:false};}});
  // Computers paired from anywhere (Settings › Computers) reach Seek over one authenticated link each.
  const desktopDevices=new DesktopDevices(root),desktopHub=new DesktopHub({devices:desktopDevices,log:ctx.logger});
  const desktopControl=new DesktopControl({hub:desktopHub,local:desktop,
    resolveOwner:exec=>{const t=engine.store.tasks.find(x=>x.sessionId===exec?.agent?.id);if(!t||t.eval||t.proactive)return null;return {taskId:t.id,sessionId:t.sessionId,status:t.status,child:false};},
    // No computer allows this task yet: ask the user (Seek, the Inbox, Discord), and the computers themselves.
    requestGrant:async(o,exec)=>{
      const t=engine.task(o.taskId),online=desktopHub.online().filter(m=>!m.busy);
      if(!online.length){const local=await desktopControl.localStatus();return local?\`Seek Desktop is running on this PC but is not paired. Ask the user to allow task \${t.id} in Seek Desktop (Advanced › Give a task control by ID), or pair it in Settings › Computers.\`:'No computer is connected to Seek. Ask the user to install Seek Desktop and pair it in Settings › Computers, then try again.';}
      if(t.desktopAsk&&t.status==='waiting')return 'Still waiting for the user to allow desktop control. End your turn.';
      const remote=online.filter(m=>m.remoteGrant),choices=[...remote.map(m=>\`Allow on \${m.name}\`),'Not now'];
      desktopHub.ask(t);
      const where=online.length===1?online[0].name:'one of your computers';
      await engine.operation(async()=>{await engine.ask(exec,{question:\`Allow Seek to use \${where} for “\${t.title}”? It shares that computer’s mouse and keyboard; press Ctrl+Alt+Shift+S there to take over any time.\${remote.length<online.length?' Seek Desktop on the computer also shows Allow.':''}\`,choices});t.desktopAsk={at:Date.now(),choices:Object.fromEntries(remote.map(m=>[\`Allow on \${m.name}\`,m.id]))};await engine.save();});
      return \`Asked the user to allow desktop control on \${online.map(m=>m.name).join(' or ')}. End your turn now; their answer comes back to you.\`;
    }});
  // An answer given on the computer itself continues the waiting task.
  desktopHub.on(ev=>{
    if(ev.type!=='answer')return;
    const t=engine.store.tasks.find(x=>x.id===ev.taskId);if(!t?.desktopAsk||t.status!=='waiting')return;
    t.desktopAsk=null;desktopHub.cancel(t.id);
    void engine.operation(()=>engine.control(t.id,'reply',ev.allowed?\`Allowed on \${ev.name}. Desktop control of that computer is granted now; continue with the desktop tools.\`:\`Not now. The user declined desktop control on \${ev.name}; continue without the desktop or explain what you need.\`,undefined,[],{fastAck:true})).catch(e=>ctx.logger.warn('Desktop answer: '+e.message));
  });
  const linkSockets=new WebSocketServer({noServer:true,maxPayload:512*1024});
  const offDesktopLink=ctx.webServer.registerUpgrade({path:'/work/desktop/link',handler:async(req,socket,head)=>{
    const deny=code=>{try{socket.write(\`HTTP/1.1 \${code} \${code===401?'Unauthorized':'Forbidden'}\\r\\nConnection: close\\r\\n\\r\\n\`);}catch{}socket.destroy();};
    if(!isTrusted(req,trusted))return deny(403);
    const m=/^Bearer\\s+(\\S+)$/.exec(String(req.headers.authorization||''));const device=m?await desktopDevices.verify(m[1]).catch(()=>null):null;
    if(!device)return deny(401);
    linkSockets.handleUpgrade(req,socket,head,ws=>desktopHub.attach(ws,device));
  }});
  const downloadsRoot=join(root,'downloads');`);
rep(`    ...buildDesktopTools({defineTool,runtime:desktop}).map(def=>ctx.tools.register(def))`,`    ...buildDesktopTools({defineTool,runtime:desktopControl}).map(def=>ctx.tools.register(def))`);
rep(`clearInterval(reminderTimer);desktop.close();off();`,`clearInterval(reminderTimer);desktopControl.close();desktop.close();desktopHub.close();offDesktopLink?.();linkSockets.close();off();`);
// Pairing (outside /work/api: a new computer has no Seek session, only the one-time code) and installer downloads.
rep(`    if(req.method==='GET'&&url.pathname==='/work/mirror-frame')`,`    if(url.pathname==='/work/desktop/pair'){
      if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return;}
      try{const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>8192)throw new Error('Request is too large.');chunks.push(chunk);}
        json(res,200,await desktopHub.pair(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')));void security.record('desktop.paired',{},{local:isLocal(req)});}
      catch(e){void security.record('desktop.pair_failed',{},{local:isLocal(req)});json(res,400,{error:e.message});}
      return;
    }
    if(req.method==='GET'&&url.pathname.startsWith('/work/downloads/')){
      const name=decodeURIComponent(url.pathname.slice('/work/downloads/'.length));
      const manifest=JSON.parse(await readFile(join(downloadsRoot,'manifest.json'),'utf8').catch(()=>'{"files":[]}'));
      const entry=(manifest.files||[]).find(x=>x.name===name);
      if(!entry||!/^[\\w.@+-]+$/.test(name)){json(res,404,{error:'Not found'});return;}
      const info=await stat(join(downloadsRoot,name)).catch(()=>null);if(!info){json(res,404,{error:'Not found'});return;}
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':info.size,'Content-Disposition':\`attachment; filename="\${name}"\`,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});
      const {createReadStream}=await import('node:fs');createReadStream(join(downloadsRoot,name)).pipe(res);return;
    }
    if(req.method==='GET'&&url.pathname==='/work/mirror-frame')`);
rep(`      if(req.method==='GET'&&url.pathname==='/work/api/calendar/devices'){`,`      if(req.method==='GET'&&url.pathname==='/work/api/desktop'){
        const manifest=JSON.parse(await readFile(join(downloadsRoot,'manifest.json'),'utf8').catch(()=>'{"files":[]}'));
        json(res,200,{computers:await desktopHub.machines(),downloads:manifest,thisPc:!!(await desktopControl.localStatus())});return;}
      if(req.method==='GET'&&url.pathname==='/work/api/calendar/devices'){`);
rep(`        else if(url.pathname==='/work/api/calendar/reminder')`,`        else if(url.pathname==='/work/api/desktop/code')value=desktopHub.createCode();
        else if(url.pathname==='/work/api/desktop/device'){if(body.action!=='remove')throw new Error('Choose remove.');await desktopHub.remove(String(body.id||''));value={removed:true};}
        else if(url.pathname==='/work/api/calendar/reminder')`);
// A reply to "Allow Seek to use …?" grants on that computer before the agent hears the answer.
rep(`    if(t.approval&&body.action==='reply')throw new Error('Choose Approve once, For this task, Always on this site or Reject.');`,`    if(t.approval&&body.action==='reply')throw new Error('Choose Approve once, For this task, Always on this site or Reject.');
    if(t.desktopAsk&&body.action==='reply'){
      const choice=String(body.answer||''),deviceId=t.desktopAsk.choices?.[choice];
      t.desktopAsk=null;desktopHub.cancel(t.id);
      if(deviceId){try{await desktopHub.grant(deviceId,t);body={...body,answer:\`\${choice}: the user allowed it. Desktop control of that computer is granted now; continue with the desktop tools.\`};}
        catch(e){body={...body,answer:\`\${choice} did not work: \${e.message} Tell the user, and do not use the desktop until they allow it again.\`};}}
      else if(choice==='Not now')body={...body,answer:'Not now. The user declined desktop control; continue without the desktop or explain what you need.'};
    }`);
await writeFile(f,t);console.log('server patched');
