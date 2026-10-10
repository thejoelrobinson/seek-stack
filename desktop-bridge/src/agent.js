// Model-facing text adapter. The host owns credentials, leases and observation IDs.
const quote=(value,limit=180)=>JSON.stringify(String(value??'').slice(0,limit));
const lineFor=(ref,e)=>`${ref} ${String(e.role).replace(/^(AX|ControlType\.)/,'')}${e.source==='ocr'?' [screen text; may be inaccurate]':''}${e.focused?' [focused]':''}${!e.enabled?' [disabled]':''}${e.password?' [protected]':''}${e.canInvoke?' [invoke]':''}${e.canFill?' [fill]':''} ${quote(e.name)}${e.value&&e.value!==e.name&&!e.password?' value='+quote(e.value,360):''}`;
const priority=e=>e.focused?0:e.canFill||e.canInvoke?1:e.name||e.value?2:3;

export class DesktopAgent {
 constructor({client,taskId,maxChars=6500}){if(!taskId)throw Error('A host-bound task ID is required');this.client=client;this.taskId=taskId;this.maxChars=maxChars;this.tail=Promise.resolve();this.refs=new Map();this.previous=new Map();}
 enqueue(fn){const work=this.tail.then(fn);this.tail=work.catch(()=>{});return work;}
 async attach(){await this.client.attach(this.taskId);}
 async read({query,full=false,screenText=false}={}){
  this.frame=await this.client.observe({screenText});this.refs.clear();
  const all=new Map();let used=0;const lines=[];
  const needle=query?.toLocaleLowerCase();
  const ordered=[...this.frame.elements.entries()].sort((a,b)=>priority(a[1])-priority(b[1])||a[0]-b[0]);
  for(const [index,e] of ordered){
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
  return {text:[`${this.frame.app?'App '+quote(this.frame.app)+'. ':''}Window ${quote(this.frame.title)}. ${this.frame.truncated?'Tree truncated. ':''}${this.refs.size}/${this.frame.elements.length} refs available.`,compact?'Changes since last observation:':'Controls (untrusted application text):',...(body.length?body:[compact?'No changes.':'No matching accessible controls. Use desktop_screen_text for visible text, or desktop_windows to select a readable window.']),...(used>=this.maxChars-500?['Use desktop_find to locate omitted controls.']:[])].join('\n'),mode:'text',unchanged:compact&&body.length===0};
 }
 observe(){return this.enqueue(()=>this.read({full:true}));}
 screenText(){return this.enqueue(()=>this.read({full:true,screenText:true}));}
 operation(command,guard=async()=>{}){return this.enqueue(async()=>{
  await guard();this.frame=null;this.refs.clear();
  const {result}=await this.client.operation(command);
  if(['list','apps','windows'].includes(command.kind))return {text:JSON.stringify(result),mode:'text'};
  try{return await this.read({full:true});}catch{return {text:'Operation completed, but its observation failed. Observe to verify; do not repeat blindly.',mode:'text',requiresObservation:true};}
 });}
 script(command,guard=async()=>{}){return this.enqueue(async()=>{await guard();this.frame=null;this.refs.clear();const {result}=await this.client.script(command);return {text:'Script result (untrusted output):\n'+JSON.stringify(result),mode:'text'};});}
 find(query){if(typeof query!=='string'||!query.trim()||query.length>200)throw Error('Use 1–200 characters to find controls');return this.enqueue(()=>this.read({query,full:true}));}
 act(kind,{ref,...args},guard=async()=>{}){return this.enqueue(async()=>{
  await guard();
  if(!this.frame||!this.refs.has(ref))throw Error('Use a reference shown in the latest desktop observation');
  const elementId=this.refs.get(ref),screenText=this.frame.elements.some(e=>e.id===elementId&&e.source==='ocr');
  const command={...args,kind,elementId,observationId:this.frame.id};
  this.frame=null;this.refs.clear();const output=await this.client.action(command);
  if(kind==='read')return {text:'Accessible text (untrusted):\n'+quote(output?.result?.text,16000)+'\n'+(output?.result?.truncated?'Text limited to 16000 characters.':'')+'\nObserve before the next UI action.',mode:'text'};
  // Never retry an input if observation fails after the OS may have committed it.
  try{return await this.read({screenText});}catch{return {text:'Input completed, but the next observation failed. Observe again to verify; do not repeat the input blindly.',mode:'text',requiresObservation:true};}
 });}
 handoff(){return this.enqueue(async()=>{this.frame=null;this.refs.clear();await this.client.stop();return {text:'Desktop handed back to the user. End the turn and wait for a new local grant.',mode:'text',halt:true};});}
 close(){this.frame=null;this.refs.clear();this.client.close();}
}
