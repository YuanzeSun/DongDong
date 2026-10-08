const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ConnectionPolicy = require('../public/connection-policy.js');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.className = '';
    this.dataset = {};
    this.value = '';
    this.hidden = false;
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
  replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
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
  focus() { this.focused = true; }
  matches(selector) { return selector === ':hover' && Boolean(this.hovered); }
  click() { return this.listeners.get('click')?.(); }
}

function renderer(panelKind = '') {
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const element = new Element();
    element.hidden = /\shidden(?:\s|>|=)/.test(tag);
    return [id, element];
  }));
  const calls = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  let animator;
  const storage = new Map();
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const desktop = {
    panelKind,
    openPanel: kind => calls.push({ action: 'open-panel', kind }),
    copy: async value => calls.push({ action: 'copy', value }),
    setOnline() {}, setWindowSize() {},
    cancelTransfer: async details => { calls.push({ action: 'cancel', ...details }); },
    retryTransfer: async details => {
      calls.push({ action: 'retry', ...details });
      return { transferId: details.transferId, roomUrl: details.url, direction: 'send', phase: 'uploading', progress: 0, canCancel: true, canRetry: false };
    }
  };
  const context = vm.createContext({
    window: { ConnectionPolicy, petDesktop: desktop, PixelCatAnimator: class {
      constructor() { animator = this; this.action = 'idle'; }
      play(action) { this.action = action; }
      durationFor() { return 600; }
    } },
    document: { body: new Element('body'), getElementById: id => elements.get(id), createElement: tag => new Element(tag) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => 'me' },
    URL, AbortSignal, WebSocket: Socket,
    fetch: async url => ({ ok: true, json: async () => url.endsWith('/session') ? { token: 'session', presence: { online: true } } : [] }),
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
  return { context, run, show, advance, elements, calls, storage, get animator() { return animator; } };
}

test('closing and reopening the quick composer preserves an unsent draft', () => {
  const page = renderer();
  const input = page.elements.get('quickMessageInput');
  input.value = '下班一起吃饭呀';
  page.run('setQuickComposer(false)');
  assert.equal(page.elements.get('quickMessageForm').hidden, true);
  page.run('setQuickComposer(true)');
  assert.equal(page.elements.get('quickMessageForm').hidden, false);
  assert.equal(input.value, '下班一起吃饭呀');
});

test('incoming speech stays readable through action feedback and pauses while hovered', () => {
  const page = renderer();
  const bubble = page.elements.get('speech');
  page.run("speak('下班一起吃饭呀', 'message')");
  page.advance(2000);
  page.run("speak('动作送出去了', 'alert')");
  assert.equal(bubble.textContent, '下班一起吃饭呀');
  assert.equal(bubble.classList.contains('speech-message'), true);
  bubble.hovered = true;
  page.run('scheduleSpeechDismiss()');
  page.advance(20000);
  assert.equal(bubble.textContent, '下班一起吃饭呀');
  bubble.hovered = false;
  page.run('scheduleSpeechDismiss()');
  page.advance(4499);
  assert.ok(bubble.textContent);
  page.advance(1);
  assert.equal(bubble.textContent, '');
  assert.equal(bubble.classList.contains('speech-message'), false);
});

test('long messages get more reading time and switching conversation clears their bubble', () => {
  const page = renderer();
  const bubble = page.elements.get('speech');
  page.run("speak('一起出去走走。'.repeat(40), 'message')");
  page.advance(11999);
  assert.ok(bubble.textContent);
  page.advance(1);
  assert.equal(bubble.textContent, '');
  page.run("speak('新的消息', 'message'); clearConversation()");
  assert.equal(bubble.textContent, '');
  assert.equal(bubble.classList.contains('speech-message'), false);
});

test('incoming speech scrolls explicitly inside the transparent desktop window', () => {
  const page = renderer();
  const bubble = page.elements.get('speech');
  page.run("speak('很长的一段消息', 'message')");
  bubble.scrollHeight = 240;
  bubble.clientHeight = 74;
  bubble.scrollTop = 0;
  page.run('scrollSpeech(80)');
  assert.equal(bubble.scrollTop, 80);
  page.run('scrollSpeech(1000)');
  assert.equal(bubble.scrollTop, 166);
  page.run('scrollSpeech(-1000)');
  assert.equal(bubble.scrollTop, 0);
});

test('clicking an incoming speech bubble opens history and copying keeps its text', async () => {
  const page = renderer();
  page.run("state.connected = true; speak('晚点见', 'message'); openSpeechHistory()");
  assert.deepEqual(page.calls.at(-1), { action: 'open-panel', kind: 'chat' });
  await page.run('copySpeechMessage()');
  assert.deepEqual(page.calls.at(-1), { action: 'copy', value: '晚点见' });
});

test('message history renders a direct copy control', async () => {
  const page = renderer();
  page.run("renderEvent({id:'message-1', kind:'message', text:'带你去吃饭', senderId:'peer', senderName:'她', createdAt:new Date().toISOString()})");
  const copyButton = page.elements.get('events').children[0].querySelector('.message-copy');
  assert.ok(copyButton);
  await copyButton.click();
  assert.deepEqual(page.calls.at(-1), { action: 'copy', value: '带你去吃饭' });
});

for (const action of ['delivery', 'receive', 'hug']) {
  test(`clearing a conversation preserves the ${action} action's normal finish`, () => {
    const page = renderer();
    page.run('state.peerOnline = false');
    page.run(action === 'delivery' ? 'animateDelivery(1)' : `animateRemoteAction('${action}')`);
    assert.equal(page.run('state.pose'), action);
    page.run('clearConversation(); setPeerOnline(true)');
    page.advance(10000);
    assert.equal(page.run('state.pose'), 'idle');
    assert.equal(page.animator.action, 'idle');
    assert.equal(page.elements.get('mainMascot').classList.contains('delivery'), false);
  });
}

test('clearing a room stops its file holding pose and exit forgets its pending callbacks', () => {
  const page = renderer();
  page.show({ phase: 'downloading', direction: 'receive', progress: 50 });
  page.run('clearConversation()');
  assert.equal(page.run('state.pose'), 'idle');
  assert.equal(page.run('activeTransferAnimations.size'), 0);
  let forgotten;
  page.context.window.petDesktop.forgetRoomTransfers = url => { forgotten = url; };
  page.run('cancelRoomTransfers(state.url)');
  assert.equal(forgotten, 'http://127.0.0.1:4827');
});

test('a failed message keeps its draft and retry identity until a successful send', async () => {
  const page = renderer();
  const form = page.elements.get('quickMessageForm');
  const input = page.elements.get('quickMessageInput');
  const button = new Element('button');
  button.className = 'send-button';
  form.appendChild(button);
  input.value = '等你回来';
  page.context.sendResult = false;
  page.run('sendMessage = async () => sendResult');
  await page.run(`submitMessage($('quickMessageForm'), $('quickMessageInput'))`);
  assert.equal(input.value, '等你回来');
  assert.ok(form.dataset.pendingId);
  assert.equal(button.disabled, false);
  page.run('setQuickComposer(false); setQuickComposer(true)');
  assert.equal(input.value, '等你回来');
  assert.ok(form.dataset.pendingId);
  page.context.sendResult = true;
  await page.run(`submitMessage($('quickMessageForm'), $('quickMessageInput'))`);
  assert.equal(input.value, '');
  assert.equal(form.dataset.pendingId, undefined);
  assert.equal(input.disabled, false);
});

test('connecting a new IP clears drafts and transfer history and starts a fresh room', async () => {
  const page = renderer();
  page.run(`setExpanded = startCatActivity = scheduleIdleAction = transitionPose = () => {};`);
  await page.run(`connect('100.80.0.1', '我', 'join')`);
  page.elements.get('quickMessageInput').value = '给上一台电脑的草稿';
  page.elements.get('messageInput').value = '历史面板中的草稿';
  page.show({ roomUrl: 'http://100.80.0.1:4827', phase: 'saved', progress: 100 });
  const oldRow = new Element();
  oldRow.className = 'transfer-event';
  page.elements.get('events').appendChild(oldRow);
  assert.ok(page.elements.get('events').querySelector('.transfer-event'));
  let sessionRequest;
  page.context.fetch = async (url, options) => {
    if (url.endsWith('/session')) sessionRequest = JSON.parse(options.body);
    return { ok: true, json: async () => url.endsWith('/session')
      ? { token: 'new-session', presence: { online: true } } : [] };
  };
  await page.run(`connect('100.80.0.2', '我', 'join')`);
  assert.equal(sessionRequest.fresh, true);
  assert.equal(page.elements.get('quickMessageInput').value, '');
  assert.equal(page.elements.get('messageInput').value, '');
  assert.equal(page.run('transferStates.size'), 0);
  assert.equal(page.run('transferRows.size'), 0);
  assert.equal(page.elements.get('events').querySelector('.transfer-event'), null);
  assert.equal(page.elements.get('events').querySelector('.empty-state')?.textContent, '这里还没有消息');
});

test('reconnecting the same IP preserves a draft without resetting the room', async () => {
  const page = renderer();
  page.run(`setExpanded = startCatActivity = scheduleIdleAction = transitionPose = () => {};`);
  await page.run(`connect('100.80.0.1', '我', 'join')`);
  page.elements.get('quickMessageInput').value = '还没有写完';
  let sessionRequest;
  page.context.fetch = async (url, options) => {
    if (url.endsWith('/session')) sessionRequest = JSON.parse(options.body);
    return { ok: true, json: async () => url.endsWith('/session')
      ? { token: 'next-session', presence: { online: true } } : [] };
  };
  await page.run(`connect('100.80.0.1', '我', 'join')`);
  assert.equal(sessionRequest.fresh, false);
  assert.equal(page.elements.get('quickMessageInput').value, '还没有写完');
});

test('a second file is rejected until the first upload finishes', async () => {
  const page = renderer();
  let finish;
  let uploads = 0;
  page.context.window.petDesktop.uploadFile = async () => {
    uploads += 1;
    return new Promise(resolve => { finish = () => resolve({ transferId: 'file-one', phase: 'uploading', progress: 0 }); });
  };
  const first = page.run(`sendFile({ size: 10, name: 'one.txt' })`);
  await Promise.resolve();
  await page.run(`sendFile({ size: 10, name: 'two.txt' })`);
  assert.equal(uploads, 1);
  assert.equal(page.elements.get('toast').textContent, '上一份文件还没有传完');
  finish();
  await first;
  assert.equal(page.run('uploadStarting'), false);
});

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
  assert.equal(row.querySelector('span').textContent, '对方接收失败，可重新选择文件发送');
});

