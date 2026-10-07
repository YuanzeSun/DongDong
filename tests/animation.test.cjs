const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTIONS, sample, normalize } = require('../public/mascot-animator.js');

test('interactive actions have distinct articulated frames', () => {
  for (const action of ['wave', 'fish', 'stretch', 'groom', 'hug', 'kiss', 'pet', 'sit', 'happy', 'jump', 'delivery', 'receive']) {
    const frames = Array.from({ length: ACTIONS[action].frames }, (_, index) => sample(action, index));
    const unique = new Set(frames.map(frame => JSON.stringify(frame)));
    assert.ok(frames.length >= 20, `${action} needs a full animation sequence`);
    assert.ok(unique.size >= 12, `${action} needs distinct drawings`);
    assert.ok(frames.some(frame => frame.hx !== 0 || frame.hy !== 0 || frame.lx !== 0 || frame.ly !== 0 || frame.rx !== 0 || frame.ry !== 0), `${action} needs articulated motion`);
  }
});

test('sleep wakes before standing, and walk changes leg positions', () => {
  assert.equal(sample('wake', 0).sleepArt, true);
  assert.equal(sample('wake', ACTIONS.wake.frames - 1).sleepArt, undefined);
  assert.notDeepEqual(sample('walk', 0), sample('walk', Math.floor(ACTIONS.walk.frames / 2)));
  assert.equal(normalize('nap'), 'sleep');
});

test('resting poses and purr use distinct silhouettes and rise transitions', () => {
  assert.equal(sample('loaf', 0).loafArt, true);
  assert.equal(sample('purr', 0).loafArt, true);
  assert.equal(sample('purr', 0).prop, '');
  assert.equal(sample('nest', 0).sleepArt, true);
  assert.equal(sample('nest', 0).bedArt, true);
  assert.equal(sample('loaf-enter', 0).loafArt, undefined);
  assert.equal(sample('loaf-enter', ACTIONS['loaf-enter'].frames - 1).loafArt, true);
  assert.equal(sample('loaf-rise', 0).loafArt, true);
  assert.equal(sample('loaf-rise', ACTIONS['loaf-rise'].frames - 1).loafArt, undefined);
  assert.equal(sample('nest-rise', 0).bedArt, true);
  assert.equal(sample('nest-rise', ACTIONS['nest-rise'].frames - 1).bedArt, undefined);
  assert.notDeepEqual(sample('purr', 0), sample('purr', Math.floor(ACTIONS.purr.frames / 4)));
});
