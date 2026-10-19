'use strict';
// Opening a folder that isn't a repository: the error is told apart, and the repositories directly
// inside it (plus their worktrees) are found. Throwaway folders in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));

async function repo(dir) {
  await git.run(path.dirname(dir), ['init', '-q', '-b', 'main', dir]);
  await git.run(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base']);
}

test('openRepo marks a folder that is not a repository', async () => {
  const dir = tmp();
  await assert.rejects(git.openRepo(dir), (err) => err.code === 'not-repo');
});

test('findRepos lists repositories one level down, main worktrees first', async () => {
  const root = tmp();
  await repo(path.join(root, 'b-app'));
  await repo(path.join(root, 'a-lib'));
  fs.mkdirSync(path.join(root, 'plain'));
  fs.mkdirSync(path.join(root, 'deep', 'x'), { recursive: true });
  await repo(path.join(root, 'deep', 'x', 'nested'));
  await git.run(path.join(root, 'b-app'), ['worktree', 'add', '-q', '-b', 'feat', path.join(root, 'b-app-feat')]);
  const outside = path.join(tmp(), 'far');
  await git.run(path.join(root, 'a-lib'), ['worktree', 'add', '-q', '-b', 'side', outside]);
  const found = await git.findRepos(root);
  const names = found.map((r) => r.name);
  assert.deepEqual(names.slice(0, 2).sort(), ['a-lib', 'b-app']);
  assert.deepEqual(names.slice(2).sort(), ['b-app-feat', 'far']);
  assert.equal(found.length, 4, 'no duplicates, nothing nested deeper');
  assert.equal(new Set(found.map((r) => r.commonDir)).size, 2);
});

test('findRepos finds nothing in an empty or missing folder', async () => {
  const root = tmp();
  assert.deepEqual(await git.findRepos(root), []);
  assert.deepEqual(await git.findRepos(path.join(root, 'gone')), []);
});
