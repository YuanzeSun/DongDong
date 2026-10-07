const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { createRoom, createTimedCache, SESSION_TTL_MS, CLOSED_SESSION_TTL_MS, MAX_SESSIONS_PER_IDENTITY, IDEMPOTENCE_TTL_MS, TRANSFER_TTL_MS } = require('../server/room.cjs');

async function setup(prefix = 'hello-pet-test-', options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const room = createRoom({ host: '127.0.0.1', port: 0, key: 'test-secret', hostId: 'host', dataDir, staticDir: path.join(__dirname, '..', 'public'), ...options });
  const { port } = await room.listen();
  const base = `http://127.0.0.1:${port}`;
  const session = async (senderId, mode, senderName = senderId) => {
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId, senderName, mode }) });
    assert.equal(response.status, 201);
    return response.json();
  };
  return { room, base, dataDir, session };
}
function closeRoom(ctx) { return ctx.room.close().then(() => fs.rmSync(ctx.dataDir, { recursive: true, force: true })); }
function waitFor(socket, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => { const message = JSON.parse(raw.toString()); if (predicate(message)) { socket.off('message', onMessage); resolve(message); } };
    socket.on('message', onMessage); socket.once('error', reject);
  });
}

test('v3 sessions authenticate, pair one guest, personalize presence, and publish events', async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(await (await fetch(`${ctx.base}/api/discover`)).json(), { app: 'dongdong', protocol: '3' });
    assert.equal((await fetch(`${ctx.base}/api/events`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'bad', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const host = await ctx.session('host', 'host', '甲');
    assert.equal(host.profile.petName, '小橘');
    const guest = await ctx.session('guest', 'join', '乙');
    assert.equal('peerStatus' in host.presence, false);
    const thirdResponse = await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId: 'third', senderName: '丙', mode: 'join' }) });
    assert.equal(thirdResponse.status, 409);

    const hostSocket = new WebSocket(`${ctx.base.replace(/^http/, 'ws')}/ws?v=3&session=${host.token}`);
    await new Promise((resolve, reject) => { hostSocket.once('open', resolve); hostSocket.once('error', reject); });
    const hostPresence = waitFor(hostSocket, message => message.type === 'presence' && message.online);
    const guestSocket = new WebSocket(`${ctx.base.replace(/^http/, 'ws')}/ws?v=3&session=${guest.token}`);
    await new Promise((resolve, reject) => { guestSocket.once('open', resolve); guestSocket.once('error', reject); });
    const presence = await hostPresence;
    assert.equal(presence.peerName, '乙');
    assert.equal('peerStatus' in presence, false);
    const guestEvent = waitFor(guestSocket, message => message.type === 'event');
    const sent = await fetch(`${ctx.base}/api/events`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'message', text: '晚安', senderId: 'spoof', senderName: '伪造', clientId: 'm1' }) });
    assert.equal(sent.status, 201); const event = await sent.json(); assert.equal(event.senderId, 'host'); assert.equal(event.senderName, '甲');
    assert.equal((await guestEvent).event.text, '晚安');
    assert.equal((await (await fetch(`${ctx.base}/api/events`, { headers: { 'X-Pet-Session': guest.token } })).json()).length, 1);
    const duplicate = await fetch(`${ctx.base}/api/events`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'message', text: '晚安', clientId: 'm1' }) });
    assert.equal((await duplicate.json()).id, event.id);
    hostSocket.close(); guestSocket.close();
  } finally { await closeRoom(ctx); }
});

