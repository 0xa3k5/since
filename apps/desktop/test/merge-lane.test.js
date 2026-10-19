'use strict';
// Merge and tidy a lane: squash its branch onto the base, remove its worktree, delete the branch,
// all as one undo step. Every test runs in throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');

async function repo() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-merge-')));
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
async function commit(dir, file, text, msg) {
  fs.writeFileSync(path.join(dir, file), text);
  await git.run(dir, ['add', file]);
  await git.run(dir, ['commit', '-q', '-m', msg]);
}
// A lane: branch `feature` in its own worktree, with two commits.
async function lane(dir) {
  const wt = await git.addWorktree(dir, { branch: 'feature' });
  await commit(wt, 'b.txt', 'b\n', 'add b');
  await commit(wt, 'c.txt', 'c\n', 'add c');
  return wt;
}
const merge = (journal, dir, opts) => journal.runLane('Merge and tidy feature', opts.merge === false ? 'tidyLane' : 'mergeLane', (done) => git.mergeLane(dir, opts, done));

test('mergeLanePlan lists the commits and the worktree, and finds no blocker', async () => {
  const { dir } = await repo();
  const wt = await lane(dir);
  const plan = await git.mergeLanePlan(dir, 'feature');
  assert.equal(plan.base, 'main');
  assert.equal(plan.baseSha, await sha(dir));
  assert.deepEqual(plan.commits.map((c) => c.subject), ['add c', 'add b']);
  assert.equal(plan.worktree.path, wt);
  assert.equal(plan.blocker, null);
  assert.equal(plan.mergeBlocker, null);
  assert.deepEqual(plan.conflicts, []);
});

test('mergeLanePlan blocks a dirty worktree and the base itself; a branch checked out here is kept', async () => {
  const { dir } = await repo();
  const wt = await lane(dir);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'dirty\n');
  assert.match((await git.mergeLanePlan(dir, 'feature')).blocker, /has 1 uncommitted change/);
  const here = await git.mergeLanePlan(wt, 'feature');
  assert.equal(here.blocker, null);
  assert.equal(here.keep, 'current');
  assert.equal(here.worktree, null);
  await git.run(dir, ['branch', 'other']);
  await git.run(dir, ['checkout', '-q', 'other']);
  assert.match((await git.mergeLanePlan(dir, 'main')).blocker, /main worktree|base branch/);
  await assert.rejects(git.mergeLane(dir, { branch: 'feature', base: 'main', message: 'x' }), /uncommitted change/);
  assert.ok(await branchExists(dir, 'feature'));
});

test('mergeLanePlan reports conflicts as a merge-only blocker', async () => {
  const { dir } = await repo();
  const wt = await git.addWorktree(dir, { branch: 'feature' });
  await commit(wt, 'a.txt', 'lane\n', 'lane edit');
  await commit(dir, 'a.txt', 'main\n', 'main edit');
  const plan = await git.mergeLanePlan(dir, 'feature');
  assert.equal(plan.blocker, null);
  assert.deepEqual(plan.conflicts, ['a.txt']);
  assert.match(plan.mergeBlocker, /conflicts with main in 1 file/);
  await assert.rejects(git.mergeLane(dir, { branch: 'feature', message: 'x' }), /conflicts with main/);
  assert.ok(fs.existsSync(wt), 'nothing changed');
});

test('merge and tidy squashes onto the checked-out base, removes the worktree and branch → undo → redo', async () => {
  const { dir, journal } = await repo();
  const wt = await lane(dir);
  const base = await sha(dir);
  const res = await merge(journal, dir, { branch: 'feature', base: 'main', message: 'Land feature\n\n- add b\n- add c' });
  assert.equal(res.base, 'main');
  assert.equal(await sha(dir), res.commit);
  assert.equal(await sha(dir, 'HEAD^'), base, 'one commit on top of base');
  assert.equal((await git.run(dir, ['log', '-1', '--format=%B'])).trim(), 'Land feature\n\n- add b\n- add c');
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'c\n', 'the working copy follows the base');
  assert.ok(!fs.existsSync(wt));
  assert.ok(!(await branchExists(dir, 'feature')));
  assert.equal(journal.undo.length, 1, 'one undo step');

  assert.equal(await journal.step('undo'), 'Merge and tidy feature');
  assert.equal(await sha(dir), base);
  assert.ok(!fs.existsSync(path.join(dir, 'c.txt')));
  assert.ok(await branchExists(dir, 'feature'));
  assert.ok(fs.existsSync(path.join(wt, 'c.txt')), 'the worktree is back on its branch');
  assert.equal((await git.getWorktrees(dir)).find((w) => w.path === wt).branch, 'feature');

  await journal.step('redo');
  assert.equal(await sha(dir), res.commit);
  assert.ok(!fs.existsSync(wt));
  assert.ok(!(await branchExists(dir, 'feature')));
});

