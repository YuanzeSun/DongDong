const { contextBridge, ipcRenderer, webUtils } = require('electron');
const panelArgument = process.argv.find(value => value.startsWith('--dongdong-panel='));
const panelKind = panelArgument?.slice('--dongdong-panel='.length) || new URLSearchParams(globalThis.location?.search || '').get('panel') || '';
let motionId = 0;
let motionKind = null;

contextBridge.exposeInMainWorld('petDesktop', {
  // Panels are regular windows. They share the renderer's session storage with the mascot,
  // while their native close button only closes that panel.
  panelKind,
  openPanel: kind => ipcRenderer.invoke('open-panel', kind),
  closePanel: () => ipcRenderer.invoke('close-panel'),
  addresses: () => ipcRenderer.invoke('addresses'),
  scanPeers: () => ipcRenderer.invoke('scan-peers'),
  startHost: (address, senderId) => ipcRenderer.invoke('start-host', address, senderId),
  stopHost: () => ipcRenderer.invoke('stop-host'),
  setWindowSize: expanded => ipcRenderer.invoke('window-size', expanded),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),
  setPeeked: peeked => ipcRenderer.invoke('set-peeked', peeked),
  startWalk: () => { motionKind = 'walk'; return ipcRenderer.invoke('start-walk', ++motionId); },
  stopWalk: () => { if (motionKind === 'walk') { ++motionId; motionKind = null; } return ipcRenderer.invoke('stop-walk'); },
  startJump: () => { motionKind = 'jump'; return ipcRenderer.invoke('start-jump', ++motionId); },
  stopJump: () => { if (motionKind === 'jump') { ++motionId; motionKind = null; } return ipcRenderer.invoke('stop-jump'); },
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.invoke('set-ignore-mouse-events', ignore, options),
  onWalkState: callback => ipcRenderer.on('walk-state', (_event, walking, id) => { if (id === motionId) { if (!walking) motionKind = null; callback(walking); } }),
  onWalkDirection: callback => ipcRenderer.on('walk-direction', (_event, direction, id) => { if (id === motionId) callback(direction); }),
  onWalkPace: callback => ipcRenderer.on('walk-pace', (_event, pace, id) => { if (id === motionId) callback(pace); }),
  onJumpState: callback => ipcRenderer.on('jump-state', (_event, jumping, id) => { if (id === motionId) { if (!jumping) motionKind = null; callback(jumping); } }),
  onPeekState: callback => ipcRenderer.on('peek-state', (_event, peeked) => callback(peeked)),
  copy: value => ipcRenderer.invoke('copy', value),
  saveRemoteFile: details => ipcRenderer.invoke('save-remote-file', details),
  uploadFile: (file, details) => ipcRenderer.invoke('upload-file', { ...details, path: webUtils.getPathForFile(file), fileName: file.name }),
  retryTransfer: details => ipcRenderer.invoke('retry-transfer', details),
  cancelTransfer: details => ipcRenderer.invoke('cancel-transfer', details),
  setTransferSession: (url, token) => ipcRenderer.invoke('transfer-session', url, token),
  updateTransfer: (url, item) => ipcRenderer.invoke('update-transfer', url, item),
  forgetRoomTransfers: url => ipcRenderer.invoke('forget-room-transfers', url),
  revealTransfer: details => ipcRenderer.invoke('reveal-transfer', details),
  transferSnapshot: () => ipcRenderer.invoke('transfer-snapshot'),
  onTransferProgress: callback => ipcRenderer.on('transfer-progress', (_event, details) => callback(details)),
  onResume: callback => ipcRenderer.on('system-resume', callback),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  logDiagnostic: (event, details) => ipcRenderer.send('renderer-diagnostic', { event, details }),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: enabled => ipcRenderer.invoke('set-auto-launch', enabled),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  close: () => ipcRenderer.invoke('close-window'),
  quit: () => ipcRenderer.invoke('quit-app'),
  onMenuAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  }
});
