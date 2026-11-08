'use strict';
// scripts/build.js turns src/ into out/, which is what Electron runs and what gets packaged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');

test('the build transpiles every .ts file, copies the rest and leaves no .ts import behind', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'since-build-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build.js'), '--out', out], { stdio: 'pipe' });
    const files = fs.readdirSync(src, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => path.relative(src, path.join(e.parentPath, e.name)));
    const ts = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    assert.ok(ts.includes(path.join('preload', 'preload.ts')) && ts.includes(path.join('shared', 'channels.ts')));
    for (const f of files) {
      const built = path.join(out, f.replace(/\.ts$/, '.js'));
      if (f.endsWith('.d.ts')) { assert.ok(!fs.existsSync(built), `${f} is for tsc only`); continue; }
      assert.ok(fs.existsSync(built), `${f} is built`);
      if (built.endsWith('.js')) assert.doesNotMatch(fs.readFileSync(built, 'utf8'), /(from|require\(|import\(?)\s*['"]\.\.?\/[^'"]+\.ts['"]/, `${f} imports a .ts file`);
    }
    for (const f of ts) {
      const r = spawnSync(process.execPath, ['--check', path.join(out, f.replace(/\.ts$/, '.js'))], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
    // A sandboxed preload can only require electron: no local files, no type imports left behind.
    const preload = fs.readFileSync(path.join(out, 'preload', 'preload.js'), 'utf8');
    assert.deepEqual([...preload.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]), ['electron']);
    assert.equal(require(path.join(out, 'shared', 'channels.js')).GIT, 'git');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
