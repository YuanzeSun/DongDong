const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');

async function launch(platform) {
  const calls = [];
  const windows = [];
  const trays = [];
  const handlers = new Map();
  let ready;
  let transfersClosed = false;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = Boolean(options.show);
      this.destroyed = false;
      this.minimized = false;
      this.webContents = new EventEmitter();
      this.webContents.send = (...args) => calls.push(['send', ...args]);
      windows.push(this);
      calls.push(['window']);
    }
    static fromWebContents(sender) { return windows.find(view => view.webContents === sender); }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (prevented) return;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }
  class Tray extends EventEmitter {
    constructor(icon) {
      super();
      assert.ok(fs.existsSync(icon), `Missing tray asset: ${icon}`);
      this.icon = icon;
      trays.push(this);
      calls.push(['tray']);
    }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then(callback) { ready = callback; } }),
    getPath: () => root,
    getVersion: () => 'test',
    setActivationPolicy: policy => calls.push(['activation', policy]),
    quit() {
      calls.push(['quit']);
      app.emit('before-quit');
      for (const view of windows) if (!view.isDestroyed()) view.close();
    }
  });
  const electron = {
    app, BrowserWindow: Window, Tray,
    Menu: { buildFromTemplate: template => template },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    powerMonitor: new EventEmitter()
  };
  const modules = {
    electron,
    '../server/room.cjs': { createRoom() {} },
    './native-helpers.cjs': require('../electron/native-helpers.cjs'),
    './transfer-manager.cjs': { createTransferManager: () => ({ close() { transfersClosed = true; } }) },
    './diagnostics.cjs': { createDiagnostics: () => ({ write() {}, close() {} }) }
  };
  vm.runInNewContext(source, {
    require: name => modules[name] || require(name),
    __dirname: path.join(root, 'electron'),
    process: { platform, arch: 'test', env: {}, on() {} },
    console, clearInterval
  });
  await ready();
  return {
    app, calls, windows, tray: trays[0], handlers,
    transfersClosed: () => transfersClosed,
    click(label) {
      const item = trays[0].menu.find(item => item.label === label);
      assert.ok(item, `Missing tray command: ${label}`);
      item.click();
    }
  };
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: messages require a room session owned by the mascot`, async () => {
    const app = await launch(platform);
    const mascot = app.windows[0];
    const messagesEnabled = () => app.tray.menu.find(item => item.label === '消息').enabled;
    const report = (sender, connected) => app.handlers.get('set-room-connected')({ sender }, connected);
    assert.equal(messagesEnabled(), false);
    assert.equal(app.handlers.get('open-panel')({}, 'chat'), false);
    app.click('设置');
    const settings = app.windows.at(-1);
    report(settings.webContents, true);
    assert.equal(messagesEnabled(), false, 'a settings panel cannot authorize message access');
    report(mascot.webContents, true);
    assert.equal(messagesEnabled(), true);
    app.click('消息');
    const messages = app.windows.at(-1);
    report(settings.webContents, false);
    assert.equal(messagesEnabled(), true, 'panel reconnections cannot change the mascot session');
    report(mascot.webContents, false);
    assert.equal(messagesEnabled(), false);
    assert.equal(messages.isDestroyed(), true, 'disconnect must close an already open message panel');
    assert.equal(settings.isDestroyed(), false);
    assert.equal(app.handlers.get('open-panel')({}, 'chat'), false);
    report(mascot.webContents, true);
    assert.equal(messagesEnabled(), true, 'reconnection enables messages again');
    mascot.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(messagesEnabled(), false);
    app.click('退出');
  });

  test(`${platform}: tray commands restore the mascot and open independent panels without taskbar entries`, async () => {
    const app = await launch(platform);
    const mascot = app.windows[0];
    assert.equal(app.tray.tooltip, 'Dongdong');
    assert.equal(path.basename(app.tray.icon), platform === 'darwin' ? 'trayTemplate.png' : 'tray.ico');
    if (platform === 'darwin') {
      assert.deepEqual(app.calls[0], ['activation', 'accessory'], 'Dock policy must precede tray/window creation');
      assert.equal(app.tray.listenerCount('click'), 0, 'menu click should not also reveal the mascot');
    } else {
      assert.equal(app.calls.some(([call]) => call === 'activation'), false, 'macOS APIs must not run on Windows');
      app.click('隐藏咚咚');
      app.tray.emit('click');
      assert.equal(mascot.visible, true);
    }
    app.click('隐藏咚咚');
    assert.equal(mascot.visible, false);
    mascot.minimized = true;
    app.click('显示咚咚');
    assert.equal(mascot.visible, true);
    assert.equal(mascot.minimized, false);
    assert.equal(mascot.focused, true);
    app.handlers.get('set-room-connected')({ sender: mascot.webContents }, true);
    for (const label of ['设置', '消息']) {
      app.click(label);
      const panel = app.windows.at(-1);
      panel.emit('ready-to-show');
      assert.equal(panel.visible, true);
      assert.equal(panel.options.skipTaskbar, true);
      panel.minimized = true;
      app.click(label);
      assert.equal(app.windows.at(-1), panel, 'reopening must reuse the existing panel');
      assert.equal(panel.minimized, false);
      panel.close();
      assert.equal(mascot.visible, true, 'closing a panel must not hide the mascot');
    }
    assert.ok(app.windows.every(view => view.options.skipTaskbar === true));
    mascot.close();
    assert.equal(mascot.isDestroyed(), false);
    assert.equal(mascot.visible, false);
    app.app.emit('second-instance');
    assert.equal(mascot.visible, true);
    mascot.hide();
    app.app.emit('activate');
    assert.equal(mascot.visible, true);
    app.app.emit('window-all-closed');
    assert.equal(app.calls.some(([call]) => call === 'quit'), false);
    app.click('设置');
    app.click('消息');
    app.click('退出');
    assert.equal(app.transfersClosed(), true);
    assert.ok(app.windows.every(view => view.isDestroyed()));
    assert.equal(app.calls.filter(([call]) => call === 'quit').length, 1);
  });
}

test('packaged menu bar app includes its native tray assets and starts as a macOS agent', () => {
  const { build } = require('../package.json');
  assert.equal(build.mac.extendInfo.LSUIElement, true);
  assert.ok(build.files.includes('assets/trayTemplate*.png'));
  assert.ok(build.files.includes('assets/tray.ico'));
  for (const [filename, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    const png = fs.readFileSync(path.join(root, 'assets', filename));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const ico = fs.readFileSync(path.join(root, 'assets/tray.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 2, 'Windows tray needs multiple sizes for display scaling');
});
