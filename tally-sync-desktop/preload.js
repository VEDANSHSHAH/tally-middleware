const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Get stats from main process
  getStats: () => ipcRenderer.invoke('get-stats'),
  
  // Send sync command
  syncNow: () => ipcRenderer.invoke('sync-now'),
  
  // Open settings
  openSettings: () => ipcRenderer.invoke('open-settings')
});