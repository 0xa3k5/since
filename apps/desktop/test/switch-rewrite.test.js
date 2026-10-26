'use strict';
// Rewrite a commit on another branch (Journal.switchRewrite, AK-581): stash, switch and rewrite as
// one undo step. Throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const { checkGit } = require('../ipc');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-test-')));
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, a);
  const write = (f, c) => fs.writeFileSync(path.join(dir, f), c);
  const commit = async (f, c, m) => { write(f, c); await git.run(dir, ['add', f]); await git.run(dir, ['commit', '-q', '-m', m]); return (await git.run(dir, ['rev-parse', 'HEAD'])).trim(); };
  await commit('app.js', 'base\n', 'base');
  await git.run(dir, ['checkout', '-q', '-b', 'feature/api']);
  await commit('api.js', 'one\n', 'api one');
  const two = await commit('api.js', 'two\n', 'api two');
  await git.run(dir, ['checkout', '-q', 'main']);
  await commit('app.js', 'main\n', 'main work');
  return {
    dir, two, write, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
    journal: new Journal(await git.openRepo(dir)),
    head: async () => (await git.run(dir, ['branch', '--show-current'])).trim(),
    tip: async (b) => (await git.run(dir, ['rev-parse', `refs/heads/${b}`])).trim(),
    stashes: async () => (await git.getStashes(dir)).length,
  };
}

test('switch and squash: one undo step brings back the branch, the switch and the stash', async () => {
  const r = await repo();
  const before = { main: await r.tip('main'), api: await r.tip('feature/api') };
  assert.deepEqual(await git.commitBranches(r.dir, r.two), { onHead: false, branches: ['feature/api'] });
  r.write('app.js', 'uncommitted\n');
  const stash = { message: 'Auto-stash on main before switching to feature/api', untracked: false };
  const a = await r.journal.switchRewrite('Squash with parent on feature/api', 'feature/api', { op: 'squash', sha: r.two }, stash);
  assert.equal(a.branch, 'main');
  assert.equal(await r.head(), 'feature/api');
  assert.equal((await git.run(r.dir, ['rev-list', '--count', 'main..feature/api'])).trim(), '1');
  assert.equal(await r.stashes(), 1);

  assert.equal(await r.journal.step('undo'), 'Squash with parent on feature/api');
  assert.equal(await r.head(), 'main');
  assert.deepEqual({ main: await r.tip('main'), api: await r.tip('feature/api') }, before);
  assert.equal(r.read('app.js'), 'uncommitted\n');
  assert.equal(await r.stashes(), 0);

  await r.journal.step('redo');
  assert.equal(await r.head(), 'feature/api');
  assert.equal((await git.run(r.dir, ['rev-list', '--count', 'main..feature/api'])).trim(), '1');
  assert.equal(await r.stashes(), 1);
});

test('switch and rewrite: a failed rewrite leaves nothing changed and nothing to undo', async () => {
  const r = await repo();
  const api = await r.tip('feature/api');
  r.write('app.js', 'uncommitted\n');
  const stash = { message: 'Auto-stash', untracked: false };
  // The root commit has no parent to squash into: refused before anything changes.
  const root = (await git.run(r.dir, ['rev-list', '--max-parents=0', 'main'])).trim();
  await assert.rejects(r.journal.switchRewrite('Squash', 'feature/api', { op: 'squash', sha: root }, stash));
  // Delete a commit the next one depends on: the rebase conflicts, and everything goes back.
  const one = (await git.run(r.dir, ['rev-parse', 'feature/api~1'])).trim();
  await assert.rejects(r.journal.switchRewrite('Delete', 'feature/api', { op: 'drop', sha: one }, stash));
  assert.equal(await r.head(), 'main');
  assert.equal(await r.tip('feature/api'), api);
  assert.equal(r.read('app.js'), 'uncommitted\n');
  assert.equal(await r.stashes(), 0);
  assert.equal(await r.journal.step('undo'), null);
});

test('switchRewrite IPC arguments', () => {
  const sha = 'a'.repeat(40);
  assert.ok(checkGit('switchRewrite', ['feature/api', 'squash', sha, null, { message: 'm', untracked: true }]));
  assert.throws(() => checkGit('switchRewrite', ['feature/api', 'rm -rf', sha]));
  assert.throws(() => checkGit('switchRewrite', ['-x', 'squash', sha]));
});
