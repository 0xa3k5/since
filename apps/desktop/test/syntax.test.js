'use strict';
// Every shipped script must parse. The renderer is buildless and no unit test imports app.js,
// so a syntax error there (a bad merge, say) passed `pnpm test` and opened a blank window (AK-250).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const renderer = path.join(root, 'renderer');
const files = [
  ...fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => path.join(root, f)),
  ...fs.readdirSync(renderer).filter((f) => f.endsWith('.js')).map((f) => path.join(renderer, f)),
];

for (const file of files) {
  test(`parses: ${path.relative(root, file)}`, () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}
