import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';

// Services started by PowerShell can inherit output handles. Use files, and wait
// for the deployment process itself rather than for inherited pipes to close.
export async function runDeployment(program,args,log,{cwd}={}){
 const output=await open(log,'a');
 try{
  return await new Promise((resolve,reject)=>{
   const child=spawn(program,args,{cwd,windowsHide:true,stdio:['ignore',output.fd,output.fd]});
   child.once('error',reject);
   child.once('exit',(code,signal)=>code===0?resolve():reject(Error('Deployment failed ('+(code??signal)+'); inspect '+log)));
  });
 }finally{await output.close();}
}
