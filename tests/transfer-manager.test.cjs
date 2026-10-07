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
  return until(() => manager.snapshot().find(job => job.transferId === transferId && !job.canCancel && ['uploaded', 'saved', 'failed', 'cancelled'].includes(job.phase)), timeout);
}
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongdong-transfer-'));
  const downloads = path.join(root, 'downloads'); fs.mkdirSync(downloads);
  return { root, downloads, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function startRoom(root) {
  const room = createRoom({ host: '127.0.0.1', port: 0, key: 'secret', hostId: 'host', dataDir: path.join(root, 'room'), staticDir: path.join(__dirname, '..', 'public') });
  const { port } = await room.listen(); const url = `http://127.0.0.1:${port}`;
  async function session(senderId, mode) {
    const response = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId, senderName: senderId, mode }) });
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
    const initial = sender.upload({ url: ctx.url, token: ctx.host.token, path: source, transferId: 'real-transfer', clientId: 'real-client' });
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
    stall = false; manager.retry({ url: fake.url, token: 'fresh-session', transferId: 'cancel-receive' });
    const saved = await terminal(manager, 'cancel-receive'); assert.equal(saved.phase, 'saved'); assert.deepEqual(fs.readFileSync(saved.savedPath), data);
  } finally { manager.close(); await fake.close(); temp.clean(); }
});

test('retry after losing the upload response reuses clientId without duplicating a room event', async () => {
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
    manager.upload({ url: proxy.url, token: ctx.host.token, path: source, transferId: 'retry-transfer', clientId: 'retry-client' });
    assert.equal((await terminal(manager, 'retry-transfer')).phase, 'failed');
    manager.retry({ url: proxy.url, token: ctx.host.token, transferId: 'retry-transfer' });
    assert.equal((await terminal(manager, 'retry-transfer')).phase, 'uploaded');
    const events = await (await fetch(`${ctx.url}/api/events`, { headers: { 'X-Pet-Session': ctx.host.token } })).json();
    assert.equal(events.filter(event => event.kind === 'file').length, 1);
    assert.equal(fs.readdirSync(path.join(temp.root, 'room', 'files')).length, 1);
  } finally { manager.close(); await proxy.close(); await ctx.room.close(); temp.clean(); }
});

test('room-specific cancellation leaves other transfers running, and active capacity is bounded', async () => {
  const temp = scratch();
  const handler = (req, res) => { if (!statusReply(req, res)) { res.writeHead(200, { 'Content-Length': 5000 }); res.write(Buffer.alloc(1000, 'x')); } };
  const first = await localServer(handler); const second = await localServer(handler);
  const manager = createTransferManager({ downloadsPath: () => temp.downloads, onProgress: () => {}, idleTimeoutMs: 2000, totalTimeoutMs: 4000 });
  try {
    const one = manager.download({ url: first.url, token: 'test', transferId: 'same-id', fileId: crypto.randomUUID(), fileName: 'one' });
    const two = manager.download({ url: second.url, token: 'test', transferId: 'same-id', fileId: crypto.randomUUID(), fileName: 'two' });
    await until(() => manager.snapshot().filter(job => job.progress > 0).length === 2);
    manager.cancelRoom(first.url); assert.equal((await one).phase, 'cancelled');
    assert.equal(manager.snapshot().find(job => job.roomUrl === second.url).canCancel, true);
    const downloads = [two];
    for (let index = 1; index < 8; index++) downloads.push(manager.download({ url: second.url, token: 'test', transferId: `capacity-${index}`, fileId: crypto.randomUUID(), fileName: `capacity-${index}` }));
    assert.throws(() => manager.download({ url: second.url, token: 'test', transferId: 'too-many', fileId: crypto.randomUUID(), fileName: 'extra' }), /太多/);
    assert.throws(() => manager.retry({ url: first.url, token: 'test', transferId: 'same-id' }), /太多/);
    manager.close(); assert.ok((await Promise.all(downloads)).every(job => job.phase === 'cancelled'));
    assert.deepEqual(fs.readdirSync(temp.downloads), []);
  } finally { manager.close(); await first.close(); await second.close(); temp.clean(); }
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
