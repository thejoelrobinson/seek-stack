import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {readdir} from 'node:fs/promises';import {join,resolve} from 'node:path';
let executable=createRequire(import.meta.url)('electron'),args=['.','--smoke'];
if(process.argv.includes('--packaged')){
 if(process.platform==='win32')executable=resolve('dist/win-unpacked/Seek Desktop.exe');
 else if(process.platform==='darwin'){
  const folders=await readdir('dist');const folder=folders.find(x=>x===(process.arch==='arm64'?'mac-arm64':'mac'));
  if(!folder)throw Error('Native packaged macOS app missing');executable=resolve(join('dist',folder,'Seek Desktop.app/Contents/MacOS/Seek Desktop'));
 }else executable=resolve('dist/linux-unpacked/seek-desktop-bridge');
 args=['--smoke'];
}
if(process.argv.includes('--input'))args.push('--smoke-input');
const child=spawn(executable,args,{stdio:'inherit',env:process.env});
const timer=setTimeout(()=>{child.kill();process.exitCode=1;},60000);
child.on('error',e=>{console.error(e);clearTimeout(timer);process.exitCode=1;});
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