test('an uploaded file offers retry to its receiver, not its sender', () => {
  for (const direction of ['send', 'receive']) {
    const page = renderer('chat');
    page.show({ direction, fileId: 'uploaded-file', phase: 'failed', canRetry: true });
    const row = page.elements.get('events').children[0];
    assert.equal(row.querySelector('button')?.textContent, direction === 'receive' ? '重试' : undefined);
  }
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

for (const kind of ['walk', 'jump']) {
  test(`${kind} waits for the sleeping cat to rise before starting native movement`, async () => {
    const page = renderer();
    const start = kind === 'walk' ? 'startWalk' : 'startJump';
    page.context.window.petDesktop[start] = async () => {
      page.calls.push({ action: start });
      page.run(`onMotionState('${kind}', true)`);
      return true;
    };
    page.run(`setPose('sleep'); animateLocalAction('${kind}')`);
    assert.equal(page.animator.action, 'wake');
    assert.equal(page.calls.length, 0);
    page.advance(600);
    await Promise.resolve();
    assert.equal(page.calls[0].action, start);
    assert.equal(page.animator.action, kind);
    page.run(`onMotionState('${kind}', false)`);
    assert.equal(page.animator.action, 'idle');
  });
}

function edgeWalkRenderer({ pending = false, refused = false } = {}) {
  const page = renderer();
  const listeners = new Map();
  let motionId;
  let resolveStart;
  const emit = moving => listeners.get('walk-state')?.({}, moving, motionId);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    process: { argv: [] }, URLSearchParams,
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => Object.assign(page.context.window.petDesktop, api) },
      ipcRenderer: {
        on: (channel, listener) => listeners.set(channel, listener),
        invoke(channel, id) {
          page.calls.push({ action: channel });
          if (channel === 'start-walk') {
            motionId = id;
            if (pending) return new Promise(resolve => { resolveStart = resolve; });
            if (!refused) emit(true);
            return Promise.resolve(!refused);
          }
          if (channel === 'stop-walk') emit(false);
          return Promise.resolve();
        }
      }
    })
  });
  page.run(`desktop.onWalkState(walking => onMotionState('walk', walking));
    Math.random = () => 0;
    state.edgeHideEnabled = true; state.peeked = true;
    schedulePeekOuting();`);
  page.advance(90000);
  return { ...page, finishStart() { emit(true); resolveStart(true); } };
}

