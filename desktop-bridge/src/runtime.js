import {readFile} from 'node:fs/promises';
import {DesktopBridgeClient} from './client.js';
import {DesktopAgent} from './agent.js';

export class DesktopRuntime {
 constructor({connectionFile,resolveOwner,readFileImpl=readFile,clientFactory=options=>new DesktopBridgeClient(options)}){
  if(!connectionFile||typeof resolveOwner!=='function')throw Error('Host configuration and a task ownership resolver are required');
  this.connectionFile=connectionFile;this.resolveOwner=resolveOwner;this.readFile=readFileImpl;this.clientFactory=clientFactory;
 }
 async owner(exec){
  const owner=await this.resolveOwner(exec);
  if(!owner||owner.child||!owner.taskId||!owner.sessionId||owner.sessionId!==exec?.agent?.id||!['running','waiting','queued'].includes(owner.status))throw Error('Desktop control is available only to the active parent task');
  return owner;
 }
 async createClient(){
  const text=await this.readFile(this.connectionFile,'utf8');if(text.length>4096)throw Error('Invalid desktop connection configuration');
  const connection=JSON.parse(text);if(typeof connection.token!=='string'||!/^[a-f0-9]{64}$/.test(connection.token))throw Error('Invalid desktop connection credential');
  return this.clientFactory({endpoint:connection.endpoint,token:connection.token});
 }
 async status(exec){
  const owner=await this.owner(exec),client=await this.createClient();
  const status=await client.request('/status');
  return {text:JSON.stringify({taskId:owner.taskId,granted:status.state==='agent'&&status.taskId===owner.taskId,activity:status.taskId===owner.taskId?status.activity:'Local desktop grant required',capabilities:status.capabilities}),mode:'text'};
 }
 async forExecution(exec){
  exec?.signal?.throwIfAborted();const owner=await this.owner(exec);
  if(this.current&&this.current.taskId===owner.taskId&&this.ownerSession===owner.sessionId&&this.current.client.auth)return this.current;
  // Attach races are fenced: never replace an in-flight owner using a second tool call.
  if(this.attaching)throw Error('Desktop attachment is in progress');
  this.attaching=true;
  try{
   this.current?.close();this.current=null;const client=await this.createClient();
   const agent=new DesktopAgent({client,taskId:owner.taskId});
   try{await agent.attach();exec?.signal?.throwIfAborted();}catch(e){agent.close();throw e;}
   this.current=agent;this.ownerSession=owner.sessionId;
   clearInterval(this.watchdog);this.watchdog=setInterval(async()=>{
    if(this.current!==agent)return;
    try{await this.owner(exec);}catch{
     if(this.current!==agent)return;
     this.current=null;clearInterval(this.watchdog);
     try{await agent.client.stop();}catch{}finally{agent.close();}
    }
   },1000);this.watchdog.unref?.();return agent;
  }finally{this.attaching=false;}
 }
 close(){clearInterval(this.watchdog);const current=this.current;this.current=null;if(current?.client.auth)void current.client.stop().catch(()=>{});current?.close();}
}
