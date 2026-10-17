'use strict';
// Review (AK-305): which files conflict when a branch merges into its base, and the hunks, read
// with merge-tree only. Every test runs in a throwaway repo in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-prconf-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
async function commit(dir, files, msg) {
  for (const [f, text] of Object.entries(files)) {
    if (text == null) await git.run(dir, ['rm', '-q', f]);
    else { fs.writeFileSync(path.join(dir, f), text); await git.run(dir, ['add', f]); }
  }
  await git.run(dir, ['commit', '-q', '-m', msg]);
}
const lines = (n, at = {}) => Array.from({ length: n }, (_, i) => at[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

test('conflictHunks cuts marked text into base and head sides with context', () => {
  const text = 'a\nb\nc\nd\n<<<<<<< main\nmine\n||||||| anc\nold\n=======\ntheirs\ntheirs 2\n>>>>>>> pr\ne\nf\n';
  assert.deepEqual(git.conflictHunks(text), [{ line: 5, before: ['b', 'c', 'd'], base: ['mine'], head: ['theirs', 'theirs 2'], after: ['e', 'f'] }]);
  assert.deepEqual(git.conflictHunks('no markers\n'), []);
  assert.deepEqual(git.conflictHunks(''), []);
});

test('conflictHunks shows shared context once and only splits on an exact ======= (AK-308)', () => {
  const two = git.conflictHunks('x\n<<<<<<< a\n1\n=======\n2\n>>>>>>> b\ny\n<<<<<<< a\n3\n=======\n4\n>>>>>>> b\nz\n');
  assert.deepEqual(two.map((h) => [h.before, h.after]), [[['x'], ['y']], [[], ['z']]]);
  const md = git.conflictHunks('<<<<<<< a\nTitle\n========\n=======\nOther\n>>>>>>> b\n');
  assert.deepEqual(md.map((h) => [h.base, h.head]), [[['Title', '========'], ['Other']]]);
});

test('mergeConflictHunks lists conflicting files with both sides, and nothing for a clean merge', async () => {
  const dir = await repo();
  await commit(dir, { 'a.txt': lines(20), 'b.txt': 'b\n', 'gone.txt': 'g\n' }, 'base');
  await git.run(dir, ['checkout', '-q', '-b', 'pr']);
  await commit(dir, { 'a.txt': lines(20, { 10: 'pr side' }), 'b.txt': 'b2\n', 'gone.txt': 'g pr\n' }, 'pr');
  await git.run(dir, ['checkout', '-q', 'main']);
  await commit(dir, { 'a.txt': lines(20, { 10: 'main side' }), 'gone.txt': null }, 'main');
  const before = await git.run(dir, ['for-each-ref']);
  const res = await git.mergeConflictHunks(dir, 'main', 'pr');
  assert.equal(res.supported, true);
  assert.deepEqual(res.files.map((f) => f.path), ['a.txt', 'gone.txt']);
  const [a, gone] = res.files;
  assert.equal(a.hunks.length, 1);
  assert.deepEqual(a.hunks[0].base, ['main side']);
  assert.deepEqual(a.hunks[0].head, ['pr side']);
  assert.deepEqual(a.hunks[0].before, ['line 7', 'line 8', 'line 9']);
  assert.deepEqual(gone, { path: 'gone.txt', hunks: gone.hunks, inBase: false, inHead: true });
  // Read-only: no refs moved, nothing in the index or worktree.
  assert.equal(await git.run(dir, ['for-each-ref']), before);
  assert.equal((await git.run(dir, ['status', '--porcelain'])).trim(), '');
  assert.deepEqual((await git.mergeConflictHunks(dir, 'main', 'main')).files, []);
});
