const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRoom } = require('../server/room.cjs');
const { createTransferManager, roomOrigin } = require('../electron/transfer-manager.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Condition not met in ${timeout}ms`);
}
function terminal(manager, transferId, timeout) {
  return until(() => manager.snapshot().find(job => job.transferId === transferId
    && ['uploaded', 'saved', 'failed', 'cancelled'].includes(job.phase)
    && (job.phase === 'uploaded' || job.phase === 'saved' && !job.canCancel || job.canRetry)), timeout);
}
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongdong-transfer-'));
  const downloads = path.join(root, 'downloads'); fs.mkdirSync(downloads);
  return { root, downloads, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function startRoom(root) {
  const room = createRoom({ host: '127.0.0.1', port: 0, hostId: 'host', dataDir: path.join(root, 'room'), staticDir: path.join(__dirname, '..', 'public') });
  const { port } = await room.listen(); const url = `http://127.0.0.1:${port}`;
  async function session(senderId, mode) {
    const response = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId, senderName: senderId, mode }) });
    assert.equal(response.status, 201); return response.json();
  }
  return { room, url, host: await session('host', 'host'), guest: await session('guest', 'join') };
}
async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
function statusReply(req, res) {
  if (req.url !== '/api/transfers') return false;
  req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  return true;
}

test('native transfer manager streams real room upload/download and publishes saved progress', async () => {
  const temp = scratch(); const ctx = await startRoom(temp.root); const phases = [];
  const sender = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: job => phases.push(`send:${job.phase}`) });
  const receiver = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: job => phases.push(`receive:${job.phase}`) });
  try {
    const content = crypto.randomBytes(280000); const source = path.join(temp.root, '照片 中文.bin'); fs.writeFileSync(source, content);
    const initial = sender.upload({ url: ctx.url, token: ctx.host.token, path: source, transferId: 'real-transfer' });
    assert.equal(initial.phase, 'uploading'); assert.equal(initial.canCancel, true);
    const sent = await terminal(sender, 'real-transfer'); assert.equal(sent.phase, 'uploaded'); assert.equal(sent.progress, 100);
    const saved = await receiver.download({ url: ctx.url, token: ctx.guest.token, fileId: sent.fileId, fileName: '照片 中文.bin', transferId: 'real-transfer' });
    assert.equal(saved.phase, 'saved'); assert.equal(saved.progress, 100); assert.equal(saved.canCancel, false);
    const actualDirectory = fs.statSync(path.dirname(saved.savedPath));
    const expectedDirectory = fs.statSync(temp.downloads);
    assert.equal(actualDirectory.dev, expectedDirectory.dev);
    assert.equal(actualDirectory.ino, expectedDirectory.ino);
    assert.deepEqual(fs.readFileSync(saved.savedPath), content);
    assert.ok(phases.includes('send:uploading')); assert.ok(phases.includes('send:uploaded'));
    assert.ok(phases.includes('receive:downloading')); assert.ok(phases.includes('receive:saved'));
    const records = await (await fetch(`${ctx.url}/api/transfers`, { headers: { 'X-Pet-Session': ctx.host.token } })).json();
    assert.equal(records[0].phase, 'saved'); assert.equal(records[0].progress, 100);
  } finally { sender.close(); receiver.close(); await ctx.room.close(); temp.clean(); }
});

