import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import readline from 'node:readline';
export class NativeInput {
  constructor({spawnImpl=spawn,platform=process.platform,timeoutMs=10000,helperPath}={}){this.spawn=spawnImpl;this.platform=platform;this.timeoutMs=timeoutMs;this.helperPath=helperPath;this.worker=null;}
  start(){
    if(this.worker)return this.worker;
    let exe,args;
    if(this.platform==='win32'){exe='powershell.exe';args=['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows.ps1',import.meta.url)).replace(/app\.asar([\\/])/,'app.asar.unpacked$1')];}
    else if(this.platform==='darwin'&&this.helperPath){exe=this.helperPath;args=[];}
    else if(this.platform==='linux'){exe='/usr/bin/python3';args=['-u',fileURLToPath(new URL('./linux-accessibility.py',import.meta.url)).replace(/app\.asar([\\/])/,'app.asar.unpacked$1')];}
    else throw Error('Native input adapter is unavailable on this platform');
    const worker={child:this.spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']}),pending:[]};this.worker=worker;
    const fail=message=>{if(this.worker===worker)this.worker=null;for(const p of worker.pending.splice(0)){clearTimeout(p.timer);p.reject(Error(message));}};
    readline.createInterface({input:worker.child.stdout}).on('line',line=>{const next=worker.pending.shift();if(!next)return;clearTimeout(next.timer);try{const r=JSON.parse(line);r.ok?next.resolve(r):next.reject(Error(r.error||'Native input failed'));}catch{next.reject(Error('Invalid native response'));if(this.worker===worker)this.stop();}});
    worker.child.on('error',()=>fail('Native input could not start'));worker.child.on('exit',()=>fail('Native input stopped'));worker.child.stdin.on('error',()=>fail('Native input channel closed'));worker.child.stderr.on('data',()=>{});return worker;
  }
  execute(command){const worker=this.start();return new Promise((resolve,reject)=>{const p={resolve,reject,timer:setTimeout(()=>{if(this.worker===worker)this.stop();},this.timeoutMs)};worker.pending.push(p);worker.child.stdin.write(JSON.stringify(command)+'\n');});}
  stop(){const worker=this.worker;if(!worker)return;this.worker=null;for(const p of worker.pending.splice(0)){clearTimeout(p.timer);p.reject(Error('Native input cancelled by takeover or timeout'));}worker.child.kill();}
}
