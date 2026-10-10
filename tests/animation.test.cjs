const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTIONS, sample, normalize } = require('../public/mascot-animator.js');

test('interactive actions have distinct articulated frames', () => {
  for (const action of ['wave', 'fish', 'stretch', 'groom', 'hug', 'kiss', 'pet', 'jump', 'delivery', 'receive']) {
    const frames = Array.from({ length: ACTIONS[action].frames }, (_, index) => sample(action, index));
    const unique = new Set(frames.map(frame => JSON.stringify(frame)));
    assert.ok(frames.length >= 20, `${action} needs a full animation sequence`);
    assert.ok(unique.size >= 12, `${action} needs distinct drawings`);
    assert.ok(frames.some(frame => frame.hx !== 0 || frame.hy !== 0 || frame.lx !== 0 || frame.ly !== 0 || frame.rx !== 0 || frame.ry !== 0), `${action} needs articulated motion`);
  }
});

test('finished gestures lower their paws and settle into idle before switching poses', () => {
  const idle = sample('idle', 0);
  const parts = ['bx', 'by', 'hx', 'hy', 'lx', 'ly', 'rx', 'ry', 'rlx', 'rly', 'rrx', 'rry', 'tx', 'ty', 'sy'];
  for (const action of ['wave', 'fish', 'stretch', 'groom', 'hug', 'kiss', 'pet', 'jump', 'delivery', 'receive', 'wake', 'loaf-rise', 'nest-rise']) {
    const last = ACTIONS[action].frames - 1;
    const end = sample(action, last);
    for (const part of [...parts, 'tail', 'eye', 'mouth', 'prop']) {
      assert.equal(end[part], idle[part], `${action} leaves ${part} displaced at the idle handoff`);
    }
    for (let frame = last - 2; frame <= last; frame++) {
      const before = sample(action, frame - 1);
      const after = sample(action, frame);
      for (const part of parts) assert.ok(Math.abs(after[part] - before[part]) <= 3, `${action} snaps ${part} instead of settling`);
    }
  }
});

test('sleep wakes before standing, and walk changes leg positions', () => {
  assert.equal(sample('wake', 0).sleepArt, true);
  assert.equal(sample('wake', ACTIONS.wake.frames - 1).sleepArt, undefined);
  assert.notDeepEqual(sample('walk', 0), sample('walk', Math.floor(ACTIONS.walk.frames / 2)));
  assert.equal(normalize('nap'), 'sleep');
});

test('walk has a full, eased four-paw gait instead of a four-frame metronome', () => {
  const frames = Array.from({ length: ACTIONS.walk.frames }, (_, index) => sample('walk', index));
  const unique = new Set(frames.map(frame => JSON.stringify(frame)));
  assert.ok(ACTIONS.walk.frames >= 40);
  assert.ok(unique.size >= 30, 'walk should visibly change throughout the cycle');
  assert.ok(new Set(frames.map(frame => frame.tail)).size >= 4, 'tail should counterbalance the steps');
  assert.ok(new Set(frames.map(frame => frame.hx)).size >= 3, 'head should have a subtle independent sway');
  assert.ok(frames.some(frame => frame.by < -1), 'body should rise during a stride');
  for (const frame of frames) {
    const lifted = [frame.ly, frame.ry, frame.rly, frame.rry].filter(value => value < -1.5).length;
    assert.ok(lifted <= 1, 'walk should keep three paws supporting the body');
  }
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1];
    const current = frames[index];
    for (const part of ['by', 'hy', 'hx', 'lx', 'ly', 'rx', 'ry', 'rlx', 'rly', 'rrx', 'rry', 'tx', 'ty']) {
      assert.ok(Math.abs(current[part] - previous[part]) <= 2, `walk snaps ${part}`);
    }
  }
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
  assert.equal(sample('sleep', ACTIONS.sleep.frames - 1).sleepArt, true);
  assert.equal(sample('nest', ACTIONS.nest.frames - 1).bedArt, true);
  assert.equal(sample('loaf', ACTIONS.loaf.frames - 1).loafArt, true);
});
