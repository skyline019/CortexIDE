const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cortexNative', {
  selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
  platform: process.platform,
});