test('actions require an online peer; delivery is transient and structured; files support unicode names', async () => {
  const ctx = await setup('hello-pet-files-');
  try {
    const host = await ctx.session('host', 'host', '甲'); const guest = await ctx.session('guest', 'join', '乙');
    const action = await fetch(`${ctx.base}/api/events`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'wave', clientId: 'w1' }) });
    assert.equal(action.status, 409);
    const hs = new WebSocket(`${ctx.base.replace(/^http/, 'ws')}/ws?v=3&session=${host.token}`);
    await new Promise((resolve, reject) => { hs.once('open', resolve); hs.once('error', reject); });
    const gs = new WebSocket(`${ctx.base.replace(/^http/, 'ws')}/ws?v=3&session=${guest.token}`);
    await new Promise((resolve, reject) => { gs.once('open', resolve); gs.once('error', reject); });
    const delivery = await fetch(`${ctx.base}/api/events`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'delivery', clientId: 'd1', data: { transferId: 't1', name: '照片.png', progress: 35, status: 'uploading', type: 'file' } }) });
    assert.equal(delivery.status, 201); const deliveryEvent = await delivery.json(); assert.deepEqual(deliveryEvent.data, { transferId: 't1', name: '照片.png', progress: 35, status: 'uploading', type: 'file' });
    assert.equal((await (await fetch(`${ctx.base}/api/events`, { headers: { 'X-Pet-Session': host.token } })).json()).some(item => item.kind === 'delivery'), false);
    const form = new FormData(); form.append('file', new Blob(['hello']), 'ignored.txt'); form.append('fileName', '你好 世界.txt'); form.append('transferId', 't1');
    const uploaded = await fetch(`${ctx.base}/api/files`, { method: 'POST', headers: { 'X-Pet-Session': host.token }, body: form });
    assert.equal(uploaded.status, 201); const file = await uploaded.json(); assert.equal(file.fileName, '你好 世界.txt'); assert.equal(file.transferId, 't1');
    assert.equal((await fetch(`${ctx.base}/api/files/${file.fileId}`)).status, 401);
    assert.equal(await (await fetch(`${ctx.base}/api/files/${file.fileId}`, { headers: { 'X-Pet-Session': guest.token } })).text(), 'hello');
    hs.close(); gs.close();
  } finally { await closeRoom(ctx); }
});

test('profile persists and guest leave releases pairing; reconnect keeps identity and history excludes actions', async () => {
  const ctx = await setup('hello-pet-reconnect-');
  try {
    const host = await ctx.session('host', 'host', '甲'); let guest = await ctx.session('guest', 'join', '乙');
    assert.equal((await fetch(`${ctx.base}/api/status`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'busy' }) })).status, 404);
    const profile = await fetch(`${ctx.base}/api/profile`, { headers: { 'X-Pet-Session': host.token } }); assert.equal(profile.status, 200);
    const updated = await fetch(`${ctx.base}/api/profile`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ petName: '小咪' }) }); assert.equal((await updated.json()).petName, '小咪');
    assert.equal((await fetch(`${ctx.base}/api/events`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'message', text: 'persist' }) })).status, 201);
    assert.equal((await fetch(`${ctx.base}/api/leave`, { method: 'POST', headers: { 'X-Pet-Session': guest.token } })).status, 204);
    const reconnect = await ctx.session('guest', 'join', '乙'); assert.equal(reconnect.senderId, 'guest');
    const thirdResponse = await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId: 'third', senderName: '丙', mode: 'join' }) });
    assert.equal(thirdResponse.status, 409);
    const history = await (await fetch(`${ctx.base}/api/events`, { headers: { 'X-Pet-Session': reconnect.token } })).json(); assert.equal(history.every(item => ['message', 'file'].includes(item.kind)), true);
  } finally { await closeRoom(ctx); }
});

test('timed caches expire unused entries and evict oldest entries at capacity', () => {
  let clock = 0;
  const cache = createTimedCache({ now: () => clock, maxAge: 100, maxSize: 2 });
  cache.set('a', 1); clock = 20; cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual(cache.values(), [2, 3]);
  clock = 80; cache.set('b', 4);
  clock = 121;
  assert.equal(cache.get('c'), undefined);
  assert.deepEqual(cache.values(), [4]);
  clock = 180; assert.deepEqual(cache.values(), []);
});

