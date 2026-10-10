import {opendir,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
export const SHORTCUT_KEYS=new Set(['Enter','Escape','Tab','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Space',...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',...'0123456789',...Array.from({length:12},(_,i)=>'F'+(i+1))]);
export function shortcut(command){
 if(!SHORTCUT_KEYS.has(command.key))throw Error('Unsupported shortcut key');
 const modifiers=command.modifiers??[];
 if(!Array.isArray(modifiers)||modifiers.length>4||new Set(modifiers).size!==modifiers.length||modifiers.some(m=>!['Control','Command','Alt','Shift'].includes(m)))throw Error('Use Control, Command, Alt or Shift modifiers');
 return {kind:'shortcut',key:command.key,modifiers};
}
function text(value,label,max=1024){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw Error('Invalid '+label);return value;}
export function desktopPath(value){
 text(value,'folder path');const home=homedir(),aliases={home,downloads:join(home,'Downloads'),desktop:join(home,'Desktop'),documents:join(home,'Documents')};
 if(aliases[value.toLowerCase()])return aliases[value.toLowerCase()];
 if(value==='~')return home;if(/^~[\\/]/.test(value))return resolve(home,value.slice(2));
 if(!isAbsolute(value))throw Error('Use an absolute path or Downloads, Desktop, Documents or Home');return resolve(value);
}
export function validateOperation(command){
 if(!command||typeof command!=='object')throw Error('Expected a desktop operation');
 switch(command.kind){
  case 'apps':case 'windows':return {kind:command.kind};
  case 'list':{const offset=command.offset??0,limit=command.limit??100;if(!Number.isInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid folder page');return {kind:'list',path:desktopPath(command.path),offset,limit};}
  case 'open-folder':return {kind:command.kind,path:desktopPath(command.path)};
  case 'open-app':return {kind:command.kind,app:text(command.app,'application ID',200)};
  case 'switch':return {kind:command.kind,windowId:text(command.windowId,'window ID',200)};
  case 'shortcut':return shortcut(command);
  case 'menu':if(!Array.isArray(command.path)||!command.path.length||command.path.length>6)throw Error('Choose a menu path');return {kind:'menu',path:command.path.map(v=>text(v,'menu item',200))};
  default:throw Error('Unsupported desktop operation');
 }
}
export async function listFolder({path,offset=0,limit=100}){
 const directory=await opendir(path);const entries=[];let index=0,more=false;
 for await(const entry of directory){if(index++<offset)continue;if(entries.length===limit){more=true;break;}let info;try{info=await stat(join(path,entry.name));}catch{}entries.push({name:entry.name,type:entry.isDirectory()?'folder':entry.isSymbolicLink()?'link':'file',size:info?.size??null,modified:info?.mtime.toISOString()??null});}
 return {path,entries,offset,nextOffset:more?offset+entries.length:null,order:'filesystem (may change while paging)'};
}
