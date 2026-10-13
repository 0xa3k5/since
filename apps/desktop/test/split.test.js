'use strict';
// Commit splitter: git.rewrite(cwd, 'split', sha, { files, messages }). Every test runs in a throwaway repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
async function commit(dir, files, msg, { author } = {}) {
  for (const [f, c] of Object.entries(files)) {
    const abs = path.join(dir, f);
    if (c == null) fs.rmSync(abs);
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c); }
  }
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', msg, ...(author ? [`--author=${author}`] : [])], { env: { GIT_AUTHOR_DATE: '1700000000 +0200' } });
  return rev(dir, 'HEAD');
}
const rev = async (dir, r) => (await git.run(dir, ['rev-parse', r])).trim();
const subjects = async (dir) => (await git.run(dir, ['log', '--format=%s'])).trim().split('\n');
const show = (dir, spec) => git.run(dir, ['show', spec]);
const diff = (dir, a, b) => git.run(dir, ['diff', '--no-renames', a, b]);

// Keys of the changed lines in `file` whose text matches `re`.
async function keysFor(dir, sha, file, re) {
  const d = (await git.commitDiffs(dir, sha)).find((x) => x.path === file);
  const keys = [];
  d.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (l.t !== ' ' && re.test(l.s)) keys.push(`${hi}:${li}`); }));
  return keys;
}

const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
const CHANGED = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n';

test('split the HEAD commit: selected lines become the first commit, the rest the second', async () => {
  const dir = await repo();
  const base = await commit(dir, { 'f.txt': BASE }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED, 'new.txt': 'new\n' }, 'change both ends', { author: 'Ada <ada@example.com>' });
  const keys = await keysFor(dir, orig, 'f.txt', /^[aA]$/);
  assert.equal(keys.length, 2);

  await git.rewrite(dir, 'split', orig, { files: { 'f.txt': keys, 'new.txt': 'all' }, messages: ['first half', 'second half\n\nwith a body'] });

  assert.deepEqual(await subjects(dir), ['second half', 'first half', 'base']);
  // The two commits together equal the original.
  assert.equal(await diff(dir, base, 'HEAD'), await diff(dir, base, orig));
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${orig}^{tree}`));
  assert.equal(await show(dir, 'HEAD~1:f.txt'), BASE.replace('a\n', 'A\n'));
  assert.equal(await show(dir, 'HEAD~1:new.txt'), 'new\n');
  assert.equal(await rev(dir, 'HEAD~2'), base);
  assert.equal((await git.run(dir, ['log', '-1', '--format=%B'])).trim(), 'second half\n\nwith a body');
  // Both keep the original author and date.
  for (const r of ['HEAD', 'HEAD~1']) assert.equal((await git.run(dir, ['log', '-1', '--format=%an <%ae> %at', r])).trim(), 'Ada <ada@example.com> 1700000000');
  assert.equal(await git.run(dir, ['status', '--porcelain']), '');
});

test('split an older commit: descendants are replayed unchanged, and undo/redo work', async () => {
  const dir = await repo();
  const base = await commit(dir, { 'f.txt': BASE }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED }, 'middle');
  await commit(dir, { 'later.txt': 'later\n' }, 'later');
  const head = await commit(dir, { 'f.txt': CHANGED.replace('e\n', 'E\n') }, 'top');
  const journal = new Journal(await git.openRepo(dir));
  const before = await git.captureRefState(dir);

  const keys = await keysFor(dir, orig, 'f.txt', /^[jJ]$/);
  await journal.record('Split commit', 'rewrite', () => git.rewrite(dir, 'split', orig, { files: { 'f.txt': keys }, messages: ['J only', 'A only'] }));

  assert.deepEqual(await subjects(dir), ['top', 'later', 'A only', 'J only', 'base']);
  assert.equal(await diff(dir, base, 'HEAD~2'), await diff(dir, base, orig));
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${head}^{tree}`));
  assert.equal(await show(dir, 'HEAD~3:f.txt'), BASE.replace('j\n', 'J\n'));
  const after = await git.captureRefState(dir);

  assert.equal(await journal.step('undo'), 'Split commit');
  assert.deepEqual(await git.captureRefState(dir), before);
  assert.equal(await rev(dir, 'HEAD'), head);
  assert.deepEqual(await subjects(dir), ['top', 'later', 'middle', 'base']);

  await journal.step('redo');
  assert.deepEqual(await git.captureRefState(dir), after);
  assert.equal(await git.run(dir, ['status', '--porcelain']), '');
});