async function openSocket(ctx, session) {
  const socket = new WebSocket(`${ctx.base.replace(/^http/, 'ws')}/ws?v=3&session=${session.token}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}
function sessionHeaders(session) { return { 'X-Pet-Session': session.token, 'Content-Type': 'application/json' }; }
function postJson(ctx, route, session, body) { return fetch(`${ctx.base}/api/${route}`, { method: 'POST', headers: sessionHeaders(session), body: JSON.stringify(body) }); }

test('session limits retain live windows, expire inactive tokens, and do not release the paired guest', async () => {
  let clock = 0;
  const ctx = await setup('hello-pet-session-expiry-', { now: () => clock });
  try {
    const host = await ctx.session('host', 'host'); const hostSocket = await openSocket(ctx, host);
    const panel = await ctx.session('host', 'host'); const panelSocket = await openSocket(ctx, panel);
    const inactive = await ctx.session('host', 'host');
    for (let index = 0; index < MAX_SESSIONS_PER_IDENTITY; index++) await ctx.session('host', 'host');
    assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(host) })).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(panel) })).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(inactive) })).status, 401);
    const guest = await ctx.session('guest', 'join');
    clock += SESSION_TTL_MS + 1;
    assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(guest) })).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(host) })).status, 200);
    const third = await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId: 'third', senderName: 'third', mode: 'join' }) });
    assert.equal(third.status, 409);
    const closed = new Promise(resolve => panelSocket.once('close', resolve)); panelSocket.close(); await closed;
    clock += CLOSED_SESSION_TTL_MS + 1;
    assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(panel) })).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(host) })).status, 200);
    hostSocket.close();
  } finally { await closeRoom(ctx); }
});

test('presence uses the newest connected peer session and guest leave closes all guest windows', async () => {
  const ctx = await setup('hello-pet-live-presence-');
  try {
    const host = await ctx.session('host', 'host'); const hs = await openSocket(ctx, host);
    const old = await ctx.session('guest', 'join', '旧名');
    const olderPresence = waitFor(hs, item => item.type === 'presence' && item.peerName === '旧名');
    const oldSocket = await openSocket(ctx, old); await olderPresence;
    const updated = await ctx.session('guest', 'join', '新名');
    const newerPresence = waitFor(hs, item => item.type === 'presence' && item.peerName === '新名');
    const newSocket = await openSocket(ctx, updated); await newerPresence;
    const detached = await ctx.session('guest', 'join', '尚未打开的名字');
    const hostAgain = await ctx.session('host', 'host'); assert.equal(hostAgain.presence.peerName, '新名');
    const offline = waitFor(hs, item => item.type === 'presence' && !item.online);
    assert.equal((await fetch(`${ctx.base}/api/leave`, { method: 'POST', headers: sessionHeaders(updated) })).status, 204);
    assert.equal((await offline).peerName, '');
    for (const session of [old, updated, detached]) assert.equal((await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(session) })).status, 401);
    assert.equal((await ctx.session('different-guest', 'join')).senderId, 'different-guest');
    hs.close(); oldSocket.close(); newSocket.close();
  } finally { await closeRoom(ctx); }
});

test('idempotency is scoped by event kind and route, and expires after the retry window', async () => {
  let clock = 0;
  const ctx = await setup('hello-pet-idempotency-', { now: () => clock });
  try {
    const host = await ctx.session('host', 'host'); const guest = await ctx.session('guest', 'join');
    const hs = await openSocket(ctx, host); const gs = await openSocket(ctx, guest);
    const first = await (await postJson(ctx, 'events', host, { kind: 'message', text: 'one', clientId: 'same-id' })).json();
    const repeat = await (await postJson(ctx, 'events', host, { kind: 'message', text: 'one', clientId: 'same-id' })).json();
    assert.equal(repeat.id, first.id);
    const action = await (await postJson(ctx, 'events', host, { kind: 'wave', clientId: 'same-id' })).json(); assert.equal(action.kind, 'wave');
    const form = new FormData(); form.append('file', new Blob(['test']), 'file.txt'); form.append('clientId', 'same-id');
    const file = await (await fetch(`${ctx.base}/api/files`, { method: 'POST', headers: { 'X-Pet-Session': host.token }, body: form })).json(); assert.equal(file.kind, 'file');
    clock += IDEMPOTENCE_TTL_MS + 1;
    const later = await (await postJson(ctx, 'events', host, { kind: 'message', text: 'two', clientId: 'same-id' })).json(); assert.notEqual(later.id, first.id);
    hs.close(); gs.close();
  } finally { await closeRoom(ctx); }
});

test('transfer snapshots and broadcasts follow real upload/save progress and enforce ownership', async () => {
  let clock = 0;
  const ctx = await setup('hello-pet-transfers-', { now: () => clock });
  try {
    const host = await ctx.session('host', 'host'); const guest = await ctx.session('guest', 'join');
    const hs = await openSocket(ctx, host); const gs = await openSocket(ctx, guest);
    const notified = waitFor(gs, item => item.type === 'transfer' && item.transfer.phase === 'uploading');
    const started = await postJson(ctx, 'transfers', host, { transferId: 'transfer-1', name: '照片.txt', phase: 'uploading', progress: 42, senderId: 'spoof' });
    assert.equal(started.status, 200); assert.equal((await notified).transfer.senderId, 'host');
    assert.equal((await postJson(ctx, 'transfers', guest, { transferId: 'transfer-1', name: 'bad', phase: 'uploading', progress: 1 })).status, 403);
    assert.equal((await postJson(ctx, 'transfers', host, { transferId: 'bad', name: 'bad', phase: 'uploading', progress: 101 })).status, 400);
    const form = new FormData(); form.append('file', new Blob(['hello']), '照片.txt'); form.append('fileName', '照片.txt'); form.append('transferId', 'transfer-1');
    const uploaded = await fetch(`${ctx.base}/api/files`, { method: 'POST', headers: { 'X-Pet-Session': host.token }, body: form });
    assert.equal(uploaded.status, 201); const file = await uploaded.json();
    let snapshots = await (await fetch(`${ctx.base}/api/transfers`, { headers: sessionHeaders(host) })).json();
    assert.equal(snapshots[0].phase, 'uploaded'); assert.equal(snapshots[0].fileId, file.fileId);
    assert.equal((await postJson(ctx, 'transfers', host, { transferId: 'transfer-1', fileId: file.fileId, phase: 'saved' })).status, 403);
    assert.equal((await postJson(ctx, 'transfers', guest, { transferId: 'wrong-id', fileId: file.fileId, phase: 'saved' })).status, 403);
    const downloading = await (await postJson(ctx, 'transfers', guest, { transferId: 'transfer-1', fileId: file.fileId, phase: 'downloading', progress: 50 })).json();
    assert.equal(downloading.phase, 'downloading'); assert.equal(downloading.senderId, 'host');
    const savedNotification = waitFor(hs, item => item.type === 'transfer' && item.transfer.phase === 'saved');
    const saved = await (await postJson(ctx, 'transfers', guest, { transferId: 'transfer-1', fileId: file.fileId, phase: 'saved' })).json();
    assert.equal(saved.progress, 100); await savedNotification;
    const stale = await (await postJson(ctx, 'transfers', host, { transferId: 'transfer-1', phase: 'uploading', progress: 90 })).json(); assert.equal(stale.phase, 'saved');
    const staleDownload = await (await postJson(ctx, 'transfers', guest, { transferId: 'transfer-1', fileId: file.fileId, phase: 'failed', error: 'late error' })).json(); assert.equal(staleDownload.phase, 'saved');
    clock += TRANSFER_TTL_MS + 1;
    snapshots = await (await fetch(`${ctx.base}/api/transfers`, { headers: sessionHeaders(host) })).json(); assert.deepEqual(snapshots, []);
    hs.close(); gs.close();
  } finally { await closeRoom(ctx); }
});

test('aborting a partial upload removes its temporary file and leaves history unchanged', async () => {
  const ctx = await setup('hello-pet-upload-abort-');
  try {
    const host = await ctx.session('host', 'host');
    const boundary = 'pet-test-boundary';
    const request = http.request(`${ctx.base}/api/files`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
    request.on('error', () => {});
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\n`);
    request.write(Buffer.alloc(64 * 1024, 'a'));
    const files = () => fs.readdirSync(path.join(ctx.dataDir, 'files'));
    for (let attempt = 0; attempt < 100 && files().length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(files().length, 1);
    request.destroy();
    for (let attempt = 0; attempt < 100 && files().length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(files(), []);
    const history = await (await fetch(`${ctx.base}/api/events`, { headers: sessionHeaders(host) })).json();
    assert.deepEqual(history, []);
  } finally { await closeRoom(ctx); }
});

test('closing a room aborts an unfinished multipart upload and waits for partial-file cleanup', async () => {
  const ctx = await setup('hello-pet-close-upload-'); let request;
  try {
    const host = await ctx.session('host', 'host'); const boundary = 'pet-close-boundary';
    request = http.request(`${ctx.base}/api/files`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
    request.on('error', () => {});
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="unfinished.txt"\r\nContent-Type: text/plain\r\n\r\n`);
    request.write(Buffer.alloc(64 * 1024, 'a'));
    const files = () => fs.readdirSync(path.join(ctx.dataDir, 'files'));
    for (let attempt = 0; attempt < 100 && files().length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(files().length, 1);
    let timeout;
    try {
      await Promise.race([ctx.room.close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Room close hung on unfinished upload')), 1000); })]);
    } finally { clearTimeout(timeout); }
    assert.deepEqual(files(), []);
  } finally { request?.destroy(); await closeRoom(ctx); }
});
