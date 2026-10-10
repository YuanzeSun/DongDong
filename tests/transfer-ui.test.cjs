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
    this._textContent = '';
    this.listeners = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => this.classList[force ?? !this.classList.contains(name) ? 'add' : 'remove'](name)
    };
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._textContent = String(value ?? ''); }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this._textContent = ''; this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
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

function renderer(panelKind = '', storage = new Map()) {
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const element = new Element();
    element.hidden = /\shidden(?:\s|>|=)/.test(tag);
    return [id, element];
  }));
  elements.get('speechShell').appendChild(elements.get('speechOutline'));
  elements.get('speech').append(elements.get('speechShell'), elements.get('speechContent'));
  const calls = [];
  const timers = new Map();
  const listeners = new Map();
  let nextId = 0;
  let clock = 0;
  let nextTimer = 0;
  let animator;
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const desktop = {
    panelKind,
    openPanel: kind => calls.push({ action: 'open-panel', kind }),
    copy: async value => calls.push({ action: 'copy', value }),
    setOnline() {}, setWindowSize() {}, onMenuAction() {}, onWalkState() {}, getAutoLaunch: async () => true,
    notify: (title, message) => calls.push({ action: 'notify', title, message }),
    cancelTransfer: async details => { calls.push({ action: 'cancel', ...details }); },
    retryTransfer: async details => {
      calls.push({ action: 'retry', ...details });
      return { transferId: details.transferId, roomUrl: details.url, direction: 'send', phase: 'uploading', progress: 0, canCancel: true, canRetry: false };
    }
  };
  const context = vm.createContext({
    window: { ConnectionPolicy, petDesktop: desktop, addEventListener: (type, listener) => listeners.set(type, listener), PixelCatAnimator: class {
      constructor() { animator = this; this.action = 'idle'; this.actions = []; }
      play(action) { this.action = action; this.actions.push(action); }
      durationFor() { return 600; }
    } },
    document: { body: new Element('body'), getElementById: id => elements.get(id), createElement: tag => new Element(tag), addEventListener() {}, querySelectorAll: () => [] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => storage.has('dongdong-sender-id-v4') ? `event-${++nextId}` : 'me' },
    URL, URLSearchParams, location: { search: '' }, AbortSignal, WebSocket: Socket,
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
  return { context, run, show, advance, elements, calls, storage, listeners, get animator() { return animator; } };
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
  page.run("speak('她摸了猫', 'alert')");
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

test('live incoming messages get a short attention cue without amplifying action alerts', () => {
  const page = renderer();
  const bubble = page.elements.get('speech');
  const windowElement = page.elements.get('window');
  page.run("speak('晚上一起吃饭呀', 'message', true)");
  assert.equal(bubble.classList.contains('speech-incoming'), true);
  assert.equal(windowElement.classList.contains('message-received'), true);
  page.advance(2799);
  assert.equal(windowElement.classList.contains('message-received'), true);
  page.advance(1);
  assert.equal(windowElement.classList.contains('message-received'), false);
  page.run("speak('她摸了猫', 'alert')");
  assert.equal(bubble.classList.contains('speech-incoming'), true);
  assert.equal(windowElement.classList.contains('message-received'), false);
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
  const content = page.elements.get('speechContent');
  page.run("speak('很长的一段消息', 'message')");
  content.scrollHeight = 240;
  content.clientHeight = 74;
  content.scrollTop = 0;
  bubble.scrollTop = 0;
  page.run('scrollSpeech(80)');
  assert.equal(content.scrollTop, 80);
  page.run('scrollSpeech(1000)');
  assert.equal(content.scrollTop, 166);
  page.run('scrollSpeech(-1000)');
  assert.equal(content.scrollTop, 0);
  assert.equal(bubble.scrollTop, 0);
});

test('speech preserves its outline while replacing text, copying a long message, and clearing', async () => {
  const page = renderer();
  const bubble = page.elements.get('speech');
  const content = page.elements.get('speechContent');
  const shell = page.elements.get('speechShell');
  const outline = page.elements.get('speechOutline');
  const message = '这是一条很长的消息。\n'.repeat(40);
  page.context.message = message;
  page.run("speak(message, 'message', true)");
  content.scrollTop = 160;
  await page.run('copySpeechMessage()');
  assert.deepEqual(page.calls.at(-1), { action: 'copy', value: message });
  assert.equal(content.textContent, message);
  assert.equal(bubble.textContent, message);
  assert.equal(bubble.classList.contains('has-content'), true);
  page.run("speak('新的消息', 'message')");
  assert.equal(content.textContent, '新的消息');
  assert.equal(content.scrollTop, 0);
  page.run('clearSpeech()');
  assert.equal(content.textContent, '');
  assert.equal(bubble.dataset.message, '');
  assert.equal(bubble.classList.contains('has-content'), false);
  assert.deepEqual(bubble.children, [shell, content]);
  assert.deepEqual(shell.children, [outline]);
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

test('actions use distinct history markers while chat retains its message bubble', () => {
  const page = renderer('chat');
  page.run(`renderEvent({ id: 'pet-marker', kind: 'pet', senderId: 'peer', senderName: '她', createdAt: new Date().toISOString() });
    renderEvent({ id: 'chat-bubble', kind: 'message', senderId: 'peer', senderName: '她', text: '晚点见', createdAt: new Date().toISOString() });`);
  const [action, message] = page.elements.get('events').children;
  assert.ok(action.classList.contains('action-event'));
  assert.ok(action.querySelector('.action-marker').querySelector('img').src.endsWith('/hand.svg'));
  assert.equal(action.querySelector('.action-caption').textContent, '她摸了猫');
  assert.equal(action.querySelector('.event-body'), null);
  assert.equal(action.querySelector('.event-meta').textContent.includes('她'), false);
  assert.equal(message.querySelector('.action-marker'), null);
  assert.equal(message.querySelector('.event-body').textContent, '晚点见');
});

test('a sent action enters history once and animates only once after its socket echo', async () => {
  const page = renderer();
  let sent;
  const event = { id: 'sent-pet', kind: 'pet', senderId: 'me', senderName: '我', createdAt: new Date().toISOString() };
  page.context.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => event };
  };
  await page.run("triggerAction('pet')");
  page.context.echo = event;
  page.run('onEvent(echo)');
  assert.equal(sent.kind, 'pet');
  assert.equal(page.elements.get('events').children.length, 1);
  assert.equal(page.elements.get('events').children[0].querySelector('.action-caption').textContent, '我摸了猫');
  assert.equal(page.animator.actions.filter(action => action === 'pet').length, 1);
  assert.equal(page.elements.get('toast').textContent || '', '');
  assert.equal(page.elements.get('speech').textContent || '', '');
});

test('a socket-confirmed action stays sent when its HTTP response is lost', async () => {
  const page = renderer();
  page.context.fetch = async (_url, options) => {
    const { clientId } = JSON.parse(options.body);
    page.context.confirmed = { id: 'confirmed-pet', clientId, kind: 'pet', senderId: 'me', senderName: '我', createdAt: new Date().toISOString() };
    page.run('onEvent(confirmed)');
    throw new Error('HTTP response lost after socket confirmation');
  };
  await page.run("triggerAction('pet')");
  const rows = page.elements.get('events').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classList.contains('unsent'), false);
  assert.equal(page.run('unsentActions().length'), 0);
  assert.equal(page.animator.actions.filter(action => action === 'pet').length, 1);
});

for (const failed of [false, true]) {
  test(`a late ${failed ? 'failed' : 'successful'} action response cannot enter a different IP's history`, async () => {
    const page = renderer();
    let finish;
    page.context.fetch = async (url, options) => {
      if (url.endsWith('/events') && options?.method === 'POST') return new Promise((resolve, reject) => {
        const { clientId } = JSON.parse(options.body);
        finish = () => failed ? reject(new Error('Old room unavailable')) : resolve({ ok: true,
          json: async () => ({ id: 'old-room-pet', clientId, kind: 'pet', senderId: 'me', senderName: '我', createdAt: new Date().toISOString() }) });
      });
      return { ok: true, json: async () => url.endsWith('/session') ? { token: 'new-room', presence: { online: true } } : [] };
    };
    const pending = page.run("triggerAction('pet')");
    await page.run("connect('100.80.0.2', '我', 'join')");
    finish();
    await pending;
    assert.equal(page.elements.get('events').querySelector('.action-event'), null);
    assert.equal(page.run('unsentActions().length'), 0);
    assert.equal(page.animator.actions.includes('pet'), false);
  });
}

for (const historyFirst of [false, true]) {
  test(`a late socket success reconciles a failed action in both windows (${historyFirst ? 'history first' : 'mascot first'})`, async () => {
    const storage = new Map();
    const page = renderer('', storage);
    const panel = renderer('chat', storage);
    await panel.run('init()');
    let clientId;
    page.context.fetch = async (_url, options) => {
      clientId = JSON.parse(options.body).clientId;
      throw new Error('HTTP response timed out');
    };
    await page.run("triggerAction('pet')");
    const key = page.run('LOCAL_ACTIONS_KEY');
    panel.listeners.get('storage')({ key, newValue: storage.get(key) });
    assert.equal(panel.elements.get('events').children[0].classList.contains('unsent'), true);
    const event = { id: 'late-confirmed-pet', clientId, kind: 'pet', senderId: 'me', senderName: '我', createdAt: new Date().toISOString() };
    page.context.confirmed = panel.context.confirmed = event;
    if (historyFirst) panel.run('onEvent(confirmed)');
    page.run('onEvent(confirmed)');
    panel.listeners.get('storage')({ key, newValue: storage.get(key) ?? null });
    if (!historyFirst) panel.run('onEvent(confirmed)');
    for (const view of [page, panel]) {
      const rows = view.elements.get('events').children;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].classList.contains('unsent'), false);
      assert.equal(rows[0].querySelector('.action-caption').textContent, '我摸了猫');
      assert.equal(view.run('unsentActions().length'), 0);
    }
    assert.equal(page.animator.actions.filter(action => action === 'pet').length, 1);
  });
}

