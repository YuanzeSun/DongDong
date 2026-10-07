const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ConnectionPolicy = require('../public/connection-policy.js');

function renderer(panelKind = '') {
  const elements = new Map();
  const timers = new Map();
  const storage = new Map();
  const sockets = [];
  const listeners = new Map();
  let nextTimer = 1;
  const environment = { addresses: [], starts: 0, stops: 0, panelsClosed: 0 };
  const element = () => ({ hidden: false, value: '', dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {}, querySelector: element });
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor() { this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({
    window: { ConnectionPolicy, addEventListener: (type, listener) => listeners.set(type, listener), petDesktop: {
      panelKind,
      addresses: async () => environment.addresses,
      startHost: async address => { environment.starts++; return { url: `http://${address}:4827` }; },
      stopHost: async () => { environment.stops++; },
      setOnline() {}, setWindowSize() {}, closePanel() { environment.panelsClosed++; },
      onMenuAction() {}, onWalkState() {}, getAutoLaunch: async () => true
    } },
    document: { body: { classList: { add() {} } }, addEventListener() {}, querySelectorAll: () => [], createElement: element, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => 'recovery-test' },
    URL, URLSearchParams, location: { search: '' }, AbortSignal, WebSocket: Socket,
    fetch: async url => ({ ok: true, json: async () => url.endsWith('/session') ? { token: 'fresh-token', presence: { online: true } } : [] }),
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {}, clearInterval() {}
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.lastIndexOf('\ninit().catch(')), context);
  const run = code => vm.runInContext(code, context);
  // Exercise the real connection, presence, and timer code while suppressing
  // unrelated rendering and file effects at this boundary.
  run(`setView = setExpanded = startCatActivity = setQuickComposer = setActionTray = applyProfile = () => {};
    transitionPose = () => {}; scheduleIdleAction = () => {}; loadTransferSnapshot = async () => {};
    cancelRoomTransfers = () => {};`);
  return { context, run, elements, timers, sockets, environment, storage, listeners, async retry() {
    const id = run('state.reconnectTimer');
    const timer = timers.get(id);
    assert.ok(timer, 'expected a scheduled recovery attempt');
    timers.delete(id);
    return timer.fn();
  } };
}

test('saved host waits in offline mode for Tailscale then restores its room', async () => {
  const page = renderer();
  await page.run(`connect('100.80.0.1:4827', '我', 'host', { restoreHost: true })`);
  assert.equal(page.run('state.connected'), true);
  assert.equal(page.run('state.roomConnection'), 'reconnecting');
  assert.equal(page.elements.get('companion').hidden, false);
  assert.equal(page.elements.get('setup').hidden, true);
  assert.equal(page.environment.starts, 0);
  page.environment.addresses = [{ address: '100.80.0.1' }];
  await page.retry();
  assert.equal(page.environment.starts, 1);
  assert.equal(page.run('state.hostStarted'), true);
  page.sockets[0].readyState = 1;
  await page.sockets[0].onopen();
  assert.equal(page.run('state.roomConnection'), 'online');
  assert.equal(page.run('state.token'), 'fresh-token');
});

test('leaving a room wins over a session request already in flight', async () => {
  const page = renderer();
  let finishSession;
  page.context.fetch = () => new Promise(resolve => { finishSession = resolve; });
  page.run(`state.connected = true; state.url = 'http://100.80.0.1:4827'; scheduleSessionRetry(0)`);
  const pending = page.retry();
  await Promise.resolve();
  await page.run('disconnect()');
  finishSession({ ok: true, json: async () => ({ token: 'late-token' }) });
  await pending;
  assert.equal(page.run('state.connected'), false);
  assert.equal(page.run('state.roomConnection'), 'closed');
  assert.equal(page.sockets.length, 0);
  assert.equal(page.elements.get('setup').hidden, false);
  assert.equal(page.timers.size, 0);
});

test('a brief outage updates presence immediately but cancels sleep when the peer returns', () => {
  const page = renderer();
  page.run('state.connected = true; state.peerOnline = true; setPeerOnline(false)');
  assert.equal(page.run('state.peerOnline'), false);
  assert.equal(page.run('state.pose'), 'idle');
  const nap = page.timers.get(page.run('napTimer'));
  assert.ok(nap.delay >= 2900 && nap.delay <= 3000);
  page.run('setPeerOnline(true)');
  assert.equal(page.timers.has(page.run('napTimer')), false);
  assert.equal(page.run('state.pose'), 'idle');
});

test('an auxiliary settings window never starts the host during session restoration', async () => {
  const page = renderer('settings');
  page.environment.addresses = [{ address: '100.80.0.1' }];
  await page.run(`connect('100.80.0.1:4827', '我', 'host', { restoreHost: true })`);
  assert.equal(page.environment.starts, 0);
  assert.equal(page.run('state.hostStarted'), false);
  assert.equal(page.sockets.length, 1);
  assert.equal(page.storage.has(page.run('SESSION_KEY')), false);
});

for (const panelKind of ['settings', 'chat']) {
  test(`closing the room invalidates a ${panelKind} window's initial session request`, async () => {
    const page = renderer(panelKind);
    await page.run('init()');
    const key = page.run('SESSION_KEY');
    page.storage.set(key, JSON.stringify({ url: 'http://100.80.0.1:4827', name: '我', mode: 'join' }));
    let finishSession;
    page.context.fetch = () => new Promise(resolve => { finishSession = resolve; });
    const pending = page.run(`connect('100.80.0.1:4827', '我', 'join')`);
    await Promise.resolve();
    assert.equal(page.run('state.connected'), false);
    page.storage.delete(key);
    page.listeners.get('storage')({ key, newValue: null });
    assert.equal(page.environment.panelsClosed, 1);
    finishSession({ ok: true, json: async () => ({ token: 'late-token' }) });
    await pending;
    assert.equal(page.run('state.connected'), false);
    assert.equal(page.run('state.roomConnection'), 'closed');
    assert.equal(page.storage.has(key), false);
    assert.equal(page.sockets.length, 0);
    assert.equal(page.timers.size, 0);
  });
}

test('leaving through settings still removes the shared session', async () => {
  const page = renderer('settings');
  const key = page.run('SESSION_KEY');
  page.storage.set(key, JSON.stringify({ url: 'http://100.80.0.1:4827', name: '我', mode: 'join' }));
  await page.run(`connect('100.80.0.1:4827', '我', 'join')`);
  await page.run('disconnect()');
  assert.equal(page.storage.has(key), false);
  assert.equal(page.environment.panelsClosed, 1);
  assert.equal(page.run('state.connected'), false);
});

test('resume promptly replaces a stale open socket without waiting for its TCP timeout', async () => {
  const page = renderer();
  await page.run(`connect('100.80.0.1:4827', '我', 'join')`);
  const stale = page.sockets[0];
  stale.readyState = 1;
  page.run('recoverConnection(true)');
  assert.equal(stale.readyState, 3);
  assert.equal(page.run('state.peerOnline'), false);
  assert.equal(page.timers.get(page.run('state.reconnectTimer')).delay, 0);
  await page.retry();
  assert.equal(page.sockets.length, 2);
});

test('opening a direct IP session sends identity without a pairing code', async () => {
  const page = renderer();
  let request;
  page.context.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ token: 'direct-token' }) };
  };
  const session = await page.run(`openSession('http://100.80.0.1:4827', '我', 'join')`);
  assert.equal(session.token, 'direct-token');
  assert.equal(request.url, 'http://100.80.0.1:4827/api/session');
  assert.deepEqual(JSON.parse(request.options.body), { senderId: 'recovery-test', senderName: '我', mode: 'join', fresh: false });
  assert.equal(request.options.headers['X-Pet-Key'], undefined);
});
