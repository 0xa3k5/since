'use strict';
// Check out a branch held by another worktree: detach it there and check it out here, as one undo
// step (Journal.freeCheckout). Throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const { checkGit } = require('../ipc');

async function repo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  const dir = path.join(tmp, 'repo'), wt = path.join(tmp, 'wt-feature');
  fs.mkdirSync(dir);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, a);
  fs.writeFileSync(path.join(dir, 'app.js'), 'base\n');
  await git.run(dir, ['add', 'app.js']);
  await git.run(dir, ['commit', '-q', '-m', 'base']);
  await git.run(dir, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  const on = async (d) => (await git.run(d, ['branch', '--show-current'])).trim();
  return { dir, wt, journal: new Journal(await git.openRepo(dir)), here: () => on(dir), there: () => on(wt) };
}

test('free and check out: one step; undo re-attaches the branch there and switches back here; redo repeats it', async () => {
  const { journal, wt, here, there } = await repo();
  await journal.freeCheckout('Checkout feature', 'feature', wt);
  assert.equal(await here(), 'feature');
  assert.equal(await there(), '', 'detached in the other worktree');
  assert.equal(journal.undo.length, 1, 'one journal step');

  assert.equal(await journal.step('undo'), 'Checkout feature');
  assert.equal(await here(), 'main');
  assert.equal(await there(), 'feature');

  assert.equal(await journal.step('redo'), 'Checkout feature');
  assert.equal(await here(), 'feature');
  assert.equal(await there(), '');
});

test('free and check out: refused when the other worktree has uncommitted changes', async () => {
  const { journal, wt, here, there } = await repo();
  fs.writeFileSync(path.join(wt, 'app.js'), 'dirty\n');
  assert.equal(await git.freeBlocker((await git.getWorktrees(wt)).find((w) => w.branch === 'feature')), 'It has 1 uncommitted change.');
  await assert.rejects(journal.freeCheckout('Checkout feature', 'feature', wt), /uncommitted change/);
  assert.equal(await here(), 'main');
  assert.equal(await there(), 'feature');
  assert.equal(journal.undo.length, 0, 'nothing recorded');
});

test('free and check out: a failed checkout here re-attaches the branch there', async () => {
  const { journal, wt, here, there } = await repo();
  await assert.rejects(journal.freeCheckout('Checkout feature', 'feature', wt, ['checkout', 'no-such-branch']));
  assert.equal(await here(), 'main');
  assert.equal(await there(), 'feature');
  assert.equal(journal.undo.length, 0);
});

test('free and check out: undo refused once the other worktree has switched branch', async () => {
  const { journal, wt, there } = await repo();
  await journal.freeCheckout('Checkout feature', 'feature', wt);
  await git.run(wt, ['checkout', '-q', 'main']);
  await assert.rejects(journal.step('undo'), /switched branch since/);
  assert.equal(await there(), 'main');
});

test('ipc: freeCheckout takes a branch and a worktree folder', () => {
  assert.equal(checkGit('freeCheckout', ['feature', '/tmp/wt']).worktreeArgs[0], 1);
  assert.throws(() => checkGit('freeCheckout', ['feature', 'relative']));
  assert.equal(checkGit('freeBlocker', ['/tmp/wt']).worktreeArgs[0], 0);
});

// Moving a dirty worktree's branch and changes here (Journal.moveCheckout).
const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
const stashCount = async (d) => (await git.getStashes(d)).length;

test('move changes and check out: one step; undo puts branch and changes back there; redo moves them again', async () => {
  const { journal, dir, wt, here, there } = await repo();
  fs.writeFileSync(path.join(wt, 'app.js'), 'theirs\n');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'untracked\n');
  assert.deepEqual(await journal.moveCheckout('Checkout feature', 'feature', wt), { conflicts: false });
  assert.equal(await here(), 'feature');
  assert.equal(await there(), '', 'detached there');
  assert.equal(read(dir, 'app.js'), 'theirs\n');
  assert.equal(read(dir, 'new.txt'), 'untracked\n');
  assert.equal(await git.worktreeChanges(wt), 0, 'nothing left there');
  assert.equal(await stashCount(dir), 0, 'their stash was popped');
  assert.equal(journal.undo.length, 1);

  assert.equal(await journal.step('undo'), 'Checkout feature');
  assert.equal(await here(), 'main');
  assert.equal(await there(), 'feature');
  assert.equal(read(wt, 'app.js'), 'theirs\n');
  assert.equal(read(wt, 'new.txt'), 'untracked\n');
  assert.equal(await git.worktreeChanges(dir), 0);
  assert.equal(await stashCount(dir), 0);

  await journal.step('redo');
  assert.equal(await here(), 'feature');
  assert.equal(read(dir, 'app.js'), 'theirs\n');
  assert.equal(await git.worktreeChanges(wt), 0);
});

