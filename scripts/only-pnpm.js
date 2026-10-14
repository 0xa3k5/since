'use strict';
// Root `preinstall` guard: fail fast when anything but pnpm installs.
// npm and bun write their lockfile before root lifecycle scripts run, so
// remove any they just left behind (only if git doesn't track it).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const agent = process.env.npm_config_user_agent || '';
if (!agent.startsWith('pnpm/')) {
  const root = path.join(__dirname, '..');
  for (const name of ['package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', name], { cwd: root, stdio: 'ignore' });
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
  const tool = agent.split('/')[0] || 'this package manager';
  console.error(`\nThis repo uses pnpm, not ${tool}: run \`pnpm install\` (enable it with \`corepack enable\`).\n`);
  process.exit(1);
}
