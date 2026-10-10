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
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    const request = http.request(`${job.roomUrl}/api/files`, { method: 'POST', signal, headers: {
      'X-Pet-Session': job.token, 'X-Pet-Transfer': job.transferId, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
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
          if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(new Error(event.error || '文件发送失败'), { status: response.statusCode });
          if (!event || typeof event.fileId !== 'string' || !event.fileId) throw new Error('服务器未确认文件已上传');
          resolve(event);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(idleTimeoutMs, () => request.destroy(Object.assign(new Error('传输超时，可重试'), { code: 'ETIMEDOUT' })));
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
  idleTimeoutMs = 30000, totalTimeoutMs = 10 * 60 * 1000, receiptRetryMs = 1000,
  now = Date.now, onDiagnostic = () => {} }) {
  const jobs = new Map();
  const roomSessions = new Map();
  const terminalPhases = new Set(['saved', 'failed', 'cancelled']);
  let closed = false;
  const keyFor = (url, id) => `${url}|${id}`;
  const isPendingSend = job => job.direction === 'send' && !terminalPhases.has(job.phase);
  const publicJob = job => ({ transferId: job.transferId, fileId: job.fileId || '', name: job.name,
    roomUrl: job.roomUrl, direction: job.direction, phase: job.phase, progress: job.progress || 0,
    savedPath: job.savedPath || '', error: job.error || '', updatedAt: job.updatedAt,
    canCancel: !terminalPhases.has(job.phase) && (Boolean(job.controller) || isPendingSend(job)),
    canRetry: !job.controller && !job.pendingReceipt && ['failed', 'cancelled'].includes(job.phase)
      && (job.direction === 'receive' || !job.fileId) });
  function prune() {
    const disposable = job => !job.controller && !job.pendingReceipt && !isPendingSend(job);
    for (const [key, job] of jobs) if (disposable(job) && job.updatedAt < now() - 24 * 60 * 60 * 1000) jobs.delete(key);
    while (jobs.size > 100) {
      const candidate = [...jobs].find(([, job]) => disposable(job));
      if (!candidate) break;
      jobs.delete(candidate[0]);
    }
  }
  function localUpdate(job, phase, progress = job.progress) {
    const changed = job.phase !== phase;
    job.phase = phase; job.progress = progress; job.updatedAt = now();
    if (changed && (phase === 'uploaded' || terminalPhases.has(phase))) {
      diagnostic('transfer-finish', { transferId: job.transferId, direction: job.direction, phase, ...job.failure });
    }
    if (!job.forgotten) onProgress(publicJob(job));
  }
  function diagnostic(event, details) {
    try { onDiagnostic(event, details); } catch { /* Diagnostics must not affect transfers. */ }
  }
  function failureDetails(error, cancelled, timedOut) {
    const code = error?.code || error?.cause?.code;
    const status = error?.status;
    const category = cancelled ? 'cancelled' : timedOut || code === 'ETIMEDOUT' || error?.name === 'TimeoutError' ? 'timeout'
      : status ? 'http' : ['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EIO', 'EMFILE', 'ENFILE', 'EROFS'].includes(code) ? 'filesystem'
        : code ? 'network' : 'unknown';
    return { category, name: error?.name, code, status };
  }
  function writeStatus(job, payload) {
    const signals = [AbortSignal.timeout(2000)];
    if (job.controller?.signal && !terminalPhases.has(payload.phase)) signals.unshift(job.controller.signal);
    const request = (job.wire || Promise.resolve()).catch(() => {}).then(async () => {
      if (job.forgotten) throw new Error('房间已切换');
      const response = await fetch(`${job.roomUrl}/api/transfers`, { method: 'POST', headers: {
          'X-Pet-Session': job.token, 'Content-Type': 'application/json'
        }, body: JSON.stringify(payload), signal: AbortSignal.any(signals) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(result.error || '传输状态更新失败'), { status: response.status });
      return result;
    });
    job.wire = request.catch(() => {});
    return request;
  }
  function scheduleReceipt(job) {
    if (closed || !job.pendingReceipt || job.receiptTimer) return;
    const wait = Math.min(30000, receiptRetryMs * 2 ** Math.min(job.receiptAttempts || 0, 5));
    job.receiptTimer = setTimeout(() => {
      job.receiptTimer = null;
      flushReceipt(job);
    }, wait);
    job.receiptTimer.unref?.();
  }
  async function flushReceipt(job) {
    if (closed || !job.pendingReceipt || job.receiptInFlight) return;
    const receipt = job.pendingReceipt;
    job.receiptInFlight = true;
    try {
      await writeStatus(job, receipt);
      if (job.pendingReceipt === receipt) {
        job.pendingReceipt = null; job.receiptAttempts = 0;
        clearTimeout(job.receiptTimer); job.receiptTimer = null;
        onProgress(publicJob(job));
      }
    } catch {
      job.receiptAttempts = (job.receiptAttempts || 0) + 1;
    } finally {
      job.receiptInFlight = false;
      scheduleReceipt(job);
    }
  }
  async function publish(job, phase, progress = job.progress, required = false) {
    localUpdate(job, phase, progress);
    if (phase === 'uploaded') return; // /api/files owns this transition.
    const payload = { transferId: job.transferId, fileId: job.direction === 'receive' ? job.fileId : undefined,
      name: job.name, phase, progress, error: job.error };
    if (terminalPhases.has(phase)) {
      job.pendingReceipt = payload;
      await flushReceipt(job);
      return;
    }
    if (required) return writeStatus(job, payload);
    try { await writeStatus(job, payload); } catch { /* Completion has its own reliable receipt. */ }
  }
  function ensureTransferSlot(job) {
    // Saving releases the data slot; the room still arbitrates while its receipt is in flight.
    if ([...jobs.values()].some(item => item !== job && item.phase !== 'saved'
      && (item.controller || isPendingSend(item) || item.pendingReceipt))) {
      throw new Error('请等上一个文件传完，再发送下一个');
    }
  }
  function run(job) {
    if (job.controller) return job.promise;
    ensureTransferSlot(job);
    diagnostic('transfer-start', { transferId: job.transferId, direction: job.direction });
    job.failure = undefined;
    job.controller = new AbortController(); job.error = '';
    job.cancelRequested = false;
    job.serverPhase = '';
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(totalTimeoutMs)]);
    job.reserved = false;
    const promise = (async () => {
      try {
        await publish(job, job.direction === 'send' ? 'uploading' : 'downloading', 0, true);
        job.reserved = true;
        signal.throwIfAborted();
        let lastProgress = -1;
        const progress = value => {
          if (signal.aborted || terminalPhases.has(job.serverPhase)) return;
          const percentage = Math.round(value);
          if (percentage < 100 && percentage - lastProgress < 10) return;
          lastProgress = percentage;
          publish(job, job.direction === 'send' ? 'uploading' : 'downloading', percentage);
        };
        if (job.direction === 'send') {
          const event = await uploadFile(job, { signal, idleTimeoutMs, maximumBytes, onProgress: progress });
          job.fileId = event.fileId;
          if (!terminalPhases.has(job.serverPhase) && job.serverPhase !== 'downloading') await publish(job, 'uploaded', 100);
        } else {
          const idle = new AbortController();
          let idleTimer;
          const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error('传输超时，可重试')), idleTimeoutMs); };
          try {
            resetIdle();
            const response = await fetch(`${job.roomUrl}/api/files/${job.fileId}`, { headers: { 'X-Pet-Session': job.token }, signal: AbortSignal.any([signal, idle.signal]) });
            if (!response.ok) throw Object.assign(new Error('文件下载失败'), { status: response.status });
            job.savedPath = await saveResponseDownload(downloadsPath(), response, job.name, maximumBytes,
              (loaded, total) => { resetIdle(); progress(total ? loaded / total * 100 : 0); });
          } catch (error) { if (idle.signal.aborted) throw Object.assign(new Error('传输超时，可重试'), { code: 'ETIMEDOUT' }); throw error; }
          finally { clearTimeout(idleTimer); }
          await publish(job, 'saved', 100);
        }
      } catch (error) {
        if (job.forgotten) return;
        const cancelled = job.cancelRequested || job.controller.signal.aborted;
        job.error = cancelled ? '已取消' : signal.aborted ? '传输超时，可重试' : error.message;
        job.failure = terminalPhases.has(job.serverPhase) ? { category: 'peer' } : failureDetails(error, cancelled, signal.aborted);
        if (terminalPhases.has(job.serverPhase)) { job.error = job.serverError || ''; localUpdate(job, job.serverPhase); }
        // A lost reservation response may already have occupied the room's slot.
        else if (job.reserved || !error.status || error.status >= 500) await publish(job, cancelled ? 'cancelled' : 'failed');
        else localUpdate(job, cancelled ? 'cancelled' : 'failed');
      } finally {
        job.controller = null;
        if (!job.forgotten) onProgress(publicJob(job));
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
    ensureTransferSlot();
    if (direction === 'receive' && !/^[0-9a-f-]{36}$/i.test(details.fileId)) throw new Error('文件编号无效');
    if (direction === 'send' && !path.isAbsolute(details.path || '')) throw new Error('请选择本机文件');
    const job = { roomUrl, token, transferId, direction, name: String(details.fileName || path.basename(details.path || 'file')).slice(0, 180),
      path: details.path, fileId: details.fileId, updatedAt: now(), phase: 'waiting' };
    jobs.set(key, job);
    run(job);
    return job;
  }
  function cancelJob(job) {
    if (!job || terminalPhases.has(job.phase)) return false;
    if (job.controller) { job.cancelRequested = true; job.controller.abort(); }
    else if (isPendingSend(job)) {
      job.cancelRequested = true; job.error = '已取消'; job.failure = { category: 'cancelled' }; publish(job, 'cancelled');
    } else return false;
    return true;
  }
  function download(details) {
    const origin = roomOrigin(details.url);
    const pending = [...jobs.values()].find(job => job.roomUrl === origin && job.direction === 'send' && job.controller && !job.reserved);
    // The peer's file can arrive before our competing send receives its rejection.
    if (pending) return pending.promise.then(() => {
      if (closed || pending.forgotten) throw new Error('文件接收已停止');
      return download(details);
    });
    const job = start(details, 'receive');
    if (!job.controller && !job.pendingReceipt && job.phase === 'failed') { job.token = String(roomSessions.get(job.roomUrl) || details.token || job.token); return run(job); }
    return job.promise;
  }
  return {
    upload: details => publicJob(start(details, 'send')),
    download,
    retry: details => {
      const job = jobs.get(keyFor(roomOrigin(details.url), details.transferId));
      if (!job) throw new Error('请重新选择文件');
      if (job.direction === 'send' && job.fileId) throw new Error('文件已上传，请对方重试接收，或重新选择文件发送');
      if (!job.controller && !job.pendingReceipt && ['failed', 'cancelled'].includes(job.phase)) {
        job.token = String(roomSessions.get(job.roomUrl) || details.token || job.token);
        run(job);
      }
      return publicJob(job);
    },
    cancel: details => {
      const job = jobs.get(keyFor(roomOrigin(details.url), details.transferId));
      return cancelJob(job);
    },
    localPath: details => {
      const job = jobs.get(keyFor(roomOrigin(details.url), details.transferId));
      return job?.direction === 'send' ? job.path : job?.savedPath;
    },
    updateSession: (url, token) => {
      const origin = roomOrigin(url);
      if (!token) return;
      roomSessions.delete(origin); roomSessions.set(origin, token);
      while (roomSessions.size > 8) roomSessions.delete(roomSessions.keys().next().value);
      for (const job of jobs.values()) if (job.roomUrl === origin) {
        job.token = token;
        if (job.pendingReceipt) { clearTimeout(job.receiptTimer); job.receiptTimer = null; flushReceipt(job); }
      }
    },
    updateTransfer: (url, item) => {
      const job = jobs.get(keyFor(roomOrigin(url), item?.transferId));
      if (!job) return;
      if (item.fileId) job.fileId = item.fileId;
      if (job.direction === 'send' && ['uploaded', 'downloading', 'saved', 'failed', 'cancelled'].includes(item.phase)) {
        job.serverPhase = item.phase;
        job.serverError = item.error || '';
        job.failure = ['failed', 'cancelled'].includes(item.phase) ? { category: 'peer' } : undefined;
        if (terminalPhases.has(item.phase)) job.controller?.abort();
        job.error = item.error || '';
        localUpdate(job, item.phase, item.progress);
      } else if (job.direction === 'receive' && ['cancelled', 'failed'].includes(item.phase) && !terminalPhases.has(job.phase)) {
        job.serverPhase = item.phase;
        job.serverError = item.error || '';
        cancelJob(job);
      }
    },
    forgetRoom: url => {
      const origin = roomOrigin(url);
      for (const [key, job] of jobs) {
        if (job.roomUrl !== origin) continue;
        clearTimeout(job.receiptTimer);
        job.pendingReceipt = null;
        job.receiptTimer = null;
        job.forgotten = true;
        if (!terminalPhases.has(job.phase)) {
          job.failure = { category: 'cancelled' };
          localUpdate(job, 'cancelled');
        }
        job.controller?.abort();
        jobs.delete(key);
      }
      roomSessions.delete(origin);
    },
    close: () => {
      closed = true;
      for (const job of jobs.values()) { clearTimeout(job.receiptTimer); cancelJob(job); }
    },
    snapshot: () => { prune(); return [...jobs.values()].map(publicJob); }
  };
}
module.exports = { createTransferManager, roomOrigin };
