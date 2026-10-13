'use strict';
// Undo/redo of destructive operations. Every test runs in a throwaway repo in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal, LIMIT } = require('../journal');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  const journal = new Journal(await git.openRepo(dir));
  return { dir, journal, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'), write: (f, c) => fs.writeFileSync(path.join(dir, f), c) };
}
async function commit(dir, file, content, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  await git.run(dir, ['add', file]);
  await git.run(dir, ['commit', '-q', '-m', msg]);
  return (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
}
const staged = (dir, f) => git.run(dir, ['show', `:${f}`]);
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
// Expire reflogs and prune everything unreachable, so only pinned objects survive.
const gcNow = (dir) => git.run(dir, ['-c', 'gc.reflogExpireUnreachable=now', '-c', 'gc.reflogExpire=now', 'gc', '-q', '--prune=now']);
const pins = async (dir) => (await git.run(dir, ['for-each-ref', '--format=%(refname)', 'refs/gitlanes'])).split('\n').filter(Boolean);

test('discard file → undo brings content back → redo discards again', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'app.js', 'one\n', 'base');
  write('app.js', 'two\n');
  fs.mkdirSync(path.join(dir, 'new'));
  write('new/notes.txt', 'untracked\n');
  await journal.runWork('discardFiles', 'Discard 2 files', [[{ path: 'app.js', status: 'M' }, { path: 'new/notes.txt', status: '?' }]]);
  assert.equal(read('app.js'), 'one\n');
  assert.ok(!exists(dir, 'new/notes.txt'));
  assert.deepEqual(journal.list().undo.map((e) => e.label), ['Discard 2 files']);

  assert.equal(await journal.step('undo'), 'Discard 2 files');
  assert.equal(read('app.js'), 'two\n');
  assert.equal(read('new/notes.txt'), 'untracked\n');
  assert.deepEqual((await git.getStatus(dir)).unstaged.map((f) => f.status).sort(), ['?', 'M']);

  assert.equal(await journal.step('redo'), 'Discard 2 files');
  assert.equal(read('app.js'), 'one\n');
  assert.ok(!exists(dir, 'new/notes.txt'));
});

test('discard keeps staged content and the executable bit', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'run.sh', 'echo 1\n', 'base');
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  write('run.sh', 'echo 2\n');
  await git.run(dir, ['add', 'run.sh']);
  write('run.sh', 'echo 3\n');
  await journal.runWork('discardFiles', 'Discard run.sh', [[{ path: 'run.sh', status: 'M' }]]);
  assert.equal(read('run.sh'), 'echo 2\n');
  await journal.step('undo');
  assert.equal(read('run.sh'), 'echo 3\n');
  assert.equal(await staged(dir, 'run.sh'), 'echo 2\n');
  assert.ok(fs.statSync(path.join(dir, 'run.sh')).mode & 0o100);
});

test('discard lines → undo → redo', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'f.txt', 'a\nb\nc\nd\n', 'base');
  write('f.txt', 'A\nb\nc\nD\n');
  const file = { path: 'f.txt', status: 'M' };
  const d = await git.workingDiff(dir, file, { staged: false });
  const keys = [];
  d.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (l.t !== ' ' && /^[dD]$/.test(l.s)) keys.push(`${hi}:${li}`); }));
  await journal.runWork('discardLines', 'Discard 2 lines in f.txt', [file, keys]);
  assert.equal(read('f.txt'), 'A\nb\nc\nd\n');
  await journal.step('undo');
  assert.equal(read('f.txt'), 'A\nb\nc\nD\n');
  await journal.step('redo');
  assert.equal(read('f.txt'), 'A\nb\nc\nd\n');
});

test('reset --hard with a dirty tree → undo restores index and working tree → redo', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', 'a1\n', 'one');
  await commit(dir, 'b.txt', 'b1\n', 'two');
  write('a.txt', 'a-staged\n');
  await git.run(dir, ['add', 'a.txt']);
  write('a.txt', 'a-worktree\n');
  write('b.txt', 'b-worktree\n');
  write('c.txt', 'c-new-staged\n');
  await git.run(dir, ['add', 'c.txt']);
  fs.unlinkSync(path.join(dir, 'b.txt'));
  write('b.txt', 'b-worktree\n');

  await journal.runWork('resetHard', 'Reset hard to HEAD', []);
  assert.equal(read('a.txt'), 'a1\n');
  assert.equal(read('b.txt'), 'b1\n');
  assert.ok(!exists(dir, 'c.txt'));

  await journal.step('undo');
  assert.equal(read('a.txt'), 'a-worktree\n');
  assert.equal(await staged(dir, 'a.txt'), 'a-staged\n');
  assert.equal(read('b.txt'), 'b-worktree\n');
  assert.equal(read('c.txt'), 'c-new-staged\n');
  assert.equal(await staged(dir, 'c.txt'), 'c-new-staged\n');

  await journal.step('redo');
  assert.equal(read('a.txt'), 'a1\n');
  assert.ok(!exists(dir, 'c.txt'));
  assert.deepEqual(await git.getStatus(dir), { staged: [], unstaged: [], conflicts: [] });
});

