const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EVENTS = 300;

function createRoom({ host, port = 4827, key, dataDir, staticDir }) {
  if (!host || !key || !dataDir || !staticDir) throw new Error('Room configuration is incomplete');
  fs.mkdirSync(dataDir, { recursive: true });
  const fileDir = path.join(dataDir, 'files');
  fs.mkdirSync(fileDir, { recursive: true });
  const historyPath = path.join(dataDir, 'history.json');
  let events = [];
  try {
    const saved = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (Array.isArray(saved)) events = saved.slice(-MAX_EVENTS);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not load room history:', error);
  }

  const app = express();
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true });
  const allowedOrigins = new Set(['null', `http://${host}:${port}`, 'http://127.0.0.1:4827']);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pet-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(staticDir));
  app.use('/api', (req, res, next) => {
    const provided = req.get('x-pet-key') || '';
    const left = Buffer.from(provided);
    const right = Buffer.from(key);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      return res.status(401).json({ error: '配对码不正确' });
    }
    next();
  });

  function publish(event) {
    events.push(event);
    while (events.length > MAX_EVENTS) {
      const removed = events.shift();
      if (removed.kind === 'file') fs.rm(path.join(fileDir, removed.fileId), { force: true }, () => {});
    }
    fs.writeFileSync(historyPath, JSON.stringify(events, null, 2));
    const wire = JSON.stringify({ type: 'event', event });
    for (const socket of sockets.clients) {
      if (socket.readyState === 1) socket.send(wire);
    }
    return event;
  }

  app.get('/api/events', (_req, res) => res.json(events));
  app.post('/api/events', express.json({ limit: '8kb' }), (req, res) => {
    const kind = req.body?.kind;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!['message', 'wave'].includes(kind) || (kind === 'message' && (!text || text.length > 1000))) {
      return res.status(400).json({ error: '消息内容无效' });
    }
    const event = publish({
      id: crypto.randomUUID(), kind,
      text: kind === 'wave' ? '' : text,
      senderId: String(req.body?.senderId || '').slice(0, 80),
      senderName: String(req.body?.senderName || '对方').trim().slice(0, 24) || '对方',
      createdAt: new Date().toISOString()
    });
    res.status(201).json(event);
  });

  const upload = multer({
    storage: multer.diskStorage({ destination: fileDir, filename: (_req, _file, callback) => callback(null, crypto.randomUUID()) }),
    limits: { fileSize: MAX_FILE_BYTES, files: 1 }
  });
  app.post('/api/files', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    const originalName = path.basename(req.file.originalname.replaceAll('\\', '/')).slice(0, 180) || 'file';
    const event = publish({
      id: crypto.randomUUID(), kind: 'file',
      fileId: req.file.filename, fileName: originalName, size: req.file.size,
      senderId: String(req.body?.senderId || '').slice(0, 80),
      senderName: String(req.body?.senderName || '对方').trim().slice(0, 24) || '对方',
      createdAt: new Date().toISOString()
    });
    res.status(201).json(event);
  });
  app.get('/api/files/:id', (req, res) => {
    const event = events.find(item => item.kind === 'file' && item.fileId === req.params.id);
    if (!event) return res.sendStatus(404);
    res.download(path.join(fileDir, event.fileId), event.fileName);
  });
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件不能超过 100 MB' });
    }
    console.error(error);
    res.status(500).json({ error: '操作失败，请重试' });
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${host}`);
    if (url.pathname !== '/ws' || url.searchParams.get('key') !== key) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request));
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    }),
    close: () => new Promise(resolve => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.close(resolve);
    }),
    server
  };
}

module.exports = { createRoom, MAX_FILE_BYTES };
