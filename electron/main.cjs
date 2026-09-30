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
  let window; let tray; let room; let walkTimer; let jumpTimer; let walkMotionId; let jumpMotionId; let isQuitting = false; let isOnline = true; let peeked = false;
  // The mascot window is intentionally independent from these regular utility windows. Closing
  // a panel must never hide the mascot, and closing the mascot must not tear down a panel.
  const panelWindows = new Map();
  const savedDownloads = new Set(); const menuListeners = new Set();
  const sendMenuAction = action => { for (const listener of menuListeners) listener(action); };
  function stopWalk() {
    if (walkTimer) clearInterval(walkTimer);
    const motionId = walkMotionId;
    const wasWalking = Boolean(walkTimer);
    walkTimer = null;
    walkMotionId = null;
    if (wasWalking && window && !window.isDestroyed()) window.webContents.send('walk-state', false, motionId);
  }
  function stopJump() {
    if (jumpTimer) clearInterval(jumpTimer);
    const motionId = jumpMotionId;
    const wasJumping = Boolean(jumpTimer);
    jumpTimer = null;
    jumpMotionId = null;
    if (wasJumping && window && !window.isDestroyed()) window.webContents.send('jump-state', false, motionId);
  }
  function setPeeked(next) {
    if (!window || window.isDestroyed()) return false;
    peeked = Boolean(next);
    const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea;
    if (peeked) {
      const width = 138; const height = 176;
      const rightSide = bounds.x + bounds.width / 2 >= area.x + area.width / 2;
      const x = rightSide ? area.x + area.width - width : area.x;
      window.setBounds(clampBounds({ x, y: Math.max(area.y, area.y + area.height - height - 36), width, height }, area));
    } else {
      // When the cursor is over the edge-peeked cat, keep the mascot under it
      // while restoring the normal window size. This prevents the cat from
      // jumping away as soon as hover interaction begins.
      const cursor = screen.getCursorScreenPoint();
      const cursorInside = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
        && cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height;
      const x = cursorInside ? cursor.x - 150 : bounds.x;
      const y = cursorInside ? cursor.y - 209 : bounds.y;
      window.setBounds(clampBounds({ x, y, width: 300, height: 340 }, area));
    }
    window.webContents.send('peek-state', peeked);
    return peeked;
  }
  function clampWindow() { if (!window || window.isDestroyed()) return; const area = screen.getDisplayMatching(window.getBounds()).workArea; window.setBounds(clampBounds(window.getBounds(), area)); }
  function startWalk(motionId) {
    if (!window || window.isDestroyed()) return false;
    stopJump();
    stopWalk();
    const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea;
    const left = area.x; const right = area.x + area.width - bounds.width; if (right <= left) return false;
    walkMotionId = motionId;
    const direction = right - bounds.x >= bounds.x - left ? 1 : -1; window.webContents.send('walk-state', true, motionId);
    walkTimer = setInterval(() => { if (!window || window.isDestroyed()) return stopWalk(); const current = window.getPosition(); const x = Math.max(left, Math.min(right, current[0] + direction * 4)); window.setPosition(x, Math.max(area.y, Math.min(area.y + area.height - bounds.height, current[1])), false); if (x === left || x === right) stopWalk(); }, 30);
    return true;
  }
  function startJump(motionId) {
    if (!window || window.isDestroyed()) return false;
    stopWalk();
    stopJump();
    const start = window.getBounds();
    const area = screen.getDisplayMatching(start).workArea;
    const left = area.x;
    const right = area.x + area.width - start.width;
    const bottom = area.y + area.height - start.height;
    const distance = Math.min(180, Math.max(72, Math.round(area.width * 0.12)));
    const direction = start.x - left < right - start.x ? 1 : -1;
    const targetX = Math.max(left, Math.min(right, start.x + direction * distance));
    const duration = 1720;
    const launchedAt = Date.now();
    jumpMotionId = motionId;
    window.webContents.send('jump-state', true, motionId);
    jumpTimer = setInterval(() => {
      if (!window || window.isDestroyed()) return stopJump();
      const progress = Math.min(1, (Date.now() - launchedAt) / duration);
      const x = Math.round(start.x + (targetX - start.x) * progress);
      const arc = Math.abs(Math.sin(Math.PI * 2 * progress)) * Math.min(96, Math.max(48, area.height * 0.12));
      const y = Math.round(Math.max(area.y, Math.min(bottom, start.y - arc)));
      window.setPosition(x, y, false);
      if (progress >= 1) {
        window.setPosition(targetX, Math.max(area.y, Math.min(bottom, start.y)), false);
        stopJump();
      }
    }, 30);
    return true;
  }
  function tailscaleAddresses() { return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => addresses.filter(item => { if (item.family !== 'IPv4' || item.internal) return false; const parts = item.address.split('.').map(Number); return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127; }).map(item => ({ name, address: item.address }))); }
  function configPath() { return path.join(app.getPath('userData'), 'room-config-v3.json'); }
  function getKey() { try { const key = JSON.parse(fs.readFileSync(configPath(), 'utf8')).key; if (typeof key === 'string' && key.length >= 20) return key; } catch { /* First launch. */ } const key = crypto.randomBytes(24).toString('base64url'); fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify({ key }), { mode: 0o600 }); return key; }
  function autoLaunchPreferencePath() { return path.join(app.getPath('userData'), 'app-settings.json'); }
  function saveAutoLaunchPreference(enabled) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(autoLaunchPreferencePath(), JSON.stringify({ autoLaunch: Boolean(enabled) }), { mode: 0o600 });
  }
  function initializeAutoLaunch() {
    if (!app.isPackaged) return;
    try {
      const preference = JSON.parse(fs.readFileSync(autoLaunchPreferencePath(), 'utf8'));
      if (typeof preference.autoLaunch === 'boolean') return;
    } catch { /* No saved preference yet. */ }
    // Apply the default once so later app or system changes are respected.
    try {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
      saveAutoLaunchPreference(true);
    } catch (error) { console.warn('Could not enable auto-launch:', error); }
  }
  function showWindow() { if (!window || window.isDestroyed()) return; window.show(); window.focus(); sendMenuAction('show'); }
  function quitApp() { isQuitting = true; stopWalk(); stopJump(); for (const panel of panelWindows.values()) if (!panel.isDestroyed()) panel.close(); panelWindows.clear(); if (room) room.close().catch(() => {}); app.quit(); }
  function panelKind(value) {
    const kind = String(value || '').toLowerCase();
    if (!['chat', 'settings'].includes(kind)) throw new Error('辅助窗口类型无效');
    return kind;
  }
  function openPanel(value) {
    const kind = panelKind(value);
    const existing = panelWindows.get(kind);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show(); existing.focus();
      return true;
    }
    const panel = new BrowserWindow({
      width: kind === 'chat' ? 430 : 420,
      height: kind === 'chat' ? 620 : 560,
      minWidth: 360,
      minHeight: 420,
      title: kind === 'chat' ? 'Dongdong · 消息' : 'Dongdong · 设置',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f8fbf9',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        additionalArguments: [`--dongdong-panel=${kind}`]
      }
    });
    panelWindows.set(kind, panel);
    panel.once('ready-to-show', () => { if (!panel.isDestroyed()) panel.show(); });
    panel.on('closed', () => { if (panelWindows.get(kind) === panel) panelWindows.delete(kind); });
    panel.loadFile(path.join(__dirname, '..', 'public', 'index.html'), { search: `?panel=${kind}` });
    return true;
  }
  function closePanel(sender) {
    const panel = BrowserWindow.fromWebContents(sender);
    if (!panel || panel === window || panel.isDestroyed()) return false;
    panel.close();
    return true;
  }
  function createTray() {
    tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png')); tray.setToolTip('Dongdong');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示东东', click: showWindow }, { label: '设置', click: () => openPanel('settings') }, { type: 'separator' }, { label: '退出', click: quitApp }])); tray.on('click', showWindow);
  }
  function createWindow() {
    window = new BrowserWindow({ width: 420, height: 700, minWidth: 280, minHeight: 300, icon: path.join(__dirname, '..', 'assets', 'icon.png'), frame: false, transparent: true, alwaysOnTop: true, resizable: false, hasShadow: false, skipTaskbar: false, backgroundColor: '#00000000', show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.loadFile(path.join(__dirname, '..', 'public', 'index.html')); window.on('close', event => { if (!isQuitting) { event.preventDefault(); window.hide(); } }); window.on('closed', () => { stopWalk(); stopJump(); window = null; }); window.on('move', clampWindow);
  }
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    initializeAutoLaunch();
    ipcMain.handle('addresses', () => tailscaleAddresses());
    ipcMain.handle('start-host', async (_event, requestedAddress, senderId) => { const address = tailscaleAddresses().find(item => item.address === requestedAddress)?.address; if (!address) throw new Error('没有找到这个 Tailscale 地址，请确认 Tailscale 已连接'); if (room) await room.close(); room = createRoom({ host: address, port: PORT, key: getKey(), hostId: String(senderId || ''), dataDir: path.join(app.getPath('userData'), 'room-v3'), staticDir: path.join(__dirname, '..', 'public') }); try { await room.listen(); } catch (error) { room = null; throw error; } return { url: `http://${address}:${PORT}`, key: getKey() }; });
    ipcMain.handle('stop-host', async () => { if (room) await room.close(); room = null; });
    ipcMain.handle('window-size', (_event, expanded) => { if (!window || window.isDestroyed()) return; if (expanded) { stopWalk(); stopJump(); } if (peeked) setPeeked(false); const [width, height] = expanded ? [420, 700] : [300, 340]; const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea; window.setBounds(clampBounds({ x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height, width, height }, area)); });
    ipcMain.on('move-window', (_event, dx, dy) => {
      if (!window || window.isDestroyed()) return;
      const deltaX = Number(dx); const deltaY = Number(dy);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
      if (walkTimer) stopWalk();
      if (jumpTimer) stopJump();
      const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea;
      window.setPosition(Math.round(bounds.x + deltaX), Math.round(bounds.y + deltaY), false);
      const next = window.getBounds();
      const clamped = clampBounds(next, area);
      if (next.x !== clamped.x || next.y !== clamped.y) window.setPosition(clamped.x, clamped.y, false);
    });
    ipcMain.handle('set-pin', (_event, pinned) => window?.setAlwaysOnTop(Boolean(pinned))); ipcMain.handle('start-walk', (_event, motionId) => startWalk(motionId)); ipcMain.handle('stop-walk', () => stopWalk()); ipcMain.handle('start-jump', (_event, motionId) => startJump(motionId)); ipcMain.handle('stop-jump', () => stopJump());
    ipcMain.handle('set-online', (_event, online) => { isOnline = Boolean(online); if (!isOnline) { stopWalk(); stopJump(); } return isOnline; }); ipcMain.handle('set-ignore-mouse-events', (_event, ignore, options = {}) => window?.setIgnoreMouseEvents(Boolean(ignore), { forward: options.forward !== false }));
    ipcMain.handle('set-peeked', (_event, next) => setPeeked(next));
    ipcMain.handle('open-panel', (_event, kind) => openPanel(kind));
    ipcMain.handle('close-panel', event => closePanel(event.sender));
    ipcMain.handle('copy', (_event, value) => clipboard.writeText(String(value).slice(0, 500))); ipcMain.handle('get-downloads-path', () => app.getPath('downloads'));
    ipcMain.handle('save-download', async (_event, data, requestedName) => { const savedPath = await saveUniqueDownload(app.getPath('downloads'), downloadBuffer(data, MAX_DOWNLOAD_BYTES), requestedName); savedDownloads.add(path.resolve(savedPath)); return savedPath; });
    ipcMain.handle('reveal-download', async (_event, requestedPath) => { const resolved = path.resolve(String(requestedPath || '')); if (!savedDownloads.has(resolved)) throw new Error('只能打开本次保存的文件'); await shell.showItemInFolder(resolved); return true; }); ipcMain.handle('open-downloads', () => shell.openPath(app.getPath('downloads')));
    ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin); ipcMain.handle('set-auto-launch', (_event, enabled) => { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true }); saveAutoLaunchPreference(enabled); return app.getLoginItemSettings().openAtLogin; });
    ipcMain.handle('notify', (_event, title, body) => { if (Notification.isSupported()) new Notification({ title: String(title), body: String(body).slice(0, 140) }).show(); }); ipcMain.handle('close-window', () => window?.hide()); ipcMain.handle('quit-app', quitApp);
    ipcMain.handle('on-menu-action', event => { const listener = action => event.sender.send('menu-action', action); menuListeners.add(listener); event.sender.once('destroyed', () => menuListeners.delete(listener)); return true; });
    createTray(); createWindow();
  });
  app.on('activate', showWindow); app.on('before-quit', () => { isQuitting = true; stopWalk(); stopJump(); }); app.on('window-all-closed', event => { if (!isQuitting && process.platform !== 'darwin') event.preventDefault(); });
}