test('reset --hard to an older commit → undo restores HEAD and the dirty tree', async () => {
  const { dir, journal, read, write } = await repo();
  const one = await commit(dir, 'a.txt', 'a1\n', 'one');
  const two = await commit(dir, 'b.txt', 'b1\n', 'two');
  write('a.txt', 'dirty\n');
  await journal.runWork('resetHard', 'Reset hard to one', [one]);
  assert.ok(!exists(dir, 'b.txt'));
  assert.equal(read('a.txt'), 'a1\n');

  await journal.step('undo');
  assert.equal((await git.run(dir, ['rev-parse', 'HEAD'])).trim(), two);
  assert.equal(read('a.txt'), 'dirty\n');
  assert.equal(read('b.txt'), 'b1\n');
  assert.deepEqual((await git.getStatus(dir)).unstaged.map((f) => f.path), ['a.txt']);

  await journal.step('redo');
  assert.equal((await git.run(dir, ['rev-parse', 'HEAD'])).trim(), one);
  assert.ok(!exists(dir, 'b.txt'));
});

test('stash drop → undo puts it back in place → redo drops it again', async () => {
  const { dir, journal, write } = await repo();
  await commit(dir, 'a.txt', '0\n', 'base');
  for (const n of [1, 2, 3]) {
    write('a.txt', `${n}\n`);
    await git.run(dir, ['stash', 'push', '-q', '-m', `wip ${n}`]);
  }
  const before = await git.getStashes(dir);
  await journal.runWork('stashDrop', 'Drop stash@{1}', ['stash@{1}']);
  assert.deepEqual((await git.getStashes(dir)).map((s) => s.message), ['On main: wip 3', 'On main: wip 1']);

  await journal.step('undo');
  assert.deepEqual((await git.getStashes(dir)).map((s) => [s.sha, s.message]), before.map((s) => [s.sha, s.message]));

  await journal.step('redo');
  assert.deepEqual((await git.getStashes(dir)).map((s) => s.message), ['On main: wip 3', 'On main: wip 1']);
});

test('stash pop → undo restores the stash and the working tree', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', '0\n', 'base');
  write('a.txt', 'stashed\n');
  await git.run(dir, ['stash', 'push', '-q', '-m', 'wip']);
  await journal.runWork('stashApply', 'Pop stash@{0}', ['stash@{0}', true]);
  assert.equal(read('a.txt'), 'stashed\n');
  assert.equal((await git.getStashes(dir)).length, 0);
  await journal.step('undo');
  assert.equal(read('a.txt'), '0\n');
  assert.deepEqual((await git.getStashes(dir)).map((s) => s.message), ['On main: wip']);
  await journal.step('redo');
  assert.equal(read('a.txt'), 'stashed\n');
  assert.equal((await git.getStashes(dir)).length, 0);
});

test('choose a conflict side → undo restores the conflict → redo', async () => {
  const { dir, journal, read } = await repo();
  await commit(dir, 'f.txt', 'base\n', 'base');
  await git.run(dir, ['checkout', '-q', '-b', 'other']);
  await commit(dir, 'f.txt', 'theirs\n', 'theirs');
  await git.run(dir, ['checkout', '-q', 'main']);
  await commit(dir, 'f.txt', 'ours\n', 'ours');
  await git.run(dir, ['merge', 'other'], { allowCodes: [0, 1] });
  const conflicted = read('f.txt');
  assert.match(conflicted, /<<<<<<</);

  await journal.runWork('chooseSide', 'Use their version of f.txt', ['f.txt', 'theirs']);
  assert.equal(read('f.txt'), 'theirs\n');
  assert.equal((await git.getStatus(dir)).conflicts.length, 0);

  await journal.step('undo');
  assert.equal(read('f.txt'), conflicted);
  assert.deepEqual((await git.getStatus(dir)).conflicts.map((f) => f.path), ['f.txt']);
  assert.equal(await git.run(dir, ['show', ':3:f.txt']), 'theirs\n');

  await journal.step('redo');
  assert.equal(read('f.txt'), 'theirs\n');
  assert.equal((await git.getStatus(dir)).conflicts.length, 0);
});

