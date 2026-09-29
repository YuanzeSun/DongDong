const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, clipboard, screen, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoom } = require('../server/room.cjs');
const { downloadBuffer, saveUniqueDownload, clampBounds } = require('./native-helpers.cjs');

const PORT = 4827;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  let window; let tray; let room; let walkTimer; let isQuitting = false; let isOnline = true;
  const savedDownloads = new Set(); const menuListeners = new Set();
  const sendMenuAction = action => { for (const listener of menuListeners) listener(action); };
  function stopWalk() { if (walkTimer) clearInterval(walkTimer); walkTimer = null; if (window && !window.isDestroyed()) window.webContents.send('walk-state', false); }
  function clampWindow() { if (!window || window.isDestroyed()) return; const area = screen.getDisplayMatching(window.getBounds()).workArea; window.setBounds(clampBounds(window.getBounds(), area)); }
  function startWalk() {
    if (!isOnline || !window || window.isDestroyed()) return false; stopWalk();
    const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea;
    const left = area.x; const right = area.x + area.width - bounds.width; if (right <= left) return false;
    const direction = right - bounds.x >= bounds.x - left ? 1 : -1; window.webContents.send('walk-state', true);
    walkTimer = setInterval(() => { if (!isOnline || !window || window.isDestroyed()) return stopWalk(); const current = window.getPosition(); const x = Math.max(left, Math.min(right, current[0] + direction * 4)); window.setPosition(x, Math.max(area.y, Math.min(area.y + area.height - bounds.height, current[1])), false); if (x === left || x === right) stopWalk(); }, 30);
    return true;
  }
  function tailscaleAddresses() { return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => addresses.filter(item => { if (item.family !== 'IPv4' || item.internal) return false; const parts = item.address.split('.').map(Number); return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127; }).map(item => ({ name, address: item.address }))); }
  function configPath() { return path.join(app.getPath('userData'), 'room-config-v3.json'); }
  function getKey() { try { const key = JSON.parse(fs.readFileSync(configPath(), 'utf8')).key; if (typeof key === 'string' && key.length >= 20) return key; } catch { /* First launch. */ } const key = crypto.randomBytes(24).toString('base64url'); fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify({ key }), { mode: 0o600 }); return key; }
  function showWindow() { if (!window || window.isDestroyed()) return; window.show(); window.focus(); sendMenuAction('show'); }
  function quitApp() { isQuitting = true; stopWalk(); if (room) room.close().catch(() => {}); app.quit(); }
  function createTray() {
    tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png')); tray.setToolTip('Dongdong');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示东东', click: showWindow }, { label: '设置', click: () => { showWindow(); sendMenuAction('settings'); } }, { type: 'separator' }, { label: '退出', click: quitApp }])); tray.on('click', showWindow);
  }
  function createWindow() {
    window = new BrowserWindow({ width: 420, height: 700, minWidth: 280, minHeight: 300, icon: path.join(__dirname, '..', 'assets', 'icon.png'), frame: false, transparent: true, alwaysOnTop: true, resizable: false, hasShadow: false, skipTaskbar: false, backgroundColor: '#00000000', show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.loadFile(path.join(__dirname, '..', 'public', 'index.html')); window.on('close', event => { if (!isQuitting) { event.preventDefault(); window.hide(); } }); window.on('closed', () => { stopWalk(); window = null; }); window.on('move', clampWindow);
  }
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    ipcMain.handle('addresses', () => tailscaleAddresses());
    ipcMain.handle('start-host', async (_event, requestedAddress, senderId) => { const address = tailscaleAddresses().find(item => item.address === requestedAddress)?.address; if (!address) throw new Error('没有找到这个 Tailscale 地址，请确认 Tailscale 已连接'); if (room) await room.close(); room = createRoom({ host: address, port: PORT, key: getKey(), hostId: String(senderId || ''), dataDir: path.join(app.getPath('userData'), 'room-v3'), staticDir: path.join(__dirname, '..', 'public') }); try { await room.listen(); } catch (error) { room = null; throw error; } return { url: `http://${address}:${PORT}`, key: getKey() }; });
    ipcMain.handle('stop-host', async () => { if (room) await room.close(); room = null; });
    ipcMain.handle('window-size', (_event, expanded) => { if (!window || window.isDestroyed()) return; if (expanded) stopWalk(); const [width, height] = expanded ? [420, 700] : [300, 340]; const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea; window.setBounds(clampBounds({ x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height, width, height }, area)); });
    ipcMain.handle('set-pin', (_event, pinned) => window?.setAlwaysOnTop(Boolean(pinned))); ipcMain.handle('start-walk', () => startWalk()); ipcMain.handle('stop-walk', () => stopWalk());
    ipcMain.handle('set-online', (_event, online) => { isOnline = Boolean(online); if (!isOnline) stopWalk(); return isOnline; }); ipcMain.handle('set-ignore-mouse-events', (_event, ignore, options = {}) => window?.setIgnoreMouseEvents(Boolean(ignore), { forward: options.forward !== false }));
    ipcMain.handle('copy', (_event, value) => clipboard.writeText(String(value).slice(0, 500))); ipcMain.handle('get-downloads-path', () => app.getPath('downloads'));
    ipcMain.handle('save-download', async (_event, data, requestedName) => { const savedPath = await saveUniqueDownload(app.getPath('downloads'), downloadBuffer(data, MAX_DOWNLOAD_BYTES), requestedName); savedDownloads.add(path.resolve(savedPath)); return savedPath; });
    ipcMain.handle('reveal-download', async (_event, requestedPath) => { const resolved = path.resolve(String(requestedPath || '')); if (!savedDownloads.has(resolved)) throw new Error('只能打开本次保存的文件'); await shell.showItemInFolder(resolved); return true; }); ipcMain.handle('open-downloads', () => shell.openPath(app.getPath('downloads')));
    ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin); ipcMain.handle('set-auto-launch', (_event, enabled) => { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true }); return app.getLoginItemSettings().openAtLogin; });
    ipcMain.handle('notify', (_event, title, body) => { if (Notification.isSupported()) new Notification({ title: String(title), body: String(body).slice(0, 140) }).show(); }); ipcMain.handle('close-window', () => window?.hide()); ipcMain.handle('quit-app', quitApp);
    ipcMain.handle('on-menu-action', event => { const listener = action => event.sender.send('menu-action', action); menuListeners.add(listener); event.sender.once('destroyed', () => menuListeners.delete(listener)); return true; });
    createTray(); createWindow();
  });
  app.on('activate', showWindow); app.on('before-quit', () => { isQuitting = true; stopWalk(); }); app.on('window-all-closed', event => { if (!isQuitting && process.platform !== 'darwin') event.preventDefault(); });
}
