const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createRoom } = require('../server/room.cjs');

test('room authenticates, delivers events, and transfers a file', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hello-pet-test-'));
  const room = createRoom({ host: '127.0.0.1', port: 0, key: 'test-secret', dataDir, staticDir: path.join(__dirname, '..', 'public') });
  const { port } = await room.listen();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'X-Pet-Key': 'test-secret' };
  try {
    assert.equal((await fetch(`${base}/api/events`)).status, 401);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?v=2&key=test-secret&senderId=a&mode=host`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const nextEvent = new Promise(resolve => socket.once('message', raw => resolve(JSON.parse(raw.toString()))));
    const sent = await fetch(`${base}/api/events`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'message', text: '晚安', senderId: 'a', senderName: '甲' })
    });
    assert.equal(sent.status, 201);
    assert.equal((await nextEvent).event.text, '晚安');
    assert.equal((await (await fetch(`${base}/api/events`, { headers })).json()).length, 1);
    assert.equal((await fetch(`${base}/api/events`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'message', text: '' })
    })).status, 400);

    const form = new FormData();
    form.append('file', new Blob(['hello from the other computer']), 'hello.txt');
    form.append('senderId', 'b');
    form.append('senderName', '乙');
    const uploaded = await fetch(`${base}/api/files`, { method: 'POST', headers, body: form });
    assert.equal(uploaded.status, 201);
    const fileEvent = await uploaded.json();
    assert.equal(fileEvent.fileName, 'hello.txt');
    assert.equal((await fetch(`${base}/api/files/${fileEvent.fileId}`)).status, 401);
    assert.equal(await (await fetch(`${base}/api/files/${fileEvent.fileId}`, { headers })).text(), 'hello from the other computer');
    socket.close();
  } finally {
    await room.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('room is one-to-one and publishes peer presence', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hello-pet-presence-'));
  const room = createRoom({ host: '127.0.0.1', port: 0, key: 'presence-secret', dataDir, staticDir: path.join(__dirname, '..', 'public') });
  const { port } = await room.listen();
  const open = (mode, id) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?v=2&key=presence-secret&senderId=${id}&mode=${mode}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  try {
    const host = await open('host', 'host');
    const guest = await open('join', 'guest');
    const rejected = await new Promise(resolve => {
      const third = new WebSocket(`ws://127.0.0.1:${port}/ws?v=2&key=presence-secret&senderId=third&mode=join`);
      third.once('unexpected-response', (_request, response) => { resolve(response.statusCode); third.close(); });
      third.once('error', () => {});
    });
    assert.equal(rejected, 409);
    host.close();
    guest.close();
  } finally {
    await room.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