test('upload idle timeout fails, and cancelling a partial upload can retry successfully', async () => {
  const temp = scratch(); let stall = true; let received = 0;
  const fake = await localServer((req, res) => {
    if (statusReply(req, res)) return;
    req.on('data', chunk => { received += chunk.length; if (stall) req.pause(); });
    req.on('end', () => { if (!stall) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ fileId: crypto.randomUUID() })); } });
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {}, idleTimeoutMs: 100, totalTimeoutMs: 2000 });
  try {
    const source = path.join(temp.root, 'large.bin'); fs.writeFileSync(source, Buffer.alloc(12 * 1024 * 1024, 5));
    manager.upload({ url: fake.url, token: 'test', path: source, transferId: 'idle-send' });
    const failed = await terminal(manager, 'idle-send', 1200); assert.equal(failed.phase, 'failed'); assert.match(failed.error, /超时/); assert.equal(failed.canRetry, true);
    received = 0;
    manager.upload({ url: fake.url, token: 'test', path: source, transferId: 'cancel-send' });
    await until(() => received > 0); assert.ok(received < fs.statSync(source).size);
    assert.equal(manager.cancel({ url: fake.url, transferId: 'cancel-send' }), true);
    const cancelled = await terminal(manager, 'cancel-send'); assert.equal(cancelled.phase, 'cancelled');
    stall = false;
    manager.retry({ url: fake.url, token: 'fresh-session', transferId: 'cancel-send' });
    const retried = await terminal(manager, 'cancel-send'); assert.equal(retried.phase, 'uploaded'); assert.equal(retried.canRetry, false);
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('download idle timeout removes partial file before the overall deadline', async () => {
  const temp = scratch();
  const fake = await localServer((req, res) => {
    if (statusReply(req, res)) return;
    res.writeHead(200, { 'Content-Length': 2000 }); res.write(Buffer.alloc(200, 3));
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {}, idleTimeoutMs: 80, totalTimeoutMs: 1000 });
  try {
    const downloading = manager.download({ url: fake.url, token: 'test', fileId: crypto.randomUUID(), fileName: 'partial.bin', transferId: 'idle-receive' });
    assert.throws(() => manager.download({ url: fake.url, token: 'test', fileId: crypto.randomUUID(), fileName: 'another.bin', transferId: 'second-receive' }), /上一个文件/);
    const failed = await terminal(manager, 'idle-receive', 700);
    assert.equal(failed.phase, 'failed'); assert.match(failed.error, /超时/); assert.equal(failed.canRetry, true);
    await downloading; assert.deepEqual(fs.readdirSync(temp.downloads), []);
  } finally { manager.close(); await until(() => manager.snapshot().every(job => !job.canCancel)); await fake.close(); temp.clean(); }
});

test('cancelled partial downloads clean disk, and retry saves the full file', async () => {
  const temp = scratch(); let stall = true; const data = crypto.randomBytes(64000);
  const fake = await localServer((req, res) => {
    if (statusReply(req, res)) return;
    res.writeHead(200, { 'Content-Length': data.length });
    if (stall) res.write(data.subarray(0, 16000)); else res.end(data);
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {}, idleTimeoutMs: 1000, totalTimeoutMs: 3000 });
  try {
    const downloading = manager.download({ url: fake.url, token: 'test', fileId: crypto.randomUUID(), fileName: 'cancelled.bin', transferId: 'cancel-receive' });
    await until(() => manager.snapshot()[0]?.progress > 0);
    assert.equal(manager.cancel({ url: fake.url, transferId: 'cancel-receive' }), true);
    assert.equal((await downloading).phase, 'cancelled'); assert.deepEqual(fs.readdirSync(temp.downloads), []);
    assert.equal((await manager.download({ url: fake.url, token: 'test', transferId: 'cancel-receive' })).phase, 'cancelled');
    stall = false; manager.retry({ url: fake.url, token: 'fresh-session', transferId: 'cancel-receive' });
    const saved = await terminal(manager, 'cancel-receive'); assert.equal(saved.phase, 'saved'); assert.deepEqual(fs.readFileSync(saved.savedPath), data);
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('retry after losing the upload response reuses the transfer without duplicating a file or room event', async () => {
  const temp = scratch(); const ctx = await startRoom(temp.root); let loseReply = true;
  const proxy = await localServer((req, res) => {
    const upstream = http.request(`${ctx.url}${req.url}`, { method: req.method, headers: req.headers }, reply => {
      if (req.url === '/api/files' && loseReply) {
        loseReply = false; reply.resume(); reply.on('end', () => res.destroy());
      } else { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); }
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {}, idleTimeoutMs: 300, totalTimeoutMs: 3000 });
  try {
    const source = path.join(temp.root, 'retry.txt'); fs.writeFileSync(source, 'exactly once');
    manager.upload({ url: proxy.url, token: ctx.host.token, path: source, transferId: 'retry-transfer' });
    assert.equal((await terminal(manager, 'retry-transfer')).phase, 'failed');
    manager.retry({ url: proxy.url, token: ctx.host.token, transferId: 'retry-transfer' });
    assert.equal((await terminal(manager, 'retry-transfer')).phase, 'uploaded');
    const events = await (await fetch(`${ctx.url}/api/events`, { headers: { 'X-Pet-Session': ctx.host.token } })).json();
    assert.equal(events.filter(event => event.kind === 'file').length, 1);
    assert.equal(fs.readdirSync(path.join(temp.root, 'room', 'files')).length, 1);
  } finally { manager.close(); await proxy.close(); await ctx.room.close(); temp.clean(); }
});

test('one file stays reserved after upload until the peer saves it; retry also respects that slot', async () => {
  const temp = scratch(); const ctx = await startRoom(temp.root);
  const sender = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {} });
  const receiver = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {} });
  try {
    const source = path.join(temp.root, 'one.txt'); fs.writeFileSync(source, 'one at a time');
    const details = { url: ctx.url, token: ctx.host.token, path: source };
    sender.upload({ ...details, path: path.join(temp.root, 'missing.txt'), transferId: 'failed-before' });
    assert.equal((await terminal(sender, 'failed-before')).phase, 'failed');
    sender.upload({ ...details, transferId: 'one' });
    assert.throws(() => sender.upload({ ...details, transferId: 'two' }), /上一个文件/);
    const uploaded = await terminal(sender, 'one'); assert.equal(uploaded.phase, 'uploaded');
    assert.equal(uploaded.canCancel, true);
    assert.throws(() => sender.upload({ ...details, transferId: 'two' }), /上一个文件/);
    assert.throws(() => sender.retry({ url: ctx.url, transferId: 'failed-before' }), /上一个文件/);
    const saved = await receiver.download({ url: ctx.url, token: ctx.guest.token, transferId: 'one', fileId: uploaded.fileId, fileName: 'one.txt' });
    assert.equal(saved.phase, 'saved');
    const snapshots = await (await fetch(`${ctx.url}/api/transfers`, { headers: { 'X-Pet-Session': ctx.host.token } })).json();
    sender.updateTransfer(ctx.url, snapshots.find(item => item.transferId === 'one'));
    assert.equal(sender.snapshot().find(item => item.transferId === 'one').canCancel, false);
    sender.upload({ ...details, transferId: 'two' });
    assert.equal((await terminal(sender, 'two')).phase, 'uploaded');
  } finally { sender.close(); receiver.close(); await ctx.room.close(); temp.clean(); }
});

test('completed job history is capped and expires by TTL; only allowed room origins are accepted', async () => {
  const temp = scratch(); let clock = 100;
  const fake = await localServer((req, res) => { if (!statusReply(req, res)) { res.writeHead(200, { 'Content-Length': 1 }); res.end('x'); } });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {}, now: () => clock });
  try {
    for (let index = 0; index < 103; index++) {
      await manager.download({ url: fake.url, token: 'test', transferId: `done-${index}`, fileId: crypto.randomUUID(), fileName: `${index}.txt` });
      clock++;
    }
    assert.equal(manager.snapshot().length, 100); assert.equal(manager.snapshot().some(job => job.transferId === 'done-0'), false);
    clock += 24 * 60 * 60 * 1000 + 1; assert.deepEqual(manager.snapshot(), []);
    assert.equal(roomOrigin('http://100.64.0.1:4827'), 'http://100.64.0.1:4827');
    for (const url of ['https://127.0.0.1', 'http://example.com', 'http://100.63.0.1', 'http://localhost/private', 'http://user@localhost']) assert.throws(() => roomOrigin(url), /房间地址无效/);
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('main-window session updates override expired panel tokens for new work and download retries', async () => {
  const temp = scratch(); let currentToken = 'main-live'; let failDownload = false; const requests = [];
  const fake = await localServer((req, res) => {
    requests.push({ url: req.url, token: req.headers['x-pet-session'] });
    if (req.headers['x-pet-session'] !== currentToken) { req.resume(); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"expired panel"}'); return; }
    if (statusReply(req, res)) return;
    if (req.method === 'POST') {
      req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ fileId: crypto.randomUUID() })); });
    } else if (failDownload) { failDownload = false; res.writeHead(503); res.end('retry'); }
    else { res.writeHead(200, { 'Content-Length': 2 }); res.end('ok'); }
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {} });
  try {
    manager.updateSession(fake.url, currentToken);
    const source = path.join(temp.root, 'session.txt'); fs.writeFileSync(source, 'ok');
    manager.upload({ url: fake.url, token: 'expired-panel', transferId: 'session-upload', path: source });
    assert.equal((await terminal(manager, 'session-upload')).phase, 'uploaded');
    manager.updateTransfer(fake.url, { transferId: 'session-upload', phase: 'saved', progress: 100 });
    const details = { url: fake.url, token: 'expired-panel', transferId: 'session-download', fileId: crypto.randomUUID(), fileName: 'session.txt' };
    failDownload = true; assert.equal((await manager.download(details)).phase, 'failed');
    currentToken = 'main-reconnected'; manager.updateSession(fake.url, currentToken);
    assert.equal((await manager.download(details)).phase, 'saved');
    assert.equal(requests.some(request => request.token === 'expired-panel'), false);
    assert.ok(requests.some(request => request.token === 'main-reconnected' && request.url.startsWith('/api/files/')));
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('an in-flight download reports completion with the renewed main-window session', async () => {
  const temp = scratch(); const reports = []; let finishDownload;
  const fake = await localServer((req, res) => {
    if (req.url === '/api/transfers') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { reports.push({ ...JSON.parse(body), token: req.headers['x-pet-session'] }); res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
      return;
    }
    res.writeHead(200, { 'Content-Length': 1000 }); res.write(Buffer.alloc(200, 'a'));
    finishDownload = () => res.end(Buffer.alloc(800, 'b'));
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {} });
  try {
    manager.updateSession(fake.url, 'main-before');
    const result = manager.download({ url: fake.url, token: 'closed-panel', transferId: 'session-active', fileId: crypto.randomUUID(), fileName: 'active.bin' });
    await until(() => manager.snapshot()[0]?.progress === 20);
    manager.updateSession(fake.url, 'main-after'); finishDownload();
    assert.equal((await result).phase, 'saved');
    assert.equal(reports.find(item => item.phase === 'saved').token, 'main-after');
    assert.equal(reports.some(item => item.token === 'closed-panel'), false);
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('a rejected reservation never uploads file bytes', async () => {
  const temp = scratch(); let uploaded = 0;
  const fake = await localServer((req, res) => {
    req.resume();
    if (req.url === '/api/files') uploaded++;
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '请等上一个文件传完' }));
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {} });
  try {
    const source = path.join(temp.root, 'not-uploaded.txt'); fs.writeFileSync(source, 'stay local');
    manager.upload({ url: fake.url, token: 'session', path: source, transferId: 'rejected' });
    const failed = await terminal(manager, 'rejected');
    assert.equal(failed.phase, 'failed'); assert.match(failed.error, /上一个文件/); assert.equal(uploaded, 0);
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('saved receipts retry HTTP errors and renew their session without downloading twice', async () => {
  const temp = scratch(); let savedAttempts = 0; let downloads = 0; const receipts = [];
  const fake = await localServer((req, res) => {
    if (req.url !== '/api/transfers') { downloads++; res.writeHead(200, { 'Content-Length': 2 }); res.end('ok'); return; }
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => {
      const item = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      if (item.phase === 'saved') {
        savedAttempts++;
        receipts.push(req.headers['x-pet-session']);
        if (savedAttempts === 1) { res.writeHead(503); res.end('{"error":"retry receipt"}'); return; }
        if (req.headers['x-pet-session'] !== 'renewed') { res.writeHead(401); res.end('{"error":"expired"}'); return; }
      }
      res.end('{}');
    });
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {}, receiptRetryMs: 10 });
  try {
    const saved = await manager.download({ url: fake.url, token: 'old', fileId: crypto.randomUUID(), fileName: 'receipt.txt', transferId: 'receipt' });
    assert.equal(saved.phase, 'saved'); assert.equal(fs.readFileSync(saved.savedPath, 'utf8'), 'ok');
    await until(() => savedAttempts >= 2);
    manager.updateSession(fake.url, 'renewed');
    await until(() => receipts.includes('renewed'));
    assert.equal(downloads, 1); assert.equal(manager.snapshot()[0].phase, 'saved');
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('forgetting a room aborts work and suppresses stale progress', async () => {
  const temp = scratch(); const reports = []; let started = false;
  const fake = await localServer((req, res) => {
    if (statusReply(req, res)) return;
    started = true; res.writeHead(200, { 'Content-Length': 1000 }); res.write(Buffer.alloc(100));
  });
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: item => reports.push(item) });
  try {
    const downloading = manager.download({ url: fake.url, token: 'session', fileId: crypto.randomUUID(), fileName: 'old.txt', transferId: 'old-room' });
    await until(() => started && manager.snapshot()[0].progress > 0);
    manager.forgetRoom(fake.url); const reportCount = reports.length;
    await downloading;
    assert.deepEqual(manager.snapshot(), []); assert.equal(reports.length, reportCount);
    assert.deepEqual(fs.readdirSync(temp.downloads), []);
  } finally { manager.close(); await fake.close(); temp.clean(); }
});
