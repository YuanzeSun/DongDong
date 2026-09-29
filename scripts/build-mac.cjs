const { spawnSync } = require('node:child_process');
const process = require('node:process');

const builder = require.resolve('electron-builder/cli.js');
const args = [builder, '--mac', 'dmg', '--arm64', '--publish', 'never'];
const env = { ...process.env };
const hasCertificate = Boolean(env.CSC_LINK || env.CSC_NAME);

if (hasCertificate) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
} else {
  // Keep unsigned developer builds usable when the repository has no signing secrets.
  args.push('--config.mac.identity=-', '--config.mac.hardenedRuntime=false');
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