test('merge and tidy moves a base that is not checked out without touching this working copy', async () => {
  const { dir, journal } = await repo();
  await commit(dir, 'b.txt', 'b\n', 'add b');
  await git.run(dir, ['checkout', '-q', '-b', 'side']);
  await git.run(dir, ['checkout', '-q', 'main']);
  await git.run(dir, ['branch', 'feature']);
  await git.run(dir, ['checkout', '-q', 'feature']);
  await commit(dir, 'd.txt', 'd\n', 'add d');
  await git.run(dir, ['checkout', '-q', 'side']);
  const base = await sha(dir, 'main');
  const res = await merge(journal, dir, { branch: 'feature', message: 'Land d' });
  assert.equal(await sha(dir, 'main'), res.commit);
  assert.equal(await sha(dir, 'main^'), base);
  assert.equal((await git.run(dir, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'side');
  assert.ok(!fs.existsSync(path.join(dir, 'd.txt')));
  assert.ok(!(await branchExists(dir, 'feature')));
  await journal.step('undo');
  assert.equal(await sha(dir, 'main'), base);
  assert.ok(await branchExists(dir, 'feature'));
});

test('a lane already on its base is only tidied, and tidyLane never moves the base', async () => {
  const { dir, journal } = await repo();
  const wt = await lane(dir);
  const base = await sha(dir);
  await merge(journal, dir, { branch: 'feature', merge: false });
  assert.equal(await sha(dir), base, 'tidy leaves the base alone');
  assert.ok(!fs.existsSync(wt));
  assert.ok(!(await branchExists(dir, 'feature')));
  await journal.step('undo');
  assert.ok(fs.existsSync(path.join(wt, 'c.txt')));

  // Squash it onto main by hand: the lane then has nothing left to merge.
  await git.run(dir, ['merge', '-q', '--squash', 'feature']);
  await git.run(dir, ['commit', '-q', '-m', 'squashed']);
  const landed = await sha(dir);
  const res = await merge(journal, dir, { branch: 'feature', message: 'unused' });
  assert.equal(res.commit, null);
  assert.equal(await sha(dir), landed);
  assert.ok(!(await branchExists(dir, 'feature')));
});

test('mergeLane refuses an empty commit message before changing anything', async () => {
  const { dir, journal } = await repo();
  const wt = await lane(dir);
  await assert.rejects(merge(journal, dir, { branch: 'feature', message: '  ' }), /commit message is empty/);
  assert.ok(fs.existsSync(wt));
  assert.equal(journal.undo.length, 0);
});

test('merge and tidy on the checked-out branch merges it and keeps the branch (AK-581) → undo', async () => {
  const { dir, journal } = await repo();
  await git.run(dir, ['checkout', '-q', '-b', 'feature']);
  await commit(dir, 'd.txt', 'd\n', 'add d');
  const base = await sha(dir, 'main');
  const plan = await git.mergeLanePlan(dir, 'feature');
  assert.equal(plan.keep, 'current');
  assert.equal(plan.commits.length, 1);
  const res = await merge(journal, dir, { branch: 'feature', message: 'Land d' });
  assert.equal(res.kept, 'current');
  assert.equal(await sha(dir, 'main'), res.commit);
  assert.ok(await branchExists(dir, 'feature'));
  assert.equal((await git.run(dir, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'feature');
  await journal.step('undo');
  assert.equal(await sha(dir, 'main'), base);
});

test('mergeLanePlan names the other worktree that has the base checked out', async () => {
  const { dir } = await repo();
  await git.run(dir, ['checkout', '-q', '-b', 'side']);
  await git.run(dir, ['branch', 'feature']);
  const wt = await git.addWorktree(dir, { branch: 'feature' });
  await commit(wt, 'b.txt', 'b\n', 'add b');
  await git.run(dir, ['checkout', '-q', 'main']);
  const plan = await git.mergeLanePlan(wt, 'feature');
  assert.equal(plan.keep, 'current');
  await git.run(dir, ['checkout', '-q', 'side']);
  const other = await git.addWorktree(dir, { branch: 'main' });
  const p2 = await git.mergeLanePlan(wt, 'feature');
  assert.equal(p2.baseWorktree?.path, other);
  assert.match(p2.mergeBlocker, /main is checked out in/);
});
