const assert = require('node:assert/strict');
const test = require('node:test');
const { planWalkPath, tailnetPeers } = require('../electron/native-helpers.cjs');

test('walk visits both directions and stays inside the work area', () => {
  const area = { x: 40, y: 30, width: 1000, height: 750 };
  const bounds = { x: 400, y: 360, width: 300, height: 340 };
  const points = planWalkPath(bounds, area, () => 0);
  assert.ok(points.length >= 3);
  const xs = [bounds.x, ...points.map(point => point.x)];
  assert.ok(xs.some((x, index) => index > 0 && x < xs[index - 1]));
  assert.ok(xs.some((x, index) => index > 0 && x > xs[index - 1]));
  for (const point of points) {
    assert.ok(point.x >= area.x && point.x <= area.x + area.width - bounds.width);
    assert.ok(point.y >= area.y && point.y <= area.y + area.height - bounds.height);
  }
});

test('walk turns inward near an edge and skips unusably narrow screens', () => {
  const area = { x: 0, y: 0, width: 700, height: 600 };
  const points = planWalkPath({ x: 400, y: 100, width: 300, height: 340 }, area, () => 0);
  assert.ok(points[0].x < 400);
  assert.deepEqual(planWalkPath({ x: 0, y: 0, width: 300, height: 340 }, { x: 0, y: 0, width: 330, height: 600 }), []);
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
