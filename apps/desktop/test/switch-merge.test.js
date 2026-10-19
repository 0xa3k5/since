'use strict';
// Merge and tidy the checked-out branch after switching away from it (Journal.switchMerge), as one
// undo step. Throwaway repos in the temp dir.
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
  return {
    dir, write, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
    journal: new Journal(await git.openRepo(dir)),
    head: async () => (await git.run(dir, ['branch', '--show-current'])).trim(),
    tip: async (b) => (await git.run(dir, ['rev-parse', '-q', '--verify', `refs/heads/${b}`], { allowCodes: [0, 1] })).trim(),
    stashes: async () => (await git.getStashes(dir)).length,
  };
}

test('switch and merge: switch to the base, squash the branch onto it and delete it, one undo step', async () => {
  const { journal, head, tip, read } = await repo();
  const featureTip = await tip('feature'), mainTip = await tip('main');
  await journal.switchMerge('Merge and tidy feature', 'main', { branch: 'feature', base: 'main', message: 'Add feature' });
  assert.equal(await head(), 'main');
  assert.equal(await tip('feature'), '');
  assert.notEqual(await tip('main'), mainTip);
  assert.equal(read('app.js'), 'feature\n', 'the work tree follows the merged base');
  assert.equal(journal.undo.length, 1, 'one journal step');

  await journal.step('undo');
  assert.equal(await head(), 'feature');
  assert.equal(await tip('feature'), featureTip);
  assert.equal(await tip('main'), mainTip);

  await journal.step('redo');
  assert.equal(await head(), 'main');
  assert.equal(await tip('feature'), '');
});

test('switch and merge with the stash box: changes are stashed, undo brings them back on the branch', async () => {
  const { journal, write, read, head, tip, stashes } = await repo();
  const mainTip = await tip('main');
  write('notes.txt', 'x\n');
  await git.run(journal.root, ['add', 'notes.txt']);
  await journal.switchMerge('Merge and tidy feature', 'main', { branch: 'feature', base: 'main', message: 'Add feature' }, { message: 'On feature', untracked: false });
  assert.equal(await stashes(), 1);
  assert.equal(await tip('feature'), '');
  await journal.step('undo');
  assert.equal(await head(), 'feature');
  assert.equal(await tip('main'), mainTip);
  assert.equal(read('notes.txt'), 'x\n');
  assert.equal(await stashes(), 0);
});

test('switch and merge: nothing changes when the merge would fail', async () => {
  const { journal, head, tip } = await repo();
  const mainTip = await tip('main');
  await assert.rejects(journal.switchMerge('x', 'main', { branch: 'feature', base: 'main', message: '  ' }), /commit message is empty/);
  await assert.rejects(journal.switchMerge('x', 'main', { branch: 'other', base: 'main', message: 'm' }), /no longer checked out here/);
  assert.equal(await head(), 'feature');
  assert.equal(await tip('main'), mainTip);
  assert.equal(journal.undo.length, 0);
});

test('ipc: switchMerge arguments are checked', () => {
  assert.doesNotThrow(() => checkGit('switchMerge', ['main', 'feature', 'main', 'msg']));
  assert.doesNotThrow(() => checkGit('switchMerge', ['main', 'feature', 'main', 'msg', { message: 'm', untracked: true }]));
  assert.throws(() => checkGit('switchMerge', ['-x', 'feature', 'main', 'msg']));
  assert.throws(() => checkGit('switchMerge', ['main', 'feature', 'main', 'msg', { cmd: 'x' }]));
});
