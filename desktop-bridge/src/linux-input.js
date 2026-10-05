import {spawn} from 'node:child_process';
export class LinuxInput {
  constructor({spawnImpl=spawn}={}){this.spawn=spawnImpl;this.child=null;}
  execute(c){
    if(this.child)throw Error('Another X11 action is executing');
    let args;
    if(c.kind==='move')args=['mousemove','--sync',String(c.x),String(c.y)];
    if(c.kind==='click')args=['mousemove','--sync',String(c.x),String(c.y),'click',c.button==='right'?'3':'1'];
    if(c.kind==='scroll')args=['mousemove','--sync',String(c.x),String(c.y),'click','--repeat',String(Math.ceil(Math.abs(c.delta)/120)),c.delta>0?'4':'5'];
    if(c.kind==='type')args=['type','--clearmodifiers','--delay','0','--',c.text];
    if(c.kind==='key'){
      const keys={Enter:'Return',Escape:'Escape',Tab:'Tab',Backspace:'BackSpace',Delete:'Delete',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down'};
      if(!keys[c.key])throw Error('Unsupported key');args=['key','--clearmodifiers',keys[c.key]];
    }
    if(!args)throw Error('Unsupported X11 input');
    return new Promise((resolve,reject)=>{
      const child=this.spawn('xdotool',args,{stdio:'ignore'});this.child=child;
      const done=error=>{clearTimeout(timer);if(this.child===child)this.child=null;error?reject(error):resolve({ok:true});};
      const timer=setTimeout(()=>{child.kill();done(Error('X11 input timed out'));},10000);
      child.on('error',()=>done(Error('Unable to start xdotool')));child.on('exit',code=>done(code===0?null:Error('X11 input interrupted or failed')));
    });
  }
  stop(){this.child?.kill();this.child=null;}
}
