const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createRoom } = require('../server/room.cjs');

async function setup(prefix = 'hello-pet-test-') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const room = createRoom({ host: '127.0.0.1', port: 0, key: 'test-secret', hostId: 'host', dataDir, staticDir: path.join(__dirname, '..', 'public') });
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
    assert.equal((await fetch(`${ctx.base}/api/events`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'bad', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const host = await ctx.session('host', 'host', '甲');
    const guest = await ctx.session('guest', 'join', '乙');
    const thirdResponse = await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId: 'third', senderName: '丙', mode: 'join' }) });
    assert.equal(thirdResponse.status, 409);

    const hostSocket = new WebSocket(`${ctx.base.replace(/^http/, 'ws')}/ws?v=3&session=${host.token}`);
    await new Promise((resolve, reject) => { hostSocket.once('open', resolve); hostSocket.once('error', reject); });
    const hostPresence = waitFor(hostSocket, message => message.type === 'presence' && message.online);
    const guestSocket = new WebSocket(`${ctx.base.replace(/^http/, 'ws')}/ws?v=3&session=${guest.token}`);
    await new Promise((resolve, reject) => { guestSocket.once('open', resolve); guestSocket.once('error', reject); });
    assert.equal((await hostPresence).peerName, '乙');
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
    const delivery = await fetch(`${ctx.base}/api/events`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'delivery', clientId: 'd1', data: { transferId: 't1', name: '照片.png', progress: 35, status: 'uploading' } }) });
    assert.equal(delivery.status, 201); const deliveryEvent = await delivery.json(); assert.deepEqual(deliveryEvent.data, { transferId: 't1', name: '照片.png', progress: 35, status: 'uploading' });
    assert.equal((await (await fetch(`${ctx.base}/api/events`, { headers: { 'X-Pet-Session': host.token } })).json()).some(item => item.kind === 'delivery'), false);
    const form = new FormData(); form.append('file', new Blob(['hello']), 'ignored.txt'); form.append('fileName', '你好 世界.txt');
    const uploaded = await fetch(`${ctx.base}/api/files`, { method: 'POST', headers: { 'X-Pet-Session': host.token }, body: form });
    assert.equal(uploaded.status, 201); const file = await uploaded.json(); assert.equal(file.fileName, '你好 世界.txt');
    assert.equal((await fetch(`${ctx.base}/api/files/${file.fileId}`)).status, 401);
    assert.equal(await (await fetch(`${ctx.base}/api/files/${file.fileId}`, { headers: { 'X-Pet-Session': guest.token } })).text(), 'hello');
    hs.close(); gs.close();
  } finally { await closeRoom(ctx); }
});

test('profile/status persist and guest leave releases pairing; reconnect keeps identity and history excludes actions', async () => {
  const ctx = await setup('hello-pet-reconnect-');
  try {
    const host = await ctx.session('host', 'host', '甲'); let guest = await ctx.session('guest', 'join', '乙');
    const profile = await fetch(`${ctx.base}/api/profile`, { headers: { 'X-Pet-Session': host.token } }); assert.equal(profile.status, 200);
    const updated = await fetch(`${ctx.base}/api/profile`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ petName: '小咪', anniversary: '2026-01-02', note: 'hello' }) }); assert.equal((await updated.json()).petName, '小咪');
    assert.equal((await fetch(`${ctx.base}/api/status`, { method: 'POST', headers: { 'X-Pet-Session': guest.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'busy' }) })).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/events`, { method: 'POST', headers: { 'X-Pet-Session': host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'message', text: 'persist' }) })).status, 201);
    assert.equal((await fetch(`${ctx.base}/api/leave`, { method: 'POST', headers: { 'X-Pet-Session': guest.token } })).status, 204);
    const reconnect = await ctx.session('guest', 'join', '乙'); assert.equal(reconnect.senderId, 'guest');
    const thirdResponse = await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { 'X-Pet-Key': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId: 'third', senderName: '丙', mode: 'join' }) });
    assert.equal(thirdResponse.status, 409);
    const history = await (await fetch(`${ctx.base}/api/events`, { headers: { 'X-Pet-Session': reconnect.token } })).json(); assert.equal(history.every(item => ['message', 'file'].includes(item.kind)), true);
  } finally { await closeRoom(ctx); }
});
