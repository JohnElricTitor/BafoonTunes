// Bridge between the app page and the Electron main process (file storage + dialogs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bafoons', {
  isDesktop: true,
  library: {
    load: () => ipcRenderer.invoke('lib:load'),
    writeFile: (packId, relPath, data) => ipcRenderer.invoke('lib:writeFile', packId, relPath, data),
    savePack: (pack, sounds) => ipcRenderer.invoke('lib:savePack', pack, sounds),
    removePack: packId => ipcRenderer.invoke('lib:removePack', packId),
    folder: () => ipcRenderer.invoke('lib:folder'),
    reveal: () => ipcRenderer.invoke('lib:reveal'),
  },
  files: {
    save: opts => ipcRenderer.invoke('file:save', opts),
    open: opts => ipcRenderer.invoke('file:open', opts),
  },
  updates: {
    version: () => ipcRenderer.invoke('app:version'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: cb => ipcRenderer.on('update', (_e, status) => cb(status)),
  },
});
