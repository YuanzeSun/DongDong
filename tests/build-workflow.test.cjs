const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build.yml'), 'utf8');
const signing = workflow.split('      - name: Build macOS arm64 DMG\n')[1].split('      - name: Build Windows installer\n')[0];
const verification = workflow.split('      - name: Verify macOS app signature\n')[1].split('      - uses:')[0];
const condition = verification.match(/^        if: (.+)$/m)[1];
const secretExpressions = [...signing.matchAll(/^          (\w+): \$\{\{ (.+) \}\}$/gm)];

for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
  test(`${event}: macOS signing secrets and signature checks follow build policy`, () => {
    const secrets = Object.fromEntries(['MAC_CERTIFICATE_BASE64', 'MAC_CERTIFICATE_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].map(name => [name, 'test-secret']));
    const context = { github: { event_name: event }, matrix: { command: 'dist:mac' }, secrets };
    assert.equal(secretExpressions.length, 5);
    for (const [, name, expression] of secretExpressions) {
      assert.equal(vm.runInNewContext(expression, context), event === 'pull_request' ? '' : 'test-secret', name);
    }
    assert.equal(vm.runInNewContext(condition, context), event !== 'pull_request');
    context.matrix.command = 'dist:win';
    assert.equal(vm.runInNewContext(condition, context), false);
    assert.match(verification, /codesign --verify --deep --strict --verbose=2/);
  });
}
