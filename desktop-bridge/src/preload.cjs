const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bridge',{
 updatesStatus:()=>ipcRenderer.invoke('updates-status'),checkUpdates:()=>ipcRenderer.invoke('updates-check'),openUpdate:()=>ipcRenderer.invoke('updates-open'),onUpdates:fn=>ipcRenderer.on('updates',(_e,s)=>fn(s)),
 showCompanion:()=>ipcRenderer.invoke('companion-show'),hideCompanion:()=>ipcRenderer.invoke('companion-hide'),
 companionData:()=>ipcRenderer.invoke('companion-data'),submitTask:input=>ipcRenderer.invoke('companion-submit',input),
 selectTask:id=>ipcRenderer.invoke('companion-select',id),
 quit:()=>ipcRenderer.invoke('quit'),
 replyTask:input=>ipcRenderer.invoke('companion-reply',input),resumeTask:id=>ipcRenderer.invoke('companion-resume',id),pauseTask:id=>ipcRenderer.invoke('companion-pause',id),
 openTask:(id,browser=false)=>ipcRenderer.invoke('companion-open',{id,browser}),openSettings:()=>ipcRenderer.invoke('companion-settings'),
 onCompanion:fn=>ipcRenderer.on('companion-data',(_e,data)=>fn(data)),onCompanionFocus:fn=>ipcRenderer.on('companion-focus',()=>fn()),
 status:()=>ipcRenderer.invoke('status'),grant:task=>ipcRenderer.invoke('grant',task),stop:()=>ipcRenderer.invoke('stop'),
 refreshCapabilities:()=>ipcRenderer.invoke('refresh-capabilities'),
 listWindows:()=>ipcRenderer.invoke('list-windows'),selectWindow:id=>ipcRenderer.invoke('select-window',id),
 selectDisplay:id=>ipcRenderer.invoke('select-display',id),showPet:()=>ipcRenderer.invoke('pet-show'),hidePet:()=>ipcRenderer.invoke('pet-hide'),
 interactive:value=>ipcRenderer.invoke('pet-interactive',!!value),movePet:delta=>ipcRenderer.invoke('pet-move',delta),
 onState:fn=>ipcRenderer.on('state',(_e,s)=>fn(s)),
 // Seek connection: pairing, phone approval and requests from Seek.
 linkStatus:()=>ipcRenderer.invoke('link-status'),pair:input=>ipcRenderer.invoke('link-pair',input),unpair:()=>ipcRenderer.invoke('link-unpair'),
 confirmLink:code=>ipcRenderer.invoke('link-confirm',code),
 invitation:()=>ipcRenderer.invoke('link-invitation'),onInvitation:fn=>ipcRenderer.on('invitation',(_e,value)=>fn(value)),
 setRemoteGrant:value=>ipcRenderer.invoke('link-remote-grant',!!value),answer:(taskId,allow)=>ipcRenderer.invoke('link-answer',{taskId,allow}),
 onLink:fn=>ipcRenderer.on('link',(_e,s)=>fn(s)),
 loginItem:()=>ipcRenderer.invoke('login-item'),setLoginItem:value=>ipcRenderer.invoke('set-login-item',!!value)
});
