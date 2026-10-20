'use strict';
// A rebase, merge or cherry-pick stopped in the way: abort it and carry on, as one undo step.
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

async function repo() {
  const dir = tmp();
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, a);
  const write = (f, c, at = dir) => fs.writeFileSync(path.join(at, f), c);
  const commit = async (f, c, m, at = dir) => { write(f, c, at); await git.run(at, ['add', f]); await git.run(at, ['commit', '-q', '-m', m]); };
  await commit('app.js', 'base\n', 'base');
  return {
    dir, write, commit,
    journal: new Journal(await git.openRepo(dir)),
    tip: async (b) => (await git.run(dir, ['rev-parse', `refs/heads/${b}`])).trim(),
    has: async (b) => (await git.run(dir, ['rev-parse', '-q', '--verify', `refs/heads/${b}`], { allowCodes: [0, 1] })).trim() !== '',
  };
}

// Worktree on `feature`, stopped on a conflict while rebasing onto main.
async function rebasingWorktree(r) {
  const wt = path.join(r.dir, '..', `${path.basename(r.dir)}-wt`);
  await git.run(r.dir, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  await r.commit('app.js', 'feature\n', 'feature', wt);
  await r.commit('app.js', 'main\n', 'main');
  await assert.rejects(git.run(wt, ['rebase', 'main']));
  assert.equal(await git.worktreeOp(wt), 'rebase');
  return fs.realpathSync(wt);
}

test('remove a worktree mid-rebase: refused with the op, then abort and remove is one step; undo re-adds it on its branch', async () => {
  const r = await repo();
  const wt = await rebasingWorktree(r);
  const featureTip = await r.tip('feature');
  await assert.rejects(r.journal.runWorktree('removeWorktree', 'Remove', [wt]), (e) => e.code === 'op-in-progress' && e.op === 'rebase');

  await r.journal.runWorktree('removeWorktree', 'Remove', [wt, { abort: true, changes: 'stash' }]);
  assert.equal(fs.existsSync(wt), false);
  assert.equal((await git.getStashes(r.dir)).length, 0, 'nothing was left to stash after the abort');
  assert.equal(r.journal.undo.length, 1, 'one journal step');

  await r.journal.step('undo');
  const back = (await git.getWorktrees(r.dir)).find((w) => w.path === wt);
  assert.equal(back?.branch, 'feature', 'back on its branch, not the detached rebase HEAD');
  assert.equal(await r.tip('feature'), featureTip);
  assert.equal(await git.worktreeOp(wt), null);
});

test('clean up a worktree mid-rebase: the failure names the op, then abort removes it and deletes the branch; undo brings both back', async () => {
  const r = await repo();
  const wt = await rebasingWorktree(r);
  const featureTip = await r.tip('feature');
  const res = await r.journal.runCleanup('Clean up', [{ branch: 'feature', worktree: wt }]);
  assert.equal(res.failed[0]?.op, 'rebase');
  assert.ok(fs.existsSync(wt) && await r.has('feature'), 'nothing removed');

  const done = await r.journal.runCleanup('Clean up', [{ branch: 'feature', worktree: wt, abort: true }]);
  assert.deepEqual(done.failed, []);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(await r.has('feature'), false);

  await r.journal.step('undo');
  assert.equal(await r.tip('feature'), featureTip);
  assert.equal((await git.getWorktrees(r.dir)).find((w) => w.path === wt)?.branch, 'feature');
});

test('merge and tidy a lane whose worktree is mid-rebase: blockerOp, then abort merges, removes and deletes as one step', async () => {
  const r = await repo();
  const wt = await rebasingWorktree(r);
  const mainTip = await r.tip('main');
  const plan = await git.mergeLanePlan(r.dir, 'feature', 'main');
  assert.equal(plan.blockerOp, 'rebase');
  assert.equal((await git.mergeLanePlan(r.dir, 'feature', 'main', { abort: true })).blocker, null);

  await r.journal.runLane('Merge and tidy feature', 'mergeLane', (done) => git.mergeLane(r.dir, { branch: 'feature', base: 'main', message: 'Feature', merge: false, abort: true }, done));
  assert.equal(fs.existsSync(wt), false);
  assert.equal(await r.has('feature'), false);
  assert.equal(r.journal.undo.length, 1, 'one journal step');

  await r.journal.step('undo');
  assert.equal(await r.tip('main'), mainTip);
  assert.equal((await git.getWorktrees(r.dir)).find((w) => w.path === wt)?.branch, 'feature');
});

test('abort and merge: a stopped cherry-pick is aborted and the merge recorded as one step', async () => {
  const r = await repo();
  await git.run(r.dir, ['checkout', '-q', '-b', 'side']);
  await r.commit('app.js', 'side\n', 'side');
  await git.run(r.dir, ['checkout', '-q', '-b', 'feature', 'main']);
  await r.commit('notes.md', 'notes\n', 'notes');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  await r.commit('app.js', 'main\n', 'main');
  const mainTip = await r.tip('main');
  await assert.rejects(git.run(r.dir, ['cherry-pick', 'side']));
  assert.equal(await git.getOperationState(r.journal.gitDir), 'cherry-pick');
  await assert.rejects(git.run(r.dir, ['merge', '--no-edit', 'feature']));

  await r.journal.abortAnd('Merge feature', 'merge', () => git.run(r.dir, ['merge', '--no-edit', 'feature']));
  assert.equal(await git.getOperationState(r.journal.gitDir), null);
  assert.notEqual(await r.tip('main'), mainTip);
  assert.equal(r.journal.undo.length, 1, 'one journal step');

  await r.journal.step('undo');
  assert.equal(await r.tip('main'), mainTip);
  assert.equal(fs.readFileSync(path.join(r.dir, 'app.js'), 'utf8'), 'main\n', 'the aborted cherry-pick stays aborted');
});

test('ipc: abortAnd only wraps ref mutations, checked with their own schema; abort flags on lanes and worktrees', () => {
  assert.deepEqual(checkGit('abortAnd', ['merge', ['feature']]).args, ['merge', ['feature']]);
  assert.throws(() => checkGit('abortAnd', ['deleteBranch', ['feature']]));
  assert.throws(() => checkGit('abortAnd', ['merge', ['--upload-pack=x']]));
  assert.doesNotThrow(() => checkGit('mergeLane', ['feature', 'main', 'msg', { abort: true }]));
  assert.doesNotThrow(() => checkGit('tidyLane', ['feature', { abort: true }]));
  assert.doesNotThrow(() => checkGit('mergeLanePlan', ['feature', null, { abort: true }]));
  assert.throws(() => checkGit('tidyLane', ['feature', { abort: 'yes' }]));
});

test('abort with files left in the worktree: tidy and clean up stash them instead of failing after the abort', async () => {
  for (const how of ['tidy', 'cleanup']) {
    const r = await repo();
    const wt = await rebasingWorktree(r);
    r.write('scratch.txt', 'notes\n', wt);
    if (how === 'tidy') await r.journal.runLane('Tidy feature', 'tidyLane', (done) => git.mergeLane(r.dir, { branch: 'feature', merge: false, abort: true }, done));
    else assert.deepEqual((await r.journal.runCleanup('Clean up', [{ branch: 'feature', worktree: wt, abort: true }])).failed, []);
    assert.equal(fs.existsSync(wt), false, how);
    assert.equal((await git.getStashes(r.dir)).length, 1, `${how}: the leftover file is in the stash list`);
  }
});

test('opInfo and opSentence (AK-584): name what is stopped', async () => {
  const { opSentence } = await import('../renderer/resolve-text.js');
  const r = await repo();
  await git.run(r.dir, ['checkout', '-q', '-b', 'feature/conflict']);
  await r.commit('app.js', 'feature\n', 'Add footer');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  await r.commit('app.js', 'main\n', 'main');
  const gitDir = path.join(r.dir, '.git');
  await assert.rejects(git.run(r.dir, ['merge', 'feature/conflict']));
  assert.equal(opSentence(await git.getOperationInfo(r.dir, gitDir), 1), 'Merging feature/conflict into main is stopped on 1 conflict.');
  await git.run(r.dir, ['merge', '--abort']);
  const sha = await r.tip('feature/conflict');
  await assert.rejects(git.run(r.dir, ['cherry-pick', sha]));
  assert.equal(opSentence(await git.getOperationInfo(r.dir, gitDir), 1), `Cherry-picking ${sha.slice(0, 7)} Add footer is stopped on 1 conflict.`);
  await git.run(r.dir, ['cherry-pick', '--abort']);
  await git.run(r.dir, ['checkout', '-q', 'feature/conflict']);
  await assert.rejects(git.run(r.dir, ['rebase', 'main']));
  assert.equal(opSentence(await git.getOperationInfo(r.dir, gitDir), 1), 'Rebasing feature/conflict onto main is stopped at 1 of 1: Add footer.');
  await git.run(r.dir, ['rebase', '--abort']);
  assert.equal(await git.getOperationInfo(r.dir, gitDir), null);
});

test('abortAnd saves only the resolved files, pinned; restoreResolved puts them back', async () => {
  const r = await repo();
  await r.commit('b.js', 'base\n', 'b');
  await git.run(r.dir, ['checkout', '-q', '-b', 'feature']);
  r.write('app.js', 'feature\n'); await git.run(r.dir, ['add', 'app.js']); await r.commit('b.js', 'feature\n', 'feature');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  r.write('app.js', 'main\n'); await git.run(r.dir, ['add', 'app.js']); await r.commit('b.js', 'main\n', 'main');
  const conflict = () => assert.rejects(git.run(r.dir, ['merge', '--no-edit', 'feature']));
  await conflict();
  r.write('app.js', 'resolved\n');
  await git.run(r.dir, ['add', 'app.js']);

  const { op, saved } = await r.journal.abortAnd('Branch x', 'createBranch', () => git.run(r.dir, ['branch', 'x']));
  assert.equal(op, 'merge');
  assert.deepEqual(saved.paths, ['app.js'], 'the still-conflicted file is not saved');
  assert.deepEqual(await git.resolvedPaths(r.dir, saved.sha), ['app.js']);
  assert.equal(r.journal.undo.top.resolved.sha, saved.sha, 'pinned with the step');
  assert.equal(await git.getOperationState(r.journal.gitDir), null);
  assert.equal(fs.readFileSync(path.join(r.dir, 'app.js'), 'utf8'), 'main\n');

  // Merge restarted on the same conflicts: the resolution is written and staged.
  await conflict();
  await r.journal.restoreResolved('Restore resolved files', saved.sha);
  assert.equal(fs.readFileSync(path.join(r.dir, 'app.js'), 'utf8'), 'resolved\n');
  const unmerged = await git.run(r.dir, ['ls-files', '-u']);
  assert.ok(!unmerged.includes('app.js') && unmerged.includes('b.js'));
  await git.run(r.dir, ['merge', '--abort']);

  // No operation stopped: applied to the work tree as a stash.
  await r.journal.restoreResolved('Restore resolved files', saved.sha);
  assert.equal(fs.readFileSync(path.join(r.dir, 'app.js'), 'utf8'), 'resolved\n');
  assert.equal((await git.run(r.dir, ['diff', '--cached', '--name-only'])).trim(), 'app.js');
  await r.journal.step('undo');
  assert.equal(fs.readFileSync(path.join(r.dir, 'app.js'), 'utf8'), 'main\n', 'restoring is undoable');
});

test('aborting a stopped rebase is not a step: the next undo takes the step before it, on the branch', async () => {
  const r = await repo();
  await git.run(r.dir, ['checkout', '-q', '-b', 'feature']);
  await r.commit('app.js', 'feature\n', 'feature');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  await r.commit('app.js', 'main\n', 'main');
  await git.run(r.dir, ['checkout', '-q', 'feature']);
  await r.journal.record('Branch kept', 'createBranch', () => git.run(r.dir, ['branch', 'kept']));
  await assert.rejects(r.journal.record('Rebase feature', 'rebase', () => git.run(r.dir, ['rebase', 'main'])));
  assert.equal(r.journal.undo.length, 2);
  const abort = async () => { const op = await git.getOperationState(r.journal.gitDir); await git.run(r.dir, [op, '--abort']); return { op }; };
  assert.deepEqual(await r.journal.abortOp(abort), { op: 'rebase' });
  assert.equal(r.journal.undo.length, 1, 'the stopped rebase is dropped, the abort adds nothing');
  await r.journal.step('undo');
  assert.equal(await r.has('kept'), false, 'undo took the step before the rebase');
  assert.equal((await git.run(r.dir, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'feature');
});

test('resolved to HEAD’s version only: nothing to save, and it says so', async () => {
  const r = await repo();
  await git.run(r.dir, ['checkout', '-q', '-b', 'feature']);
  await r.commit('app.js', 'feature\n', 'feature');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  await r.commit('app.js', 'main\n', 'main');
  await assert.rejects(git.run(r.dir, ['merge', '--no-edit', 'feature']));
  await git.run(r.dir, ['checkout', '--ours', '--', 'app.js']);
  await git.run(r.dir, ['add', 'app.js']);
  assert.deepEqual(await git.saveResolved(r.dir, r.journal.gitDir), { sha: null, paths: [], unchanged: 1 });
  const { saved } = await r.journal.abortAnd('Branch x', 'createBranch', () => git.run(r.dir, ['branch', 'x']));
  assert.equal(saved.sha, null);
  assert.equal(r.journal.undo.top.resolved, undefined);

test('merge and tidy that aborts a merge stopped here saves the resolved files, pinned (AK-601)', async () => {
  const r = await repo();
  await r.commit('b.js', 'base\n', 'b');
  const wt = path.join(r.dir, '..', `${path.basename(r.dir)}-lane`);
  await git.run(r.dir, ['worktree', 'add', '-q', '-b', 'lane', wt]);
  await r.commit('c.js', 'lane\n', 'lane', wt);
  await git.run(r.dir, ['checkout', '-q', '-b', 'feature']);
  r.write('app.js', 'feature\n'); await git.run(r.dir, ['add', 'app.js']); await r.commit('b.js', 'feature\n', 'feature');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  r.write('app.js', 'main\n'); await git.run(r.dir, ['add', 'app.js']); await r.commit('b.js', 'main\n', 'main');
  await assert.rejects(git.run(r.dir, ['merge', '--no-edit', 'feature']));
  r.write('app.js', 'resolved\n');
  await git.run(r.dir, ['add', 'app.js']);

  const res = await r.journal.runLane('Merge and tidy lane', 'mergeLane', (done) => git.mergeLane(r.dir, { branch: 'lane', base: 'main', message: 'Lane', abort: true }, done));
  assert.equal(res.op, 'merge');
  assert.deepEqual(res.saved.paths, ['app.js']);
  assert.equal(r.journal.undo.top.resolved.sha, res.saved.sha, 'pinned with the step');
  assert.equal(await git.getOperationState(r.journal.gitDir), null);
  assert.equal(fs.readFileSync(path.join(r.dir, 'c.js'), 'utf8'), 'lane\n');
});
