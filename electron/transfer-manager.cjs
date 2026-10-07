const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { saveResponseDownload } = require('./native-helpers.cjs');

function roomOrigin(value) {
  const url = new URL(String(value));
  const octets = url.hostname.split('.').map(Number);
  const tailnet = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  if (url.protocol !== 'http:' || !tailnet && !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('房间地址无效');
  return url.origin;
}

// Streaming multipart keeps large files out of renderer/IPC memory and lets a
// transfer continue after the window that selected the file has closed.
async function uploadFile(job, { signal, idleTimeoutMs, maximumBytes, onProgress }) {
  const stat = await fs.promises.stat(job.path);
  if (!stat.isFile() || stat.size > maximumBytes) throw new Error('请选择不超过 100 MB 的文件');
  const boundary = `dongdong-${crypto.randomUUID()}`;
  const fields = { fileName: job.name, clientId: job.clientId, transferId: job.transferId };
  const prefix = Buffer.from(Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    const request = http.request(`${job.roomUrl}/api/files`, { method: 'POST', signal, headers: {
      'X-Pet-Session': job.token, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': prefix.length + stat.size + suffix.length
    } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) request.destroy(new Error('服务器响应过大'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const event = JSON.parse(body);
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(event.error || '文件发送失败');
          resolve(event);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(idleTimeoutMs, () => request.destroy(new Error('传输超时，可重试')));
    request.on('error', reject);
    const source = fs.createReadStream(job.path);
    async function* parts() {
      yield prefix;
      let loaded = 0;
      for await (const chunk of source) {
        loaded += chunk.length;
        yield chunk;
        onProgress(stat.size ? loaded / stat.size * 100 : 100);
      }
      yield suffix;
    }
    pipeline(Readable.from(parts()), request, { signal }).catch(reject).finally(() => source.destroy());
  });
}

function createTransferManager({ downloadsPath, onProgress, maximumBytes = 100 * 1024 * 1024,
  idleTimeoutMs = 30000, totalTimeoutMs = 10 * 60 * 1000, now = Date.now }) {
  const jobs = new Map();
  const roomSessions = new Map();
  const keyFor = (url, id) => `${url}|${id}`;
  const publicJob = job => ({ transferId: job.transferId, fileId: job.fileId || '', name: job.name,
    roomUrl: job.roomUrl, direction: job.direction, phase: job.phase, progress: job.progress || 0,
    savedPath: job.savedPath || '', error: job.error || '', updatedAt: job.updatedAt,
    canCancel: Boolean(job.controller), canRetry: !job.controller && ['failed', 'cancelled'].includes(job.phase) });
  function prune() {
    for (const [key, job] of jobs) if (!job.controller && job.updatedAt < now() - 24 * 60 * 60 * 1000) jobs.delete(key);
    while (jobs.size > 100) {
      const candidate = [...jobs].find(([, job]) => !job.controller);
      if (!candidate) break;
      jobs.delete(candidate[0]);
    }
  }
  async function publish(job, phase, progress = job.progress) {
    job.phase = phase; job.progress = progress; job.updatedAt = now();
    onProgress(publicJob(job));
    const payload = { transferId: job.transferId, fileId: job.fileId, name: job.name, phase, progress, error: job.error };
    // Serialize status writes per transfer, so a slow progress request cannot
    // overwrite a later saved/failed state on the other computer.
    const write = async () => {
      if (phase === 'uploaded') return; // /api/files publishes the authoritative upload result.
      if (['saved', 'failed', 'cancelled', 'uploaded'].includes(job.phase) && phase !== job.phase) return;
      try {
        await fetch(`${job.roomUrl}/api/transfers`, { method: 'POST', headers: {
          'X-Pet-Session': job.token, 'Content-Type': 'application/json'
        }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2000) });
      } catch { /* Local progress stays available while the room reconnects. */ }
    };
    job.wire = (job.wire || Promise.resolve()).then(write);
    return job.wire;
  }
  function run(job) {
    if (job.controller) return job.promise;
    if ([...jobs.values()].filter(item => item.controller).length >= 8) throw new Error('同时传输的文件太多，请稍后再试');
    job.controller = new AbortController(); job.error = '';
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(totalTimeoutMs)]);
    const promise = (async () => {
      try {
        await publish(job, job.direction === 'send' ? 'uploading' : 'downloading', 0);
        signal.throwIfAborted();
        let lastProgress = -1;
        const progress = value => {
          const percentage = Math.round(value);
          if (percentage < 100 && percentage - lastProgress < 10) return;
          lastProgress = percentage;
          publish(job, job.direction === 'send' ? 'uploading' : 'downloading', percentage);
        };
        if (job.direction === 'send') {
          const event = await uploadFile(job, { signal, idleTimeoutMs, maximumBytes, onProgress: progress });
          job.fileId = event.fileId;
          job.event = event;
          await publish(job, 'uploaded', 100);
        } else {
          const idle = new AbortController();
          let idleTimer;
          const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error('传输超时，可重试')), idleTimeoutMs); };
          try {
            resetIdle();
            const response = await fetch(`${job.roomUrl}/api/files/${job.fileId}`, { headers: { 'X-Pet-Session': job.token }, signal: AbortSignal.any([signal, idle.signal]) });
            job.savedPath = await saveResponseDownload(downloadsPath(), response, job.name, maximumBytes,
              (loaded, total) => { resetIdle(); progress(total ? loaded / total * 100 : 0); });
          } catch (error) { if (idle.signal.aborted) throw new Error('传输超时，可重试'); throw error; }
          finally { clearTimeout(idleTimer); }
          await publish(job, 'saved', 100);
        }
      } catch (error) {
        const cancelled = job.controller.signal.aborted;
        job.error = cancelled ? '已取消' : signal.aborted ? '传输超时，可重试' : error.message;
        await publish(job, cancelled ? 'cancelled' : 'failed');
      } finally {
        job.controller = null;
        onProgress(publicJob(job));
        prune();
      }
      return publicJob(job);
    })();
    job.promise = promise;
    return promise;
  }
  function start(details, direction) {
    prune();
    const roomUrl = roomOrigin(details.url);
    const token = String(roomSessions.get(roomUrl) || details.token || '');
    if (!token || token.length > 200) throw new Error('文件会话无效');
    const transferId = String(details.transferId || '');
    if (!/^[\w-]{1,120}$/.test(transferId)) throw new Error('传输编号无效');
    const key = keyFor(roomUrl, transferId);
    const existing = jobs.get(key);
    if (existing) return existing;
    if ([...jobs.values()].filter(job => job.controller).length >= 8) throw new Error('同时传输的文件太多，请稍后再试');
    if (direction === 'receive' && !/^[0-9a-f-]{36}$/i.test(details.fileId)) throw new Error('文件编号无效');
    if (direction === 'send' && !path.isAbsolute(details.path || '')) throw new Error('请选择本机文件');
    const job = { roomUrl, token, transferId, direction, name: String(details.fileName || path.basename(details.path || 'file')).slice(0, 180),
      path: details.path, fileId: details.fileId, clientId: String(details.clientId || crypto.randomUUID()), updatedAt: now(), phase: 'waiting' };
    jobs.set(key, job);
    run(job);
    return job;
  }
  return {
    upload: details => publicJob(start(details, 'send')),
    download: details => {
      const job = start(details, 'receive');
      if (!job.controller && job.phase === 'failed') { job.token = String(roomSessions.get(job.roomUrl) || details.token || job.token); return run(job); }
      return job.promise;
    },
    retry: details => {
      const job = jobs.get(keyFor(roomOrigin(details.url), details.transferId));
      if (!job) throw new Error('请重新选择文件');
      if (!job.controller && ['failed', 'cancelled'].includes(job.phase)) {
        job.token = String(roomSessions.get(job.roomUrl) || details.token || job.token);
        run(job);
      }
      return publicJob(job);
    },
    cancel: details => {
      const job = jobs.get(keyFor(roomOrigin(details.url), details.transferId));
      job?.controller?.abort();
      return Boolean(job?.controller);
    },
    cancelRoom: url => { for (const job of jobs.values()) if (job.roomUrl === url) job.controller?.abort(); },
    localPath: details => {
      const job = jobs.get(keyFor(roomOrigin(details.url), details.transferId));
      return job?.direction === 'send' ? job.path : job?.savedPath;
    },
    updateSession: (url, token) => {
      const origin = roomOrigin(url);
      if (!token) return;
      roomSessions.delete(origin); roomSessions.set(origin, token);
      while (roomSessions.size > 8) roomSessions.delete(roomSessions.keys().next().value);
      for (const job of jobs.values()) if (job.roomUrl === origin) job.token = token;
    },
    close: () => { for (const job of jobs.values()) job.controller?.abort(); },
    snapshot: () => { prune(); return [...jobs.values()].map(publicJob); }
  };
}
module.exports = { createTransferManager, roomOrigin };