test('move changes and check out: both dirty, mine stashed; undo restores both sides', async () => {
  const { journal, dir, wt, here, there } = await repo();
  fs.writeFileSync(path.join(wt, 'app.js'), 'theirs\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'mine\n');
  await journal.moveCheckout('Checkout feature', 'feature', wt, { message: 'mine', untracked: true });
  assert.equal(await here(), 'feature');
  assert.equal(read(dir, 'app.js'), 'theirs\n');
  assert.equal(await stashCount(dir), 1, 'my changes kept as a stash');

  await journal.step('undo');
  assert.equal(await here(), 'main');
  assert.equal(await there(), 'feature');
  assert.equal(read(dir, 'app.js'), 'mine\n');
  assert.equal(read(wt, 'app.js'), 'theirs\n');
  assert.equal(await stashCount(dir), 0);
});

test('move changes and check out: changes that overlap mine stop it, and both sides stay as they were', async () => {
  const { journal, dir, wt, here, there } = await repo();
  fs.writeFileSync(path.join(wt, 'app.js'), 'theirs\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'mine\n');
  // Not stashing mine: git carries it across the checkout, then won't pop their changes over it.
  await assert.rejects(journal.moveCheckout('Checkout feature', 'feature', wt), /overlap the changes here/);
  assert.equal(await here(), 'main');
  assert.equal(await there(), 'feature');
  assert.equal(read(dir, 'app.js'), 'mine\n');
  assert.equal(read(wt, 'app.js'), 'theirs\n');
  assert.equal(await stashCount(dir), 0);
  assert.equal(journal.undo.length, 0);
});

test('move changes and check out: refused with an operation in progress there; nothing changes', async () => {
  const { journal, dir, wt, here, there } = await repo();
  fs.writeFileSync(path.join(wt, 'app.js'), 'theirs\n');
  const gitDir = (await git.run(wt, ['rev-parse', '--absolute-git-dir'])).trim();
  fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), (await git.run(dir, ['rev-parse', 'HEAD'])).trim() + '\n');
  const hold = await git.worktreeHold((await git.getWorktrees(dir)).find((w) => w.branch === 'feature'));
  assert.match(hold.blocker, /in progress/);
  await assert.rejects(journal.moveCheckout('Checkout feature', 'feature', wt), /in progress/);
  assert.equal(await here(), 'main');
  assert.equal(await there(), 'feature');
  assert.equal(read(wt, 'app.js'), 'theirs\n');
  assert.equal(journal.undo.length, 0);
});

test('worktreeHold: counts the changes and when the newest was written', async () => {
  const { dir, wt } = await repo();
  fs.writeFileSync(path.join(wt, 'app.js'), 'theirs\n');
  const hold = await git.worktreeHold((await git.getWorktrees(dir)).find((w) => w.branch === 'feature'));
  assert.equal(hold.blocker, null);
  assert.equal(hold.changes, 1);
  assert.ok(Date.now() - hold.changedAt < 60e3);
});

test('ipc: moveCheckout takes a branch, a worktree folder and an optional stash', () => {
  assert.equal(checkGit('moveCheckout', ['feature', '/tmp/wt']).worktreeArgs[0], 1);
  assert.ok(checkGit('moveCheckout', ['feature', '/tmp/wt', { message: 'm', untracked: true }]));
  assert.throws(() => checkGit('moveCheckout', ['feature', '/tmp/wt', { message: 'm', extra: 1 }]));
  assert.equal(checkGit('worktreeHold', ['/tmp/wt']).worktreeArgs[0], 0);
});

test('in-use sheet: dirty, clean, open in another window', async () => {
  const { inUsePlan } = await import('../renderer/checkout-plan.js');
  const wt = { name: 'wt-dirty', path: '/Users/ak/code/wt-dirty' };
  const now = 1e9;
  const dirty = inUsePlan(wt, { blocker: null, changes: 3, changedAt: now - 2 * 60e3 }, 2, now);
  assert.deepEqual(dirty, { kind: 'dirty', where: '~/…/wt-dirty', changes: '3 uncommitted changes', changed: 'Last changed 2 min ago', stash: 'Stash my 2 changes', actions: ['move', 'open'] });
  assert.equal(inUsePlan(wt, { blocker: null, changes: 1, changedAt: now - 11 * 60e3 }, 0, now).changed, null);
  assert.equal(inUsePlan(wt, { blocker: null, changes: 1, changedAt: now }, 0, now).stash, null);
  assert.deepEqual(inUsePlan(wt, { blocker: null, changes: 0 }), { kind: 'clean', where: '~/…/wt-dirty', actions: ['free', 'open'] });
  assert.deepEqual(inUsePlan(wt, { blocker: 'It’s open in another window.' }), { kind: 'blocked', where: '~/…/wt-dirty', why: 'It’s open in another window.', actions: ['open'] });
});
