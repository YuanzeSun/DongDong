const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { clampBounds } = require('../electron/native-helpers.cjs');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const start = source.indexOf("    ipcMain.on('move-window',");
const end = source.indexOf("    ipcMain.handle('start-walk',", start);
assert.ok(start >= 0 && end > start, 'main process drag handler must be present');

function dragWindow(initial = { x: 400, y: 250, width: 300, height: 340 }, area = { x: 0, y: 25, width: 1400, height: 875 }) {
  let bounds = { ...initial };
  let handler;
  const sender = {};
  const positions = [];
  const stopped = [];
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { on(channel, callback) { assert.equal(channel, 'move-window'); handler = callback; } },
    ownsCat: event => event.sender === sender,
    walkTimer: 1,
    jumpTimer: 1,
    stopWalk: () => stopped.push('walk'),
    stopJump: () => stopped.push('jump'),
    clampBounds,
    screen: { getDisplayMatching: () => ({ workArea: area }) },
    window: {
      getBounds: () => ({ ...bounds }),
      setPosition(x, y, animate) {
        assert.ok([x, y].every(value => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31),
          `native window coordinates must fit Int32: ${x}, ${y}`);
        assert.ok(x >= area.x && x <= area.x + area.width - bounds.width, `x must be clamped before native move: ${x}`);
        assert.ok(y >= area.y && y <= area.y + area.height - bounds.height, `y must be clamped before native move: ${y}`);
        assert.equal(animate, false);
        positions.push([x, y]);
        bounds = { ...bounds, x, y };
      }
    }
  });
  return { positions, stopped, move: (dx, dy, owner = true) => handler({ sender: owner ? sender : {} }, dx, dy) };
}

test('drag applies fractional pointer deltas once as native integer coordinates', () => {
  const cat = dragWindow();
  cat.move(12.6, -4.6);
  assert.deepEqual(cat.positions, [[413, 245]]);
  assert.deepEqual(cat.stopped, ['walk', 'jump']);
});

test('drag clamps to every screen edge before moving the native window', () => {
  const cat = dragWindow();
  cat.move(10000, -10000);
  cat.move(-10000, 10000);
  assert.deepEqual(cat.positions, [[1100, 25], [0, 560]]);
});

test('drag preserves negative monitor coordinates and clamps within that monitor', () => {
  const cat = dragWindow(
    { x: -1500, y: -200, width: 300, height: 340 },
    { x: -1920, y: -400, width: 1920, height: 1080 }
  );
  cat.move(12.6, -4.6);
  cat.move(-10000, -10000);
  cat.move(10000, 10000);
  assert.deepEqual(cat.positions, [[-1487, -205], [-1920, -400], [-300, 340]]);
});

for (const delta of [2 ** 31, -(2 ** 31), Number.MAX_VALUE, -Number.MAX_VALUE]) {
  test(`drag bounds finite extreme delta ${delta} before native conversion`, () => {
    const cat = dragWindow();
    cat.move(delta, delta);
    assert.deepEqual(cat.positions, [delta > 0 ? [1100, 560] : [0, 25]]);
  });
}

test('drag ignores non-finite deltas on either axis without interrupting movement', () => {
  const cat = dragWindow();
  for (const delta of [NaN, Infinity, -Infinity, undefined]) {
    cat.move(delta, 10);
    cat.move(10, delta);
  }
  assert.deepEqual(cat.positions, []);
  assert.deepEqual(cat.stopped, []);
});

test('auxiliary windows cannot move the mascot or interrupt its movement', () => {
  const cat = dragWindow();
  cat.move(10, 20, false);
  assert.deepEqual(cat.positions, []);
  assert.deepEqual(cat.stopped, []);
});
