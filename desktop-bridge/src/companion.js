import {randomBytes} from 'node:crypto';
const active=new Set(['queued','running','waiting']);
const requestId=()=>randomBytes(16).toString('hex');
export class Companion {
  constructor({link,session,grant,stop,beforeGrant=()=>{},onChange=()=>{}}){Object.assign(this,{link,session,grant,stop,beforeGrant,onChange});this.data={name:'Seek',look:{},tasks:[]};this.busy=false;}
  task(id){const t=this.data.tasks.find(t=>t.id===id);if(!t)throw Error('Choose a recent conversation first.');return t;}
  remember(t){this.activeId=t.id;this.data.tasks=[t,...this.data.tasks.filter(x=>x.id!==t.id)].slice(0,20);this.onChange(this.data);return t;}
  async select(id){if(!id){this.activeId='';return null;}this.task(id);return this.remember(await this.link.requestHost('get',{id}));}
  async refresh(){
    if(this.refreshing||!this.link.online)return this.data;
    this.refreshing=true;const peer=this.link.peer;
    try{
      const data=await this.link.requestHost('list');if(this.link.peer!==peer)return this.data;
      this.data=data;
      if(this.activeId&&data.tasks.some(t=>t.id===this.activeId)){const t=await this.link.requestHost('get',{id:this.activeId});if(this.link.peer!==peer)return this.data;data.tasks=data.tasks.map(x=>x.id===t.id?t:x);}
      const s=this.session.snapshot(),t=data.tasks.find(t=>t.id===s.taskId);
      if(s.state==='agent'&&t?.mode==='desktop'){
        if(!active.has(t.status))this.stop(t.status==='complete'?'Task complete — you have control':'Seek is paused — you have control');
        else if(t.status==='queued')this.session.heartbeat(s);
      }
      this.onChange(data);return data;
    }finally{this.refreshing=false;}
  }
  async run(fn){if(this.busy)throw Error('Your last action is still being received.');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  async takeOver(t,method,body={}){
    if(!this.link.online)throw Error('Wait for the secure connection to Seek.');
    this.beforeGrant();this.grant(t.id,t.title);const epoch=this.session.epoch;
    try{const result=await this.link.requestHost(method,{...body,id:t.id});if(this.session.epoch!==epoch)throw Error('You took control. Choose Continue on this computer when ready.');return this.remember(result);}
    catch(e){if(this.session.epoch===epoch)this.stop('Seek could not start — you have control');throw e;}
  }
  submit({mode,text,computerId}){return this.run(async()=>{
    if(!['chat','browser','desktop'].includes(mode)||typeof text!=='string'||!text.trim()||text.length>8000)throw Error('Enter a message or task.');
    const epoch=this.session.epoch;
    const t=this.remember(await this.link.requestHost('create',{mode,text,computerId,requestId:requestId()}));
    if(mode!=='desktop'||t.remote)return t;
    if(this.session.epoch!==epoch)throw Error('You took control before the task started. Find it in Recent conversations to continue.');
    return this.takeOver(t,'start');
  });}
  reply({id,text}){return this.run(async()=>{
    const t=this.task(id),body={text,requestId:requestId()};
    if(typeof text!=='string'||!text.trim()||text.length>8000)throw Error('Enter a message.');
    if(t.mode==='desktop'&&!t.remote&&(this.session.state!=='agent'||this.session.taskId!==id))return this.takeOver(t,'reply',body);
    return this.remember(await this.link.requestHost('reply',{id,...body}));
  });}
  resume(id){return this.run(()=>{const t=this.task(id);return t.mode==='desktop'&&!t.remote?this.takeOver(t,'resume'):this.link.requestHost('resume',{id}).then(t=>this.remember(t));});}
  async pause(id){this.task(id);if(this.session.taskId===id)this.stop();return this.remember(await this.link.requestHost('pause',{id}));}
}
