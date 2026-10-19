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
