import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';

export function createBridgeService({session,native,token,status,capture,toNative=x=>x,stop}) {
  let busy=false;
  const authenticate=req=>{
    const authorization=req.headers.authorization;
    if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))return false;
    const value=Buffer.from(authorization.slice(7)),expected=Buffer.from(token);
    return value.length===expected.length&&timingSafeEqual(value,expected);
  };
  const server=createServer(async(req,res)=>{
    const json=(code,value)=>{if(res.destroyed)return;res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    const localHost=/^127\.0\.0\.1:\d+$/.test(req.headers.host||'');
    if(req.headers.origin||!localHost||!authenticate(req))return json(403,{error:'Authenticated local agent access only'});
    try{
      if(req.method==='GET'&&req.url==='/status')return json(200,status());
      if(req.method!=='POST')return json(404,{error:'Not found'});
      if(!String(req.headers['content-type']).startsWith('application/json'))return json(415,{error:'Expected JSON'});
      let length=0;const chunks=[];
      for await(const chunk of req){length+=chunk.length;if(length>20000){json(413,{error:'Request too large'});req.resume();return;}chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(400,{error:'Invalid JSON'});}
      if(!body||typeof body!=='object'||Array.isArray(body))return json(400,{error:'Expected an object'});
      if(req.url==='/heartbeat')return json(200,session.heartbeat(body));
      if(req.url==='/stop'){session.check(body);stop('Agent released control');return json(200,status());}
      if(req.url==='/observe'){
        session.check(body);if(busy)throw Error('Wait for the current action to finish');
        const frame=await capture();session.check(body);
        return json(200,{...session.observe(body,frame.display,frame),...frame});
      }
      if(req.url==='/action'){
        if(busy)throw Error('Another action is executing');
        if(!status().capabilities.input)throw Error(status().capabilities.inputReason||'Desktop input is unavailable');
        const command=toNative(session.action(body,body.command));busy=true;
        try{await native.execute(command);session.settled(body);return json(200,{ok:true,requiresFreshObservation:true});}
        catch(e){if(session.state==='agent'&&session.id===body.sessionId)stop('Input interrupted; take over or grant again');throw e;}
        finally{busy=false;}
      }
      return json(404,{error:'Not found'});
    }catch(e){json(409,{error:e.message});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
