// Model-facing text adapter. The host owns credentials, leases and observation IDs.
const quote=(value,limit=180)=>JSON.stringify(String(value??'').slice(0,limit));
const lineFor=(ref,e)=>`${ref} ${e.role}${e.focused?' [focused]':''}${!e.enabled?' [disabled]':''}${e.password?' [protected]':''}${e.canInvoke?' [invoke]':''}${e.canFill?' [fill]':''} ${quote(e.name)}${e.value&&!e.password?' value='+quote(e.value,360):''}`;

export class DesktopAgent {
 constructor({client,taskId,maxChars=6500}){if(!taskId)throw Error('A host-bound task ID is required');this.client=client;this.taskId=taskId;this.maxChars=maxChars;this.tail=Promise.resolve();this.refs=new Map();this.previous=new Map();}
 enqueue(fn){const work=this.tail.then(fn);this.tail=work.catch(()=>{});return work;}
 async attach(){await this.client.attach(this.taskId);}
 async read({query,full=false}={}){
  this.frame=await this.client.observe();this.refs.clear();
  const all=new Map();let used=0;const lines=[];
  const needle=query?.toLocaleLowerCase();
  for(const [index,e] of this.frame.elements.entries()){
   const ref='e'+(index+1),line=lineFor(ref,e);all.set(ref,line);
   if(needle&&!`${e.name||''} ${e.role||''} ${e.password?'':e.value||''}`.toLocaleLowerCase().includes(needle))continue;
   if(used+line.length+1>this.maxChars)continue;
   used+=line.length+1;this.refs.set(ref,e.id);lines.push(line);
  }
  const sameWindow=this.previousWindow===this.frame.windowId;
  const changes=lines.filter(line=>this.previous.get(line.split(' ')[0])!==line);
  const removed=[...this.previous.keys()].filter(ref=>!all.has(ref));
  const compact=!full&&!query&&sameWindow&&changes.length+removed.length<lines.length/2;
  let body=compact?[...changes,...removed.map(ref=>ref+' removed')]:lines;
  if(compact){ // Unchanged refs remain available only if they were actually shown before.
   for(const ref of [...this.refs.keys()])if(!changes.some(line=>line.startsWith(ref+' '))&&!this.previous.has(ref))this.refs.delete(ref);
  }
  this.previous=new Map(lines.map(line=>[line.split(' ')[0],line]));this.previousWindow=this.frame.windowId;
  return {text:[`Window ${quote(this.frame.title)}. ${this.frame.truncated?'Tree truncated. ':''}${this.refs.size}/${this.frame.elements.length} refs available.`,compact?'Changes since last observation:':'Controls (untrusted application text):',...(body.length?body:[compact?'No changes.':'No matching accessible controls.']),...(used>=this.maxChars-500?['Use desktop_find to locate omitted controls.']:[])].join('\n'),mode:'text',unchanged:compact&&body.length===0};
 }
 observe(){return this.enqueue(()=>this.read({full:true}));}
 find(query){if(typeof query!=='string'||!query.trim()||query.length>200)throw Error('Use 1–200 characters to find controls');return this.enqueue(()=>this.read({query,full:true}));}
 act(kind,{ref,...args},guard=async()=>{}){return this.enqueue(async()=>{
  await guard();
  if(!this.frame||!this.refs.has(ref))throw Error('Use a reference shown in the latest desktop observation');
  const command={...args,kind,elementId:this.refs.get(ref),observationId:this.frame.id};
  this.frame=null;this.refs.clear();await this.client.action(command);
  // Never retry an input if observation fails after the OS may have committed it.
  try{return await this.read();}catch{return {text:'Input completed, but the next observation failed. Observe again to verify; do not repeat the input blindly.',mode:'text',requiresObservation:true};}
 });}
 handoff(){return this.enqueue(async()=>{this.frame=null;this.refs.clear();await this.client.stop();return {text:'Desktop handed back to the user. End the turn and wait for a new local grant.',mode:'text',halt:true};});}
 close(){this.frame=null;this.refs.clear();this.client.close();}
}