test('split keeps uncommitted changes (autostash)', async () => {
  const dir = await repo();
  await commit(dir, { 'f.txt': BASE, 'w.txt': 'w\n' }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED }, 'change');
  fs.writeFileSync(path.join(dir, 'w.txt'), 'dirty\n');
  await git.rewrite(dir, 'split', orig, { files: { 'f.txt': await keysFor(dir, orig, 'f.txt', /^[aA]$/) }, messages: ['one', 'two'] });
  assert.deepEqual(await subjects(dir), ['two', 'one', 'base']);
  assert.equal(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'), 'dirty\n');
});

test('split the root commit, partial deletions, and whole binary files', async () => {
  const dir = await repo();
  const root = await commit(dir, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'root');
  assert.equal(root, await rev(dir, 'HEAD'));
  await git.rewrite(dir, 'split', root, { files: { 'a.txt': 'all' }, messages: ['add a', 'add b'] });
  assert.deepEqual(await subjects(dir), ['add b', 'add a']);
  assert.equal((await git.run(dir, ['ls-tree', '--name-only', 'HEAD~1'])).trim(), 'a.txt');
  assert.equal((await git.run(dir, ['rev-list', '--count', 'HEAD'])).trim(), '2');

  // Deleting a file: keep some of its lines in the first commit, the deletion in the second.
  await commit(dir, { 'del.txt': 'x\ny\nz\n' }, 'add del');
  const del = await commit(dir, { 'del.txt': null, 'bin.dat': Buffer.from([0, 1, 2, 0, 255]) }, 'delete and binary');
  const keys = await keysFor(dir, del, 'del.txt', /^x$/);
  await git.rewrite(dir, 'split', del, { files: { 'del.txt': keys, 'bin.dat': 'all' }, messages: ['partial', 'rest'] });
  assert.equal(await show(dir, 'HEAD~1:del.txt'), 'y\nz\n');
  assert.ok((await git.run(dir, ['ls-tree', '--name-only', 'HEAD~1'])).includes('bin.dat'));
  assert.ok(!(await git.run(dir, ['ls-tree', '--name-only', 'HEAD'])).includes('del.txt'));
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${del}^{tree}`));
});

test('split refuses empty halves, merges, and other branches, changing nothing', async () => {
  const dir = await repo();
  await commit(dir, { 'f.txt': BASE }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED, 'bin.dat': Buffer.from([0, 1, 0]) }, 'change');
  const head = await rev(dir, 'HEAD');
  const split = (sha, extra) => git.rewrite(dir, 'split', sha, { messages: ['one', 'two'], ...extra });

  await assert.rejects(split(orig, { files: {} }), /at least one change for the first commit/);
  await assert.rejects(split(orig, { files: { 'f.txt': 'all', 'bin.dat': 'all' } }), /at least one change for the second commit/);
  await assert.rejects(split(orig, { files: { 'f.txt': 'all' }, messages: ['one', ' '] }), /Both commits need a message/);
  await assert.rejects(split(orig, { files: { 'nope.txt': 'all' } }), /not changed in this commit/);

  await git.run(dir, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
  const side = await commit(dir, { 's.txt': 's\n', 't.txt': 't\n' }, 'side');
  await git.run(dir, ['checkout', '-q', 'main']);
  await assert.rejects(split(side, { files: { 's.txt': 'all' } }), /not on the current branch/);
  await git.run(dir, ['merge', '-q', '--no-edit', 'side']);
  const merge = await rev(dir, 'HEAD');
  await assert.rejects(split(merge, { files: { 's.txt': 'all' } }), /merge commits is not supported/);
  await assert.rejects(split(orig, { files: { 'f.txt': 'all' } }), /merge commits between/);

  assert.equal(await rev(dir, 'HEAD'), merge);
  assert.equal(await rev(dir, 'HEAD^1'), head);
  assert.equal(await git.run(dir, ['status', '--porcelain']), '');
});

test('split files with spaces and non-ASCII characters in their names', async () => {
  const dir = await repo();
  await commit(dir, { 'my notes.txt': BASE, 'über/çay.txt': BASE }, 'base');
  const orig = await commit(dir, { 'my notes.txt': CHANGED, 'über/çay.txt': CHANGED }, 'change');
  assert.deepEqual((await git.commitDiffs(dir, orig)).map((d) => d.path).sort(), ['my notes.txt', 'über/çay.txt']);
  await git.rewrite(dir, 'split', orig, { files: { 'my notes.txt': await keysFor(dir, orig, 'my notes.txt', /^[aA]$/), 'über/çay.txt': 'all' }, messages: ['one', 'two'] });
  assert.equal(await show(dir, 'HEAD~1:my notes.txt'), BASE.replace('a\n', 'A\n'));
  assert.equal(await show(dir, 'HEAD~1:über/çay.txt'), CHANGED);
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${orig}^{tree}`));
});
