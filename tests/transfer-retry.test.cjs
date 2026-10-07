const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoom } = require('../server/room.cjs');
const { createTransferManager } = require('../electron/transfer-manager.cjs');

test('only the receiver retries an uploaded file after saving fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongdong-retry-'));
  const source = path.join(root, 'letter.txt');
  fs.writeFileSync(source, 'a letter');
  const room = createRoom({ host: '127.0.0.1', port: 0, hostId: 'host', dataDir: path.join(root, 'room'), staticDir: path.join(__dirname, '../public') });
  const { port } = await room.listen();
  const url = `http://127.0.0.1:${port}`;
  const session = async (senderId, mode) => (await fetch(`${url}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId, senderName: senderId, mode })
  })).json();
  const host = await session('host', 'host');
  const guest = await session('guest', 'join');
  let downloads = source; // A regular file cannot be used as a download directory.
  const sender = createTransferManager({ downloadsPath: () => root, onProgress() {} });
  const receiver = createTransferManager({ downloadsPath: () => downloads, onProgress() {} });
  const waitFor = async (manager, predicate) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const item = manager.snapshot().find(predicate);
      if (item) return item;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Transfer did not reach expected state');
  };
  const sync = async () => {
    const transfers = await (await fetch(`${url}/api/transfers`, { headers: { 'X-Pet-Session': host.token } })).json();
    transfers.forEach(item => sender.updateTransfer(url, item));
  };
  try {
    sender.upload({ url, token: host.token, path: source, transferId: 'letter' });
    const uploaded = await waitFor(sender, item => item.phase === 'uploaded');
    const failed = await receiver.download({ url, token: guest.token, fileId: uploaded.fileId, fileName: 'letter.txt', transferId: 'letter' });
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.canRetry, true);
    await sync();
    assert.equal(sender.snapshot()[0].canRetry, false);
    assert.throws(() => sender.retry({ url, token: host.token, transferId: 'letter' }), /请对方重试接收/);

    downloads = path.join(root, 'downloads');
    receiver.retry({ url, token: guest.token, transferId: 'letter' });
    const saved = await waitFor(receiver, item => item.phase === 'saved' && !item.canCancel);
    assert.equal(fs.readFileSync(saved.savedPath, 'utf8'), 'a letter');
    await sync();
    assert.equal(sender.snapshot()[0].phase, 'saved');
    const events = await (await fetch(`${url}/api/events`, { headers: { 'X-Pet-Session': host.token } })).json();
    assert.equal(events.filter(item => item.kind === 'file').length, 1);
    assert.doesNotThrow(() => sender.upload({ url, token: host.token, path: source, transferId: 'next' }));
    await waitFor(sender, item => item.transferId === 'next' && item.phase === 'uploaded');
  } finally {
    sender.close(); receiver.close();
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
