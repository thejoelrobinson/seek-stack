// Wires the shared calendar into work-server.js: store, CalDAV route, JSON API, reminders, tools.
import {readFile,writeFile} from 'node:fs/promises';
const file=new URL('../../plugins/browser-viewer/lib/work-server.js',import.meta.url);
let t=await readFile(file,'utf8');
const rep=(a,b)=>{const n=t.split(a).length-1;if(n!==1)throw new Error(`expected 1 match, found ${n}: ${a.slice(0,80)}`);t=t.replace(a,()=>b);};

rep(`import {installWorkToolPolicy} from './work-tool-policy.js';`,`import {installWorkToolPolicy} from './work-tool-policy.js';
import {CalendarStore} from './work-calendar.js';
import {CalDAV,DAV_BASE} from './work-caldav.js';
import {DavDevices,DAV_USER,mobileconfig} from './work-dav-auth.js';
import {calendarTools,localText} from './work-calendar-tools.js';`);

rep(`  const finance=await new FinanceService(root,ctx.logger).init();`,`  const finance=await new FinanceService(root,ctx.logger).init();
  // The shared calendar and to-do list (you + Seek), synced with Apple Calendar and Reminders over CalDAV.
  const calendar=await new CalendarStore(root).init(),davDevices=new DavDevices(root),dav=new CalDAV(calendar,{owner:'Seek',log:ctx.logger});
  const profileDownloads=new Map();`);

rep(`    ...financeTools(finance,ctx,{onEvidence:(e,evidence)=>{const t=engine.forAgent(e);recordFinanceEvidence(t,evidence);}})
  ];`,`    ...financeTools(finance,ctx,{onEvidence:(e,evidence)=>{const t=engine.forAgent(e);recordFinanceEvidence(t,evidence);}}),
    ...calendarTools(calendar,register,{forAgent:e=>engine.forAgent(e)})
  ];`);

// CalDAV comes first in the /work route: it has its own methods, bodies and auth (device passwords).
rep(`    const url=new URL(req.url,'http://local');
    if(req.method==='GET'&&url.pathname==='/work/mirror-frame')`,`    const url=new URL(req.url,'http://local');
    if(url.pathname===DAV_BASE||url.pathname.startsWith(DAV_BASE+'/')){
      // From outside, CalDAV arrives only through the proxy, which checked a device password.
      if(!isLocal(req)&&!req.headers['x-seek-dav-device']){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Seek Calendar"','Cache-Control':'no-store'});res.end();return;}
      let body='';if(['PUT','PROPFIND','PROPPATCH','REPORT'].includes(req.method)){const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}body=Buffer.concat(chunks).toString('utf8');}
      const out=await dav.handle(req.method,url.pathname,req.headers,body);
      res.writeHead(out.status,out.headers);res.end(out.body||undefined);return;
    }
    if(req.method==='GET'&&url.pathname==='/work/mirror-frame')`);

rep(`      if(req.method==='GET'&&url.pathname==='/work/api/dreaming') {`,`      if(req.method==='GET'&&url.pathname==='/work/api/calendar'){
        const from=Number(url.searchParams.get('from'))||calendar.midnight(Date.now())-7*86400000,to=Number(url.searchParams.get('to'))||from+42*86400000;
        if(!(to>from)||to-from>400*86400000){json(res,400,{error:'Ask for a range of at most 400 days.'});return;}
        json(res,200,{...calendar.range(from,to),reminders:calendar.activeReminders(),devices:(await davDevices.list()).length});return;}
      if(req.method==='GET'&&url.pathname==='/work/api/calendar/devices'){json(res,200,{devices:await davDevices.list(),server:davHost(req),username:DAV_USER,path:DAV_BASE+'/'});return;}
      if(req.method==='GET'&&url.pathname==='/work/api/calendar/profile'){
        const ticket=profileDownloads.get(url.searchParams.get('ticket')||'');profileDownloads.delete(url.searchParams.get('ticket')||'');
        if(!ticket||ticket.expires<Date.now()){res.writeHead(410,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('This setup link has expired. Create a new one in Seek.');return;}
        res.writeHead(200,{'Content-Type':'application/x-apple-aspen-config','Content-Disposition':'attachment; filename="Seek-Calendar.mobileconfig"','Cache-Control':'no-store'});res.end(mobileconfig(ticket));return;}
      if(req.method==='GET'&&url.pathname==='/work/api/calendar/outbox'){if(!isLocal(req)){json(res,403,{error:'Only local helpers can read the reminder outbox.'});return;}json(res,200,{items:calendar.pending(url.searchParams.get('channel')||'discord')});return;}
      if(req.method==='GET'&&url.pathname==='/work/api/dreaming') {`);

