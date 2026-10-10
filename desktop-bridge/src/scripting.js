import {spawn} from 'node:child_process';
export class DesktopScripts{
 constructor({platform=process.platform,spawnImpl=spawn}={}){this.platform=platform;this.spawn=spawnImpl;this.current=null;}
 run({language,source,timeoutMs=8000}){
  if(this.current)throw Error('A script is already running');
  if(typeof source!=='string'||!source.trim()||source.length>12000||source.includes('\0'))throw Error('Use 1–12000 characters of script');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('Script timeout must be 100–60000 ms');
  let exe,args,input;
  if(this.platform==='darwin'&&language==='applescript'){exe='/usr/bin/osascript';args=['-'];input=source;}
  else if(this.platform==='darwin'&&language==='shell'){exe='/bin/zsh';args=['-c',source];}
  else if(this.platform==='win32'&&language==='powershell'){exe='powershell.exe';args=['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')];}
  else throw Error('Use applescript or shell on Mac, powershell on Windows');
  return new Promise((resolve,reject)=>{
   const child=this.spawn(exe,args,{windowsHide:true,detached:this.platform!=='win32',stdio:['pipe','pipe','pipe']});
   const job={child,output:[],bytes:0,truncated:false,reject};this.current=job;
   const done=()=>{clearTimeout(job.timer);if(this.current===job)this.current=null;};
   const append=stream=>chunk=>{const room=24000-job.bytes;if(room>0){const kept=Buffer.from(chunk).subarray(0,room);job.output.push({stream,text:kept.toString('utf8')});job.bytes+=kept.length;}if(chunk.length>room)job.truncated=true;};
   child.stdout.on('data',append('stdout'));child.stderr.on('data',append('stderr'));child.stdin.on('error',()=>{});
   child.on('error',e=>{done();reject(Error('Could not start script: '+e.message));});
   child.on('close',(exitCode,signal)=>{done();resolve({exitCode,signal,output:job.output,truncated:job.truncated});});
   job.timer=setTimeout(()=>this.stop('Script timed out; effects may already have occurred. Do not repeat blindly.'),timeoutMs);
   child.stdin.end(input);
  });
 }
 stop(reason='Script cancelled by takeover; effects may already have occurred'){
  const job=this.current;if(!job)return;this.current=null;clearTimeout(job.timer);
  if(this.platform==='win32'&&job.child.pid)this.spawn('taskkill.exe',['/PID',String(job.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>job.child.kill());
  else {try{process.kill(-job.child.pid,'SIGKILL');}catch{job.child.kill();}}
  job.reject(Error(reason));
 }
}
