'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const check = require('../ipc');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-fh-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
async function commit(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', msg]);
  return (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
}

test('fileHistory follows renames and pages without losing the rename', async () => {
  const dir = await repo();
  const a = await commit(dir, 'old.txt', 'one\ntwo\nthree\nfour\n', 'add');
  await commit(dir, 'other.txt', 'x\n', 'unrelated');
  const b = await commit(dir, 'old.txt', 'one\ntwo\nthree\nfour\nfive\n', 'edit old');
  await git.run(dir, ['mv', 'old.txt', 'new.txt']);
  const c = await commit(dir, 'new.txt', 'one\ntwo\nthree\nfour\nfive\n', 'rename');
  const d = await commit(dir, 'new.txt', 'ONE\ntwo\nthree\nfour\nfive\n', 'edit new');

  const all = await git.fileHistory(dir, 'new.txt');
  assert.deepEqual(all.entries.map((e) => e.sha), [d, c, b, a]);
  assert.equal(all.next, null);
  assert.deepEqual(all.entries.map((e) => e.path), ['new.txt', 'new.txt', 'old.txt', 'old.txt']);
  assert.deepEqual(all.entries.map((e) => e.status), ['M', 'R', 'M', 'A']);
  assert.equal(all.entries[1].oldPath, 'old.txt');
  assert.equal(all.entries[0].subject, 'edit new');
  assert.equal(all.entries[0].author, 'Test');
  assert.ok(all.entries[0].time > 0);

  // Page boundary right on the rename: the next page continues under the old name.
  const p1 = await git.fileHistory(dir, 'new.txt', { limit: 2 });
  assert.deepEqual(p1.entries.map((e) => e.sha), [d, c]);
  assert.deepEqual(p1.next, { from: c, skip: 1, path: 'old.txt' });
  const p2 = await git.fileHistory(dir, p1.next.path, { ...p1.next, limit: 2 });
  assert.deepEqual(p2.entries.map((e) => e.sha), [b, a]);
  const p3 = await git.fileHistory(dir, p2.next.path, { ...p2.next, limit: 2 });
  assert.deepEqual(p3.entries, []);
  assert.equal(p3.next, null);
});

test('fileHistory handles paths with spaces, quotes and unicode', async () => {
  const dir = await repo();
  const name = 'dir/we "ird" ü name.txt';
  fs.mkdirSync(path.join(dir, 'dir'));
  const a = await commit(dir, name, 'x\n', 'add');
  const { entries } = await git.fileHistory(dir, name);
  assert.deepEqual(entries.map((e) => [e.sha, e.path]), [[a, name]]);
});

test('blame maps lines to commits, at a revision and in the working tree', async () => {
  const dir = await repo();
  const a = await commit(dir, 'f.txt', 'one\ntwo\n', 'first');
  const b = await commit(dir, 'f.txt', 'one\nTWO\nthree\n', 'second');
  const { commits, lines } = await git.blame(dir, 'f.txt', 'HEAD');
  assert.deepEqual(lines.map((l) => [l.line, commits[l.commit].sha, l.text]), [[1, a, 'one'], [2, b, 'TWO'], [3, b, 'three']]);
  assert.equal(commits.length, 2);
  assert.equal(commits[lines[1].commit].summary, 'second');
  assert.equal(commits[0].author, 'Test');
  assert.equal(commits[0].email, 't@example.com');

  const old = await git.blame(dir, 'f.txt', a);
  assert.deepEqual(old.lines.map((l) => l.text), ['one', 'two']);

  fs.writeFileSync(path.join(dir, 'f.txt'), 'one\nTWO\nthree\nfour\n');
  const wt = await git.blame(dir, 'f.txt');
  assert.equal(wt.lines.length, 4);
  assert.ok(wt.commits[wt.lines[3].commit].uncommitted);
  assert.ok(!wt.commits[wt.lines[0].commit].uncommitted);
});

test('trackedFiles lists the files in the index', async () => {
  const dir = await repo();
  fs.mkdirSync(path.join(dir, 'sub'));
  await commit(dir, 'sub/a b.txt', 'x\n', 'add');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'y');
  assert.deepEqual(await git.trackedFiles(dir), ['sub/a b.txt']);
});

test('blame keeps tabs and empty lines in content', () => {
  const sha = 'a'.repeat(40);
  const out = `${sha} 1 1 2\nauthor A\nauthor-mail <a@x>\nauthor-time 5\nsummary s\nboundary\nfilename f\n\t\tindented\n${sha} 2 2\n\t\n`;
  const { commits, lines } = git.parseBlame(out);
  assert.deepEqual(lines, [{ line: 1, commit: 0, text: '\tindented' }, { line: 2, commit: 0, text: '' }]);
  assert.equal(commits[0].boundary, true);
  assert.equal(commits[0].email, 'a@x');
});

test('IPC checks reject unsafe file history and blame arguments', () => {
  assert.doesNotThrow(() => check.checkGit('fileHistory', ['a/b.txt', { from: 'abc123', skip: 1, path: 'a.txt' }]));
  assert.doesNotThrow(() => check.checkGit('blame', ['a.txt']));
  assert.throws(() => check.checkGit('fileHistory', ['../etc/passwd']));
  assert.throws(() => check.checkGit('fileHistory', ['a.txt', { from: '--output=/tmp/x' }]));
  assert.throws(() => check.checkGit('fileHistory', ['a.txt', { path: '/abs' }]));
  assert.throws(() => check.checkGit('blame', ['a.txt', '--contents=/etc/passwd']));
});

test('blame rows mark commit runs and age buckets', async () => {
  const { blameRows, historyRows, splitPath } = await import('../renderer/blame.js');
  const commits = [{ time: 100 }, { time: 200 }, { time: 0, uncommitted: true }];
  const lines = [{ line: 1, commit: 0 }, { line: 2, commit: 0 }, { line: 3, commit: 1 }, { line: 4, commit: 2 }];
  assert.deepEqual(blameRows({ commits, lines }).map((l) => [l.first, l.age]), [[true, 0], [false, 0], [true, 4], [true, 4]]);
  assert.deepEqual(blameRows({ commits: [{ time: 5 }], lines: [{ line: 1, commit: 0 }] }).map((l) => l.age), [4]);
  const rows = historyRows('a/b.txt', [{ sha: 'x', path: 'a/b.txt' }]);
  assert.equal(rows[0].sha, null);
  assert.equal(rows[0].path, 'a/b.txt');
  assert.equal(rows.length, 2);
  assert.deepEqual(splitPath('a/b/c.txt'), ['c.txt', 'a/b']);
  assert.deepEqual(splitPath('c.txt'), ['c.txt', '']);
});
