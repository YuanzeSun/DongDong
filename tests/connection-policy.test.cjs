const assert = require('node:assert/strict');
const test = require('node:test');
const { retryDelay, shouldRetry } = require('../public/connection-policy.js');

test('connection retries back off with jitter and never exceed thirty seconds', () => {
  const delays = Array.from({ length: 12 }, (_, attempt) => retryDelay(attempt, () => 0.5));
  assert.equal(delays[0], 1500);
  assert.ok(delays[1] > delays[0]);
  assert.ok(delays[3] > delays[2]);
  assert.equal(delays.at(-1), 30000);
  for (let attempt = 0; attempt < 15; attempt++) {
    const low = retryDelay(attempt, () => 0);
    const high = retryDelay(attempt, () => 1);
    assert.ok(low > 0 && low < high);
    assert.ok(high <= 30000);
  }
});

test('recovery retries offline and temporary server failures but stops for rejected sessions', () => {
  for (const error of [new TypeError('Failed to fetch'), { code: 'ROOM_UNREACHABLE' }, { status: 408 }, { status: 429 }, { status: 503 }]) {
    assert.equal(shouldRetry(error), true);
  }
  for (const status of [400, 401, 403, 404, 409]) assert.equal(shouldRetry({ status }), false);
});