rep(`        else if(url.pathname==='/work/api/dreaming/settings')value=await dreaming.configure(body);`,`        else if(url.pathname==='/work/api/dreaming/settings')value=await dreaming.configure(body);
        else if(url.pathname==='/work/api/calendar/item'){
          const action=String(body.action||'save');
          if(action==='save')value=calendar.save(String(body.kind||''),body.fields||{},{id:body.id||null,source:'you'});
          else if(action==='complete')value=calendar.complete(String(body.id||''),body.done!==false);
          else if(action==='delete')value=calendar.delete(String(body.id||''));
          else throw new Error('Choose save, complete or delete.');
        }
        else if(url.pathname==='/work/api/calendar/reminder')value=calendar.actOnReminder(String(body.key||''),String(body.action||''),body.minutes);
        else if(url.pathname==='/work/api/calendar/settings')value=calendar.configure(body);
        else if(url.pathname==='/work/api/calendar/devices'){
          if(body.action==='revoke')value=await davDevices.revoke(String(body.id||''));
          else if(body.action==='create'){
            const device=await davDevices.create(body.name),ticket=randomUUID();
            // A one-time, ten-minute link to the configuration profile that carries this password.
            profileDownloads.set(ticket,{host:davHost(req),password:device.password,deviceName:device.name,expires:Date.now()+10*60000});
            for(const [k,v] of profileDownloads)if(v.expires<Date.now())profileDownloads.delete(k);
            value={...device,server:davHost(req),path:DAV_BASE+'/',profile:'/work/api/calendar/profile?ticket='+ticket};
          }else throw new Error('Choose create or revoke.');
        }
        else if(url.pathname==='/work/api/calendar/outbox/ack'){if(!isLocal(req))throw new Error('Only local helpers can acknowledge reminders.');value={acknowledged:calendar.delivered(Array.isArray(body.ids)?body.ids:[])};}`);

// Reminders: fire alarms, deliver them, and start Seek's prep work.
rep(`  const secretError=()=>{`,`  // Public host for Apple devices: the request's own host, or the configured public host when on this PC.
  const davHost=req=>{let h='';try{h=new URL('http://'+(req.headers['x-forwarded-host']||req.headers.host||'')).hostname;}catch{}return isLocal(req)||!h?(trusted.find(x=>!/^(localhost|127\\.|\\[::1\\])/.test(x))||h||'localhost').replace(/:\\d+$/,''):h;};
  calendar.onChange(()=>updates.refresh());
  const whenText=(ms,allDay)=>allDay?new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:calendar.zone}).format(new Date(ms)):new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:calendar.zone}).format(new Date(ms));
  let remindersBusy=false;
  const reminderTimer=setInterval(async()=>{
    if(remindersBusy)return;remindersBusy=true;
    try{
      const {fired,prep}=calendar.scan(),settings=calendar.settings();
      for(const r of fired){
        const item=(()=>{try{return calendar.summary(calendar.find(r.id));}catch{return null;}})(),allDay=!!item?.allDay;
        const body=r.kind==='todo'?(r.start?\`Due \${whenText(r.start,allDay)}\`:'To-do'):\`\${whenText(r.start,allDay)}\${item?.location?' · '+item.location:''}\`;
        if(settings.push&&engine.store.settings.notifications!==false)void push.notify({title:r.kind==='todo'?\`To-do: \${r.title}\`:r.title,body,tag:'cal-'+r.key.slice(0,60)});
        if(settings.discord)calendar.enqueue('discord',{key:r.key,kind:r.kind,title:r.title,when:body,id:r.id});
      }
      for(const p of prep){
        const when=whenText(p.start,p.allDay);
        const objective=\`Get ready for "\${p.title}" (\${when}\${p.location?', at '+p.location:''}). \${p.instruction}\\n\\nThis preparation was started automatically from the shared calendar\${p.notes?'. Notes on the item: '+p.notes.slice(0,600):''}. Research, compare and draft only: do not buy, book, send or sign up for anything. Finish with a short summary of what you prepared and what still needs the user's decision.\`;
        const task=await engine.operation(async()=>{const t=await engine.create({objective,mode:'task'});t.proactive={calendar:p.uid,occurrence:p.occurrence};t.title=\`Prepared: \${p.title}\`.slice(0,90);await engine.save();return t;});
        calendar.markPrepStarted(p.uid,p.occurrence,task.id);
        if(engine.store.settings.notifications!==false)void push.notify({title:\`Getting ready: \${p.title}\`,body:\`Seek started preparing for \${when}.\`,taskId:task.id,tag:'prep-'+task.id});
      }
    }catch(e){ctx.logger.warn('Calendar reminders: '+e.message);}
    finally{remindersBusy=false;}
  },20000);
  const secretError=()=>{`);

rep(`clearInterval(notifier);off();`,`clearInterval(notifier);clearInterval(reminderTimer);off();`);
rep(`await engine.persistence.close?.();authority.close();`,`await engine.persistence.close?.();authority.close();calendar.close();`);
await writeFile(file,t);console.log('server patched');
