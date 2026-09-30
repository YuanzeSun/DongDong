const { spawnSync } = require('node:child_process');
const process = require('node:process');

const builder = require.resolve('electron-builder/cli.js');
const args = [builder, '--mac', 'dmg', '--arm64', '--publish', 'never'];
const env = { ...process.env };
const hasCertificate = [env.CSC_LINK, env.CSC_NAME].some((value) => typeof value === 'string' && value.trim().length > 0);

if (hasCertificate) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
} else {
  // Keep ad-hoc developer builds usable when the repository has no signing secrets.
  // GitHub Actions exposes missing secrets as empty strings. Remove them instead of
  // letting electron-builder resolve an empty CSC_LINK to the project directory.
  delete env.CSC_LINK;
  delete env.CSC_NAME;
  delete env.CSC_KEY_PASSWORD;
  delete env.APPLE_ID;
  delete env.APPLE_APP_SPECIFIC_PASSWORD;
  delete env.APPLE_TEAM_ID;
  args.push('--config.mac.identity=-', '--config.mac.hardenedRuntime=false');
  args.push('--config.mac.notarize=false');
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
