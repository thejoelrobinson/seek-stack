import {spawnSync} from 'node:child_process';
export function platformCapabilities({platform=process.platform,env=process.env,accessibility=false,macHelper=false,xdotool=false,atspi=false}={}){
  let input=false,inputReason='Desktop input is unavailable';
  if(platform==='win32'){input=true;inputReason=null;}
  else if(platform==='darwin'){input=accessibility&&macHelper;inputReason=!macHelper?'macOS input helper is missing':!accessibility?'Enable Accessibility for Seek Desktop in System Settings':null;}
  else if(platform==='linux'){
    input=env.XDG_SESSION_TYPE!=='wayland'&&!!env.DISPLAY&&xdotool;
    inputReason=env.XDG_SESSION_TYPE==='wayland'?'Wayland input portal adapter is not implemented':!env.DISPLAY?'No X11 display is available':!xdotool?'Install xdotool for X11 input':null;
  }
  const structuredObservation=platform==='win32'||(platform==='darwin'&&macHelper&&accessibility)||(platform==='linux'&&atspi&&input);
  return {capture:true,input,inputReason,structuredObservation,screenText:['win32','darwin'].includes(platform),directNavigation:['win32','darwin'].includes(platform),scripting:platform==='darwin'?['applescript','shell']:platform==='win32'?['powershell']:[],observationReason:structuredObservation?null:platform==='linux'?'Install python3-gi and gir1.2-atspi-2.0; enable the accessibility bus':'Grant Accessibility permission to the native helper',backgroundAccessibility:platform==='win32',independentCursor:false,separateWorkspace:false};
}
export function hasXdotool(){return process.platform==='linux'&&spawnSync('xdotool',['--version'],{timeout:2000,stdio:'ignore'}).status===0;}
export function hasAtspi(){return process.platform==='linux'&&spawnSync('/usr/bin/python3',['-c',"import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi"],{timeout:2000,stdio:'ignore'}).status===0;}
