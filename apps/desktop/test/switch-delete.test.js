'use strict';
// Switch and delete the checked-out branch as one undo step (Journal.switchDelete). Throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const { checkGit } = require('../ipc');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, a);
  const write = (f, c) => fs.writeFileSync(path.join(dir, f), c);
  const commit = async (f, c, m) => { write(f, c); await git.run(dir, ['add', f]); await git.run(dir, ['commit', '-q', '-m', m]); };
  await commit('app.js', 'base\n', 'base');
  await git.run(dir, ['checkout', '-q', '-b', 'feature']);
  await commit('app.js', 'feature\n', 'feature');
  // An upstream, so undo and redo have to carry the `[branch "feature"]` section too.
  await git.run(dir, ['config', 'branch.feature.remote', 'origin']);
  await git.run(dir, ['config', 'branch.feature.merge', 'refs/heads/feature']);
  return {
    dir, write, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
    journal: new Journal(await git.openRepo(dir)),
    head: async () => (await git.run(dir, ['branch', '--show-current'])).trim(),
    tip: async (b) => (await git.run(dir, ['rev-parse', '-q', '--verify', `refs/heads/${b}`], { allowCodes: [0, 1] })).trim(),
    cfg: async () => (await git.run(dir, ['config', '--get-regexp', '^branch\\.feature\\.'], { allowCodes: [0, 1] })).trim(),
    stashes: async () => (await git.getStashes(dir)).length,
  };
}

test('switch and delete: one step, undo brings the branch, its upstream and the checkout back, redo repeats it', async () => {
  const { journal, head, tip, cfg } = await repo();
  const featureTip = await tip('feature'), mainTip = await tip('main');
  const config = await cfg();
  assert.ok(config.includes('branch.feature.remote origin'));
  await journal.switchDelete('Delete branch feature', 'main');
  assert.equal(await head(), 'main');
  assert.equal(await tip('feature'), '');
  assert.equal(await cfg(), '');
  assert.equal(journal.undo.length, 1, 'one journal step');

  assert.equal(await journal.step('undo'), 'Delete branch feature');
  assert.equal(await head(), 'feature');
  assert.equal(await tip('feature'), featureTip);
  assert.equal(await tip('main'), mainTip);
  assert.equal(await cfg(), config);

  await journal.step('redo');
  assert.equal(await head(), 'main');
  assert.equal(await tip('feature'), '');
  assert.equal(await cfg(), '');
  assert.equal(await tip('main'), mainTip);
});

test('switch and delete with the stash box: changes are stashed, undo pops them back on the branch', async () => {
  const { journal, write, read, head, tip, stashes } = await repo();
  write('app.js', 'mine\n');
  const a = await journal.switchDelete('Delete branch feature', 'main', { message: 'On feature', untracked: false });
  assert.ok(a.sha);
  assert.equal(a.branch, null, 'no "offer it back" on a branch that is gone');
  assert.equal(await head(), 'main');
  assert.equal(await tip('feature'), '');
  assert.equal(read('app.js'), 'base\n');
  assert.equal(await stashes(), 1);

  await journal.step('undo');
  assert.equal(await head(), 'feature');
  assert.equal(read('app.js'), 'mine\n');
  assert.equal(await stashes(), 0);

  await journal.step('redo');
  assert.equal(await head(), 'main');
  assert.equal(await tip('feature'), '');
  assert.equal(read('app.js'), 'base\n');
  assert.equal(await stashes(), 1);
});

test('switch and delete refuses a dirty switch without the stash box and records nothing', async () => {
  const { journal, write, read, head, tip } = await repo();
  write('app.js', 'mine\n');
  await assert.rejects(journal.switchDelete('Delete branch feature', 'main'));
  assert.equal(await head(), 'feature');
  assert.ok(await tip('feature'));
  assert.equal(read('app.js'), 'mine\n');
  assert.equal(journal.undo.length, 0);
});

test('switch and delete: undo refuses once branches moved since', async () => {
  const { dir, journal, head } = await repo();
  await journal.switchDelete('Delete branch feature', 'main');
  await git.run(dir, ['commit', '-q', '--allow-empty', '-m', 'later']);
  await assert.rejects(journal.step('undo'), /moved since|changed since/);
  assert.equal(await head(), 'main');
});

test('switch and delete: target must differ from the branch being deleted', async () => {
  const { journal } = await repo();
  await assert.rejects(journal.switchDelete('x', 'feature'), /Pick another branch/);
});

test('ipc: switchDelete arguments are checked', () => {
  assert.doesNotThrow(() => checkGit('switchDelete', ['main']));
  assert.doesNotThrow(() => checkGit('switchDelete', ['main', { message: 'm', untracked: true }]));
  assert.throws(() => checkGit('switchDelete', ['-x']));
  assert.throws(() => checkGit('switchDelete', ['main', { message: 'm', cmd: 'x' }]));
});
