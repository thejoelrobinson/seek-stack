// Work helper requests only. Standard DSH coding inference never passes through here.
export class WorkModelQueue {
  constructor({busy=()=>false,onRecord=()=>{},pollMs=250}={}) {this.busy=busy;this.onRecord=onRecord;this.pollMs=pollMs;this.pending=[];this.active=null;this.timer=null;this.sequence=0;this.closed=false;}
  submit(fn,{priority=20,signal,label='helper'}={}) {
    if(this.closed)return Promise.reject(new Error('Work model queue is closed.'));
    if(signal?.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const job={fn,priority,signal,label,resolve,reject,sequence:this.sequence++,queuedAt:Date.now()};
      job.abort=()=>{if(this.active===job)job.controller.abort(signal.reason);else{this.pending=this.pending.filter(j=>j!==job);reject(signal.reason);signal.removeEventListener('abort',job.abort);}};
      signal?.addEventListener('abort',job.abort,{once:true});this.pending.push(job);this.pending.sort((a,b)=>a.priority-b.priority||a.sequence-b.sequence);this.pump();
    });
  }
  wake(){this.pump();}
  pump(){
    if(this.closed)return;
    if(this.busy()) {
      if(this.active&&!this.active.controller.signal.aborted){this.active.preempted=true;this.active.controller.abort(new Error('Yielding to foreground work.'));}
      if((this.active||this.pending.length)&&!this.timer)this.timer=setTimeout(()=>{this.timer=null;this.pump();},this.pollMs);
      return;
    }
    if(this.active||!this.pending.length)return;
    const job=this.pending.shift();this.active=job;job.controller=new AbortController();job.preempted=false;const start=Date.now();
    Promise.resolve().then(()=>job.fn(job.controller.signal)).then(value=>{job.resolve(value);this.finish(job,start,'complete');},error=>{
      if(job.preempted&&!job.signal?.aborted&&!this.closed){this.pending.push(job);this.pending.sort((a,b)=>a.priority-b.priority||a.sequence-b.sequence);this.finish(job,start,'yielded',false);}
      else{job.reject(error);this.finish(job,start,'error');}
    });
  }
  finish(job,start,status,settled=true){
    try{this.onRecord({label:job.label,status,queueMs:start-job.queuedAt,runMs:Date.now()-start});}catch{}
    if(settled)job.signal?.removeEventListener('abort',job.abort);this.active=null;this.pump();
  }
  close(){this.closed=true;clearTimeout(this.timer);this.active?.controller.abort(new Error('Work model queue closed.'));for(const job of this.pending){job.signal?.removeEventListener('abort',job.abort);job.reject(new Error('Work model queue closed.'));}this.pending=[];}
}
