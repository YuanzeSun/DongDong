const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function renderer() {
  const elements = new Map();
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  let clock = 0;
  const context = vm.createContext({
    window: { petDesktop: {
      startWalk: () => { calls.push('walk'); return true; },
      startJump: () => { calls.push('jump'); return true; },
      stopWalk: () => calls.push('stop-walk'),
      stopJump: () => calls.push('stop-jump'),
      setPeeked: value => calls.push(value ? 'hide' : 'reveal'),
      setIgnoreMouseEvents: () => Promise.resolve()
    } },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        hidden: ['quickMessageForm', 'actionTray', 'contextMenu', 'dropOverlay'].includes(id),
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, focus() {},
        getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 })
      });
      return elements.get(id);
    } },
    localStorage: { getItem: () => null, setItem() {} },
    crypto: { randomUUID: () => 'idle-test' },
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay, due: clock + delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    setInterval() {}, clearInterval() {}
  });
  const run = code => vm.runInContext(code, context);
  run(source.slice(0, source.lastIndexOf('\ninit().catch(')));
  run('state.connected = state.peerOnline = state.edgeHideEnabled = true; state.expanded = false;');
  function advance(ms) {
    const target = clock + ms;
    for (let count = 0; count < 100; count++) {
      const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) { clock = target; return; }
      clock = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
    }
    throw new Error('Unexpected recurring idle activity');
  }
  return { run, calls, timers, elements, advance };
}

for (const control of ['setQuickComposer', 'setActionTray']) {
  test(`${control} suspends edge hiding and restarts its full idle delay when closed`, () => {
    const page = renderer();
    page.run('schedulePeek()');
    page.advance(60000);
    page.run(`${control}(true)`);
    page.advance(300000);
    assert.equal(page.run('state.peeked'), false);
    assert.deepEqual(page.calls, []);
    page.run(`${control}(false)`);
    page.advance(69999);
    assert.equal(page.run('state.peeked'), false);
    page.advance(50001);
    assert.equal(page.run('state.peeked'), true);
    assert.deepEqual(page.calls, ['hide']);
  });
}

test('closing one control while the other stays open cannot resume edge hiding', () => {
  const page = renderer();
  page.run('setQuickComposer(true); setActionTray(true); setActionTray(false)');
  page.advance(300000);
  assert.equal(page.run('state.peeked'), false);
  assert.deepEqual(page.calls, []);
});

test('opening controls reveals an edge-hidden cat and rejects a stale hide callback', () => {
  const page = renderer();
  page.run('schedulePeek()');
  const hide = page.timers.get(page.run('peekTimer')).callback;
  page.run('state.peeked = true; setQuickComposer(true)');
  hide();
  page.advance(300000);
  assert.equal(page.run('state.peeked'), false);
  assert.deepEqual(page.calls, ['reveal']);
});

test('long online inactivity keeps the cat idle without starting a pose or movement', () => {
  const page = renderer();
  page.run('state.edgeHideEnabled = false; startCatActivity()');
  page.advance(3600000);
  assert.equal(page.run('state.pose'), 'idle');
  assert.equal(page.run('state.walking || state.jumping'), false);
  assert.deepEqual(page.calls, []);
  assert.equal(page.timers.size, 0);
});

test('an edge-hidden cat stays there until interaction, then gets a fresh stay before hiding', () => {
  const page = renderer();
  page.run('Math.random = () => 0; startCatActivity()');
  page.advance(70000);
  assert.equal(page.run('state.peeked'), true);
  page.advance(3600000);
  assert.deepEqual(page.calls, ['hide']);
  page.run('unpeek(true)');
  assert.equal(page.run('state.peeked'), false);
  page.advance(249999);
  assert.equal(page.run('state.peeked'), false);
  page.advance(1);
  assert.equal(page.run('state.peeked'), true);
  assert.deepEqual(page.calls, ['hide', 'reveal', 'hide']);
});

test('a normal interaction restarts the edge-hide timer before the cat has hidden', () => {
  const page = renderer();
  page.run('Math.random = () => 0; schedulePeek()');
  page.advance(60000);
  page.run('unpeek(true)');
  page.advance(69999);
  assert.equal(page.run('state.peeked'), false);
  page.advance(1);
  assert.equal(page.run('state.peeked'), true);
});

test('offline sleep still follows presence changes without recurring idle actions', () => {
  const page = renderer();
  page.run('state.edgeHideEnabled = false; setPeerOnline(false)');
  page.advance(2999);
  assert.equal(page.run('state.pose'), 'idle');
  page.advance(1);
  assert.equal(page.run('state.pose'), 'nap');
  page.advance(3600000);
  assert.equal(page.run('state.pose'), 'nap');
  assert.deepEqual(page.calls, []);
  page.run('setPeerOnline(true)');
  page.advance(600);
  assert.equal(page.run('state.pose'), 'idle');
});

test('explicit movement remains available while composing or choosing an action', () => {
  const page = renderer();
  page.run("setQuickComposer(true); startMotion('walk'); onMotionState('walk', true); setActionTray(true)");
  assert.deepEqual(page.calls, ['walk']);
  page.run("startMotion('jump'); onMotionState('jump', true); setQuickComposer(false); setQuickComposer(true)");
  assert.deepEqual(page.calls, ['walk', 'stop-walk', 'jump']);
});
