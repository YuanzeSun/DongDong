const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.listeners = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => this.classList[force ?? !this.classList.contains(name) ? 'add' : 'remove'](name)
    };
  }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tagName === selector) return child;
      const result = child.querySelector(selector);
      if (result) return result;
    }
    return null;
  }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  setAttribute(name, value) { this[name] = value; }
  click() { return this.listeners.get('click')?.(); }
}

function renderer(panelKind = '') {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const calls = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  let animator;
  const storage = new Map();
  const desktop = {
    panelKind,
    cancelTransfer: async details => { calls.push({ action: 'cancel', ...details }); },
    retryTransfer: async details => {
      calls.push({ action: 'retry', ...details });
      return { transferId: details.transferId, roomUrl: details.url, direction: 'send', phase: 'uploading', progress: 0, canCancel: true, canRetry: false };
    }
  };
  const context = vm.createContext({
    window: { petDesktop: desktop, PixelCatAnimator: class {
      constructor() { animator = this; this.action = 'idle'; }
      play(action) { this.action = action; }
      durationFor() { return 600; }
    } },
    document: { body: new Element('body'), getElementById: id => elements.get(id), createElement: tag => new Element(tag) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID: () => 'me' },
    setTimeout(callback, ms = 0) { const id = ++nextTimer; timers.set(id, { callback, due: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++nextTimer; }, clearInterval() {}
  });
  vm.runInContext(source.slice(0, source.lastIndexOf('\ninit().catch(')), context);
  const run = code => vm.runInContext(code, context);
  run(`state.connected = true; state.peerOnline = true; state.url = 'http://127.0.0.1:4827'; state.token = 'session';`);
  const show = item => { context.item = { transferId: 'file-one', name: '小鱼干.txt', direction: 'send', ...item }; run('showTransfer(item)'); };
  function advance(ms) {
    const target = clock + ms;
    for (let count = 0; count < 100; count++) {
      const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      clock = next[1].due; timers.delete(next[0]); next[1].callback();
    }
    clock = target;
  }
  return { run, show, advance, elements, calls, get animator() { return animator; } };
}

test('history keeps upload cancellation and retry attached to one progress row', async () => {
  const page = renderer('chat');
  page.show({ phase: 'uploading', progress: 25, canCancel: true });
  const row = page.elements.get('events').children[0];
  assert.equal(row.querySelector('progress').value, 25);
  assert.equal(row.querySelector('button').textContent, '取消');
  await row.querySelector('button').click();
  assert.equal(page.calls.at(-1).action, 'cancel');
  assert.equal(page.calls.at(-1).transferId, 'file-one');
  page.show({ phase: 'cancelled', progress: 25, canCancel: false, canRetry: true });
  assert.equal(row.querySelector('button').textContent, '重试');
  await row.querySelector('button').click();
  assert.equal(page.calls.at(-1).action, 'retry');
  assert.equal(row.querySelector('button').textContent, '取消');
  assert.equal(row.querySelector('progress').value, 0);
  assert.equal(page.elements.get('events').children.length, 1);
});

test('saved history progress cannot regress when an older upload update arrives', () => {
  const page = renderer('chat');
  page.show({ phase: 'saved', progress: 100, canCancel: false });
  page.show({ phase: 'uploading', progress: 90, canCancel: true });
  const row = page.elements.get('events').children[0];
  assert.equal(row.querySelector('span').textContent, '对方已保存到下载');
  assert.equal(row.querySelector('progress').hidden, true);
  assert.equal(row.querySelector('button'), null);
});

test('a late local upload completion cannot erase the recipient download failure', () => {
  const page = renderer('chat');
  page.show({ phase: 'uploaded', fileId: 'saved-file', progress: 100 });
  page.show({ phase: 'downloading', fileId: 'saved-file', progress: 45 });
  page.show({ phase: 'failed', fileId: 'saved-file', progress: 45, error: '传输超时，可重试' });
  page.show({ phase: 'uploaded', fileId: 'saved-file', progress: 100, canCancel: false, canRetry: false });
  const row = page.elements.get('events').children[0];
  assert.equal(row.querySelector('span').textContent, '传输超时，可重试');
});

test('switching from settings to history shows transfers completed while settings were open', () => {
  const page = renderer('settings');
  page.run(`setView('connection')`);
  page.show({ phase: 'uploading', progress: 25, canCancel: true });
  page.show({ phase: 'failed', progress: 25, canCancel: false, canRetry: true });
  page.run(`setView('chat')`);
  const row = page.elements.get('events').children[0];
  assert.ok(row, 'History should render the cached transfer after switching tabs');
  assert.equal(row.querySelector('span').textContent, '发送失败，可重试');
  assert.equal(row.querySelector('button').textContent, '重试');
});

test('a fast transfer that finishes during wake-up cannot leave the cat holding forever', () => {
  const page = renderer();
  page.run(`setPose('sleep')`);
  page.show({ direction: 'receive', phase: 'downloading', progress: 0 });
  page.show({ direction: 'receive', phase: 'saved', progress: 100, fileId: 'saved-file' });
  page.advance(5000);
  assert.equal(page.run('activeTransferAnimations.size'), 0);
  assert.notEqual(page.animator.action, 'delivery-hold');
  assert.notEqual(page.run('state.pose'), 'delivery-hold');
});

test('a file starting during a message animation enters the lasting transfer pose', () => {
  const page = renderer();
  page.run('animateDelivery(0)');
  page.show({ phase: 'uploading', progress: 10 });
  page.advance(3000);
  assert.equal(page.animator.action, 'delivery-hold');
  page.show({ phase: 'saved', progress: 100 });
  page.advance(5000);
  assert.equal(page.run('activeTransferAnimations.size'), 0);
  assert.notEqual(page.animator.action, 'delivery-hold');
});

test('finishing one concurrent transfer keeps the cat holding until the last completes', () => {
  const page = renderer();
  page.show({ phase: 'uploading', progress: 10 });
  page.show({ transferId: 'file-two', phase: 'downloading', direction: 'receive', progress: 20 });
  page.show({ phase: 'saved', progress: 100 });
  assert.equal(page.animator.action, 'delivery-hold');
  page.show({ transferId: 'file-two', phase: 'saved', direction: 'receive', progress: 100 });
  page.advance(5000);
  assert.equal(page.run('activeTransferAnimations.size'), 0);
  assert.notEqual(page.animator.action, 'delivery-hold');
});
