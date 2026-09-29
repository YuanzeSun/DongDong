const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EVENTS = 300;
const PROTOCOL_VERSION = '3';
const EVENT_KINDS = new Set(['message', 'wave', 'walk', 'jump', 'pet', 'fish', 'sit', 'sleep', 'stretch', 'delivery', 'hug', 'kiss', 'groom', 'purr']);
const ACTION_KINDS = new Set([...EVENT_KINDS].filter(kind => kind !== 'message'));
const STATUS_VALUES = new Set(['available', 'busy', 'away']);

function stringValue(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function normalizeFileName(value, explicit = false) {
  let original = path.basename(String(value || '').replaceAll('\\', '/'));
  if (!explicit) {
    const decoded = Buffer.from(original, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD') && /[\u4e00-\u9fff]/.test(decoded) && !/[\u4e00-\u9fff]/.test(original)) original = decoded;
  }
  original = original.replace(/[\u0000-\u001f\u007f]/g, '').trim().normalize('NFC').slice(0, 180);
  return original && original !== '.' && original !== '..' ? original : 'file';
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn(`Could not load ${path.basename(file)}:`, error); return fallback; }
}
function safeWriteJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function createRoom({ host, port = 4827, key, dataDir, staticDir, hostId }) {
  if (!host || !key || !dataDir || !staticDir) throw new Error('Room configuration is incomplete');
  fs.mkdirSync(dataDir, { recursive: true });
  const fileDir = path.join(dataDir, 'files');
  fs.mkdirSync(fileDir, { recursive: true });
  const historyPath = path.join(dataDir, 'history.json');
  const pairingPath = path.join(dataDir, 'pairing.json');
  const profilePath = path.join(dataDir, 'profile.json');
  const defaultProfile = { petName: '咚咚', anniversary: '', note: '' };
  let events = readJson(historyPath, []);
  if (!Array.isArray(events)) events = [];
  events = events.filter(event => event && (event.kind === 'message' || event.kind === 'file')).slice(-MAX_EVENTS);
  let profile = { ...defaultProfile, ...(readJson(profilePath, {}) || {}) };
  profile = { petName: stringValue(profile.petName, 80) || defaultProfile.petName, anniversary: stringValue(profile.anniversary, 80), note: stringValue(profile.note, 1000) };
  const savedPairing = readJson(pairingPath, {});
  let pairedGuest = savedPairing && typeof savedPairing.guestId === 'string' ? { id: savedPairing.guestId, name: stringValue(savedPairing.guestName, 24) || '对方' } : null;

  const app = express();
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true });
  const sessions = new Map();
  const idempotent = new Map();
  const allowedOrigins = new Set(['null', `http://${host}:${port}`, 'http://127.0.0.1:4827']);
  let expectedHostId = stringValue(hostId, 80) || null;
  let heartbeatTimer;
  const persistPairing = () => safeWriteJson(pairingPath, pairedGuest ? { guestId: pairedGuest.id, guestName: pairedGuest.name } : {});
  const persistEvents = () => safeWriteJson(historyPath, events);
  const persistProfile = () => safeWriteJson(profilePath, profile);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pet-Key, X-Pet-Session');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.static(staticDir));
  const keyIsValid = req => {
    const provided = Buffer.from(req.get('x-pet-key') || ''); const expected = Buffer.from(String(key));
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };
  const tokenFrom = req => req.get('x-pet-session') || '';
  const peerFor = session => [...sessions.values()].find(item => item.senderId !== session.senderId);
  const activePeer = session => [...sockets.clients].some(socket => socket.readyState === 1 && socket.session && socket.session.senderId !== session.senderId);
  const presenceFor = session => { const peer = peerFor(session); return { online: Boolean(peer && activePeer(session)), peerName: peer?.senderName || '', peerStatus: peer?.status || 'away' }; };
  const sendPresence = () => { for (const socket of sockets.clients) if (socket.readyState === 1 && socket.session) { const presence = presenceFor(socket.session); socket.send(JSON.stringify({ type: 'presence', ...presence, presence })); } };
  const sendProfile = () => { const wire = JSON.stringify({ type: 'profile', profile }); for (const socket of sockets.clients) if (socket.readyState === 1) socket.send(wire); };
  function broadcastEvent(event, persist = true) {
    if (persist) {
      events.push(event);
      while (events.length > MAX_EVENTS) { const removed = events.shift(); if (removed?.kind === 'file' && removed.fileId) fs.rm(path.join(fileDir, removed.fileId), { force: true }, () => {}); }
      persistEvents();
    }
    const wire = JSON.stringify({ type: 'event', event });
    for (const socket of sockets.clients) if (socket.readyState === 1) socket.send(wire);
    return event;
  }
  function requireSession(req, res, next) {
    const session = sessions.get(tokenFrom(req));
    if (!session) return res.status(401).json({ error: '会话已失效，请重新连接' });
    session.lastSeen = Date.now(); req.session = session; next();
  }
  const sessionName = value => stringValue(value, 24) || '对方';

  app.post('/api/session', express.json({ limit: '16kb' }), (req, res) => {
    if (!keyIsValid(req)) return res.status(401).json({ error: '配对码不正确' });
    const senderId = stringValue(req.body?.senderId, 80); const senderName = sessionName(req.body?.senderName); const mode = req.body?.mode;
    if (!senderId || !['host', 'join'].includes(mode) || !stringValue(req.body?.senderName, 24)) return res.status(400).json({ error: '会话信息无效' });
    if (mode === 'host') { if (expectedHostId && senderId !== expectedHostId) return res.status(403).json({ error: '主机身份不匹配' }); if (!expectedHostId) expectedHostId = senderId; }
    else { if (pairedGuest && pairedGuest.id !== senderId) return res.status(409).json({ error: '房间已有另一位访客' }); if (!pairedGuest) { pairedGuest = { id: senderId, name: senderName }; persistPairing(); } else if (pairedGuest.name !== senderName) { pairedGuest.name = senderName; persistPairing(); } }
    const token = crypto.randomBytes(32).toString('base64url'); const session = { token, senderId, senderName, mode, status: 'available', createdAt: Date.now(), lastSeen: Date.now() };
    sessions.set(token, session); sendPresence();
    res.status(201).json({ token, senderId, senderName, mode, profile, presence: presenceFor(session) });
  });
  app.use('/api', (req, res, next) => req.path === '/session' ? next() : requireSession(req, res, next));
  app.get('/api/events', (_req, res) => res.json(events));

  function validateDelivery(body) {
    const input = body?.data && typeof body.data === 'object' ? body.data : body; const transferId = stringValue(input?.transferId, 120); const name = stringValue(input?.name, 180); const progress = Number(input?.progress); const status = stringValue(input?.status, 32);
    return transferId && name && Number.isFinite(progress) && progress >= 0 && progress <= 100 && status ? { transferId, name, progress, status } : null;
  }
  app.post('/api/events', express.json({ limit: '32kb' }), (req, res) => {
    const { session } = req; const kind = req.body?.kind; const clientId = stringValue(req.body?.clientId, 120);
    if (!EVENT_KINDS.has(kind)) return res.status(400).json({ error: '事件类型无效' });
    let text = ''; let data;
    if (kind === 'message') { text = stringValue(req.body?.text, 1000); if (!text) return res.status(400).json({ error: '消息内容无效' }); }
    else if (kind === 'delivery') { data = validateDelivery(req.body); if (!data) return res.status(400).json({ error: '传送信息无效' }); }
    const idempotenceKey = clientId ? `${session.senderId}:${clientId}` : '';
    if (idempotenceKey && idempotent.has(idempotenceKey)) return res.status(200).json(idempotent.get(idempotenceKey));
    if (ACTION_KINDS.has(kind) && !activePeer(session)) return res.status(409).json({ error: '对方当前不在线' });
    const event = { id: crypto.randomUUID(), kind, text, senderId: session.senderId, senderName: session.senderName, createdAt: new Date().toISOString() };
    if (clientId) event.clientId = clientId; if (data) event.data = data;
    const output = broadcastEvent(event, kind === 'message'); if (idempotenceKey) idempotent.set(idempotenceKey, output); res.status(201).json(output);
  });

  app.get('/api/profile', (_req, res) => res.json(profile));
  app.post('/api/profile', express.json({ limit: '8kb' }), (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: '资料无效' });
    const next = { ...profile };
    for (const field of ['petName', 'anniversary', 'note']) if (req.body[field] !== undefined) { if (typeof req.body[field] !== 'string') return res.status(400).json({ error: '资料无效' }); next[field] = req.body[field].trim().normalize('NFC').slice(0, field === 'note' ? 1000 : 80); }
    if (!next.petName) return res.status(400).json({ error: '宠物名称不能为空' }); profile = next; persistProfile(); sendProfile(); res.json(profile);
  });
  app.post('/api/status', express.json({ limit: '2kb' }), (req, res) => { if (!STATUS_VALUES.has(req.body?.status)) return res.status(400).json({ error: '状态无效' }); req.session.status = req.body.status; sendPresence(); res.json({ status: req.body.status }); });
  app.post('/api/leave', (req, res) => {
    const session = req.session; sessions.delete(session.token);
    if (session.mode === 'join' && pairedGuest?.id === session.senderId) { pairedGuest = null; persistPairing(); for (const [token, item] of sessions) if (item.mode === 'join' && item.senderId === session.senderId) sessions.delete(token); for (const socket of sockets.clients) if (socket.session?.senderId === session.senderId) socket.close(1000, 'left'); }
    sendPresence(); res.status(204).end();
  });

  const upload = multer({ storage: multer.diskStorage({ destination: fileDir, filename: (_req, _file, callback) => callback(null, crypto.randomUUID()) }), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  app.post('/api/files', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    const explicit = typeof req.body?.fileName === 'string' && req.body.fileName.trim(); const originalName = normalizeFileName(explicit ? req.body.fileName : req.file.originalname, Boolean(explicit)); const clientId = stringValue(req.body?.clientId, 120); const idempotenceKey = clientId ? `${req.session.senderId}:${clientId}` : '';
    if (idempotenceKey && idempotent.has(idempotenceKey)) { fs.rm(req.file.path, { force: true }, () => {}); return res.status(200).json(idempotent.get(idempotenceKey)); }
    const event = { id: crypto.randomUUID(), kind: 'file', fileId: req.file.filename, fileName: originalName, size: req.file.size, senderId: req.session.senderId, senderName: req.session.senderName, createdAt: new Date().toISOString() }; if (clientId) event.clientId = clientId;
    broadcastEvent(event, true); if (idempotenceKey) idempotent.set(idempotenceKey, event); res.status(201).json(event);
  });
  app.get('/api/files/:id', (req, res) => { const event = events.find(item => item.kind === 'file' && item.fileId === req.params.id); if (!event) return res.sendStatus(404); res.download(path.join(fileDir, event.fileId), event.fileName); });
  app.use((error, _req, res, _next) => { if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件不能超过 100 MB' }); if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: '请求格式无效' }); console.error(error); res.status(500).json({ error: '操作失败，请重试' }); });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${host}`); const session = sessions.get(url.searchParams.get('session') || '');
    if (url.pathname !== '/ws' || url.searchParams.get('v') !== PROTOCOL_VERSION || !session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => { ws.session = session; sockets.emit('connection', ws, request); });
  });
  sockets.on('connection', socket => { socket.isAlive = true; socket.on('pong', () => { socket.isAlive = true; }); socket.on('error', () => {}); sendPresence(); socket.on('close', sendPresence); });
  function startHeartbeat() { heartbeatTimer = setInterval(() => { for (const socket of sockets.clients) { if (socket.isAlive === false) { socket.terminate(); continue; } socket.isAlive = false; socket.ping(); } }, 15000); heartbeatTimer.unref?.(); }
  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); startHeartbeat(); resolve(server.address()); }); }),
    close: () => new Promise(resolve => { if (heartbeatTimer) clearInterval(heartbeatTimer); for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(resolve); }),
    server
  };
}
module.exports = { createRoom, MAX_FILE_BYTES, PROTOCOL_VERSION, normalizeFileName };
