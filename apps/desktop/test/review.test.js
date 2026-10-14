'use strict';
// Branch review: git.branchReview (temp repos) and the per-file reviewed ticks (renderer/review.js):
// persistence, and invalidation when the branch tip moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

const load = () => import('../renderer/review.js');

// localStorage stand-in.
function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size };
}

const g = (dir, args) => git.run(dir, args);
async function commit(dir, file, content, msg = `edit ${file}`) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-q', '-m', msg]);
}
async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-review-')));
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.name', 'Test']);
  await g(dir, ['config', 'user.email', 't@example.com']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  await commit(dir, 'a.txt', 'a\n', 'base');
  await commit(dir, 'old.txt', 'one\ntwo\nthree\nfour\nfive\n', 'old');
  return dir;
}
const blobOf = (dir, rev) => g(dir, ['rev-parse', rev]).then((s) => s.trim());

test('branchReview diffs the branch from its merge-base, with each file’s blob at the tip', async () => {
  const dir = await repo();
  await g(dir, ['checkout', '-q', '-b', 'feature']);
  await commit(dir, 'a.txt', 'a\nfeature\n');
  await commit(dir, 'src/new file.js', 'x\n');
  await g(dir, ['mv', 'old.txt', 'renamed.txt']);
  await g(dir, ['commit', '-q', '-m', 'rename']);
  // Main moves on: its own change must not show up in the branch's review.
  await g(dir, ['checkout', '-q', 'main']);
  await commit(dir, 'main-only.txt', 'm\n');

  const r = await git.branchReview(dir, 'feature');
  assert.equal(r.base, 'main');
  assert.equal(r.tip, await blobOf(dir, 'feature'));
  assert.equal(r.mergeBase, (await g(dir, ['merge-base', 'main', 'feature'])).trim());
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'renamed.txt', 'src/new file.js']);
  assert.equal(byPath['a.txt'].status, 'M');
  assert.equal(byPath['a.txt'].add, 1);
  assert.equal(byPath['renamed.txt'].status, 'R');
  assert.equal(byPath['renamed.txt'].oldPath, 'old.txt');
  for (const p of Object.keys(byPath)) assert.equal(byPath[p].blob, await blobOf(dir, `feature:${p}`));

  // An explicit base, and a deletion's blob is the zero id.
  await g(dir, ['checkout', '-q', 'feature']);
  await g(dir, ['rm', '-q', 'a.txt']);
  await g(dir, ['commit', '-q', '-m', 'drop a']);
  const r2 = await git.branchReview(dir, 'feature', 'main');
  assert.equal(r2.files.find((f) => f.path === 'a.txt').blob, '0'.repeat(40));
});

test('branchReview refuses unknown branches, option-like names and unrelated history', async () => {
  const dir = await repo();
  await assert.rejects(git.branchReview(dir, 'nope'), /no commits/);
  await assert.rejects(git.branchReview(dir, '--output=x'), /Unknown branch/);
  await assert.rejects(git.branchReview(dir, 'main', 'nope'), /Unknown base/);
  await g(dir, ['checkout', '-q', '--orphan', 'island']);
  await commit(dir, 'z.txt', 'z\n');
  await assert.rejects(git.branchReview(dir, 'island', 'main'), /shares no history/);
});

const review = (tip, blobs) => ({ tip, files: Object.entries(blobs).map(([p, blob]) => ({ path: p, status: 'M', blob })) });

test('ticks persist per repository and lane, keyed by blob', async () => {
  const { storeKey, readTicks, writeTicks, toggleTick, fileStates, progress } = await load();
  const store = memoryStore();
  const key = storeKey('/repo', 'b:feature');
  assert.notEqual(key, storeKey('/other', 'b:feature'));
  assert.notEqual(key, storeKey('/repo', 'b:other'));
  const r = review('t1', { 'a.js': 'A1', 'b.js': 'B1', 'c.js': 'C1' });

  let saved = readTicks(store, key);
  assert.equal(progress(saved, 't1'), null);
  saved = toggleTick(saved, r, 'a.js');
  saved = toggleTick(saved, r, 'b.js');
  writeTicks(store, key, saved);

  const back = readTicks(store, key);
  assert.deepEqual(back.files['a.js'], { blob: 'A1', tip: 't1' });
  assert.deepEqual(fileStates(back, r).map((s) => s.state), ['reviewed', 'reviewed', 'new']);
  assert.deepEqual(progress(back, 't1'), { label: '2 / 3 reviewed', done: false, moved: false });

  // Toggling again unticks; with no ticks left the record goes away.
  saved = toggleTick(toggleTick(back, r, 'a.js'), r, 'b.js');
  writeTicks(store, key, saved);
  assert.equal(store.size(), 0);
  assert.equal(toggleTick(saved, r, 'missing.js'), saved);

  // Corrupt storage starts over instead of throwing.
  store.setItem(key, '{oops');
  assert.deepEqual(readTicks(store, key), { files: {}, summary: null });
});

test('a tip move unticks files whose blob changed and remembers the tip to diff from', async () => {
  const { toggleTick, fileStates, refreshSummary, progress } = await load();
  const r1 = review('t1', { 'a.js': 'A1', 'b.js': 'B1', 'c.js': 'C1' });
  let saved = ['a.js', 'b.js', 'c.js'].reduce((s, p) => toggleTick(s, r1, p), { files: {}, summary: null });
  assert.deepEqual(progress(saved, 't1'), { label: '3 / 3 reviewed', done: true, moved: false });

  // New tip: b.js changed, c.js was reverted out of the branch, d.js is new.
  const r2 = review('t2', { 'a.js': 'A1', 'b.js': 'B2', 'd.js': 'D1' });
  assert.equal(progress(saved, 't2').moved, true);
  assert.deepEqual(fileStates(saved, r2), [
    { path: 'a.js', state: 'reviewed' },
    { path: 'b.js', state: 'changed', since: 't1' },
    { path: 'd.js', state: 'new' },
  ]);
  saved = refreshSummary(saved, r2);
  assert.deepEqual(progress(saved, 't2'), { label: '1 / 3 reviewed', done: false, moved: false });
  assert.equal(refreshSummary(saved, r2), null);

  // Re-ticking b.js keys it to the new blob and tip; c.js's stale tick is dropped.
  saved = toggleTick(saved, r2, 'b.js');
  assert.deepEqual(saved.files['b.js'], { blob: 'B2', tip: 't2' });
  assert.equal(saved.files['c.js'], undefined);
  assert.deepEqual(saved.summary, { tip: 't2', done: 2, total: 3 });

  // The file changing back to the reviewed blob counts as reviewed again.
  const r3 = review('t3', { 'a.js': 'A1', 'b.js': 'B2', 'd.js': 'D1' });
  assert.equal(fileStates(saved, r3)[1].state, 'reviewed');
});
