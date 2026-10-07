const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function renderer(panelKind) {
  const calls = [];
  const elements = new Map();
  for (const [tag, id] of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    assert.ok(!elements.has(id), `Duplicate element id: ${id}`);
    elements.set(id, {
      parentElement: null,
      hidden: /\shidden(?:\s|>|=)/.test(tag),
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild(child) { child.parentElement = this; return child; }
    });
  }
  const storage = new Map();
  const desktop = new Proxy({ panelKind }, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => calls.push({ key, args });
    }
  });
  const context = vm.createContext({
    window: { petDesktop: desktop },
    document: {
      body: { classList: { add() {} } },
      getElementById(id) {
        assert.ok(elements.has(id), `Unknown element: ${id}`);
        return elements.get(id);
      }
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID: () => 'window-test' },
    setTimeout: (...args) => calls.push({ key: 'timeout', args }),
    setInterval: (...args) => calls.push({ key: 'interval', args }),
    clearTimeout() {}, clearInterval() {}
  });
  // Load the renderer functions without booting network connections or the UI.
  vm.runInContext(source.slice(0, source.lastIndexOf('\ninit().catch(')), context);
  return { context, elements, calls, run: code => vm.runInContext(code, context) };
}

for (const panel of ['settings', 'chat']) {
  test(`${panel} panel cannot start cat animation, timers, or desktop movement`, () => {
    const page = renderer(panel);
    page.run(`
      state.connected = true;
      state.peerOnline = true;
      state.edgeHideEnabled = true;
      startCatActivity();
      scheduleNap(); schedulePeek(); schedulePeekOuting(); scheduleIdleAction();
      setPose('sleep'); transitionPose('nest');
      wakeThen(() => { throw new Error('Panel ran a motion callback'); });
      speak('喵'); actionVoice('purr');
      animateLocalAction('happy'); animateRemoteAction('purr'); animateLocalAction('walk');
      startMotion('walk'); startMotion('jump');
      onMotionState('walk', true); onMotionState('jump', true); interruptMotion();
      state.peeked = true;
      state.edgeAutoOuting = true;
      unpeek(true); finishPeekOuting();
      setEdgeHide(false);
    `);
    assert.deepEqual(page.calls, []);
    assert.equal(page.run('state.pose'), 'idle');
    assert.equal(page.run('state.walking'), false);
    assert.equal(page.run('state.jumping'), false);
    assert.equal(page.run('state.edgeHideEnabled'), false);
    assert.equal(page.elements.get('edgeHideToggle').checked, false);
  });
}

test('the same application preferences stay available before and after pairing', () => {
  const page = renderer('settings');
  const preferences = page.elements.get('preferenceSettings');
  const autoLaunch = page.elements.get('autoLaunchSetup');
  page.run('setAutoLaunchToggles(true); placePreferences()');
  assert.equal(preferences.parentElement, page.elements.get('setupPreferences'));
  page.run('state.connected = true; setView("connection")');
  assert.equal(preferences.parentElement, page.elements.get('connectionPreferences'));
  assert.equal(page.elements.get('connectionView').hidden, false);
  assert.equal(page.elements.get('appSettings').hidden, true);
  assert.equal(autoLaunch.checked, true);
  page.run('state.connected = false; placePreferences()');
  assert.equal(preferences.parentElement, page.elements.get('setupPreferences'));
  assert.equal(autoLaunch.checked, true);
});