test('hover stops an edge outing even when preload filters its native stop event', async () => {
  const page = edgeWalkRenderer();
  await new Promise(setImmediate);
  assert.equal(page.run('state.walking'), true);
  assert.equal(page.run('state.pose'), 'walk');
  page.elements.get('mainMascot').classList.add('walk-left');
  page.run('unpeek(true)');
  assert.ok(page.calls.some(call => call.action === 'stop-walk'));
  assert.equal(page.run('state.walking'), false);
  assert.equal(page.run('state.pose'), 'idle');
  assert.equal(page.elements.get('mainMascot').classList.contains('walk-left'), false);
  page.advance(28000);
  assert.equal(page.run('state.pose'), 'blink', 'Idle activity should resume after the walk stops');
  page.advance(152000);
  assert.equal(page.run('state.edgeHold'), false);
  page.advance(70000);
  assert.equal(page.run('state.peeked'), true, 'The cat should dock again after its interaction hold expires');
});

test('hover cancels a pending edge walk without accepting its delayed start event', async () => {
  const page = edgeWalkRenderer({ pending: true });
  assert.equal(page.run('motionPendingKind'), 'walk');
  page.run('unpeek(true)');
  page.finishStart();
  await new Promise(setImmediate);
  assert.ok(page.calls.some(call => call.action === 'stop-walk'));
  assert.equal(page.run('motionPendingKind'), null);
  assert.equal(page.run('state.walking'), false);
  assert.equal(page.run('state.pose'), 'idle');
  assert.equal(page.run('state.edgeAutoOuting'), false);
});

test('an edge walk refused by the native window returns to the side', async () => {
  const page = edgeWalkRenderer({ refused: true });
  await new Promise(setImmediate);
  assert.equal(page.run('motionPendingKind'), null);
  assert.equal(page.run('state.edgeAutoOuting'), false);
  assert.equal(page.run('state.peeked'), true);
});

test('petting during a file transfer returns to holding the file until it finishes', () => {
  const page = renderer();
  page.show({ phase: 'uploading', progress: 10 });
  page.run(`animateLocalAction('pet')`);
  assert.equal(page.animator.action, 'pet');
  page.advance(1000);
  assert.equal(page.animator.action, 'delivery-hold');
  page.show({ phase: 'saved', progress: 100 });
  page.advance(1000);
  assert.equal(page.animator.action, 'idle');
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
