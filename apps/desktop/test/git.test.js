'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
async function commit(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  await git.run(dir, ['add', file]);
  await git.run(dir, ['commit', '-q', '-m', msg]);
  return (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
}
const subjects = async (dir) => (await git.run(dir, ['log', '--format=%s'])).trim().split('\n');

test('openRepo, refs, log, status', async () => {
  const dir = await repo();
  const a = await commit(dir, 'a.txt', '1\n', 'first');
  await git.run(dir, ['tag', 'v1']);
  const info = await git.openRepo(dir);
  assert.equal(info.root, dir);
  const { refs, head } = await git.getRefs(dir);
  assert.equal(head.branch, 'main');
  assert.equal(head.oid, a);
  assert.ok(refs.find((r) => r.kind === 'tag' && r.short === 'v1' && r.target === a));
  const log = await git.getLog(dir);
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, 'first');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  const st = await git.getStatus(dir);
  assert.deepEqual(st.unstaged.map((f) => f.status).sort(), ['?', 'M']);
});

test('co-authors come from Co-authored-by trailers', async () => {
  const dir = await repo();
  const sha = await commit(dir, 'a.txt', '1\n', 'pair\n\nBody.\n\nCo-authored-by: Bo <bo@x>\nco-authored-by: Test <T@example.com>\nCo-authored-by: Bo again <bo@x>\nCo-authored-by: Cy <cy@x>');
  const want = [{ name: 'Bo', email: 'bo@x' }, { name: 'Cy', email: 'cy@x' }];
  assert.deepEqual((await git.getLog(dir))[0].coAuthors, want);
  assert.deepEqual((await git.getCommit(dir, sha)).coAuthors, want);
  const { parseDetails } = await import('../renderer/log.js');
  let got;
  parseDetails(await git.getLogDetails(dir, [sha]), (...f) => { got = f[5]; });
  assert.deepEqual(got, want);
  await commit(dir, 'b.txt', '1\n', 'solo');
  assert.deepEqual((await git.getLog(dir))[0].coAuthors, []);
});

test('partial staging stages only selected lines', async () => {
  const dir = await repo();
  await commit(dir, 'f.txt', 'a\nb\nc\nd\n', 'base');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'A\nb\nc\nD\n');
  const d = await git.workingDiff(dir, { path: 'f.txt', status: 'M' }, { staged: false });
  // pick the change for the first line only (the - and + of 'a' -> 'A')
  const keys = [];
  d.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (l.t !== ' ' && /^[aA]$/.test(l.s)) keys.push(`${hi}:${li}`); }));
  assert.equal(keys.length, 2);
  await git.applyPatch(dir, git.buildPartialPatch(d, keys, 'stage'), { cached: true });
  const staged = await git.run(dir, ['show', ':f.txt']);
  assert.equal(staged, 'A\nb\nc\nd\n');

  // unstage it again via reverse patch
  const sd = await git.workingDiff(dir, { path: 'f.txt', status: 'M' }, { staged: true });
  const all = [];
  sd.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (l.t !== ' ') all.push(`${hi}:${li}`); }));
  await git.applyPatch(dir, git.buildPartialPatch(sd, all, 'reverse'), { cached: true, reverse: true });
  assert.equal(await git.run(dir, ['show', ':f.txt']), 'a\nb\nc\nd\n');

  // discard only the D line in the working tree
  const wd = await git.workingDiff(dir, { path: 'f.txt', status: 'M' }, { staged: false });
  const dk = [];
  wd.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (l.t !== ' ' && /^[dD]$/.test(l.s)) dk.push(`${hi}:${li}`); }));
  await git.applyPatch(dir, git.buildPartialPatch(wd, dk, 'reverse'), { reverse: true });
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'A\nb\nc\nd\n');
});