test('peer actions name the actor in history and history replay causes no new animation or notification', () => {
  const page = renderer();
  page.context.event = { id: 'peer-pet', kind: 'pet', senderId: 'peer', senderName: '她', createdAt: new Date().toISOString() };
  page.run('onEvent(event, { replay: true })');
  assert.equal(page.elements.get('events').children[0].querySelector('.action-caption').textContent, '她摸了猫');
  assert.deepEqual(page.animator.actions, []);
  assert.deepEqual(page.calls, []);
  assert.equal(page.elements.get('speech').textContent || '', '');
  page.run("onEvent({ ...event, id: 'live-pet' })");
  assert.equal(page.animator.action, 'pet');
  assert.ok(page.calls.some(call => call.action === 'notify' && call.message === '她摸了猫'));
});

test('offline actions animate locally and remain marked unsent when history opens or the peer returns', async () => {
  const page = renderer();
  const requests = [];
  page.context.fetch = async (...args) => { requests.push(args); throw new Error('Offline action attempted a request'); };
  page.run("state.peerOnline = false; state.name = '我'");
  await page.run("triggerAction('pet')");
  await page.run("triggerAction('fish')");
  assert.equal(requests.length, 0);
  assert.equal(page.animator.actions.filter(action => action === 'pet').length, 1);
  assert.equal(page.animator.action, 'fish');
  const rows = page.elements.get('events').children;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.classList.contains('unsent') && row.querySelector('.event-meta').textContent.endsWith('未发送')));
  const panel = renderer('chat', new Map(page.storage));
  await panel.run("connect('127.0.0.1:4827', '我', 'join')");
  const history = panel.elements.get('events').children;
  assert.equal(history.length, 2);
  assert.equal(history[0].querySelector('.action-caption').textContent, '我摸了猫');
  assert.ok(history.every(row => row.classList.contains('unsent')));
  page.run('setPeerOnline(true)');
  page.advance(10000);
  assert.equal(requests.length, 0, 'Returning online must never deliver earlier offline actions');
});

