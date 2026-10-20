'use strict';
// Worktrees: listing, add/remove, lock, and undo/redo of add and remove.
// Every test runs in throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');

async function repo() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-wt-')));
  const dir = path.join(parent, 'app');
  fs.mkdirSync(dir);
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await git.run(dir, ['add', 'a.txt']);
  await git.run(dir, ['commit', '-q', '-m', 'base']);
  const journal = new Journal(await git.openRepo(dir));
  return { parent, dir, journal };
}
const sha = async (dir, ref = 'HEAD') => (await git.run(dir, ['rev-parse', ref])).trim();
const branchExists = async (dir, b) => !!(await git.run(dir, ['rev-parse', '-q', '--verify', `refs/heads/${b}`], { allowCodes: [0, 1] })).trim();
const names = async (dir) => (await git.getWorktrees(dir)).map((w) => w.name);

test('openRepo reports the shared common dir of a linked worktree', async () => {
  const { parent, dir } = await repo();
  await git.addWorktree(dir, { branch: 'feature' });
  const main = await git.openRepo(dir);
  const linked = await git.openRepo(path.join(parent, 'app-feature'));
  assert.equal(main.commonDir, main.gitDir);
  assert.equal(linked.commonDir, main.commonDir);
  assert.notEqual(linked.gitDir, main.gitDir);
  assert.equal(linked.name, 'app-feature');
});

test('list: main first, current flagged, branch / detached / locked / missing', async () => {
  const { parent, dir } = await repo();
  const head = await sha(dir);
  await git.addWorktree(dir, { branch: 'feature' });
  await git.addWorktree(dir, { dir: 'app-detached' });
  await git.lockWorktree(dir, path.join(parent, 'app-detached'), 'on a USB stick');
  await git.addWorktree(dir, { branch: 'gone' });
  fs.rmSync(path.join(parent, 'app-gone'), { recursive: true });

  // git lists the main worktree first, then the linked ones by path.
  const list = await git.getWorktrees(dir);
  assert.deepEqual(list.map((w) => w.name), ['app', 'app-detached', 'app-feature', 'app-gone']);
  const [main, detached, feature, gone] = list;
  assert.deepEqual(list.map((w) => [w.main, w.current]), [[true, true], [false, false], [false, false], [false, false]]);
  assert.equal(main.branch, 'main');
  assert.equal(feature.branch, 'feature');
  assert.equal(detached.detached, true);
  assert.equal(detached.head, head);
  assert.equal(detached.locked, true);
  assert.equal(detached.lockReason, 'on a USB stick');
  assert.equal(gone.missing, true);
  assert.equal(feature.missing, false);
  // Seen from a linked worktree, that one is current.
  assert.deepEqual((await git.getWorktrees(path.join(parent, 'app-feature'))).map((w) => w.current), [false, false, true, false]);

  await git.unlockWorktree(dir, path.join(parent, 'app-detached'));
  await git.pruneWorktrees(dir);
  assert.deepEqual(await names(dir), ['app', 'app-detached', 'app-feature']);
  assert.equal((await git.getWorktrees(dir))[1].locked, false);
});

