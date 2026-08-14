const { contextBridge, ipcRenderer } = require('electron')

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktopShell', {
    getStatus: () => ipcRenderer.invoke('shell:get-status'),
    retry: () => ipcRenderer.invoke('shell:retry'),
    openLogs: () => ipcRenderer.invoke('shell:open-logs'),
    onStatus: callback => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('shell:status', listener)
      return () => ipcRenderer.removeListener('shell:status', listener)
    },
  })
}
