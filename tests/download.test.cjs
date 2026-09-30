const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveResponseDownload } = require('../electron/native-helpers.cjs');

test('streamed downloads keep unicode names, report progress, and avoid overwrites', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dongdong-download-'));
  try {
    const progress = [];
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('hello '));
        controller.enqueue(Buffer.from('world'));
        controller.close();
      }
    }), { headers: { 'content-length': '11' } });
    const first = await saveResponseDownload(directory, response, '你好.txt', 100, (received, total) => progress.push([received, total]));
    assert.equal(path.basename(first), '你好.txt');
    assert.equal(await fs.readFile(first, 'utf8'), 'hello world');
    assert.deepEqual(progress.at(-1), [11, 11]);
    const second = await saveResponseDownload(directory, new Response('again'), '你好.txt', 100);
    assert.equal(path.basename(second), '你好 (1).txt');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed or oversized downloads leave no partial file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dongdong-download-fail-'));
  try {
    await assert.rejects(saveResponseDownload(directory, new Response('too large'), 'big.txt', 3), /超过允许/);
    assert.deepEqual(await fs.readdir(directory), []);
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('part'));
        controller.error(new Error('connection lost'));
      }
    }));
    await assert.rejects(saveResponseDownload(directory, response, 'broken.txt', 100), /connection lost/);
    assert.deepEqual(await fs.readdir(directory), []);
    await assert.rejects(saveResponseDownload(directory, new Response('short', { headers: { 'content-length': '10' } }), 'short.txt', 100), /不完整/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