test('gc after a snapshot → undo and redo still work', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', 'a\n', 'base');
  write('only-here.txt', 'never committed\n');
  write('a.txt', 'never staged\n');
  await journal.runWork('discardFiles', 'Discard 2 files', [[{ path: 'only-here.txt', status: '?' }, { path: 'a.txt', status: 'M' }]]);
  for (const n of [1, 2]) {
    write('a.txt', `stash ${n}\n`);
    await git.run(dir, ['stash', 'push', '-q', '-m', `wip ${n}`]);
  }
  await journal.runWork('stashDrop', 'Drop stash@{0}', ['stash@{0}']);
  await gcNow(dir);

  await journal.step('undo');
  assert.deepEqual((await git.getStashes(dir)).map((s) => s.message), ['On main: wip 2', 'On main: wip 1']);
  await git.run(dir, ['stash', 'drop', '-q', 'stash@{0}']);
  await git.run(dir, ['stash', 'drop', '-q', 'stash@{0}']);
  await gcNow(dir);
  // The stash entry is redone against a stash list that no longer has it.
  await assert.rejects(journal.step('redo'), /no longer exists/);
  journal.redo = [];

  await journal.step('undo');
  assert.equal(read('only-here.txt'), 'never committed\n');
  assert.equal(read('a.txt'), 'never staged\n');
  await gcNow(dir);
  await journal.step('redo');
  assert.ok(!exists(dir, 'only-here.txt'));
  await journal.step('undo');
  assert.equal(read('only-here.txt'), 'never committed\n');
});

test('ref undo survives gc after the branch is deleted', async () => {
  const { dir, journal } = await repo();
  await commit(dir, 'a.txt', 'a\n', 'base');
  await git.run(dir, ['checkout', '-q', '-b', 'topic']);
  const tip = await commit(dir, 'b.txt', 'b\n', 'topic work');
  await git.run(dir, ['checkout', '-q', 'main']);
  await journal.record('Delete topic', 'deleteBranch', () => git.run(dir, ['branch', '-D', 'topic']));
  await gcNow(dir);
  assert.equal((await git.run(dir, ['cat-file', '-t', tip])).trim(), 'commit');
  await journal.step('undo');
  assert.equal((await git.run(dir, ['rev-parse', 'topic'])).trim(), tip);
});

test('a failed snapshot aborts the destructive action', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', 'a\n', 'base');
  write('a.txt', 'precious\n');
  let ran = false;
  await assert.rejects(
    journal.record('Discard a.txt', 'discardFiles', async () => { ran = true; }, { paths: async () => { throw new Error('disk full'); } }),
    /Nothing was changed.*disk full/,
  );
  assert.equal(ran, false);
  assert.equal(read('a.txt'), 'precious\n');
  assert.equal(journal.undo.length, 0);
  assert.deepEqual(await pins(dir), []);
});

test('undo refuses to overwrite changes made after the discard', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', 'a\n', 'base');
  write('a.txt', 'first edit\n');
  await journal.runWork('discardFiles', 'Discard a.txt', [[{ path: 'a.txt', status: 'M' }]]);
  write('a.txt', 'newer edit\n');
  await assert.rejects(journal.step('undo'), /a\.txt changed since/);
  assert.equal(read('a.txt'), 'newer edit\n');
  assert.equal(journal.undo.length, 1);
});

test('no-op destructive actions leave no entry and no pins', async () => {
  const { dir, journal } = await repo();
  await commit(dir, 'a.txt', 'a\n', 'base');
  await journal.runWork('resetHard', 'Reset hard to HEAD', []);
  assert.equal(journal.undo.length, 0);
  assert.deepEqual(await pins(dir), []);
});

test('pins are pruned when entries leave the journal', async () => {
  const { dir, journal, write } = await repo();
  await commit(dir, 'a.txt', 'a\n', 'base');
  write('a.txt', 'one\n');
  await journal.runWork('discardFiles', 'Discard a.txt', [[{ path: 'a.txt', status: 'M' }]]);
  const first = journal.undo[0].id;
  assert.ok((await pins(dir)).some((r) => r.startsWith(`refs/gitlanes/undo/${first}/`)));

  // Undo, then a new action: the redo entry is gone, and so are its pins.
  await journal.step('undo');
  write('b.txt', 'two\n');
  await journal.runWork('discardFiles', 'Discard b.txt', [[{ path: 'b.txt', status: '?' }]]);
  assert.ok(!(await pins(dir)).some((r) => r.startsWith(`refs/gitlanes/undo/${first}/`)));

  // Push the remaining entry out of the 200-entry journal.
  const kept = journal.undo[0].id;
  const filler = { label: 'filler', before: journal.undo[0].before, after: journal.undo[0].before };
  for (let i = 0; i < LIMIT; i++) journal.undo.push({ ...filler, id: kept + 1 + i, time: 0 });
  journal.persist();
  await journal.prune();
  assert.equal(journal.undo.length, LIMIT);
  assert.deepEqual(await pins(dir), []);
});

test('journal persists across sessions', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', 'a\n', 'base');
  write('a.txt', 'kept\n');
  await journal.runWork('discardFiles', 'Discard a.txt', [[{ path: 'a.txt', status: 'M' }]]);
  const again = new Journal(await git.openRepo(dir));
  assert.equal(await again.step('undo'), 'Discard a.txt');
  assert.equal(read('a.txt'), 'kept\n');
});
