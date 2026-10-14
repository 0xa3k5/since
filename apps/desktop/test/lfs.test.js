'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../git');

const hasLfs = (() => { try { execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const NO_LFS = hasLfs ? false : 'git-lfs is not installed';

const OID = 'a'.repeat(64);
const pointer = (oid = OID, size = 12345) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

// Isolate from the user's config: a global filter.lfs without git-lfs on PATH makes `git add` fail.
const ISO = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
const run = (dir, args, env) => git.run(dir, args, { env: { ...ISO, ...env } });

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-lfs-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
const write = (dir, f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
const big = (n = 4096) => Buffer.alloc(n, 7);

test('parseLfsPointer reads oid and size, rejects other text', () => {
  assert.deepEqual(git.parseLfsPointer(pointer(OID, 42)), { oid: OID, size: 42 });
  assert.equal(git.parseLfsPointer('hello\n'), null);
  assert.equal(git.parseLfsPointer('version https://git-lfs.github.com/spec/v1\nsize 3\n'), null);
  assert.equal(git.parseLfsPointer(pointer() + 'x'.repeat(2000)), null);
  assert.equal(git.parseLfsPointer(''), null);
});

test('parseLfsPatterns keeps filter=lfs lines only', () => {
  const attrs = '# comment\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.txt text\nassets/** filter=lfs\n*.bin -filter=lfs\n';
  assert.deepEqual(git.parseLfsPatterns(attrs), ['*.psd', 'assets/**']);
  assert.deepEqual(git.parseLfsPatterns(''), []);
});

test('getLfs: a plain repository does not use LFS', async () => {
  const dir = await repo();
  write(dir, 'a.txt', 'a\n');
  await run(dir, ['add', '.']);
  await run(dir, ['commit', '-q', '-m', 'a']);
  const lfs = await git.getLfs(dir);
  assert.equal(lfs.used, false);
  assert.equal(lfs.installed, hasLfs);
  assert.deepEqual(lfs.files, []);
});

test('getLfs: attributes alone mark the repository as using LFS', async () => {
  const dir = await repo();
  write(dir, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  const lfs = await git.getLfs(dir);
  assert.equal(lfs.used, true);
  assert.deepEqual(lfs.patterns, ['*.bin']);
});

// Without git-lfs a checkout leaves pointer text in the working tree; that's the "pointer" state.
test('getLfs: pointer vs downloaded vs deleted, and files stored in full', { skip: hasLfs && 'git-lfs would convert files on add' }, async () => {
  const dir = await repo();
  write(dir, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  write(dir, 'ptr.bin', pointer());
  write(dir, 'sub/whole.bin', big());
  write(dir, 'gone.bin', pointer('b'.repeat(64), 9));
  write(dir, 'plain.txt', 'x\n');
  await run(dir, ['add', '.']);
  await run(dir, ['commit', '-q', '-m', 'files']);
  fs.rmSync(path.join(dir, 'gone.bin'));
  const lfs = await git.getLfs(dir);
  assert.equal(lfs.installed, false);
  const by = Object.fromEntries(lfs.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['gone.bin', 'ptr.bin', 'sub/whole.bin']);
  assert.equal(by['ptr.bin'].state, 'pointer');
  assert.equal(by['ptr.bin'].size, 12345);
  assert.equal(by['ptr.bin'].stored, true);
  assert.equal(by['sub/whole.bin'].state, 'downloaded');
  assert.equal(by['sub/whole.bin'].stored, false);
  assert.equal(by['gone.bin'].state, 'missing');
});

test('markLfs flags changed LFS paths in status, including untracked and spaced names', async () => {
  const dir = await repo();
  write(dir, '.gitattributes', '*.bin filter=lfs -text\n');
  write(dir, 'a.txt', 'a\n');
  await run(dir, ['add', '.']);
  await run(dir, ['commit', '-q', '-m', 'init']);
  write(dir, 'new file.bin', hasLfs ? big() : pointer());
  write(dir, 'a.txt', 'b\n');
  const st = await git.markLfs(dir, await git.getStatus(dir));
  const flags = Object.fromEntries(st.unstaged.map((f) => [f.path, !!f.lfs]));
  assert.deepEqual(flags, { 'a.txt': false, 'new file.bin': true });
  assert.deepEqual(await git.markLfs(dir, { staged: [], unstaged: [], conflicts: [] }), { staged: [], unstaged: [], conflicts: [] });
});

// With git-lfs: staging stores a pointer, diffs show pointer text, checkout restores the real file.
test('git-lfs: stage, diff and checkout round-trip', { skip: NO_LFS }, async () => {
  const dir = await repo();
  const env = { HOME: dir, XDG_CONFIG_HOME: dir }; // keep `git lfs install` out of the user's config
  await run(dir, ['lfs', 'install', '--local'], env);
  write(dir, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  write(dir, 'data.bin', big());
  await run(dir, ['add', '-A', '--'], env);
  const blob = await git.run(dir, ['cat-file', '-p', ':data.bin']);
  assert.ok(git.parseLfsPointer(blob), 'index holds a pointer');
  await run(dir, ['commit', '-q', '-m', 'lfs'], env);
  write(dir, 'data.bin', big(5000));
  const d = await git.workingDiff(dir, { path: 'data.bin', status: 'M' }, { staged: false });
  assert.ok(d, 'diff is produced');
  await run(dir, ['checkout', '--', 'data.bin'], env);
  assert.equal(fs.statSync(path.join(dir, 'data.bin')).size, 4096);
  const lfs = await git.getLfs(dir);
  assert.equal(lfs.installed, true);
  assert.deepEqual(lfs.files.map((f) => [f.path, f.state, f.stored]), [['data.bin', 'downloaded', true]]);
});
