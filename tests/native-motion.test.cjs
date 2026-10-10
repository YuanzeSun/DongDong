const assert = require('node:assert/strict');
const test = require('node:test');
const { planWalkTimeline, walkPositionAt, tailnetPeers } = require('../electron/native-helpers.cjs');

function seeded(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test('strolls vary their curved destinations without mirrored out-and-back legs', () => {
  const area = { x: 40, y: 30, width: 1600, height: 1000 };
  const bounds = { x: 600, y: 300, width: 300, height: 340 };
  const paths = [];
  let changesDirection = false;
  let continuesDirection = false;
  for (let seed = 1; seed <= 16; seed++) {
    const timeline = planWalkTimeline(bounds, area, seeded(seed));
    assert.ok(timeline.segments.length === 3 || timeline.segments.length === 4);
    assert.ok(timeline.totalMs >= 15000 && timeline.totalMs <= 25000);
    paths.push(timeline.segments.map(({ to }) => [Math.round(to.x), Math.round(to.y)]));
    let curved = false;
    let elapsedMs = 0;
    timeline.segments.forEach(({ from, to, travelMs, pauseMs }, index) => {
      const chord = Math.hypot(to.x - from.x, to.y - from.y);
      const middle = walkPositionAt(timeline, elapsedMs + travelMs / 2);
      const bend = Math.abs((middle.x - from.x) * (to.y - from.y) - (middle.y - from.y) * (to.x - from.x)) / chord;
      if (bend > 5) curved = true;
      elapsedMs += travelMs + pauseMs;
      if (!index) return;
      const previous = timeline.segments[index - 1];
      assert.ok(Math.hypot(to.x - previous.from.x, to.y - previous.from.y) >= 35, 'should choose a new destination instead of retracing');
      const direction = Math.sign(to.x - from.x);
      if (direction === Math.sign(previous.to.x - previous.from.x)) continuesDirection = true;
      else changesDirection = true;
    });
    assert.ok(curved, 'stroll needs a visible curved segment');
  }
  assert.equal(new Set(paths.map(points => JSON.stringify(points))).size, paths.length);
  assert.ok(changesDirection && continuesDirection, 'direction changes must vary instead of alternating mechanically');
});

test('stroll sampling is slow, eased and contained at corners, narrow areas and negative monitor origins', () => {
  const cases = [
    [{ x: 430, y: 300, width: 300, height: 340 }, { x: 0, y: 0, width: 1400, height: 900 }],
    [{ x: 400, y: 260, width: 300, height: 340 }, { x: 0, y: 0, width: 700, height: 600 }],
    [{ x: 0, y: 0, width: 300, height: 340 }, { x: 0, y: 0, width: 330, height: 600 }],
    [{ x: -1550, y: -250, width: 300, height: 340 }, { x: -1920, y: -400, width: 1920, height: 1080 }]
  ];
  for (const [bounds, area] of cases) for (let seed = 1; seed <= 12; seed++) {
    const timeline = planWalkTimeline(bounds, area, seeded(seed));
    const first = timeline.segments[0];
    const start = walkPositionAt(timeline, 0);
    const early = walkPositionAt(timeline, first.travelMs * .1);
    const middle = walkPositionAt(timeline, first.travelMs * .5);
    assert.ok(Math.hypot(early.x - start.x, early.y - start.y) < Math.hypot(middle.x - start.x, middle.y - start.y) * .3, 'start should ease in');
    const paused = walkPositionAt(timeline, first.travelMs + first.pauseMs * .5);
    assert.equal(paused.pace, 0);
    assert.equal(paused.x, first.to.x);
    assert.equal(paused.y, first.to.y);
    let previous = start;
    for (let elapsed = 20; elapsed < timeline.totalMs; elapsed += 20) {
      const position = walkPositionAt(timeline, elapsed);
      const speed = Math.hypot(position.x - previous.x, position.y - previous.y) / .02;
      assert.ok(speed <= 45, `stroll accelerated to ${speed} px/s`);
      assert.ok(position.x >= area.x - 1e-6 && position.x <= area.x + area.width - bounds.width + 1e-6);
      assert.ok(position.y >= area.y - 1e-6 && position.y <= area.y + area.height - bounds.height + 1e-6);
      previous = position;
    }
    assert.equal(walkPositionAt(timeline, timeline.totalMs + 1).done, true);
  }
  assert.deepEqual(planWalkTimeline({ x: 0, y: 0, width: 300, height: 340 }, { x: 0, y: 0, width: 330, height: 370 }).segments, []);
});

test('tailnet discovery keeps valid peer IPv4 addresses and online order', () => {
  const peers = tailnetPeers({
    Self: { TailscaleIPs: ['100.64.0.1'] },
    Peer: {
      a: { HostName: 'offline-pc', Online: false, TailscaleIPs: ['100.90.0.4'] },
      b: { HostName: 'online-pc', Online: true, TailscaleIPs: ['fd7a:115c:a1e0::1', '100.80.0.3'] },
      c: { HostName: 'invalid', Online: true, TailscaleIPs: ['100.999.0.1'] },
      d: { HostName: 'self', Online: true, TailscaleIPs: ['100.64.0.1'] }
    }
  });
  assert.deepEqual(peers, [
    { address: '100.80.0.3', name: 'online-pc', online: true },
    { address: '100.90.0.4', name: 'offline-pc', online: false }
  ]);
});
