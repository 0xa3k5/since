'use strict';
// Undo/redo of destructive operations. Every test runs in a throwaway repo in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal, refChanges } = require('../journal');

async function repo(opts) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  const journal = new Journal(await git.openRepo(dir), opts);
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

test('stash file → undo drops the stash and brings the change back → redo stashes it again', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', '0\n', 'base');
  await commit(dir, 'b.txt', '0\n', 'b');
  write('a.txt', 'a\n');
  write('b.txt', 'b\n');
  await journal.runWork('stashSave', 'Stash a.txt', ['wip', false, { paths: ['a.txt'] }]);
  assert.equal(read('a.txt'), '0\n');
  const [stash] = await git.getStashes(dir);
  await journal.step('undo');
  assert.equal(read('a.txt'), 'a\n');
  assert.equal(read('b.txt'), 'b\n');
  assert.equal((await git.getStashes(dir)).length, 0);
  await journal.step('redo');
  assert.equal(read('a.txt'), '0\n');
  assert.deepEqual((await git.getStashes(dir)).map((s) => [s.sha, s.message]), [[stash.sha, stash.message]]);
});

test('stash staged → undo restores the staged change, not just the file', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', '0\n', 'base');
  write('a.txt', 'staged\n');
  await git.run(dir, ['add', 'a.txt']);
  await journal.runWork('stashSave', 'Stash staged changes', ['', false, { staged: true }]);
  assert.equal((await git.getStashes(dir)).length, 1);
  await journal.step('undo');
  assert.equal(read('a.txt'), 'staged\n');
  assert.equal(await staged(dir, 'a.txt'), 'staged\n');
  assert.equal((await git.getStashes(dir)).length, 0);
});

