'use strict';
// Push, pull and cherry-pick failures with a known cause get a fix offered instead of git's output.
// Throwaway repos and a bare remote in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const { checkGit } = require('../ipc');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
const cfg = [['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']];

async function commit(dir, f, c, m) {
  fs.writeFileSync(path.join(dir, f), c);
  await git.run(dir, ['add', f]);
  await git.run(dir, ['commit', '-q', '-m', m]);
}

// `dir` tracks origin/main; someone else pushed `theirs` to origin, and `dir` committed `ours`.
async function diverged() {
  const root = tmp();
  const remote = path.join(root, 'origin.git'), dir = path.join(root, 'repo'), other = path.join(root, 'other');
  await git.run(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git.run(root, ['clone', '-q', remote, dir]);
  for (const a of cfg) await git.run(dir, a);
  await commit(dir, 'a.txt', 'base\n', 'base');
  await git.run(dir, ['push', '-q', '-u', 'origin', 'main']);
  await git.run(root, ['clone', '-q', remote, other]);
  for (const a of cfg) await git.run(other, a);
  await commit(other, 'b.txt', 'theirs\n', 'theirs');
  await git.run(other, ['push', '-q']);
  await git.run(dir, ['fetch', '-q']);
  await commit(dir, 'c.txt', 'ours\n', 'ours');
  return { dir, remote, journal: new Journal(await git.openRepo(dir)) };
}

const rev = (dir, r) => git.run(dir, ['rev-parse', r]).then((s) => s.trim());
const pullConfigured = async (dir) => (await git.run(dir, ['config', '--get', 'pull.rebase'], { allowCodes: [0, 1] })).trim() !== '';

test('a rejected push is told apart; pull and push with rebase lands both, as one undo step', async () => {
  const { dir, journal } = await diverged();
  const err = await git.run(dir, ['push']).catch((e) => git.remoteFailure(e));
  assert.equal(err.code, 'rejected');
  const ours = await rev(dir, 'HEAD');
  await journal.record('Pull and push main', 'pullAndPush', async () => { await git.pull(dir, 'rebase'); await git.run(dir, ['push', '-q']); });
  assert.equal(await rev(dir, 'HEAD'), await rev(dir, 'origin/main'));
  assert.equal((await git.run(dir, ['log', '--format=%s', '-3'])).trim(), 'ours\ntheirs\nbase');
  await journal.step('undo', {});
  assert.equal(await rev(dir, 'HEAD'), ours);
});

test('pull on diverged branches with no strategy is told apart; merge settles it', async (t) => {
  const { dir } = await diverged();
  if (await pullConfigured(dir)) return t.skip('pull.rebase is set in this git config');
  const err = await git.pull(dir).catch((e) => git.remoteFailure(e));
  assert.equal(err.code, 'diverged');
  await git.pull(dir, 'merge');
  assert.equal((await git.run(dir, ['rev-list', '--count', '--merges', 'HEAD'])).trim(), '1');
});

test('auth failures keep only git\'s line about it; unknown failures keep git\'s output', () => {
  const auth = git.remoteFailure(new git.GitError('x', { stderr: "Cloning…\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }));
  assert.equal(auth.code, 'auth');
  assert.equal(auth.message, "could not read Username for 'https://github.com': terminal prompts disabled");
  const other = git.remoteFailure(new git.GitError('fatal: something else', { code: 128, stderr: 'fatal: something else' }));
  assert.equal(other.code, 128);
  assert.equal(other.message, 'fatal: something else');
});

test('an empty cherry-pick leaves nothing in progress; commit anyway keeps it', async () => {
  const dir = tmp();
  await git.run(dir, ['init', '-q', '-b', 'main']);
  for (const a of cfg) await git.run(dir, a);
  await commit(dir, 'a.txt', 'base\n', 'base');
  await git.run(dir, ['switch', '-q', '-c', 'picked']);
  await commit(dir, 'p.txt', 'same\n', 'same change');
  const sha = await rev(dir, 'HEAD');
  await git.run(dir, ['switch', '-q', 'main']);
  await git.run(dir, ['cherry-pick', sha]);
  const head = await rev(dir, 'HEAD');
  await assert.rejects(git.cherryPick(dir, sha), (e) => e.code === 'empty-pick');
  assert.equal(await git.getOperationState(path.join(dir, '.git')), null);
  assert.equal(await rev(dir, 'HEAD'), head);
  await git.cherryPick(dir, sha, true);
  assert.equal(await rev(dir, 'HEAD~1'), head);
});

test('ipc: pull modes and keep-empty cherry-picks are checked', () => {
  assert.deepEqual(checkGit('pull', ['rebase']).args, ['rebase']);
  assert.deepEqual(checkGit('pullAndPush', ['merge']).args, ['merge']);
  assert.throws(() => checkGit('pull', ['ff']));
  assert.deepEqual(checkGit('cherryPick', ['abc1234', true]).args, ['abc1234', true]);
  assert.throws(() => checkGit('cherryPick', ['abc1234', 'yes']));
  assert.deepEqual(checkGit('stashAnd', ['pullAndPush', ['rebase']]).args, ['pullAndPush', ['rebase']]);
});