test('add: new branch at a base, existing branch, default path does not clobber', async () => {
  const { parent, dir } = await repo();
  const base = await sha(dir);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  await git.run(dir, ['add', 'b.txt']);
  await git.run(dir, ['commit', '-q', '-m', 'second']);
  await git.run(dir, ['branch', 'existing']);

  const p1 = await git.addWorktree(dir, { branch: 'topic', base });
  assert.equal(p1, path.join(parent, 'app-topic'));
  assert.equal(await sha(p1), base);
  assert.equal(await sha(dir, 'topic'), base);

  // A relative location is taken from the folder that holds the main worktree.
  const p2 = await git.addWorktree(dir, { branch: 'existing', dir: 'custom' });
  assert.equal(p2, path.join(parent, 'custom'));
  assert.equal((await git.run(p2, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'existing');

  // `force` moves an existing branch to `base` as it adds the worktree (a PR checkout's update).
  await git.run(dir, ['branch', 'moved']);
  const p3 = await git.addWorktree(dir, { branch: 'moved', base, force: true });
  assert.equal(await sha(dir, 'moved'), base);
  assert.equal(await sha(p3), base);

  fs.mkdirSync(path.join(parent, 'app-x'));
  fs.writeFileSync(path.join(parent, 'app-x', 'keep'), '');
  assert.equal(await git.addWorktree(dir, { branch: 'x' }), path.join(parent, 'app-x-2'));
  await assert.rejects(git.addWorktree(dir, { branch: 'y', dir: path.join(parent, 'app-x') }), /already exists/);
  await assert.rejects(git.addWorktree(dir, { branch: 'main' }), /already (checked out|used by worktree)/);
});

test('remove is blocked when dirty, locked, main or current', async () => {
  const { dir } = await repo();
  const wt = await git.addWorktree(dir, { branch: 'feature' });
  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n');
  assert.equal(await git.worktreeChanges(wt), 2);
  await assert.rejects(git.removeWorktree(dir, wt), /has 2 uncommitted changes/);
  assert.ok(fs.existsSync(path.join(wt, 'new.txt')));

  await git.run(wt, ['checkout', '--', 'a.txt']);
  fs.rmSync(path.join(wt, 'new.txt'));
  await git.lockWorktree(dir, wt);
  await assert.rejects(git.removeWorktree(dir, wt), /is locked\. Unlock it first/);
  await git.unlockWorktree(dir, wt);

  await assert.rejects(git.removeWorktree(dir, dir), /main worktree/);
  await assert.rejects(git.removeWorktree(wt, wt), /This window is showing that worktree/);
  assert.equal(path.basename((await git.removeWorktree(dir, wt)).path), 'app-feature');
  assert.ok(!fs.existsSync(wt));
  assert.ok(await branchExists(dir, 'feature'));
});

test('add with a new branch → undo removes both → redo brings both back', async () => {
  const { parent, dir, journal } = await repo();
  const res = await journal.runWorktree('addWorktree', 'New worktree for feature', [{ branch: 'feature' }]);
  assert.equal(res.path, path.join(parent, 'app-feature'));
  assert.ok(await branchExists(dir, 'feature'));
  assert.deepEqual(journal.list().undo.map((e) => [e.label, e.movesRefs]), [['New worktree for feature', false]]);

  assert.equal(await journal.step('undo'), 'New worktree for feature');
  assert.ok(!fs.existsSync(res.path));
  assert.ok(!(await branchExists(dir, 'feature')));
  assert.deepEqual(await names(dir), ['app']);

  assert.equal(await journal.step('redo'), 'New worktree for feature');
  assert.ok(fs.existsSync(path.join(res.path, 'a.txt')));
  assert.equal((await git.getWorktrees(dir))[1].branch, 'feature');
});

test('undoing an add refuses while the new worktree has work in it', async () => {
  const { dir, journal } = await repo();
  const { path: wt } = await journal.runWorktree('addWorktree', 'New worktree', [{ branch: 'feature' }]);
  fs.writeFileSync(path.join(wt, 'wip.txt'), 'wip\n');
  await assert.rejects(journal.step('undo'), /Can't undo “New worktree”: .*1 uncommitted change/);
  assert.ok(fs.existsSync(path.join(wt, 'wip.txt')));

  // A commit there moves the branch: undo must not delete it either.
  await git.run(wt, ['add', 'wip.txt']);
  await git.run(wt, ['commit', '-q', '-m', 'wip']);
  await assert.rejects(journal.step('undo'), /feature moved since/);
  assert.ok(await branchExists(dir, 'feature'));
  assert.equal(journal.list().undo.length, 1);
});

test('remove a detached worktree → undo restores it at the same commit, even after gc', async () => {
  const { parent, dir, journal } = await repo();
  const wt = await git.addWorktree(dir, { dir: path.join(parent, 'scratch') });
  fs.writeFileSync(path.join(wt, 'only-here.txt'), 'x\n');
  await git.run(wt, ['add', 'only-here.txt']);
  await git.run(wt, ['commit', '-q', '-m', 'detached work']);
  const head = await sha(wt);

  await journal.runWorktree('removeWorktree', 'Remove worktree scratch', [wt]);
  assert.ok(!fs.existsSync(wt));
  await git.run(dir, ['-c', 'gc.reflogExpireUnreachable=now', '-c', 'gc.reflogExpire=now', 'gc', '-q', '--prune=now']);

  await journal.step('undo');
  assert.equal(await sha(wt), head);
  assert.equal(fs.readFileSync(path.join(wt, 'only-here.txt'), 'utf8'), 'x\n');
  assert.equal((await git.getWorktrees(dir))[1].detached, true);

  await journal.step('redo');
  assert.ok(!fs.existsSync(wt));
});

test('remove a branch worktree → undo → redo', async () => {
  const { dir, journal } = await repo();
  const wt = await git.addWorktree(dir, { branch: 'feature' });
  await journal.runWorktree('removeWorktree', 'Remove worktree app-feature', [wt]);
  assert.deepEqual(await names(dir), ['app']);
  await journal.step('undo');
  assert.deepEqual(await names(dir), ['app', 'app-feature']);
  assert.equal((await git.getWorktrees(dir))[1].branch, 'feature');
  await journal.step('redo');
  assert.deepEqual(await names(dir), ['app']);
});

test('a failed remove records nothing', async () => {
  const { dir, journal } = await repo();
  const wt = await git.addWorktree(dir, { branch: 'feature' });
  fs.writeFileSync(path.join(wt, 'wip.txt'), 'wip\n');
  await assert.rejects(journal.runWorktree('removeWorktree', 'Remove', [wt]), /uncommitted/);
  assert.equal(journal.list().undo.length, 0);
});

test('log includes extra heads, such as another worktree’s detached HEAD', async () => {
  const { parent, dir } = await repo();
  const wt = await git.addWorktree(dir, { dir: path.join(parent, 'scratch') });
  await git.run(wt, ['commit', '-q', '--allow-empty', '-m', 'detached only']);
  const head = await sha(wt);
  assert.ok(!(await git.getLog(dir)).some((c) => c.sha === head));
  assert.equal((await git.getLog(dir, { heads: [head] }))[0].subject, 'detached only');
});
