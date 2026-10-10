const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnostics } = require('../electron/diagnostics.cjs');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dongdong-diagnostics-'));
}

test('diagnostics writes only allowlisted fields and rotates bounded files', () => {
  const root = scratch();
  try {
    const initialRoot = path.join(root, 'initial');
    const logger = createDiagnostics({ logsPath: initialRoot, maxBytes: 2048, maxFiles: 3, now: () => new Date('2026-10-09T00:00:00.000Z') });
    assert.equal(logger.write('connection', {
      state: 'online', mode: 'join', code: 1006, attempt: 2,
      chat: '不应写入', filePath: '/Users/private/secret.txt', token: 'secret'
    }), true);
    logger.renderer({ event: 'renderer-error', details: {
      kind: 'unhandled-rejection', name: 'TypeError', source: 'mascot-animator.js', line: 42,
      message: 'private renderer text', stack: '/private/secret.js'
    }});
    const initialText = fs.readFileSync(path.join(initialRoot, 'dongdong.log'), 'utf8');
    assert.doesNotMatch(initialText, /不应写入|secret|private|message|stack|filePath/);
    const initialRecords = initialText.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(initialRecords.some(record => record.event === 'connection' && record.code === 1006 && record.attempt === 2));
    assert.ok(initialRecords.some(record => record.event === 'renderer-error' && record.source === 'mascot-animator.js' && record.line === 42));

    const rotationRoot = path.join(root, 'rotation');
    const rotating = createDiagnostics({ logsPath: rotationRoot, maxBytes: 180, maxFiles: 3, now: () => new Date('2026-10-09T00:00:00.000Z') });
    for (let index = 0; index < 8; index += 1) rotating.write('transfer-finish', { direction: 'send', phase: 'failed', name: 'secret.txt' });
    const files = fs.readdirSync(rotationRoot).filter(name => name.startsWith('dongdong.log')).sort();
    assert.deepEqual(files, ['dongdong.log', 'dongdong.log.1', 'dongdong.log.2']);
    for (const name of files) assert.ok(fs.statSync(path.join(rotationRoot, name)).size <= 180);
    const text = files.map(name => fs.readFileSync(path.join(rotationRoot, name), 'utf8')).join('');
    assert.doesNotMatch(text, /不应写入|secret|private|message|stack|filePath/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed rotation stops logging instead of growing the current file', () => {
  const root = scratch();
  try {
    const logPath = path.join(root, 'dongdong.log');
    const logger = createDiagnostics({ logsPath: root, maxBytes: 180 });
    fs.writeFileSync(logPath, 'x'.repeat(180));
    fs.mkdirSync(`${logPath}.2`);
    assert.equal(logger.write('renderer-responsive'), false);
    assert.equal(fs.statSync(logPath).size, 180);
    fs.rmdirSync(`${logPath}.2`);
    assert.equal(logger.write('renderer-responsive'), false);
    assert.equal(fs.statSync(logPath).size, 180);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('transfer correlation and error details omit arbitrary data', () => {
  const root = scratch();
  try {
    const logger = createDiagnostics({ logsPath: root });
    const transferId = '666c20a0-fbd5-475f-9fb5-28954eb7c3b4';
    assert.equal(logger.renderer({ event: 'app-start', details: { version: 'private' } }), false);
    logger.write('transfer-finish', { transferId, direction: 'send', phase: 'failed', category: 'filesystem',
      name: 'Error', code: 'ENOSPC', status: 413, token: 'secret', fileName: 'private.txt', path: '/private', message: 'private' });
    logger.write('transfer-finish', { transferId: 'private-filename', direction: 'receive', phase: 'failed',
      name: 'private', code: 'private', status: 'private', category: 'private' });
    logger.write('server-error', { name: 'Error', code: 'EIO', status: 500, message: 'private' });
    const text = fs.readFileSync(logger.path, 'utf8');
    assert.doesNotMatch(text, /secret|private/);
    const records = text.trim().split('\n').map(JSON.parse);
    assert.equal(records[0].transferId, transferId);
    assert.equal(records[0].category, 'filesystem');
    assert.equal(records[0].code, 'ENOSPC');
    assert.equal(records[0].status, 413);
    assert.equal(records[1].transferId, undefined);
    assert.equal(records[1].code, undefined);
    assert.equal(records[1].status, undefined);
    assert.equal(records[2].code, 'EIO');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid or unavailable diagnostic input fails safely', () => {
  const logger = createDiagnostics();
  assert.equal(logger.write('connection', { state: 'not-a-state', mode: 'private', code: 'oops' }), false);
  assert.equal(logger.renderer({ event: 'not-allowed', details: { message: 'secret' } }), false);
});
