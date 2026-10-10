const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_FILES = 3;
const EVENT_NAMES = new Set([
  'app-start', 'app-quit', 'main-error', 'server-error', 'renderer-crash', 'renderer-unresponsive',
  'renderer-responsive', 'renderer-load-error', 'renderer-error', 'connection', 'operation-failed',
  'transfer-start', 'transfer-finish'
]);
const CONNECTION_STATES = new Set(['connecting', 'online', 'offline', 'disconnected']);
const CONNECTION_MODES = new Set(['host', 'join', 'unknown']);
const FAILURE_OPERATIONS = new Set([
  'connect', 'send-message', 'send-action', 'send-file', 'receive-file',
  'retry-transfer', 'cancel-transfer', 'scan-peers', 'auto-launch'
]);
const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'TimeoutError'
]);
const RENDERER_DIAGNOSTICS = new Set(['connection', 'operation-failed', 'renderer-error']);
const ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EIO', 'EMFILE', 'ENFILE', 'EROFS',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH',
  'EPIPE', 'ENOTFOUND', 'ETIMEDOUT', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'
]);

function enumValue(value, values, fallback = 'unknown') {
  const candidate = String(value || '');
  return values.has(candidate) ? candidate : fallback;
}

function integer(value, { min = 0, max = 999999 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

function errorName(value) {
  const candidate = typeof value === 'string' ? value : value?.name;
  return enumValue(candidate, ERROR_NAMES, 'Error');
}

function normalizeFields(eventName, details = {}) {
  const source = details && typeof details === 'object' ? details : {};
  switch (eventName) {
    case 'app-start':
      return {
        version: String(source.version || 'unknown').slice(0, 32),
        platform: enumValue(source.platform, new Set(['darwin', 'win32', 'linux']), 'unknown'),
        arch: enumValue(source.arch, new Set(['arm64', 'x64', 'ia32', 'arm']), 'unknown')
      };
    case 'app-quit':
      return { reason: enumValue(source.reason, new Set(['user', 'shutdown', 'crash', 'unknown'])) };
    case 'main-error':
    case 'server-error':
      return { name: errorName(source.name), code: ERROR_CODES.has(source.code) ? source.code : undefined,
        status: integer(source.status, { min: 100, max: 599 }) };
    case 'renderer-crash':
      return {
        reason: enumValue(source.reason, new Set(['clean-exit', 'abnormal-exit', 'crashed', 'oom', 'launch-failed', 'killed', 'integrity-failure', 'unknown'])),
        exitCode: integer(source.exitCode, { min: -999, max: 999 })
      };
    case 'renderer-load-error':
      return { code: integer(source.code, { min: -99999, max: 99999 }), isMainFrame: Boolean(source.isMainFrame) };
    case 'renderer-error':
      return {
        kind: enumValue(source.kind, new Set(['error', 'unhandled-rejection']), 'error'),
        name: errorName(source.name),
        source: enumValue(source.source, new Set(['app.js', 'mascot-animator.js']), 'app.js'),
        line: integer(source.line, { min: 0, max: 100000 })
      };
    case 'renderer-unresponsive':
    case 'renderer-responsive':
      return {};
    case 'connection':
      return {
        state: enumValue(source.state, CONNECTION_STATES),
        mode: enumValue(source.mode, CONNECTION_MODES),
        code: integer(source.code, { min: 0, max: 9999 }),
        attempt: integer(source.attempt, { min: 0, max: 999 })
      };
    case 'operation-failed':
      return {
        operation: enumValue(source.operation, FAILURE_OPERATIONS),
        status: integer(source.status, { min: 0, max: 599 }),
        errorName: errorName(source.errorName)
      };
    case 'transfer-start':
    case 'transfer-finish':
      return {
        transferId: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.transferId) ? source.transferId : undefined,
        direction: enumValue(source.direction, new Set(['send', 'receive']), 'unknown'),
        phase: eventName === 'transfer-finish' ? enumValue(source.phase, new Set(['uploaded', 'saved', 'failed', 'cancelled']), 'unknown') : undefined,
        category: source.category ? enumValue(source.category, new Set(['timeout', 'cancelled', 'filesystem', 'network', 'http', 'peer', 'unknown'])) : undefined,
        name: source.name ? errorName(source.name) : undefined,
        code: ERROR_CODES.has(source.code) ? source.code : undefined,
        status: integer(source.status, { min: 100, max: 599 })
      };
    default:
      return {};
  }
}

function createDiagnostics({ logsPath, maxBytes = MAX_LOG_BYTES, maxFiles = MAX_LOG_FILES, now = () => new Date() } = {}) {
  const basePath = typeof logsPath === 'string' && logsPath ? logsPath : null;
  const filePath = basePath && path.join(basePath, 'dongdong.log');
  const byteLimit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_LOG_BYTES;
  const fileLimit = Number.isInteger(maxFiles) && maxFiles >= 2 ? maxFiles : MAX_LOG_FILES;
  let disabled = !filePath;

  function rotate(requiredBytes) {
    fs.mkdirSync(basePath, { recursive: true, mode: 0o700 });
    const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (currentSize + requiredBytes <= byteLimit) return;
    fs.rmSync(`${filePath}.${fileLimit - 1}`, { force: true });
    for (let index = fileLimit - 2; index >= 1; index -= 1) {
      const older = `${filePath}.${index}`;
      if (fs.existsSync(older)) fs.renameSync(older, `${filePath}.${index + 1}`);
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
  }

  function write(eventName, details) {
    if (disabled || !EVENT_NAMES.has(eventName)) return false;
    try {
      const record = { time: now().toISOString(), event: eventName, ...normalizeFields(eventName, details) };
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > byteLimit) return false;
      rotate(bytes);
      fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      disabled = true;
      return false;
    }
  }

  function renderer(payload) {
    if (!payload || typeof payload !== 'object' || !RENDERER_DIAGNOSTICS.has(payload.event)) return false;
    return write(payload.event, payload.details);
  }

  return {
    write,
    renderer,
    path: filePath,
    close() { disabled = true; }
  };
}

module.exports = {
  createDiagnostics,
  MAX_LOG_BYTES,
  MAX_LOG_FILES
};
