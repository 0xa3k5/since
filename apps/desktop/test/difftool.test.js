'use strict';
const os = require('node:os');
// Isolate from the user's diff.tool / merge.tool (git.js copies the environment when loaded).
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const git = require('../git');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-difftool-')));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, args);
  return dir;
}
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const commit = async (dir, msg) => { await git.run(dir, ['add', '-A']); await git.run(dir, ['commit', '-q', '-m', msg]); };

// A "tool" that appends what it was asked to compare to log.txt (outside the repo's tracked files).
async function fakeDifftool(dir) {
  const log = path.join(path.dirname(dir), path.basename(dir) + '.log');
  await git.run(dir, ['config', 'diff.tool', 'fake']);
  await git.run(dir, ['config', 'difftool.fake.cmd', `{ cat "$LOCAL"; echo "|"; cat "$REMOTE"; echo; } >> '${log}'`]);
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
}

async function conflict(dir) {
  write(dir, 'a.txt', 'base\n'); write(dir, 'b.txt', 'base\n');
  await commit(dir, 'base');
  await git.run(dir, ['checkout', '-q', '-b', 'other']);
  write(dir, 'a.txt', 'theirs\n'); write(dir, 'b.txt', 'theirs\n');
  await commit(dir, 'theirs');
  await git.run(dir, ['checkout', '-q', 'main']);
  write(dir, 'a.txt', 'ours\n'); write(dir, 'b.txt', 'ours\n');
  await commit(dir, 'ours');
  await git.run(dir, ['merge', 'other'], { allowCodes: [1] });
}

test('difftoolArgs covers working tree, staged, commit, root commit and renames', () => {
  assert.deepEqual(git.difftoolArgs({ path: 'a' }), ['difftool', '--no-prompt', '--', 'a']);
  assert.deepEqual(git.difftoolArgs({ path: 'a' }, { staged: true }), ['difftool', '--no-prompt', '--cached', '--', 'a']);
  assert.deepEqual(git.difftoolArgs({ path: 'a' }, { commit: 'c1', parent: 'p1' }), ['difftool', '--no-prompt', 'p1', 'c1', '--', 'a']);
  assert.equal(git.difftoolArgs({ path: 'a' }, { commit: 'c1' })[2], '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.deepEqual(git.difftoolArgs({ path: 'new', oldPath: 'old' }).slice(-2), ['old', 'new']);
  assert.deepEqual(git.mergetoolArgs(), ['mergetool', '--no-prompt']);
  assert.deepEqual(git.mergetoolArgs(['x']), ['mergetool', '--no-prompt', '--', 'x']);
});

test('checkTool refuses a missing or terminal-only tool', () => {
  assert.throws(() => git.checkTool(null, 'diff'), /No diff tool set.*diff\.tool/);
  assert.throws(() => git.checkTool('vimdiff', 'merge'), /runs in a terminal/);
  assert.throws(() => git.checkTool('nvimdiff2', 'diff'), /runs in a terminal/);
  assert.equal(git.checkTool('opendiff', 'diff'), 'opendiff');
  assert.equal(git.checkTool('gvimdiff', 'merge'), 'gvimdiff');
});

test('getExternalTools reads diff.tool and falls back to merge.tool for diffs', async () => {
  const dir = await repo();
  assert.deepEqual(await git.getExternalTools(dir), { diff: null, merge: null });
  await git.run(dir, ['config', 'merge.tool', 'meld']);
  assert.deepEqual(await git.getExternalTools(dir), { diff: 'meld', merge: 'meld' });
  await git.run(dir, ['config', 'diff.tool', 'ksdiff']);
  assert.deepEqual(await git.getExternalTools(dir), { diff: 'ksdiff', merge: 'meld' });
});

test('difftool without a configured tool fails with a readable message', async () => {
  const dir = await repo();
  write(dir, 'a.txt', 'one\n'); await commit(dir, 'one');
  write(dir, 'a.txt', 'two\n');
  await assert.rejects(git.difftool(dir, { path: 'a.txt' }), /No diff tool set/);
});

test('difftool opens working, staged and commit versions in the configured tool', async () => {
  const dir = await repo();
  const log = await fakeDifftool(dir);
  write(dir, 'a.txt', 'one\n'); await commit(dir, 'one');
  write(dir, 'a.txt', 'two\n'); await commit(dir, 'two');
  const sha = (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
  const parent = (await git.run(dir, ['rev-parse', 'HEAD^'])).trim();
  await git.difftool(dir, { path: 'a.txt' }, { commit: sha, parent });
  assert.equal(log(), 'one\n|\ntwo\n\n');

  write(dir, 'a.txt', 'staged\n'); await git.run(dir, ['add', 'a.txt']);
  write(dir, 'a.txt', 'working\n');
  await git.difftool(dir, { path: 'a.txt' }, { staged: true });
  await git.difftool(dir, { path: 'a.txt' });
  assert.match(log(), /two\n\|\nstaged\n\n/);
  assert.match(log(), /staged\n\|\nworking\n\n$/);
  assert.equal(read(dir, 'a.txt'), 'working\n');
});

test('mergetool resolves conflicts and reports what is left', async () => {
  const dir = await repo();
  await conflict(dir);
  await git.run(dir, ['config', 'merge.tool', 'fake']);
  await git.run(dir, ['config', 'mergetool.fake.cmd', 'cp "$REMOTE" "$MERGED"']);
  await git.run(dir, ['config', 'mergetool.fake.trustExitCode', 'true']);
  await git.run(dir, ['config', 'mergetool.keepBackup', 'false']);

  assert.deepEqual(await git.mergetool(dir, ['a.txt']), { remaining: [] });
  assert.equal(read(dir, 'a.txt'), 'theirs\n');
  assert.deepEqual((await git.getStatus(dir)).conflicts.map((f) => f.path), ['b.txt']);

  // A tool that exits without resolving leaves the file conflicted.
  await git.run(dir, ['config', 'mergetool.fake.cmd', 'exit 1']);
  assert.deepEqual(await git.mergetool(dir), { remaining: ['b.txt'] });
  assert.deepEqual((await git.getStatus(dir)).conflicts.map((f) => f.path), ['b.txt']);
});

test('mergetool refuses when nothing is conflicted or no tool is set', async () => {
  const dir = await repo();
  write(dir, 'a.txt', 'one\n'); await commit(dir, 'one');
  await assert.rejects(git.mergetool(dir), /No merge tool set/);
  await git.run(dir, ['config', 'merge.tool', 'vimdiff']);
  await assert.rejects(git.mergetool(dir), /runs in a terminal/);
  await git.run(dir, ['config', 'merge.tool', 'meld']);
  await assert.rejects(git.mergetool(dir), /no conflicted files/);
});