test('stash lines → undo puts the lines back and drops the stash', async () => {
  const { dir, journal, read, write } = await repo();
  await commit(dir, 'a.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', 'base');
  write('a.txt', 'ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n');
  const file = { path: 'a.txt', status: 'M' };
  const d = await git.workingDiff(dir, file, { staged: false });
  const keys = d.hunks[0].lines.map((l, i) => (l.t !== ' ' ? `0:${i}` : null)).filter(Boolean);
  await journal.runWork('stashLines', 'Stash lines in a.txt', [file, keys, 'wip']);
  assert.equal(read('a.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n');
  await journal.step('undo');
  assert.equal(read('a.txt'), 'ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n');
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
  journal.redo.hot = [];

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
  const first = journal.undo.hot[0].id;
  assert.ok((await pins(dir)).some((r) => r.startsWith(`refs/gitlanes/undo/main/${first}/`)));

  // Undo, then a new action: the redo entry is gone, and so are its pins.
  await journal.step('undo');
  write('b.txt', 'two\n');
  await journal.runWork('discardFiles', 'Discard b.txt', [[{ path: 'b.txt', status: '?' }]]);
  assert.ok(!(await pins(dir)).some((r) => r.startsWith(`refs/gitlanes/undo/main/${first}/`)));

  // Undo past it and start over: nothing is left, and neither are pins.
  await journal.step('undo');
  write('c.txt', 'three\n');
  await journal.record('Branch', 'createBranch', () => git.run(dir, ['branch', 'other']));
  assert.deepEqual(journal.list().undo.map((e) => e.label), ['Branch']);
  assert.ok((await pins(dir)).every((r) => r.startsWith(`refs/gitlanes/undo/main/${journal.undo.top.id}/`)));
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

// A chain of commits on main, made in one fast-import run.
async function chain(dir, n) {
  let input = '';
  for (let i = 1; i <= n; i++) input += `commit refs/heads/main\ncommitter T <t@example.com> ${1_700_000_000 + i} +0000\ndata ${String(i).length}\n${i}\n${i > 1 ? '' : ''}M 644 inline f.txt\ndata ${String(i).length + 1}\n${i}\n\n`;
  await git.run(dir, ['fast-import', '--quiet'], { input });
  await git.run(dir, ['reset', '-q', '--hard', 'main']);
  return (await git.run(dir, ['rev-list', '--reverse', 'main'])).trim().split('\n');
}
const head = async (dir) => (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
const pageFiles = (dir) => fs.readdirSync(path.join(dir, '.git', 'gitlanes-history'));

test('1,000+ entries: memory stays flat, history survives restarts and gc, undo reaches the oldest', { timeout: 600_000 }, async () => {
  const N = 1_050, REAL = 120, pageSize = 50;
  const { dir, journal } = await repo({ pageSize });
  const shas = await chain(dir, N + 1);
  await git.run(dir, ['reset', '-q', '--hard', shas[0]]);
  // The first entries are recorded for real, across several page boundaries.
  for (let i = 1; i <= REAL; i++) {
    await journal.record(`Move main to ${i}`, 'reset', () => git.run(dir, ['reset', '-q', '--keep', shas[i]]));
    assert.ok(journal.undo.hot.length <= 2 * pageSize);
  }
  assert.ok(journal.undo.pages.length >= 1);
  // The rest are written the way finish() writes them, without running each move.
  const state = (oid) => ({ refs: { 'refs/heads/main': oid }, head: 'refs/heads/main', headOid: oid });
  for (let i = REAL + 1; i <= N; i++) {
    journal.undo.hot.push({ id: journal.undo.top.id + 1, label: `Move main to ${i}`, method: 'reset', time: Date.now(), before: state(shas[i - 1]), after: state(shas[i]) });
    await journal.archive(journal.undo);
    assert.ok(journal.undo.hot.length <= 2 * pageSize);
  }
  for (const e of journal.undo.hot) if (!e.pin) await journal.pin(e.id, { objects: [e.before.headOid, e.after.headOid] });
  await git.run(dir, ['reset', '-q', '--keep', shas[N]]);
  journal.persist();
  await journal.prune();

  assert.equal(journal.undo.length, N);
  assert.ok(pageFiles(dir).length >= (N - 2 * pageSize) / pageSize);
  // Archived pages share one pin set each instead of one per entry.
  assert.ok((await pins(dir)).length < 2 * N);
  // The index stays small; old entries live in page files.
  assert.ok(fs.statSync(journal.file).size < 100_000);
  const listed = journal.list(10);
  assert.deepEqual(listed.undo.map((e) => e.label), Array.from({ length: 10 }, (_, k) => `Move main to ${N - 9 + k}`));
  assert.equal(listed.undoCount, N);
  assert.equal(journal.list(N).undo.length, N);

  // Restore the state before the oldest entry, by id, from an archived page; then undo that.
  await journal.restore(journal.list(N).undo[0].id);
  assert.equal(await head(dir), shas[0]);
  assert.equal(await journal.step('undo'), 'Restore “Move main to 1”');
  assert.equal(await head(dir), shas[N]);

  // Restart, gc, and undo every step, restarting again half-way.
  await gcNow(dir);
  let again = new Journal(await git.openRepo(dir), { pageSize });
  assert.equal(again.undo.length, N);
  for (let i = N; i >= 1; i--) {
    if (i === N / 2) {
      await gcNow(dir);
      again = new Journal(await git.openRepo(dir), { pageSize });
    }
    assert.equal(await again.step('undo'), `Move main to ${i}`);
    assert.ok(again.undo.hot.length <= 2 * pageSize && again.redo.hot.length <= 2 * pageSize);
  }
  assert.equal(await head(dir), shas[0]);
  assert.equal(await again.step('undo'), null);
  assert.equal(again.redo.length, N + 1); // the undone restore is still there to redo, under the others

  // Redo across page boundaries after another restart.
  again = new Journal(await git.openRepo(dir), { pageSize });
  for (let i = 1; i <= 150; i++) assert.equal(await again.step('redo'), `Move main to ${i}`);
  assert.equal(await head(dir), shas[150]);

  // A new action drops everything left to redo: its pages and pins go too.
  const redoPages = again.redo.pages.map((p) => `${p.n}.json`);
  assert.ok(redoPages.length);
  await again.record('Branch', 'createBranch', () => git.run(dir, ['branch', 'topic']));
  assert.equal(again.redo.length, 0);
  assert.equal(again.undo.length, 151);
  assert.ok(redoPages.every((f) => !pageFiles(dir).includes(f)));
  const keys = new Set((await pins(dir)).map((r) => r.split('/')[4]));
  assert.deepEqual([...keys].sort(), [...new Set(again.undo.pinKeys().map(String))].sort());
});

test('a journal saved in the first format is read and archived', async () => {
  const { dir, journal } = await repo({ pageSize: 2 });
  const shas = await chain(dir, 7);
  await git.run(dir, ['reset', '-q', '--hard', shas[0]]);
  for (let i = 1; i <= 5; i++) await journal.record(`Move ${i}`, 'reset', () => git.run(dir, ['reset', '-q', '--keep', shas[i]]));
  const all = journal.list(10).undo.map((e) => journal.find(e.id));
  fs.writeFileSync(journal.file, JSON.stringify({ undo: all.map(({ pin, ...e }) => e), redo: [] }));
  for (const e of all) await git.pinUndo(dir, e.id, { objects: [e.before.headOid, e.after.headOid] });
  const old = new Journal(await git.openRepo(dir), { pageSize: 2 });
  assert.equal(old.undo.length, 5);
  await old.prune();
  // Its pins move into this worktree's namespace.
  assert.ok((await pins(dir)).every((r) => r.startsWith('refs/gitlanes/undo/main/')));
  await old.record('Move 6', 'reset', () => git.run(dir, ['reset', '-q', '--keep', shas[6]]));
  assert.ok(old.undo.hot.length <= 4);
  await gcNow(dir);
  for (let i = 6; i >= 1; i--) assert.equal(await old.step('undo'), `Move ${i}`);
  assert.equal(await head(dir), shas[0]);
});

test('archived discards keep their content through gc', async () => {
  const { dir, journal, read, write } = await repo({ pageSize: 1 });
  await commit(dir, 'a.txt', 'base\n', 'base');
  for (const n of [1, 2, 3, 4]) {
    write('a.txt', `edit ${n}\n`);
    await journal.runWork('discardFiles', `Discard ${n}`, [[{ path: 'a.txt', status: 'M' }]]);
  }
  assert.equal(journal.undo.pages.length, 2);
  assert.ok((await pins(dir)).some((r) => r.startsWith('refs/gitlanes/undo/main/p1/blobs')));
  await gcNow(dir);
  const again = new Journal(await git.openRepo(dir), { pageSize: 1 });
  for (const n of [4, 3, 2, 1]) {
    assert.equal(await again.step('undo'), `Discard ${n}`);
    assert.equal(read('a.txt'), `edit ${n}\n`);
    if (n > 1) write('a.txt', 'base\n'); // the state the next-older discard left behind
  }
});

test('two worktrees keep separate pins, and undo works in both after gc', async () => {
  const { dir, journal: mainJournal } = await repo({ pageSize: 1 });
  const shas = await chain(dir, 6);
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-wt-')));
  fs.rmdirSync(wt);
  await git.run(dir, ['worktree', 'add', '-q', '-b', 'side', wt, shas[0]]);
  const side = [shas[0]];
  for (let i = 1; i <= 4; i++) side.push(await commit(wt, 's.txt', `${i}\n`, `side ${i}`));

  // Each worktree walks its branch back, so the newer commits are only kept alive by pins.
  for (let i = 4; i >= 0; i--) await mainJournal.record(`Main to ${i}`, 'reset', () => git.run(dir, ['reset', '-q', '--keep', shas[i]]));
  assert.ok(mainJournal.undo.pages.length >= 2);
  // Opening the linked worktree prunes only its own namespace.
  let wtJournal = new Journal(await git.openRepo(wt), { pageSize: 1 });
  assert.equal(wtJournal.ns, `wt/${path.basename(wt)}`);
  await wtJournal.prune();
  for (let i = 3; i >= 0; i--) await wtJournal.record(`Side to ${i}`, 'reset', () => git.run(wt, ['reset', '-q', '--keep', side[i]]));
  assert.ok(wtJournal.undo.pages.length >= 1);
  const refs = await pins(dir);
  assert.ok(refs.some((r) => r.startsWith('refs/gitlanes/undo/main/p1/')));
  assert.ok(refs.some((r) => r.startsWith(`refs/gitlanes/undo/${wtJournal.ns}/p1/`)));

  // Restart both (each prunes on open), gc, and undo everything in each.
  let again = new Journal(await git.openRepo(dir), { pageSize: 1 });
  await again.prune();
  wtJournal = new Journal(await git.openRepo(wt), { pageSize: 1 });
  await wtJournal.prune();
  await gcNow(dir);
  for (let i = 0; i <= 3; i++) assert.equal(await wtJournal.step('undo'), `Side to ${i}`);
  assert.equal(await head(wt), side[4]);
  for (let i = 0; i <= 4; i++) assert.equal(await again.step('undo'), `Main to ${i}`);
  assert.equal(await head(dir), shas[5]);
});

test('overlapping undo and redo steps run one at a time across page boundaries', async () => {
  const { dir, journal } = await repo({ pageSize: 2 });
  const shas = await chain(dir, 13);
  for (let i = 11; i >= 0; i--) await journal.record(`Move ${i}`, 'reset', () => git.run(dir, ['reset', '-q', '--keep', shas[i]]));
  assert.ok(journal.undo.pages.length >= 2);
  // A held ⌘Z: every step starts before the one before it has finished.
  const undone = await Promise.all(Array.from({ length: 13 }, () => journal.step('undo')));
  assert.deepEqual(undone, [...Array.from({ length: 12 }, (_, i) => `Move ${i}`), null]);
  assert.equal(await head(dir), shas[12]);
  assert.equal(journal.redo.length, 12);
  const pages = journal.redo.pages.map((p) => p.n);
  assert.equal(new Set(pages).size, pages.length);
  await gcNow(dir);
  const redone = await Promise.all(Array.from({ length: 12 }, () => journal.step('redo')));
  assert.deepEqual(redone, Array.from({ length: 12 }, (_, i) => `Move ${11 - i}`));
  assert.equal(await head(dir), shas[0]);
  assert.equal(journal.undo.length, 12);
});

test('an unreadable index keeps every page and pin', async () => {
  const { dir, journal } = await repo({ pageSize: 1 });
  const shas = await chain(dir, 5);
  for (let i = 3; i >= 0; i--) await journal.record(`Move ${i}`, 'reset', () => git.run(dir, ['reset', '-q', '--keep', shas[i]]));
  const before = { pins: await pins(dir), pages: pageFiles(dir) };
  assert.ok(before.pages.length);
  fs.writeFileSync(journal.file, '{ not json');
  const again = new Journal(await git.openRepo(dir), { pageSize: 1 });
  await again.prune();
  assert.equal(again.undo.length, 0);
  assert.ok(fs.existsSync(`${journal.file}.bad`));
  assert.deepEqual(await pins(dir), before.pins);
  assert.deepEqual(pageFiles(dir), before.pages);
});

// AK-59: a conflicted rebase is three steps (start, resolve, continue); undo must
// go back to the branch in one step, not leave HEAD detached mid-rebase.
test('conflicted rebase → resolve → continue → one undo puts you back on the branch', async () => {
  const { dir, journal, read } = await repo();
  await commit(dir, 'conflict.txt', 'base\n', 'base');
  await git.run(dir, ['checkout', '-q', '-b', 'feature']);
  const feature = await commit(dir, 'conflict.txt', 'feature\n', 'feature change');
  await git.run(dir, ['checkout', '-q', 'main']);
  const before = await commit(dir, 'conflict.txt', 'main\n', 'main change');
  const env = { GIT_EDITOR: 'true' };
  await assert.rejects(journal.record('Rebase onto feature', 'rebaseOnto', () => git.run(dir, ['rebase', feature])));
  assert.equal(await git.getOperationState(path.join(dir, '.git')), 'rebase');
  await journal.runWork('chooseSide', 'Use theirs', ['conflict.txt', 'theirs']);
  await journal.record('Continue rebase', 'continueOp', () => git.run(dir, ['-c', 'core.editor=true', 'rebase', '--continue'], { env }));
  const after = (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
  assert.notEqual(after, before);
  assert.equal(journal.undo.length, 1);

  assert.equal(await journal.step('undo'), 'Rebase onto feature');
  assert.equal((await git.run(dir, ['status', '--porcelain', '--branch'])).trim(), '## main');
  assert.equal((await git.run(dir, ['rev-parse', 'HEAD'])).trim(), before);
  assert.equal(await git.getOperationState(path.join(dir, '.git')), null);
  assert.equal(read('conflict.txt'), 'main\n');

  assert.equal(await journal.step('redo'), 'Rebase onto feature');
  assert.equal((await git.run(dir, ['symbolic-ref', 'HEAD'])).trim(), 'refs/heads/main');
  assert.equal((await git.run(dir, ['rev-parse', 'HEAD'])).trim(), after);
  assert.equal(read('conflict.txt'), 'main\n');
});

test('checking out a commit and then a branch stays two undo steps', async () => {
  const { dir, journal } = await repo();
  const first = await commit(dir, 'a.txt', '1\n', 'one');
  await commit(dir, 'a.txt', '2\n', 'two');
  await journal.record('Checkout one', 'checkout', () => git.run(dir, ['checkout', '-q', first]));
  await journal.record('Checkout main', 'checkout', () => git.run(dir, ['checkout', '-q', 'main']));
  assert.equal(journal.undo.length, 2);
});

test('refChanges lists HEAD, moved, created and deleted refs', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  const current = { refs: { 'refs/heads/main': b, 'refs/heads/new': c, 'refs/tags/v1': a }, head: 'refs/heads/new', headOid: c };
  const target = { refs: { 'refs/heads/main': a, 'refs/heads/old': a, 'refs/tags/v1': a }, head: 'refs/heads/main', headOid: a };
  assert.deepEqual(refChanges(current, target), [
    { ref: 'HEAD', kind: 'head', from: 'refs/heads/new', to: 'refs/heads/main' },
    { ref: 'refs/heads/main', kind: 'move', from: b, to: a },
    { ref: 'refs/heads/new', kind: 'delete', from: c, to: null },
    { ref: 'refs/heads/old', kind: 'create', from: null, to: a },
  ]);
  assert.deepEqual(refChanges(current, current), []);
  // Same branch checked out: the branch move is listed, HEAD isn't.
  assert.deepEqual(refChanges({ ...target, refs: { ...target.refs, 'refs/heads/main': b }, headOid: b }, target).map((x) => x.ref), ['refs/heads/main']);
  // Detached HEAD moving to another commit, and detaching from a branch.
  assert.equal(refChanges({ refs: {}, head: null, headOid: a }, { refs: {}, head: null, headOid: b })[0].to, b);
  assert.equal(refChanges({ refs: {}, head: 'refs/heads/main', headOid: a }, { refs: {}, head: null, headOid: a })[0].to, a);
});

test('previewRestore shows what Restore before would change, without changing it', async () => {
  const { dir, journal } = await repo();
  const one = await commit(dir, 'a.txt', '1', 'one');
  await journal.record('Branch topic', 'createBranch', () => git.run(dir, ['branch', 'topic']));
  const two = await commit(dir, 'a.txt', '2', 'two');
  await journal.record('Reset main', 'reset', () => git.run(dir, ['reset', '-q', '--keep', one]));
  await journal.record('Move main', 'reset', () => git.run(dir, ['reset', '-q', '--keep', two]));
  const [branch] = journal.list().undo;
  const preview = await journal.previewRestore(branch.id);
  assert.equal(preview.label, 'Branch topic');
  assert.equal(preview.movesHead, true);
  assert.deepEqual(preview.changes, [
    { ref: 'refs/heads/main', kind: 'move', from: two, to: one },
    { ref: 'refs/heads/topic', kind: 'delete', from: one, to: null },
  ]);
  assert.equal((await git.run(dir, ['rev-parse', 'main'])).trim(), two);
  // Restoring does exactly what the preview listed.
  await journal.restore(branch.id);
  assert.equal((await git.run(dir, ['rev-parse', 'main'])).trim(), one);
  assert.equal((await git.run(dir, ['branch', '--list', 'topic'])).trim(), '');
  assert.deepEqual((await journal.previewRestore(branch.id)).changes, []);
  await assert.rejects(journal.previewRestore(99999), /Snapshot not found/);
});

test('remotes: editing a URL under an insteadOf rule undoes to the configured value', async () => {
  const { dir, journal } = await repo();
  await git.run(dir, ['config', 'url.git@github.com:.insteadOf', 'https://github.com/']);
  await git.run(dir, ['remote', 'add', 'origin', 'https://github.com/a/a.git']);
  const configured = async () => (await git.run(dir, ['config', '--get', 'remote.origin.url'])).trim();
  const [r] = await git.getRemotes(dir);
  assert.equal(r.url, 'git@github.com:a/a.git', 'remote -v shows the rewritten URL');
  assert.equal(r.setUrl, 'https://github.com/a/a.git');
  await journal.runRemote('setRemoteUrl', 'Edit origin', ['origin', 'https://github.com/a/b.git']);
  await journal.step('undo');
  assert.equal(await configured(), 'https://github.com/a/a.git');
  await journal.step('redo');
  assert.equal(await configured(), 'https://github.com/a/b.git');
});

test('remotes: add, edit URL, rename and remove are each undoable, remove keeps refs and upstreams', async () => {
  const { dir, journal } = await repo();
  const sha = await commit(dir, 'a.txt', 'a\n', 'base');
  const urls = async () => Object.fromEntries((await git.getRemotes(dir)).map((r) => [r.name, r.url]));
  await journal.runRemote('addRemote', 'Add remote origin', ['origin', 'https://example.com/a.git']);
  await journal.runRemote('setRemoteUrl', 'Edit origin', ['origin', 'https://example.com/b.git']);
  assert.deepEqual(await urls(), { origin: 'https://example.com/b.git' });
  await journal.step('undo');
  assert.deepEqual(await urls(), { origin: 'https://example.com/a.git' });
  await journal.step('redo');
  await journal.runRemote('renameRemote', 'Rename origin', ['origin', 'upstream']);
  assert.deepEqual(await urls(), { upstream: 'https://example.com/b.git' });
  await journal.step('undo');
  assert.deepEqual(await urls(), { origin: 'https://example.com/b.git' });

  // A remote-tracking branch (and its HEAD) plus a local branch tracking it.
  await git.run(dir, ['update-ref', 'refs/remotes/origin/main', sha]);
  await git.run(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  await git.run(dir, ['branch', '--set-upstream-to=origin/main', 'main']);
  await journal.runRemote('removeRemote', 'Remove origin', ['origin']);
  assert.deepEqual(await urls(), {});
  assert.equal((await git.run(dir, ['for-each-ref', 'refs/remotes'])).trim(), '');
  await gcNow(dir);
  await journal.step('undo');
  assert.deepEqual(await urls(), { origin: 'https://example.com/b.git' });
  assert.equal((await git.run(dir, ['rev-parse', 'refs/remotes/origin/main'])).trim(), sha);
  assert.equal((await git.run(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim(), 'refs/remotes/origin/main');
  assert.equal((await git.run(dir, ['rev-parse', '--abbrev-ref', 'main@{upstream}'])).trim(), 'origin/main');
  assert.equal((await git.run(dir, ['config', '--get-all', 'remote.origin.fetch'])).trim(), '+refs/heads/*:refs/remotes/origin/*');
  await journal.step('redo');
  assert.deepEqual(await urls(), {});

  // A step whose remote changed since fails without changing anything.
  await journal.step('undo'); // remove
  await git.run(dir, ['remote', 'set-url', 'origin', 'https://example.com/other.git']);
  await assert.rejects(journal.step('undo'), /URL of origin has changed/);
  await assert.rejects(journal.runRemote('addRemote', 'Add', ['origin', 'x']), /already exists/);
});
