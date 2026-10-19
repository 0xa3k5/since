'use strict';
// Uncommitted changes in the way: stash (or discard) them and carry on, as one undo step.
// Throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const { checkGit } = require('../ipc');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));

async function init(dir) {
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, a);
}

async function repo() {
  const dir = tmp();
  await init(dir);
  const write = (f, c, at = dir) => fs.writeFileSync(path.join(at, f), c);
  const read = (f, at = dir) => fs.readFileSync(path.join(at, f), 'utf8');
  const commit = async (f, c, m) => { write(f, c); await git.run(dir, ['add', f]); await git.run(dir, ['commit', '-q', '-m', m]); };
  await commit('app.js', 'base\n', 'base');
  return {
    dir, write, read, commit,
    journal: new Journal(await git.openRepo(dir)),
    stashes: async (at = dir) => git.getStashes(at),
    tip: async (b) => (await git.run(dir, ['rev-parse', `refs/heads/${b}`])).trim(),
  };
}

async function dirtyWorktree(r) {
  const wt = path.join(r.dir, '..', `${path.basename(r.dir)}-wt`);
  await git.run(r.dir, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  r.write('app.js', 'edited\n', wt);
  r.write('notes.md', 'new\n', wt);
  return fs.realpathSync(wt);
}

test('remove a worktree with changes: refused, then stash and remove is one step and undo brings the changes back', async () => {
  const r = await repo();
  const wt = await dirtyWorktree(r);
  await assert.rejects(r.journal.runWorktree('removeWorktree', 'Remove', [wt]), (e) => e.code === 'dirty-worktree' && e.changes === 2);

  await r.journal.runWorktree('removeWorktree', 'Remove', [wt, { stash: true }]);
  assert.equal(fs.existsSync(wt), false);
  assert.equal((await r.stashes()).length, 1, 'the changes are in the stash list');
  assert.equal(r.journal.undo.length, 1, 'one journal step');

  await r.journal.step('undo');
  assert.equal(r.read('app.js', wt), 'edited\n');
  assert.equal(r.read('notes.md', wt), 'new\n');
  assert.equal((await r.stashes()).length, 0, 'the stash went back into the worktree');

  await r.journal.step('redo');
  assert.equal(fs.existsSync(wt), false);
  assert.equal((await r.stashes()).length, 1);
  await r.journal.step('undo');
  assert.equal(r.read('notes.md', wt), 'new\n');
});

test('clean up a dirty worktree: stash keeps the changes listed, and undo puts them back', async () => {
  const r = await repo();
  const wt = await dirtyWorktree(r);
  const res = await r.journal.runCleanup('Clean up', [{ worktree: wt, branch: 'feature', head: await r.tip('feature'), stash: true }]);
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal((await r.stashes()).length, 1);
  await r.journal.step('undo');
  assert.equal(r.read('app.js', wt), 'edited\n');
  assert.equal((await r.stashes()).length, 0);
  await r.journal.step('redo');
  assert.equal(fs.existsSync(wt), false);
});

test('undo blocked by a file changed since: code dirty, then stash and undo', async () => {
  const r = await repo();
  r.write('app.js', 'mine\n');
  await r.journal.runWork('discardFiles', 'Discard app.js', [[{ path: 'app.js', status: 'M' }]]);
  r.write('app.js', 'later edit\n');
  await assert.rejects(r.journal.step('undo'), (e) => e.code === 'dirty' && /app\.js changed since/.test(e.message));
  assert.equal(await r.journal.step('undo', { stash: true }), 'Discard app.js');
  assert.equal(r.read('app.js'), 'mine\n');
  const [s] = await r.stashes();
  assert.match(s.message, /Set aside to undo/);
});

test('discard and undo (AK-583): the newer edit leaves no stash, and redo brings it back', async () => {
  const r = await repo();
  r.write('app.js', 'mine\n');
  await r.journal.runWork('discardFiles', 'Discard app.js', [[{ path: 'app.js', status: 'M' }]]);
  r.write('app.js', 'later edit\n');
  assert.equal(await r.journal.step('undo', { discard: true }), 'Discard app.js');
  assert.equal(r.read('app.js'), 'mine\n');
  assert.equal((await r.stashes()).length, 0);
  assert.equal(await r.journal.step('redo'), 'Discard app.js');
  assert.equal(r.read('app.js'), 'later edit\n');
});

test('discard and undo a ref step: redo puts the commit and the discarded edit back', async () => {
  const r = await repo();
  await r.journal.record('Commit two', 'cherryPick', () => r.commit('app.js', 'two\n', 'two'));
  r.write('app.js', 'dirty\n');
  await r.journal.step('undo', { discard: true });
  assert.equal(r.read('app.js'), 'base\n');
  assert.equal((await r.stashes()).length, 0);
  await r.journal.step('redo');
  assert.equal(r.read('app.js'), 'dirty\n');
  assert.equal((await git.run(r.dir, ['log', '-1', '--format=%s'])).trim(), 'two');
  assert.deepEqual(checkGit('undo', [{ discard: true }]).args, [{ discard: true }]);
});

test('undo refused by reset --keep over a dirty file: code dirty, then stash and undo', async () => {
  const r = await repo();
  await r.journal.record('Commit two', 'cherryPick', () => r.commit('app.js', 'two\n', 'two'));
  r.write('app.js', 'dirty\n');
  await assert.rejects(r.journal.step('undo'), (e) => e.code === 'dirty');
  await r.journal.step('undo', { stash: true });
  assert.equal(r.read('app.js'), 'base\n');
  assert.equal((await r.stashes()).length, 1);
});

test('stash and merge: git refused the merge over local changes; one step, undo pops the stash', async () => {
  const r = await repo();
  await git.run(r.dir, ['checkout', '-q', '-b', 'feature']);
  await r.commit('app.js', 'feature\n', 'feature');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  const mainTip = await r.tip('main');
  r.write('app.js', 'local\n');
  await assert.rejects(git.run(r.dir, ['merge', '--no-edit', 'feature']), /would be overwritten/);

  await r.journal.stashAnd('Merge feature', 'merge', () => git.run(r.dir, ['merge', '--no-edit', 'feature']));
  assert.equal(r.read('app.js'), 'feature\n');
  assert.equal((await r.stashes()).length, 1);
  assert.equal(r.journal.undo.length, 1, 'one journal step');

  await r.journal.step('undo');
  assert.equal(await r.tip('main'), mainTip);
  assert.equal(r.read('app.js'), 'local\n');
  assert.equal((await r.stashes()).length, 0);
});

test('stash and merge that still fails pops the stash and records nothing', async () => {
  const r = await repo();
  r.write('app.js', 'local\n');
  await assert.rejects(r.journal.stashAnd('Merge nope', 'merge', () => git.run(r.dir, ['merge', '--no-edit', 'nope'])));
  assert.equal(r.read('app.js'), 'local\n');
  assert.equal((await r.stashes()).length, 0);
  assert.equal(r.journal.undo.length, 0);
});

test('submodule with local changes: refused with code dirty-submodule, then stash in submodule and continue', async () => {
  const lib = tmp();
  await init(lib);
  fs.writeFileSync(path.join(lib, 'lib.js'), 'v1\n');
  await git.run(lib, ['add', '.']);
  await git.run(lib, ['commit', '-q', '-m', 'v1']);
  const v1 = (await git.run(lib, ['rev-parse', 'HEAD'])).trim();
  const r = await repo();
  await git.run(r.dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib']);
  await git.run(r.dir, ['commit', '-q', '-m', 'add lib']);
  const sub = path.join(r.dir, 'vendor/lib');
  // Recorded at v2, checked out at v1 with an edit: out of date and modified.
  fs.writeFileSync(path.join(sub, 'lib.js'), 'v2\n');
  await git.run(sub, ['commit', '-q', '-am', 'v2']);
  await git.run(r.dir, ['commit', '-q', '-am', 'lib v2']);
  await git.run(sub, ['checkout', '-q', '--detach', v1]);
  fs.writeFileSync(path.join(sub, 'other.txt'), 'mine\n');

  await assert.rejects(r.journal.runSubmodules('Update', ['vendor/lib']), (e) => e.code === 'dirty-submodule');
  await r.journal.runSubmodules('Update', ['vendor/lib'], { stash: true });
  assert.notEqual((await git.run(sub, ['rev-parse', 'HEAD'])).trim(), v1);
  assert.equal((await r.stashes(sub)).length, 1);
  assert.equal(fs.existsSync(path.join(sub, 'other.txt')), false);

  await r.journal.step('undo');
  assert.equal((await git.run(sub, ['rev-parse', 'HEAD'])).trim(), v1);
  assert.equal(fs.readFileSync(path.join(sub, 'other.txt'), 'utf8'), 'mine\n');
  assert.equal((await r.stashes(sub)).length, 0);

  await r.journal.step('redo');
  assert.equal((await r.stashes(sub)).length, 1, 'redo stashes the changes again');
});

test('ipc: stashAnd checks the inner method and its arguments', () => {
  assert.deepEqual(checkGit('stashAnd', ['merge', ['feature']]).args, ['merge', ['feature']]);
  assert.throws(() => checkGit('stashAnd', ['deleteBranch', ['x']]));
  assert.throws(() => checkGit('stashAnd', ['merge', ['--upload-pack=x']]));
  assert.throws(() => checkGit('stashAnd', ['merge', 'feature']));
  assert.deepEqual(checkGit('undo', [{ stash: true }]).args, [{ stash: true }]);
});
