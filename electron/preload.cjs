const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDesktop', {
  addresses: () => ipcRenderer.invoke('addresses'),
  startHost: address => ipcRenderer.invoke('start-host', address),
  stopHost: () => ipcRenderer.invoke('stop-host'),
  setWindowSize: expanded => ipcRenderer.invoke('window-size', expanded),
  setPinned: pinned => ipcRenderer.invoke('set-pin', pinned),
  startWalk: () => ipcRenderer.invoke('start-walk'),
  stopWalk: () => ipcRenderer.invoke('stop-walk'),
  onWalkState: callback => ipcRenderer.on('walk-state', (_event, walking) => callback(walking)),
  copy: value => ipcRenderer.invoke('copy', value),
  saveDownload: (data, name) => ipcRenderer.invoke('save-download', data, name),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: enabled => ipcRenderer.invoke('set-auto-launch', enabled),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  close: () => ipcRenderer.invoke('close-window')
});
