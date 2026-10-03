const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  resolve: (args) => ipcRenderer.invoke('bb:resolve', args),
  proxyFetch: (args) => ipcRenderer.invoke('bb:fetch', args),
  isElectron: true,
});
