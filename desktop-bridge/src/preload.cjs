const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bridge',{
 status:()=>ipcRenderer.invoke('status'),grant:task=>ipcRenderer.invoke('grant',task),stop:()=>ipcRenderer.invoke('stop'),
 refreshCapabilities:()=>ipcRenderer.invoke('refresh-capabilities'),
 listWindows:()=>ipcRenderer.invoke('list-windows'),selectWindow:id=>ipcRenderer.invoke('select-window',id),
 selectDisplay:id=>ipcRenderer.invoke('select-display',id),showPet:()=>ipcRenderer.invoke('pet-show'),hidePet:()=>ipcRenderer.invoke('pet-hide'),
 interactive:value=>ipcRenderer.invoke('pet-interactive',!!value),movePet:delta=>ipcRenderer.invoke('pet-move',delta),
 onState:fn=>ipcRenderer.on('state',(_e,s)=>fn(s))
});