test('rewrite: reword, swap, squash, fixup, drop', async () => {
  const dir = await repo();
  await commit(dir, 'a', '1', 'one');
  const two = await commit(dir, 'b', '2', 'two');
  const three = await commit(dir, 'c', '3', 'three');
  await commit(dir, 'd', '4', 'four');

  await git.rewrite(dir, 'reword', two, { message: 'TWO\n' });
  assert.deepEqual(await subjects(dir), ['four', 'three', 'TWO', 'one']);

  let [, threeSha] = (await git.run(dir, ['log', '--format=%H'])).trim().split('\n');
  await git.rewrite(dir, 'swapParent', threeSha);
  assert.deepEqual(await subjects(dir), ['four', 'TWO', 'three', 'one']);

  let shas = (await git.run(dir, ['log', '--format=%H'])).trim().split('\n');
  await git.rewrite(dir, 'fixup', shas[1]); // TWO into three
  assert.deepEqual(await subjects(dir), ['four', 'three', 'one']);
  assert.ok(fs.existsSync(path.join(dir, 'b')));

  shas = (await git.run(dir, ['log', '--format=%H'])).trim().split('\n');
  await git.rewrite(dir, 'drop', shas[0]);
  assert.deepEqual(await subjects(dir), ['three', 'one']);
  assert.ok(!fs.existsSync(path.join(dir, 'd')));

  shas = (await git.run(dir, ['log', '--format=%H'])).trim().split('\n');
  await git.rewrite(dir, 'squash', shas[0]);
  assert.deepEqual((await subjects(dir)), ['one']);
  const body = await git.run(dir, ['log', '-1', '--format=%B']);
  assert.match(body, /three/);
  assert.ok(three);
});

test('undo restores refs and working tree', async () => {
  const dir = await repo();
  await commit(dir, 'a', '1', 'one');
  const before = await git.captureRefState(dir);
  await commit(dir, 'b', '2', 'two');
  await git.run(dir, ['branch', 'feature']);
  await git.restoreRefState(dir, before);
  assert.deepEqual(await subjects(dir), ['one']);
  assert.ok(!fs.existsSync(path.join(dir, 'b')));
  const { refs } = await git.getRefs(dir);
  assert.ok(!refs.find((r) => r.short === 'feature'));
});

test('graph layout assigns lanes for branches and merges', async () => {
  const { layout } = await import('../renderer/graph.js');
  // m merges b into a; a and b both descend from root
  const commits = [
    { sha: 'm', parents: ['a', 'b'] },
    { sha: 'b', parents: ['r'] },
    { sha: 'a', parents: ['r'] },
    { sha: 'r', parents: [] },
  ];
  const g = layout(commits);
  assert.equal(g.row(0).col, 0);
  assert.equal(g.row(1).col, 1); // b sits on its own lane
  assert.equal(g.row(2).col, 0);
  assert.equal(g.row(3).col, 0);
  assert.equal(g.maxLanes, 2);
  assert.ok(g.row(0).merge);
});

test('remoteWebUrl', () => {
  assert.equal(git.remoteWebUrl('git@github.com:octo/hello.git'), 'https://github.com/octo/hello');
  assert.equal(git.remoteWebUrl('https://github.com/octo/hello.git'), 'https://github.com/octo/hello');
  assert.equal(git.remoteWebUrl('ssh://git@gitlab.com:22/a/b.git'), 'https://gitlab.com/a/b');
  assert.equal(git.remoteWebUrl('https://user:secret@github.com/octo/hello.git'), 'https://github.com/octo/hello');
  assert.equal(git.remoteWebUrl('http://token@example.com:8443/team/repo/'), 'https://example.com:8443/team/repo');
  assert.equal(git.remoteWebUrl('git://example.org/a/b.git'), 'https://example.org/a/b');
  assert.equal(git.remoteWebUrl('deploy@host.example:group/sub/repo.git'), 'https://host.example/group/sub/repo');
  assert.equal(git.remoteWebUrl('/Users/me/repos/hello.git'), null);
  assert.equal(git.remoteWebUrl('file:///Users/me/repos/hello.git'), null);
  assert.equal(git.remoteWebUrl('../hello'), null);
});