test('repeated offline presence cannot interrupt a local action before it naturally finishes', async () => {
  const page = renderer();
  page.run("setPeerOnline(false); setPose('nap')");
  await page.run("triggerAction('pet')");
  page.run('setPeerOnline(false)');
  page.advance(600);
  assert.equal(page.animator.action, 'pet');
  page.run('setPeerOnline(false)');
  page.advance(500);
  assert.equal(page.animator.action, 'pet');
  page.advance(1000);
  assert.equal(page.run('state.pose'), 'nap');
});

test('an open history panel receives offline action records through shared storage without duplicate rows', async () => {
  const storage = new Map();
  const page = renderer('', storage);
  const panel = renderer('chat', storage);
  await panel.run('init()');
  page.run("state.peerOnline = false; state.name = '我'");
  await page.run("triggerAction('pet')");
  const key = page.run('LOCAL_ACTIONS_KEY');
  const update = { key, newValue: storage.get(key) };
  panel.listeners.get('storage')(update);
  panel.listeners.get('storage')(update);
  const rows = panel.elements.get('events').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.action-caption').textContent, '我摸了猫');
  assert.ok(rows[0].classList.contains('unsent'));
  assert.deepEqual(panel.calls, []);
});

test('switching IP discards local unsent action history as part of the old conversation', async () => {
  const page = renderer();
  page.run("state.peerOnline = false; recordUnsentAction('pet')");
  assert.ok(page.storage.has(page.run('LOCAL_ACTIONS_KEY')));
  await page.run("connect('100.80.0.2', '我', 'join')");
  assert.equal(page.storage.has(page.run('LOCAL_ACTIONS_KEY')), false);
  assert.equal(page.elements.get('events').querySelector('.unsent'), null);
  assert.equal(page.elements.get('events').querySelector('.empty-state')?.textContent, '这里还没有消息');
});

test('a history window adopting a changed IP cannot erase new offline actions already created there', async () => {
  const storage = new Map();
  const page = renderer('', storage);
  const panel = renderer('chat', storage);
  await panel.run('init()');
  await page.run("connect('100.80.0.2', '我', 'join')");
  page.run('setPeerOnline(false)');
  await page.run("triggerAction('pet')");
  const sessionKey = page.run('SESSION_KEY');
  panel.listeners.get('storage')({ key: sessionKey, newValue: storage.get(sessionKey) });
  await new Promise(setImmediate);
  assert.equal(page.run('unsentActions().length'), 1);
  const rows = panel.elements.get('events').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.action-caption').textContent, '我摸了猫');
  assert.equal(rows[0].classList.contains('unsent'), true);
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
  page.run(`setExpanded = startCatActivity = transitionPose = () => {};`);
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
  page.run(`setExpanded = startCatActivity = transitionPose = () => {};`);
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
