const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bridge',{
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