test('remoteLabel', () => {
  assert.equal(git.remoteLabel('git@github.com:0xa3k5/web3icons.git'), 'github.com/0xa3k5/web3icons');
  assert.equal(git.remoteLabel('https://github.com/0xa3k5/web3icons.git'), 'github.com/0xa3k5/web3icons');
  assert.equal(git.remoteLabel('https://user:pass@github.com/0xa3k5/web3icons'), 'github.com/0xa3k5/web3icons');
  assert.equal(git.remoteLabel('file:///srv/git/hello.git'), '/srv/git/hello.git');
  assert.equal(git.remoteLabel('/srv/git/hello.git'), '/srv/git/hello.git');
  assert.equal(git.remoteLabel('https://user:tok@example.com'), 'https://example.com');
  assert.equal(git.remoteLabel('ssh://git:secret@example.com:2222'), 'ssh://example.com:2222');
});

test('getConfig parses scopes, multi-line and valueless entries', async () => {
  const dir = await repo();
  await git.run(dir, ['config', 'gitlanes.multi', 'line one\nline two']);
  fs.appendFileSync(path.join(dir, '.git', 'config'), '[gitlanes]\n\tflag\n');
  const config = await git.getConfig(dir);
  const local = (key) => config.find((c) => c.scope === 'local' && c.key === key);
  assert.equal(local('user.name').value, 'Test');
  assert.equal(local('gitlanes.multi').value, 'line one\nline two');
  assert.equal(local('gitlanes.flag').value, '');
  assert.ok(config.every((c) => ['system', 'global', 'local', 'worktree', 'command'].includes(c.scope)));
});

test('partial stash: selected files and staged-only changes', async () => {
  const dir = await repo();
  await commit(dir, 'a.txt', 'a\n', 'first');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  await git.run(dir, ['add', 'b.txt']);
  await git.run(dir, ['commit', '-q', '-m', 'second']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b2\n');
  await git.stashPush(dir, { message: 'only a', paths: ['a.txt'] });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b2\n');
  assert.deepEqual((await git.run(dir, ['stash', 'show', '--name-only', 'stash@{0}'])).trim(), 'a.txt');

  await git.run(dir, ['add', 'b.txt']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a3\n');
  await git.stashPush(dir, { message: 'staged', staged: true });
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a3\n');
  const stashes = await git.getStashes(dir);
  assert.deepEqual(stashes.map((s) => s.message.replace(/^On main: /, '')), ['staged', 'only a']);
  await assert.rejects(git.stashPush(dir, { staged: true, untracked: true }), /untracked/);
});

test('partial stash: selected lines leave the working tree and apply back', async () => {
  const dir = await repo();
  await commit(dir, 'f.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', 'first');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n');
  const file = { path: 'f.txt', status: 'M' };
  const d = await git.workingDiff(dir, file, { staged: false });
  // Pick only the lines of the first hunk (the change at the top of the file).
  const keys = d.hunks[0].lines.map((l, i) => (l.t !== ' ' ? `0:${i}` : null)).filter(Boolean);
  assert.ok(keys.length);
  await git.stashLines(dir, file, keys, 'top only');
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), '1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n');
  const [s] = await git.getStashes(dir);
  assert.equal(s.message, 'On main: top only');
  const stashed = await git.run(dir, ['diff', 'stash@{0}^1', 'stash@{0}']);
  assert.match(stashed, /\+ONE/);
  assert.doesNotMatch(stashed, /TEN/);
  await git.run(dir, ['commit', '-q', '-am', 'ten']);
  await git.stashApply(dir, 'stash@{0}', true);
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n');
  assert.equal((await git.run(dir, ['diff', '--cached', '--name-only'])).trim(), '');

  // A file with staged changes can't have lines stashed (the stash is based on HEAD).
  await git.run(dir, ['add', 'f.txt']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n11\n');
  const d2 = await git.workingDiff(dir, file, { staged: false });
  await assert.rejects(git.stashLines(dir, file, [`0:${d2.hunks[0].lines.findIndex((l) => l.t === '+')}`]), /staged changes/);
});
