// Bridge between the app page and the Electron main process (file storage + dialogs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bafoons', {
  isDesktop: true,
  library: {
    load: () => ipcRenderer.invoke('lib:load'),
    writeFile: (packId, relPath, data) => ipcRenderer.invoke('lib:writeFile', packId, relPath, data),
    savePack: (pack, sounds) => ipcRenderer.invoke('lib:savePack', pack, sounds),
    removePack: packId => ipcRenderer.invoke('lib:removePack', packId),
    deleteFiles: (packId, relPaths) => ipcRenderer.invoke('lib:deleteFiles', packId, relPaths),
    folder: () => ipcRenderer.invoke('lib:folder'),
    reveal: () => ipcRenderer.invoke('lib:reveal'),
  },
  files: {
    save: opts => ipcRenderer.invoke('file:save', opts),
    open: opts => ipcRenderer.invoke('file:open', opts),
    // a .tunes file double-clicked in Windows: the one the app was launched with, and later ones
    pending: () => ipcRenderer.invoke('file:pending'),
    onOpen: cb => ipcRenderer.on('file:opened', (_e, file) => cb(file)),
  },
  system: {
    // Windows' own microphone privacy switch: 'granted' | 'denied' | …
    micAccess: () => ipcRenderer.invoke('sys:micAccess'),
    openMicSettings: () => ipcRenderer.invoke('sys:openMicSettings'),
  },
  updates: {
    version: () => ipcRenderer.invoke('app:version'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: cb => ipcRenderer.on('update', (_e, status) => cb(status)),
  },
});
