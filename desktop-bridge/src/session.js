import {randomUUID} from 'node:crypto';
import {shortcut} from './operations.js';
export class DesktopSession {
  constructor({clock=Date.now,onState=()=>{}}={}) {this.clock=clock;this.onState=onState;this.epoch=0;this.state='idle';this.held=new Set();}
  emit(){this.onState(this.snapshot());}
  snapshot(){return {state:this.state,epoch:this.epoch,taskId:this.taskId||null,sessionId:this.id||null,scriptsAllowed:!!this.scriptsAllowed,expiresAt:this.expiresAt||null,activity:this.activity||'Ready',cursor:this.cursor||null};}
  grant(taskId){if(typeof taskId!=='string'||!taskId.trim()||taskId.length>200)throw Error('A task ID is required');if(this.state==='agent')throw Error('A task already owns the desktop');this.epoch++;this.id=randomUUID();this.taskId=taskId;this.state='agent';this.expiresAt=this.clock()+15000;this.observation=null;this.activity='Agent has control';this.emit();return this.snapshot();}
  check(auth){if(this.state!=='agent'||this.clock()>=this.expiresAt){if(this.state==='agent')this.revoke('Connection expired');throw Error('Desktop control is paused');}if(!auth||auth.sessionId!==this.id||auth.epoch!==this.epoch)throw Error('Stale control session');}
  heartbeat(auth){this.check(auth);this.expiresAt=this.clock()+15000;return this.snapshot();}
  allowScripts(auth){this.check(auth);this.scriptsAllowed=true;this.emit();return this.snapshot();}
  checkScripts(auth){this.check(auth);if(!this.scriptsAllowed)throw Error('Scripting needs your approval for this task');}
  observe(auth,display,frame={}){this.check(auth);this.observation={id:randomUUID(),at:this.clock(),display:{...display},elements:(frame.elements||[]).map(e=>({...e})),windowId:frame.windowId};return this.observation;}
  action(auth,command){
    this.check(auth);
    if(!command||!this.observation||command.observationId!==this.observation.id||this.clock()-this.observation.at>30000)throw Error('Take a fresh observation before acting');
    if(!['move','click','scroll','type','key','invoke','fill','shortcut','read'].includes(command.kind))throw Error('Unsupported input');
    const d=this.observation.display,result={kind:command.kind,windowId:this.observation.windowId};
    if(this.observation.windowId&&!command.elementId&&command.kind!=='shortcut')throw Error('Choose an element from the structured observation');
    if(command.elementId)result.targetId=command.elementId;
    if(command.elementId){const element=this.observation.elements.find(e=>e.id===command.elementId);if(!element||!element.enabled||element.password)throw Error('Element is unavailable or protected');if(command.kind==='invoke'&&!element.canInvoke||command.kind==='fill'&&!element.canFill)throw Error('This control does not support the requested accessibility action');if(['move','click','scroll'].includes(command.kind))command={...command,x:element.x+element.width/2,y:element.y+element.height/2};else if(['type','key'].includes(command.kind)&&!element.focused)throw Error('Focus the target element before typing or pressing a key');}
    else if(['invoke','fill'].includes(command.kind))throw Error('An accessible target is required');
    if(['move','click','scroll'].includes(command.kind)){
      if(!Number.isFinite(command.x)||!Number.isFinite(command.y)||command.x<0||command.y<0||command.x>=d.width||command.y>=d.height)throw Error('Coordinates are outside the selected display');
      result.x=Math.round(d.x+command.x);result.y=Math.round(d.y+command.y);
    }
    if(['type','fill'].includes(command.kind)){
      if(typeof command.text!=='string'||(command.kind==='type'&&!command.text.length)||command.text.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(command.text))throw Error('Text must contain at most 4000 printable characters');result.text=command.text;
    }
    if(command.elementId&&['type','key'].includes(command.kind))result.focusId=command.elementId;
    if(command.kind==='scroll'){
      if(!Number.isFinite(command.delta)||!Number.isInteger(command.delta)||Math.abs(command.delta)>1200||!command.delta)throw Error('Invalid scroll amount');result.delta=command.delta;
    }
    if(command.kind==='click'){if(!['left','right'].includes(command.button||'left'))throw Error('Invalid button');result.button=command.button||'left';}
    if(command.kind==='key'){if(!['Enter','Escape','Tab','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(command.key))throw Error('Unsupported key');result.key=command.key;}
    if(command.kind==='shortcut')Object.assign(result,shortcut(command));
    // Consume before execution so an observation cannot authorize two racing inputs.
    this.observation=null;
    if(result.x!==undefined)this.cursor={x:result.x,y:result.y};
    this.activity=['type','fill'].includes(command.kind)?'Typing':command.kind==='key'?'Pressing a key':'Using the desktop';this.emit();return result;
  }
  settled(auth){this.check(auth);this.activity='Agent has control';this.emit();}
  revoke(reason='You have control'){this.epoch++;this.state='human';this.activity=reason;this.observation=null;this.scriptsAllowed=false;this.cursor=null;this.expiresAt=null;this.id=null;this.taskId=null;this.emit();return this.snapshot();}
}
