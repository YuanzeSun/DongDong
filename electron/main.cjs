const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, clipboard, screen, shell, powerMonitor } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRoom } = require('../server/room.cjs');
const { clampBounds, planWalkPath, tailnetPeers } = require('./native-helpers.cjs');
const { createTransferManager } = require('./transfer-manager.cjs');

const PORT = 4827;
const execFileAsync = promisify(execFile);
async function tailscaleStatus() {
  const commands = process.platform === 'win32'
    ? ['tailscale.exe', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe')]
    : ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];
  for (const command of [...new Set(commands)]) {
    try {
      const { stdout } = await execFileAsync(command, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('无法读取 Tailscale 设备，请检查 Tailscale 是否已登录');
    }
  }
  throw new Error('未找到 Tailscale 命令');
}
async function scanTailnetPeers() {
  const peers = tailnetPeers(await tailscaleStatus()).slice(0, 64);
  return Promise.all(peers.map(async peer => {
    if (!peer.online) return { ...peer, room: false };
    try {
      const response = await fetch(`http://${peer.address}:${PORT}/api/discover`, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) return { ...peer, room: false };
      const data = await response.json();
      return { ...peer, room: data.app === 'dongdong' && data.protocol === '4' };
    } catch { return { ...peer, room: false }; }
  }));
}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  let window; let tray; let room; let walkTimer; let jumpTimer; let walkMotionId; let jumpMotionId; let isQuitting = false; let peeked = false; let prePeekBounds = null; let ignoringMouse = false;
  // The mascot window is intentionally independent from these regular utility windows. Closing
  // a panel must never hide the mascot, and closing the mascot must not tear down a panel.
  const panelWindows = new Map();
  const ownsCat = event => window && !window.isDestroyed() && event.sender === window.webContents;
  const transferManager = createTransferManager({ downloadsPath, onProgress: reportTransfer });
  function reportTransfer(details) {
    for (const panel of [window, ...panelWindows.values()]) if (panel && !panel.isDestroyed()) panel.webContents.send('transfer-progress', details);
  }
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
    const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea;
    peeked = Boolean(next);
    if (peeked) {
      prePeekBounds = bounds;
      const width = 138; const height = 176;
      const rightSide = bounds.x + bounds.width / 2 >= area.x + area.width / 2;
      const x = rightSide ? area.x + area.width - width : area.x;
      const y = bounds.y + Math.round((bounds.height - height) / 2);
      window.setBounds(clampBounds({ x, y, width, height }, area));
    } else {
      // When the cursor is over the edge-peeked cat, keep the mascot under it
      // while restoring the normal window size. This prevents the cat from
      // jumping away as soon as hover interaction begins.
      const cursor = screen.getCursorScreenPoint();
      const cursorInside = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
        && cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height;
      const restored = cursorInside
        ? { x: cursor.x - 150, y: cursor.y - 209, width: 300, height: 340 }
        : prePeekBounds || { x: bounds.x, y: bounds.y, width: 300, height: 340 };
      window.setBounds(clampBounds(restored, area));
      prePeekBounds = null;
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
    const path = planWalkPath(bounds, area); if (!path.length) return false;
    walkMotionId = motionId;
    let targetIndex = 0;
    window.webContents.send('walk-state', true, motionId);
    window.webContents.send('walk-direction', Math.sign(path[0].x - bounds.x), motionId);
    walkTimer = setInterval(() => {
      if (!window || window.isDestroyed()) return stopWalk();
      const [x, y] = window.getPosition();
      const target = path[targetIndex];
      const dx = target.x - x;
      const dy = target.y - y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 5) {
        window.setPosition(target.x, target.y, false);
        targetIndex += 1;
        if (targetIndex === path.length) return stopWalk();
        window.webContents.send('walk-direction', Math.sign(path[targetIndex].x - target.x), motionId);
        return;
      }
      window.setPosition(Math.round(x + dx / distance * 5), Math.round(y + dy / distance * 5), false);
    }, 30);
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
  function autoLaunchPreferencePath() { return path.join(app.getPath('userData'), 'app-settings.json'); }
  function downloadsPath() { return !app.isPackaged && process.env.DONGDONG_QA_DOWNLOADS_DIR || app.getPath('downloads'); }
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
  function showWindow() { if (!window || window.isDestroyed()) return; window.show(); window.focus(); window.webContents.send('menu-action', 'show'); }
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
    window = new BrowserWindow({ width: 420, height: 700, minWidth: 138, minHeight: 176, icon: path.join(__dirname, '..', 'assets', 'icon.png'), frame: false, transparent: true, alwaysOnTop: true, resizable: false, hasShadow: false, skipTaskbar: false, backgroundColor: '#00000000', show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.loadFile(path.join(__dirname, '..', 'public', 'index.html')); window.on('close', event => { if (!isQuitting) { event.preventDefault(); window.hide(); } }); window.on('closed', () => { stopWalk(); stopJump(); window = null; }); window.on('move', clampWindow);
  }
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    initializeAutoLaunch();
    ipcMain.handle('addresses', () => tailscaleAddresses());
    let hostOperation = Promise.resolve();
    ipcMain.handle('start-host', (event, requestedAddress, senderId) => {
      if (!ownsCat(event)) throw new Error('房间由桌宠主窗口管理');
      const start = async () => {
        const address = tailscaleAddresses().find(item => item.address === requestedAddress)?.address;
        if (!address) throw new Error('没有找到这个 Tailscale 地址，请确认 Tailscale 已连接');
        if (room?.server.listening && room.server.address()?.address === address) return { url: `http://${address}:${PORT}` };
        if (room) await room.close();
        room = createRoom({ host: address, port: PORT, hostId: String(senderId || ''), dataDir: path.join(app.getPath('userData'), 'room-v4'), staticDir: path.join(__dirname, '..', 'public') });
        try { await room.listen(); } catch (error) { room = null; throw error; }
        return { url: `http://${address}:${PORT}` };
      };
      hostOperation = hostOperation.catch(() => {}).then(start);
      return hostOperation;
    });
    ipcMain.handle('stop-host', event => {
      if (!ownsCat(event)) return;
      hostOperation = hostOperation.catch(() => {}).then(async () => { if (room) await room.close(); room = null; });
      return hostOperation;
    });
    ipcMain.handle('window-size', (event, expanded) => { if (!ownsCat(event)) return; if (expanded) { stopWalk(); stopJump(); } if (peeked) setPeeked(false); const [width, height] = expanded ? [420, 700] : [300, 340]; const bounds = window.getBounds(); const area = screen.getDisplayMatching(bounds).workArea; window.setBounds(clampBounds({ x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height, width, height }, area)); });
    ipcMain.on('move-window', (event, dx, dy) => {
      if (!ownsCat(event)) return;
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
    ipcMain.handle('start-walk', (event, motionId) => ownsCat(event) && startWalk(motionId));
    ipcMain.handle('stop-walk', event => { if (ownsCat(event)) stopWalk(); });
    ipcMain.handle('start-jump', (event, motionId) => ownsCat(event) && startJump(motionId));
    ipcMain.handle('stop-jump', event => { if (ownsCat(event)) stopJump(); });
    ipcMain.handle('scan-peers', () => scanTailnetPeers());
    ipcMain.handle('set-ignore-mouse-events', (event, ignore) => {
      if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
      const next = Boolean(ignore);
      if (next !== ignoringMouse) {
        window.setIgnoreMouseEvents(next, { forward: true });
        ignoringMouse = next;
      }
      return ignoringMouse;
    });
    ipcMain.handle('set-peeked', (event, next) => ownsCat(event) && setPeeked(next));
    ipcMain.handle('open-panel', (_event, kind) => openPanel(kind));
    ipcMain.handle('close-panel', event => closePanel(event.sender));
    ipcMain.handle('copy', (_event, value) => clipboard.writeText(String(value).slice(0, 500)));
    ipcMain.handle('transfer-snapshot', () => transferManager.snapshot());
    ipcMain.handle('upload-file', (_event, details) => transferManager.upload(details));
    ipcMain.handle('save-remote-file', (_event, details) => transferManager.download(details));
    ipcMain.handle('retry-transfer', (_event, details) => transferManager.retry(details));
    ipcMain.handle('cancel-transfer', (_event, details) => transferManager.cancel(details));
    ipcMain.handle('transfer-session', (event, url, token) => { if (ownsCat(event)) transferManager.updateSession(url, token); });
    ipcMain.handle('update-transfer', (event, url, item) => { if (ownsCat(event)) transferManager.updateTransfer(url, item); });
    ipcMain.handle('forget-room-transfers', (event, url) => { if (ownsCat(event)) transferManager.forgetRoom(url); });
    ipcMain.handle('reveal-transfer', (_event, details) => {
      const localPath = transferManager.localPath(details);
      if (!localPath || !fs.existsSync(localPath)) return false;
      shell.showItemInFolder(localPath); return true;
    });
    ipcMain.handle('open-downloads', () => shell.openPath(downloadsPath()));
    ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin); ipcMain.handle('set-auto-launch', (_event, enabled) => { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true }); saveAutoLaunchPreference(enabled); return app.getLoginItemSettings().openAtLogin; });
    ipcMain.handle('notify', (_event, title, body) => { if (Notification.isSupported()) new Notification({ title: String(title), body: String(body).slice(0, 140) }).show(); }); ipcMain.handle('close-window', () => window?.hide()); ipcMain.handle('quit-app', quitApp);
    createTray(); createWindow();
  });
  powerMonitor.on('resume', () => { for (const view of [window, ...panelWindows.values()]) if (view && !view.isDestroyed()) view.webContents.send('system-resume'); });
  app.on('activate', showWindow); app.on('before-quit', () => { isQuitting = true; transferManager.close(); stopWalk(); stopJump(); }); app.on('window-all-closed', event => { if (!isQuitting && process.platform !== 'darwin') event.preventDefault(); });
}
