import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {join,resolve} from 'node:path';import {packagedPath} from './packaged-path.mjs';
let executable,args;
if(process.argv.includes('--packaged')){
 if(process.platform==='win32')executable=resolve('dist/win-unpacked/Seek Desktop.exe');
 else if(process.platform==='darwin'){
  const app = process.env.SEEK_MAC_SMOKE_APP || packagedPath();
  executable=resolve(join(app,'Contents/MacOS/Seek Desktop'));
 }else executable=resolve('dist/linux-unpacked/seek-desktop-bridge');
 args=['--smoke'];
}else{executable=createRequire(import.meta.url)('electron');args=['.','--smoke'];}
if(process.argv.includes('--input'))args.push('--smoke-input');
const child=spawn(executable,args,{stdio:'inherit',env:process.env});
const timer=setTimeout(()=>{console.error('Smoke test timed out after 120 s');child.kill();process.exitCode=1;},120000);
child.on('error',e=>{console.error(e);clearTimeout(timer);process.exitCode=1;});
child.on('exit',(code,signal)=>{clearTimeout(timer);if(code!==0)console.error(`Smoke app exited with code ${code}${signal?` (signal ${signal})`:''}`);process.exitCode=code??1;});
