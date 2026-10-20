'use strict';
// Git version gates (AK-586): a git too old for a feature fails with code 'git-version', and once
// another git is chosen the same action goes through. The "old git" is a wrapper around the real one
// that reports 2.30 and refuses what 2.30 lacks. Throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
const cfg = [['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']];

async function oldGit(version = '2.30.1') {
  const real = (await git.gitInfo()).path;
  const bin = path.join(tmp(), 'git');
  fs.writeFileSync(bin, `#!/bin/sh
case "$1" in
  version|--version) echo "git version ${version}"; exit 0 ;;
  merge-tree) echo "usage: git merge-tree <base-tree> <branch1> <branch2>" >&2; exit 129 ;;
esac
for a in "$@"; do [ "$a" = "--staged" ] && { echo "error: unknown option \\\`staged'" >&2; echo "usage: git stash push" >&2; exit 129; }; done
exec "${real}" "$@"
`, { mode: 0o755 });
  return bin;
}

async function repo() {
  const dir = tmp();
  await git.run(dir, ['init', '-q', '-b', 'main']);
  for (const a of cfg) await git.run(dir, a);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await git.run(dir, ['add', 'a.txt']);
  await git.run(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

test('gitMeets compares major.minor; unparsable is too old', async () => {
  const { gitMeets } = require('../renderer/git-version.js');
  assert.equal(gitMeets('2.37.3', '2.38'), false);
  assert.equal(gitMeets('git version 2.38.0 (Apple Git-150)', '2.38'), true);
  assert.equal(gitMeets('3.0', '2.40'), true);
  assert.equal(gitMeets('nonsense', '2.35'), false);
});

test('gitInfo: path and version of the git in use, or a not-git error', async () => {
  const bin = await oldGit();
  assert.deepEqual(await git.gitInfo(bin), { path: bin, version: '2.30.1' });
  await assert.rejects(git.gitInfo('/bin/echo'), { code: 'not-git' });
  await assert.rejects(git.gitInfo('/nonexistent/git'), { code: 'not-git' });
});

test('stash staged on an old git: git-version, then goes through with another git', async (t) => {
  t.after(() => git.setGitPath(null));
  const dir = await repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  await git.run(dir, ['add', 'a.txt']);
  git.setGitPath(await oldGit());
  await assert.rejects(git.stashPush(dir, { message: 'wip', staged: true }), { code: 'git-version', message: 'Stash staged changes needs git 2.35 or later.' });
  git.setGitPath(null);
  await git.stashPush(dir, { message: 'wip', staged: true });
  assert.match(await git.run(dir, ['stash', 'list']), /wip/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
});

test('merge here on an old git: git-version before trying merge-tree; another git clears it', async (t) => {
  t.after(() => git.setGitPath(null));
  const dir = await repo();
  await git.run(dir, ['switch', '-q', '-c', 'feat']);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  await git.run(dir, ['add', 'b.txt']);
  await git.run(dir, ['commit', '-q', '-m', 'feat']);
  await git.run(dir, ['switch', '-q', 'main']);
  git.setGitPath(await oldGit());
  const plan = await git.mergeLanePlan(dir, 'feat', 'main');
  assert.equal(plan.mergeBlockerCode, 'git-version');
  assert.equal(plan.mergeBlocker, 'Merging here needs git 2.38 or later.');
  assert.equal(await git.canForecast(dir), false);
  git.setGitPath(null);
  assert.equal(await git.canForecast(dir), true);
  const ok = await git.mergeLanePlan(dir, 'feat', 'main');
  assert.equal(ok.mergeBlocker, null);
  // A merge-tree failure on a new enough git is an error, not an old-git gate.
  git.setGitPath(await oldGit('2.45.0'));
  const broken = await git.mergeLanePlan(dir, 'feat', 'main');
  assert.equal(broken.mergeBlockerCode, undefined);
  assert.match(broken.mergeBlocker, /usage: git merge-tree/);
});

test('merge here decision: old git → version toast with the git in use; new git + failure → error', () => {
  const { mergeHereBlock } = require('../renderer/git-version.js');
  assert.equal(mergeHereBlock({ mergeBlocker: null }, '2.34.1'), null);
  assert.deepEqual(mergeHereBlock({ mergeBlocker: 'Merging here needs git 2.38 or later.', mergeBlockerCode: 'git-version' }, '2.34.1'),
    { kind: 'git-version', message: 'Merging here needs git 2.38 or later', detail: 'In use: git 2.34.1' });
  assert.deepEqual(mergeHereBlock({ mergeBlocker: 'fatal: bad object' }, '2.45.0'), { kind: 'error', detail: 'fatal: bad object' });
});

test('merge here checks the git version before handing off, offers the gate with carry-on, and every window hears a new git', () => {
  const fsm = require('node:fs'), pth = require('node:path');
  const app = fsm.readFileSync(pth.join(__dirname, '../renderer/app.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function mergeLane('), app.indexOf('async function mergeLane(') + 6000);
  assert.ok(fn.indexOf("kind === 'git-version'") < fn.indexOf("kind: 'mergeLane'"), 'version first');
  assert.match(fn, /updateGit\('mergeHere', \(\) => mergeLane\(/);
  assert.doesNotMatch(fn, /run: chooseGit/);
  assert.match(fn, /toast\(`Continue in \$\{plan\.baseWorktree\.name\}`\)/);
  assert.match(app, /api\.on\('git', /);
  const main = fsm.readFileSync(pth.join(__dirname, '../main.js'), 'utf8');
  assert.match(main.slice(main.indexOf("handle('app:git-use'")), /webContents\.send\('git', info\)/);
  assert.match(fsm.readFileSync(pth.join(__dirname, '../preload.js'), 'utf8'), /'git'\]/);
});
