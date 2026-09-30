const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDesktop', {
  // Panels are regular windows. They share the renderer's session storage with the mascot,
  // while their native close button only closes that panel.
  panelKind: new URLSearchParams(globalThis.location?.search || '').get('panel') || '',
  openPanel: kind => ipcRenderer.invoke('open-panel', kind),
  closePanel: () => ipcRenderer.invoke('close-panel'),
  addresses: () => ipcRenderer.invoke('addresses'),
  startHost: (address, senderId) => ipcRenderer.invoke('start-host', address, senderId),
  stopHost: () => ipcRenderer.invoke('stop-host'),
  setWindowSize: expanded => ipcRenderer.invoke('window-size', expanded),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),
  setPeeked: peeked => ipcRenderer.invoke('set-peeked', peeked),
  setPinned: pinned => ipcRenderer.invoke('set-pin', pinned),
  startWalk: () => ipcRenderer.invoke('start-walk'),
  stopWalk: () => ipcRenderer.invoke('stop-walk'),
  setOnline: online => ipcRenderer.invoke('set-online', online),
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.invoke('set-ignore-mouse-events', ignore, options),
  onWalkState: callback => ipcRenderer.on('walk-state', (_event, walking) => callback(walking)),
  onPeekState: callback => ipcRenderer.on('peek-state', (_event, peeked) => callback(peeked)),
  copy: value => ipcRenderer.invoke('copy', value),
  saveDownload: (data, name) => ipcRenderer.invoke('save-download', data, name),
  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
  revealDownload: savedPath => ipcRenderer.invoke('reveal-download', savedPath),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: enabled => ipcRenderer.invoke('set-auto-launch', enabled),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  close: () => ipcRenderer.invoke('close-window'),
  quit: () => ipcRenderer.invoke('quit-app'),
  onMenuAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu-action', listener);
    ipcRenderer.invoke('on-menu-action');
    return () => ipcRenderer.removeListener('menu-action', listener);
  }
});
