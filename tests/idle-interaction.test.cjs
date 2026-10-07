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
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, focus() {},
        getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 })
      });
      return elements.get(id);
    } },
    localStorage: { getItem: () => null, setItem() {} },
    crypto: { randomUUID: () => 'idle-test' },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    setInterval() {}, clearInterval() {}
  });
  const run = code => vm.runInContext(code, context);
  run(source.slice(0, source.lastIndexOf('\ninit().catch(')));
  run('state.connected = state.peerOnline = state.edgeHideEnabled = true; state.expanded = false;');
  return { run, calls, timers, elements };
}

for (const control of ['setQuickComposer', 'setActionTray']) {
  test(`${control} pauses automatic walking and resumes after a fresh idle delay`, () => {
    const page = renderer();
    page.run("startMotion('walk', true); onMotionState('walk', true);");
    assert.deepEqual(page.calls, ['walk']);
    page.run(`${control}(true);`);
    assert.deepEqual(page.calls, ['walk', 'stop-walk']);
    assert.equal(page.run('state.walking'), false);
    page.run('scheduleIdleAction(); schedulePeek();');
    assert.equal(page.timers.has(page.run('state.idleTimer')), false);
    assert.equal(page.timers.has(page.run('peekTimer')), false);
    page.run(`${control}(false);`);
    assert.ok(page.timers.get(page.run('state.idleTimer')).delay >= 28000);
    assert.ok(page.timers.get(page.run('peekTimer')).delay >= 70000);
    assert.deepEqual(page.calls, ['walk', 'stop-walk']);
  });
}

test('opening one control while the other stays open does not resume automatic activity', () => {
  const page = renderer();
  page.run('setQuickComposer(true); setActionTray(true); setActionTray(false);');
  assert.equal(page.timers.has(page.run('state.idleTimer')), false);
  assert.equal(page.timers.has(page.run('peekTimer')), false);
});

test('controls cancel edge outings and stale timers cannot hide or move the cat', () => {
  const page = renderer();
  page.run('scheduleIdleAction(); schedulePeek();');
  const idle = page.timers.get(page.run('state.idleTimer')).callback;
  const hide = page.timers.get(page.run('peekTimer')).callback;
  page.run('state.peeked = true; schedulePeekOuting();');
  const outing = page.timers.get(page.run('peekOutingTimer')).callback;
  page.run('setQuickComposer(true);');
  idle(); hide(); outing();
  assert.equal(page.run('state.peeked'), false);
  assert.deepEqual(page.calls, ['reveal']);
  page.run('state.edgeAutoOuting = true; finishPeekOuting();');
  assert.equal(page.run('state.peeked'), false);
});

test('opening controls during a wake-up cancels the pending automatic walk', () => {
  const page = renderer();
  page.run("state.pose = 'nap'; startMotion('walk', true);");
  page.run('setQuickComposer(true);');
  const waking = page.timers.get(page.run('wakeTimer'));
  waking.callback();
  assert.equal(page.calls.includes('walk'), false);
});

test('explicit movement remains available while composing or choosing an action', () => {
  const page = renderer();
  page.run("setQuickComposer(true); startMotion('walk'); onMotionState('walk', true); setActionTray(true);");
  assert.deepEqual(page.calls, ['walk']);
  page.run("startMotion('jump'); onMotionState('jump', true); setQuickComposer(false); setQuickComposer(true);");
  assert.deepEqual(page.calls, ['walk', 'stop-walk', 'jump']);
});
