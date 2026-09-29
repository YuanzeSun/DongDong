const { app, BrowserWindow, ipcMain, Notification, clipboard, screen } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoom } = require('../server/room.cjs');

let window;
let room;
let walkTimer;
const PORT = 4827;

function stopWalk() {
  if (walkTimer) clearInterval(walkTimer);
  walkTimer = null;
  if (window && !window.isDestroyed()) window.webContents.send('walk-state', false);
}

function startWalk() {
  if (!window || window.isDestroyed()) return;
  stopWalk();
  const bounds = window.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const left = area.x;
  const right = area.x + area.width - bounds.width;
  if (right <= left) return;
  const direction = right - bounds.x >= bounds.x - left ? 1 : -1;
  window.webContents.send('walk-state', true);
  walkTimer = setInterval(() => {
    if (!window || window.isDestroyed()) return stopWalk();
    const current = window.getPosition();
    const x = Math.max(left, Math.min(right, current[0] + direction * 4));
    window.setPosition(x, current[1], false);
    if (x === left || x === right) stopWalk();
  }, 30);
}

function tailscaleAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    addresses.filter(item => {
      if (item.family !== 'IPv4' || item.internal) return false;
      const parts = item.address.split('.').map(Number);
      return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
    }).map(item => ({ name, address: item.address }))
  );
}

function configPath() { return path.join(app.getPath('userData'), 'room-config.json'); }
function getKey() {
  try {
    const key = JSON.parse(fs.readFileSync(configPath(), 'utf8')).key;
    if (typeof key === 'string' && key.length >= 20) return key;
  } catch { /* First launch. */ }
  const key = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ key }), { mode: 0o600 });
  return key;
}

function createWindow() {
  window = new BrowserWindow({
    width: 386, height: 548, minWidth: 250, minHeight: 280,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    skipTaskbar: false, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  });
  window.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
  window.on('closed', () => { stopWalk(); window = null; });
}

app.whenReady().then(() => {
  ipcMain.handle('addresses', () => tailscaleAddresses());
  ipcMain.handle('start-host', async (_event, requestedAddress) => {
    const address = tailscaleAddresses().find(item => item.address === requestedAddress)?.address;
    if (!address) throw new Error('没有找到这个 Tailscale 地址，请确认 Tailscale 已连接');
    if (room) await room.close();
    room = createRoom({
      host: address, port: PORT, key: getKey(),
      dataDir: path.join(app.getPath('userData'), 'room'),
      staticDir: path.join(__dirname, '..', 'public')
    });
    try { await room.listen(); }
    catch (error) { room = null; throw error; }
    return { url: `http://${address}:${PORT}`, key: getKey() };
  });
  ipcMain.handle('stop-host', async () => {
    if (room) await room.close();
    room = null;
  });
  ipcMain.handle('window-size', (_event, expanded) => {
    if (expanded) stopWalk();
    const [width, height] = expanded ? [410, 628] : [264, 320];
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const x = Math.max(area.x, Math.min(area.x + area.width - width, bounds.x + bounds.width - width));
    const y = Math.max(area.y, Math.min(area.y + area.height - height, bounds.y + bounds.height - height));
    window.setBounds({ x, y, width, height });
  });
  ipcMain.handle('set-pin', (_event, pinned) => window.setAlwaysOnTop(Boolean(pinned)));
  ipcMain.handle('start-walk', () => startWalk());
  ipcMain.handle('stop-walk', () => stopWalk());
  ipcMain.handle('copy', (_event, value) => clipboard.writeText(String(value).slice(0, 500)));
  ipcMain.handle('notify', (_event, title, body) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body).slice(0, 140) }).show();
  });
  ipcMain.handle('close-window', () => window.close());
  createWindow();
});

app.on('window-all-closed', async () => {
  if (room) await room.close();
  app.quit();
});
