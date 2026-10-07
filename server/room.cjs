const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EVENTS = 300;
const SESSION_TTL_MS = 30 * 60 * 1000;
const CLOSED_SESSION_TTL_MS = 60 * 1000;
const MAX_SESSIONS_PER_IDENTITY = 16;
const IDEMPOTENCE_TTL_MS = 30 * 60 * 1000;
const MAX_IDEMPOTENT = 2000;
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSFERS = 300;
const GUEST_GRACE_MS = 5000;
const TRANSFER_LEASE_MS = 15 * 60 * 1000;
const ACTIVE_TRANSFER_PHASES = new Set(['uploading', 'uploaded', 'downloading']);
const PROTOCOL_VERSION = '4';
const EVENT_KINDS = new Set(['message', 'wave', 'walk', 'jump', 'pet', 'fish', 'sit', 'sleep', 'stretch', 'hug', 'kiss', 'groom', 'purr']);
const ACTION_KINDS = new Set([...EVENT_KINDS].filter(kind => kind !== 'message'));

function stringValue(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function normalizeFileName(value) {
  let original = path.basename(String(value || '').replaceAll('\\', '/'));
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

function createTimedCache({ maxAge, maxSize, now = Date.now }) {
  const entries = new Map();
  function prune() {
    for (const [key, entry] of entries) if (entry.expiresAt <= now()) entries.delete(key);
    while (entries.size > maxSize) entries.delete(entries.keys().next().value);
  }
  return {
    get(key) { const entry = entries.get(key); if (!entry) return undefined; if (entry.expiresAt <= now()) { entries.delete(key); return undefined; } return entry.value; },
    set(key, value) { entries.delete(key); entries.set(key, { value, expiresAt: now() + maxAge }); prune(); return value; },
    values() { prune(); return [...entries.values()].map(entry => entry.value); },
    clear() { entries.clear(); },
    prune,
  };
}

function createRoom({ host, port = 4827, dataDir, staticDir, hostId, now = Date.now }) {
  if (!host || !dataDir || !staticDir) throw new Error('Room configuration is incomplete');
  fs.mkdirSync(dataDir, { recursive: true });
  const fileDir = path.join(dataDir, 'files');
  fs.mkdirSync(fileDir, { recursive: true });
  const profilePath = path.join(dataDir, 'profile.json');
  const defaultProfile = { petName: '小橘' };
  let events = [];
  const savedProfile = readJson(profilePath, {}) || {};
  const savedPetName = stringValue(savedProfile.petName, 80);
  let profile = { petName: savedPetName || defaultProfile.petName };
  let currentGuest = null;
  let lastGuestId = null;
  let roomId = crypto.randomUUID();

  const app = express();
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true });
  const sessions = new Map();
  const idempotent = createTimedCache({ maxAge: IDEMPOTENCE_TTL_MS, maxSize: MAX_IDEMPOTENT, now });
  const transfers = createTimedCache({ maxAge: TRANSFER_TTL_MS, maxSize: MAX_TRANSFERS, now });
  const transferRequests = new Map();
  let activeTransfer = null;
  const allowedOrigins = new Set(['null', `http://${host}:${port}`, 'http://127.0.0.1:4827']);
  let expectedHostId = stringValue(hostId, 80) || null;
  let heartbeatTimer;
  let sessionSequence = 0;
  const persistProfile = () => safeWriteJson(profilePath, profile);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pet-Session, X-Pet-Transfer');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.static(staticDir));
  const tokenFrom = req => req.get('x-pet-session') || '';
  const liveSocket = socket => socket.readyState === 1 && socket.session && sessions.get(socket.session.token) === socket.session;
  const activeSession = token => [...sockets.clients].some(socket => liveSocket(socket) && socket.session.token === token);
  const peerFor = session => [...sockets.clients].filter(socket => liveSocket(socket) && socket.session.senderId !== session.senderId).map(socket => socket.session).sort((a, b) => b.sequence - a.sequence)[0];
  const activePeer = session => Boolean(peerFor(session));
  const presenceFor = session => { const peer = peerFor(session); return { online: Boolean(peer), peerName: peer?.senderName || '' }; };
  const guestOnline = () => currentGuest && [...sockets.clients].some(socket => socket.readyState !== 3 && socket.session && sessions.get(socket.session.token) === socket.session && socket.session.senderId === currentGuest.id);
  function releaseTransferIfFinished(transferId) {
    if (activeTransfer?.id === transferId && !transferRequests.get(transferId)?.size && !ACTIVE_TRANSFER_PHASES.has(transfers.get(transferId)?.phase)) activeTransfer = null;
  }
  function abortTransferRequests(transferId) {
    for (const { req, res } of transferRequests.get(transferId) || []) { if (!req.complete) req.destroy(); else res.destroy(); }
  }
  function trackTransferRequest(transferId, req, res) {
    const requests = transferRequests.get(transferId) || new Set();
    const request = { req, res }; requests.add(request); transferRequests.set(transferId, requests);
    return () => { requests.delete(request); if (!requests.size) transferRequests.delete(transferId); releaseTransferIfFinished(transferId); };
  }
  function reserveTransfer(transferId, res) {
    if (activeTransfer && activeTransfer.id !== transferId) { res.status(409).json({ error: '请等待上一个文件传完，再发送下一个' }); return false; }
    activeTransfer = { id: transferId, expiresAt: now() + TRANSFER_LEASE_MS };
    return true;
  }
  function revokeIdentity(senderId) {
    for (const [token, session] of sessions) if (session.senderId === senderId) sessions.delete(token);
    for (const socket of sockets.clients) if (socket.session?.senderId === senderId) socket.close(1000, 'left');
  }
  function resetConversation() {
    if (activeTransfer) abortTransferRequests(activeTransfer.id);
    events = []; idempotent.clear(); transfers.clear();
    if (activeTransfer) releaseTransferIfFinished(activeTransfer.id);
    for (const entry of fs.readdirSync(fileDir)) fs.rm(path.join(fileDir, entry), { force: true }, () => {});
    roomId = crypto.randomUUID();
    const wire = JSON.stringify({ type: 'reset', roomId });
    for (const socket of sockets.clients) if (liveSocket(socket)) socket.send(wire);
  }
  function pruneCaches() {
    for (const [token, session] of sessions) {
      const expiresAt = Math.min(session.lastSeen + SESSION_TTL_MS, session.closedAt === undefined ? Infinity : session.closedAt + CLOSED_SESSION_TTL_MS);
      if (!activeSession(token) && expiresAt <= now()) sessions.delete(token);
    }
    idempotent.prune(); transfers.prune();
    if (activeTransfer && activeTransfer.expiresAt <= now()) {
      const transfer = transfers.get(activeTransfer.id);
      if (transfer && ACTIVE_TRANSFER_PHASES.has(transfer.phase)) publishTransfer({ ...transfer, phase: 'failed', error: '传输等待超时，请重试' });
      else { abortTransferRequests(activeTransfer.id); releaseTransferIfFinished(activeTransfer.id); }
    }
  }
  const sendPresence = () => { for (const socket of sockets.clients) if (liveSocket(socket)) { const presence = presenceFor(socket.session); socket.send(JSON.stringify({ type: 'presence', ...presence, presence })); } };
  const sendProfile = () => { const wire = JSON.stringify({ type: 'profile', profile }); for (const socket of sockets.clients) if (liveSocket(socket)) socket.send(wire); };
  function broadcastEvent(event, persist = true) {
    if (persist) {
      events.push(event);
      while (events.length > MAX_EVENTS) { const removed = events.shift(); if (removed?.kind === 'file' && removed.fileId) fs.rm(path.join(fileDir, removed.fileId), { force: true }, () => {}); }
    }
    const wire = JSON.stringify({ type: 'event', event });
    for (const socket of sockets.clients) if (liveSocket(socket)) socket.send(wire);
    return event;
  }
  function requireSession(req, res, next) {
    pruneCaches();
    const session = sessions.get(tokenFrom(req));
    if (!session) return res.status(401).json({ error: '会话已失效，请重新连接' });
    session.lastSeen = now(); delete session.closedAt; req.session = session; req.roomId = roomId; next();
  }
  function requireCurrentRoom(req, res, next) {
    if (sessions.get(req.session.token) !== req.session) return res.status(401).json({ error: '会话已失效，请重新连接' });
    if (req.roomId !== roomId) return res.status(409).json({ error: '房间已切换，请重试' });
    next();
  }
  const sessionName = value => stringValue(value, 24) || '对方';

  app.post('/api/session', express.json({ limit: '16kb' }), (req, res) => {
    pruneCaches();
    const senderId = stringValue(req.body?.senderId, 80); const senderName = sessionName(req.body?.senderName); const mode = req.body?.mode;
    if (!senderId || !['host', 'join'].includes(mode) || !stringValue(req.body?.senderName, 24)) return res.status(400).json({ error: '会话信息无效' });
    if (mode === 'host' && expectedHostId && senderId !== expectedHostId) return res.status(403).json({ error: '主机身份不匹配' });
    if (mode === 'join' && senderId === expectedHostId) return res.status(403).json({ error: '访客和房主需要使用不同身份' });
    if (mode === 'join' && currentGuest && currentGuest.id !== senderId) {
      if (guestOnline() || currentGuest.graceUntil > now()) return res.status(409).json({ error: '房间已有另一位访客' });
      revokeIdentity(currentGuest.id); currentGuest = null;
    }
    const sameIdentity = [...sessions.values()].filter(session => session.senderId === senderId).sort((a, b) => a.lastSeen - b.lastSeen || a.sequence - b.sequence);
    if (sameIdentity.length >= MAX_SESSIONS_PER_IDENTITY) {
      const inactive = sameIdentity.find(session => !activeSession(session.token));
      if (!inactive) return res.status(429).json({ error: '打开的窗口过多，请关闭后重试' });
      sessions.delete(inactive.token);
    }
    if (req.body?.fresh === true || mode === 'join' && lastGuestId !== senderId) resetConversation();
    if (mode === 'host') { if (!expectedHostId) expectedHostId = senderId; }
    else {
      lastGuestId = senderId;
      currentGuest = { id: senderId, graceUntil: now() + GUEST_GRACE_MS };
    }
    const token = crypto.randomBytes(32).toString('base64url'); const session = { token, senderId, senderName, mode, lastSeen: now(), sequence: ++sessionSequence };
    sessions.set(token, session); sendPresence();
    res.status(201).json({ token, senderId, senderName, mode, roomId, profile, presence: presenceFor(session) });
  });
  app.get('/api/discover', (_req, res) => res.json({ app: 'dongdong', protocol: PROTOCOL_VERSION }));
  app.use('/api', (req, res, next) => req.path === '/session' || req.path === '/discover' ? next() : requireSession(req, res, next));
  app.get('/api/events', (_req, res) => res.json(events));

  function publishTransfer(transfer) {
    const updated = { ...transfer, updatedAt: new Date(now()).toISOString() };
    transfers.set(updated.transferId, updated);
    if (ACTIVE_TRANSFER_PHASES.has(updated.phase)) activeTransfer = { id: updated.transferId, expiresAt: now() + TRANSFER_LEASE_MS };
    else { abortTransferRequests(updated.transferId); releaseTransferIfFinished(updated.transferId); }
    const wire = JSON.stringify({ type: 'transfer', transfer: updated });
    for (const socket of sockets.clients) if (liveSocket(socket)) socket.send(wire);
    return updated;
  }
  app.get('/api/transfers', (_req, res) => res.json(transfers.values()));
  app.post('/api/transfers', express.json({ limit: '8kb' }), requireCurrentRoom, (req, res) => {
    const transferId = stringValue(req.body?.transferId, 120);
    const phase = stringValue(req.body?.phase, 24);
    const fileId = stringValue(req.body?.fileId, 120);
    const progress = req.body?.progress === undefined ? (phase === 'saved' ? 100 : 0) : Number(req.body.progress);
    if (!transferId || !['uploading', 'downloading', 'saved', 'failed', 'cancelled'].includes(phase) || !Number.isFinite(progress) || progress < 0 || progress > 100) return res.status(400).json({ error: '传输信息无效' });
    const previous = transfers.get(transferId);
    let transfer;
    if (fileId) {
      const event = events.find(item => item.kind === 'file' && item.fileId === fileId);
      if (!event) return res.status(404).json({ error: '文件不存在' });
      if (event.senderId === req.session.senderId || transferId !== (event.transferId || event.fileId) || (previous && previous.fileId !== fileId)) return res.status(403).json({ error: '不能修改这项传输' });
      if (!['downloading', 'saved', 'failed', 'cancelled'].includes(phase)) return res.status(400).json({ error: '传输阶段无效' });
      // Independent windows may receive progress out of order; a saved file stays saved.
      if (previous?.phase === 'saved') return res.json(previous);
      if (phase === 'downloading' && !reserveTransfer(transferId, res)) return;
      transfer = { transferId, fileId, name: event.fileName, senderId: event.senderId, senderName: event.senderName, phase, progress: phase === 'saved' ? 100 : progress };
    } else {
      if (previous && previous.senderId !== req.session.senderId) return res.status(403).json({ error: '不能修改这项传输' });
      if (!['uploading', 'failed', 'cancelled'].includes(phase)) return res.status(400).json({ error: '传输阶段无效' });
      if (previous?.fileId) {
        if (phase === 'cancelled' || phase === 'failed') return res.json(previous.phase === 'saved' ? previous : publishTransfer({ ...previous, phase, error: stringValue(req.body?.error, 160) || undefined }));
        return res.json(previous);
      }
      const name = stringValue(req.body?.name, 180) || previous?.name;
      if (!name) return res.status(400).json({ error: '文件名称无效' });
      if (phase === 'uploading') {
        if (previous && !ACTIVE_TRANSFER_PHASES.has(previous.phase) && transferRequests.get(transferId)?.size) return res.status(409).json({ error: '上一个传输正在停止，请稍后重试' });
        if (!reserveTransfer(transferId, res)) return;
      }
      transfer = { transferId, name: normalizeFileName(name), senderId: req.session.senderId, senderName: req.session.senderName, phase, progress };
    }
    const error = stringValue(req.body?.error, 160);
    if (phase === 'failed' && error) transfer.error = error;
    res.json(publishTransfer(transfer));
  });

  app.post('/api/events', express.json({ limit: '32kb' }), requireCurrentRoom, (req, res) => {
    const { session } = req; const kind = req.body?.kind; const clientId = stringValue(req.body?.clientId, 120);
    if (!EVENT_KINDS.has(kind)) return res.status(400).json({ error: '事件类型无效' });
    let text = '';
    if (kind === 'message') { text = stringValue(req.body?.text, 1000); if (!text) return res.status(400).json({ error: '消息内容无效' }); }
    const idempotenceKey = clientId ? JSON.stringify(['events', kind, session.senderId, clientId]) : '';
    const duplicate = idempotenceKey && idempotent.get(idempotenceKey);
    if (duplicate) return res.status(200).json(duplicate);
    if (ACTION_KINDS.has(kind) && !activePeer(session)) return res.status(409).json({ error: '对方当前不在线' });
    const event = { id: crypto.randomUUID(), kind, text, senderId: session.senderId, senderName: session.senderName, createdAt: new Date(now()).toISOString() };
    if (clientId) event.clientId = clientId;
    if (kind === 'message') { const transferId = stringValue(req.body?.data?.transferId, 120); if (transferId) event.transferId = transferId; }
    const output = broadcastEvent(event, kind === 'message'); if (idempotenceKey) idempotent.set(idempotenceKey, output); res.status(201).json(output);
  });

  app.get('/api/profile', (_req, res) => res.json(profile));
  app.post('/api/profile', express.json({ limit: '8kb' }), requireCurrentRoom, (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: '资料无效' });
    const next = { ...profile };
    if (req.body.petName !== undefined) { if (typeof req.body.petName !== 'string') return res.status(400).json({ error: '资料无效' }); next.petName = req.body.petName.trim().normalize('NFC').slice(0, 80); }
    if (!next.petName) return res.status(400).json({ error: '宠物名称不能为空' }); profile = next; persistProfile(); sendProfile(); res.json(profile);
  });
  app.post('/api/leave', (req, res) => {
    const transfer = activeTransfer && transfers.get(activeTransfer.id);
    if (transfer && ACTIVE_TRANSFER_PHASES.has(transfer.phase)) publishTransfer({ ...transfer, phase: 'cancelled' });
    const session = req.session; revokeIdentity(session.senderId);
    if (session.mode === 'join' && currentGuest?.id === session.senderId) currentGuest = null;
    sendPresence(); res.status(204).end();
  });

  const upload = multer({ storage: multer.diskStorage({ destination: fileDir, filename: (_req, _file, callback) => callback(null, crypto.randomUUID()) }), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  const pendingUploads = new Set();
  const receiveFile = upload.single('file');
  app.post('/api/files', (req, res, next) => {
    const transferId = stringValue(req.get('x-pet-transfer'), 120);
    const transfer = transfers.get(transferId);
    if (!transferId || !transfer || transfer.senderId !== req.session.senderId) return res.status(403).json({ error: '请先开始文件传输' });
    if (transfer.fileId) {
      const event = events.find(item => item.kind === 'file' && item.fileId === transfer.fileId);
      if (event) { req.resume(); return res.status(200).json(event); }
    }
    if (transfer.phase !== 'uploading' || activeTransfer?.id !== transferId || transferRequests.get(transferId)?.size) return res.status(409).json({ error: '请等待上一个文件传完，再发送下一个' });
    req.transferId = transferId;
    const releaseRequest = trackTransferRequest(transferId, req, res);
    let finished;
    const pending = new Promise(resolve => { finished = resolve; });
    pendingUploads.add(pending);
    receiveFile(req, res, error => {
      if (error || req.aborted) {
        const previous = transfers.get(transferId);
        if (previous?.phase === 'uploading') publishTransfer({ ...previous, phase: req.aborted ? 'cancelled' : 'failed', error: '上传中断，请重试' });
      }
      releaseRequest(); pendingUploads.delete(pending); finished(); next(error);
    });
  }, (req, res) => {
    if (!req.file) { const previous = transfers.get(req.transferId); if (previous?.phase === 'uploading') publishTransfer({ ...previous, phase: 'failed', error: '请选择文件' }); return res.status(400).json({ error: '请选择文件' }); }
    const transferId = req.transferId;
    const previous = transfers.get(transferId);
    if (!previous || previous.senderId !== req.session.senderId || previous.fileId || previous.phase !== 'uploading' || activeTransfer?.id !== transferId) { fs.rm(req.file.path, { force: true }, () => {}); return res.status(409).json({ error: '传输已停止，请重新发送' }); }
    const event = { id: crypto.randomUUID(), kind: 'file', transferId, fileId: req.file.filename, fileName: previous.name, size: req.file.size, senderId: req.session.senderId, senderName: req.session.senderName, createdAt: new Date(now()).toISOString() };
    publishTransfer({ ...previous, fileId: event.fileId, phase: 'uploaded', progress: 100 });
    broadcastEvent(event, true); res.status(201).json(event);
  });
  app.get('/api/files/:id', (req, res) => {
    const event = events.find(item => item.kind === 'file' && item.fileId === req.params.id); if (!event) return res.sendStatus(404);
    const transferId = event.transferId;
    const transfer = transfers.get(transferId);
    if (transfer?.phase !== 'saved' && (activeTransfer?.id !== transferId || !ACTIVE_TRANSFER_PHASES.has(transfer?.phase))) return res.status(409).json({ error: '请先开始下载，并等待上一个文件传完' });
    if (activeTransfer && activeTransfer.id !== transferId) return res.status(409).json({ error: '请等待上一个文件传完，再下载下一个' });
    const releaseRequest = trackTransferRequest(transferId, req, res);
    res.once('close', releaseRequest);
    res.download(path.join(fileDir, event.fileId), event.fileName, error => { releaseRequest(); if (error && !res.headersSent && !res.destroyed) res.status(404).end(); });
  });
  app.use((error, req, res, _next) => { if (req.aborted || res.destroyed) return; if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件不能超过 100 MB' }); if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: '请求格式无效' }); console.error(error); res.status(500).json({ error: '操作失败，请重试' }); });

  server.on('upgrade', (request, socket, head) => {
    pruneCaches();
    const url = new URL(request.url, `http://${host}`); const session = sessions.get(url.searchParams.get('session') || '');
    if (url.pathname !== '/ws' || url.searchParams.get('v') !== PROTOCOL_VERSION || !session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    session.lastSeen = now(); delete session.closedAt;
    sockets.handleUpgrade(request, socket, head, ws => { ws.session = session; sockets.emit('connection', ws, request); });
  });
  sockets.on('connection', socket => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; socket.session.lastSeen = now(); });
    socket.on('error', () => {}); sendPresence();
    socket.on('close', () => { if (!activeSession(socket.session.token)) socket.session.closedAt = now(); if (socket.session.mode === 'join' && currentGuest?.id === socket.session.senderId && !guestOnline()) currentGuest.graceUntil = now() + GUEST_GRACE_MS; pruneCaches(); sendPresence(); });
  });
  function startHeartbeat() { heartbeatTimer = setInterval(() => { for (const socket of sockets.clients) { if (socket.isAlive === false) { socket.terminate(); continue; } socket.isAlive = false; socket.ping(); } pruneCaches(); }, 15000); heartbeatTimer.unref?.(); }
  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); startHeartbeat(); resolve(server.address()); }); }),
    close: () => new Promise(resolve => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.close(async () => { await Promise.allSettled([...pendingUploads]); resolve(); });
      // Incomplete multipart requests otherwise hold host restart open forever.
      // Multer removes their partial files before its callback resolves above.
      server.closeAllConnections();
    }),
    server
  };
}
module.exports = { createRoom, MAX_FILE_BYTES, PROTOCOL_VERSION, normalizeFileName, createTimedCache, SESSION_TTL_MS, CLOSED_SESSION_TTL_MS, MAX_SESSIONS_PER_IDENTITY, IDEMPOTENCE_TTL_MS, TRANSFER_TTL_MS, GUEST_GRACE_MS, TRANSFER_LEASE_MS };
