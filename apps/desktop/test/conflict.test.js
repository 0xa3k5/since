'use strict';
// Built-in conflict editor: marker parsing, composing the result, and the git side
// (reading a conflict, saving a resolution, undo). Git tests run in throwaway temp repos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const { checkGit } = require('../ipc');

const load = () => import('../renderer/conflict.js');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  const journal = new Journal(await git.openRepo(dir));
  return { dir, journal, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}
async function commit(dir, file, content, msg) {
  if (content == null) await git.run(dir, ['rm', '-q', file]);
  else { fs.writeFileSync(path.join(dir, file), content); await git.run(dir, ['add', file]); }
  await git.run(dir, ['commit', '-q', '-m', msg]);
}
// main and `other` both change f.txt from `base`; returns once `op` has stopped on the conflict.
async function conflicted(base, ours, theirs, { op = 'merge', file = 'f.txt' } = {}) {
  const r = await repo();
  await commit(r.dir, file, base, 'base');
  await git.run(r.dir, ['checkout', '-q', '-b', 'other']);
  await commit(r.dir, file, theirs, 'theirs');
  await git.run(r.dir, ['checkout', '-q', 'main']);
  await commit(r.dir, file, ours, 'ours');
  if (op === 'merge') await git.run(r.dir, ['merge', 'other'], { allowCodes: [0, 1] });
  if (op === 'cherry-pick') await git.run(r.dir, ['cherry-pick', 'other'], { allowCodes: [0, 1] });
  if (op === 'rebase') { await git.run(r.dir, ['checkout', '-q', 'other']); await git.run(r.dir, ['rebase', 'main'], { allowCodes: [0, 1] }); }
  return r;
}

test('parseConflicts: merge and diff3 styles, CRLF, round trip', async () => {
  const { parseConflicts, composeResult, conflictCount } = await load();
  const text = 'a\n<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs\n>>>>>>> other\nb\n<<<<<<< HEAD\nx\r\n||||||| base\nbase\r\n=======\ny\r\n>>>>>>> other\nc\n';
  const segs = parseConflicts(text);
  assert.equal(conflictCount(segs), 2);
  const [first, second] = segs.filter((s) => s.type === 'conflict');
  assert.deepEqual([first.ours, first.theirs, first.base, first.oursLabel, first.theirsLabel], [['ours 1', 'ours 2'], ['theirs'], null, 'HEAD', 'other']);
  assert.deepEqual([second.ours, second.base, second.theirs, second.baseLabel], [['x\r'], ['base\r'], ['y\r'], 'base']);
  assert.equal(composeResult(segs), text, 'unresolved blocks keep their markers');
});

test('parseConflicts: unterminated markers and look-alikes stay text', async () => {
  const { parseConflicts, conflictCount, composeResult, hasMarkers } = await load();
  for (const text of ['<<<<<<< HEAD\nours\n=======\ntheirs\n', '<<<<<<<< eight\n========\n>>>>>>>>\n', '<<<<<<<x\n=======\n>>>>>>> y\n']) {
    const segs = parseConflicts(text);
    assert.equal(conflictCount(segs), 0, text);
    assert.equal(composeResult(segs), text);
    assert.equal(hasMarkers(text), false);
  }
  assert.equal(hasMarkers('<<<<<<< a\n=======\n>>>>>>> b'), true);
});

test('composeResult: whole sides, both, per-line picks', async () => {
  const { parseConflicts, composeResult, sideChoice } = await load();
  const segs = parseConflicts('top\n<<<<<<< HEAD\no1\no2\n=======\nt1\nt2\n>>>>>>> other\nend\n');
  const b = segs[1];
  assert.equal(composeResult(segs, [sideChoice(b, 'ours')]), 'top\no1\no2\nend\n');
  assert.equal(composeResult(segs, [sideChoice(b, 'theirs')]), 'top\nt1\nt2\nend\n');
  assert.equal(composeResult(segs, [sideChoice(b, 'both')]), 'top\no1\no2\nt1\nt2\nend\n');
  assert.equal(composeResult(segs, [sideChoice(b, 'both-rev')]), 'top\nt1\nt2\no1\no2\nend\n');
  assert.equal(composeResult(segs, [{ ours: [false, true], theirs: [true, false] }]), 'top\no2\nt1\nend\n');
  assert.equal(composeResult(segs, [sideChoice(b, null)]), 'top\nend\n', 'an empty pick drops the block');
});

test('getConflict reads a text conflict; resolveConflict stages it; undo brings the conflict back', async () => {
  const { dir, journal, read } = await conflicted('base\n', 'ours\n', 'theirs\n');
  const markers = read('f.txt');
  const info = await git.getConflict(dir, 'f.txt');
  assert.deepEqual({ ...info, text: null }, { path: 'f.txt', base: true, ours: true, theirs: true, kind: 'text', text: null });
  assert.equal(info.text, markers);

  await journal.runWork('resolveConflict', 'Resolve conflicts in f.txt', ['f.txt', 'ours\ntheirs\n']);
  assert.equal(read('f.txt'), 'ours\ntheirs\n');
  assert.equal((await git.getStatus(dir)).conflicts.length, 0);
  assert.equal(await git.run(dir, ['show', ':f.txt']), 'ours\ntheirs\n');

  await journal.step('undo');
  assert.equal(read('f.txt'), markers);
  assert.deepEqual((await git.getStatus(dir)).conflicts.map((f) => f.path), ['f.txt']);

  await journal.step('redo');
  assert.equal(read('f.txt'), 'ours\ntheirs\n');
  assert.equal((await git.getStatus(dir)).conflicts.length, 0);
});

test('conflicts from rebase and cherry-pick parse the same way', async () => {
  const { parseConflicts, conflictCount } = await load();
  for (const op of ['rebase', 'cherry-pick']) {
    const { dir } = await conflicted('base\n', 'ours\n', 'theirs\n', { op });
    const info = await git.getConflict(dir, 'f.txt');
    assert.equal(info.kind, 'text', op);
    assert.equal(conflictCount(parseConflicts(info.text)), 1, op);
  }
});

test('binary and deleted files take a whole side; a deleted side removes the file', async () => {
  const bin = await conflicted(Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3]), Buffer.from([0, 1, 4]), { file: 'b.bin' });
  assert.equal((await git.getConflict(bin.dir, 'b.bin')).kind, 'binary');
  await bin.journal.runWork('chooseSide', 'Use their version', ['b.bin', 'theirs']);
  assert.deepEqual([...fs.readFileSync(path.join(bin.dir, 'b.bin'))], [0, 1, 4]);

  const del = await conflicted('base\n', 'ours\n', null);
  const info = await git.getConflict(del.dir, 'f.txt');
  assert.deepEqual([info.ours, info.theirs], [true, false]);
  await del.journal.runWork('chooseSide', 'Use their version', ['f.txt', 'theirs']);
  assert.equal(fs.existsSync(path.join(del.dir, 'f.txt')), false);
  assert.equal((await git.getStatus(del.dir)).conflicts.length, 0);
  await del.journal.step('undo');
  assert.equal(del.read('f.txt'), 'ours\n');
  assert.deepEqual((await git.getStatus(del.dir)).conflicts.map((f) => f.path), ['f.txt']);
});

test('resolveConflict refuses to write through a symlink', async () => {
  const { dir } = await repo();
  fs.symlinkSync('/etc/hosts', path.join(dir, 'link'));
  assert.equal((await git.getConflict(dir, 'link')).kind, 'binary');
  await assert.rejects(git.resolveConflict(dir, 'link', 'x'), /not a regular file/);
  await commit(dir, 'plain.txt', 'plain\n', 'plain');
  await assert.rejects(git.resolveConflict(dir, 'plain.txt', 'x'), /no conflict/);
  assert.equal(fs.readFileSync(path.join(dir, 'plain.txt'), 'utf8'), 'plain\n');
});

test('chooseSide refuses a path with no conflict stages instead of deleting it', async () => {
  const { dir } = await repo();
  await commit(dir, 'plain.txt', 'plain\n', 'plain');
  for (const side of ['ours', 'theirs']) await assert.rejects(git.chooseSide(dir, 'plain.txt', side), /no conflict/);
  assert.equal(fs.readFileSync(path.join(dir, 'plain.txt'), 'utf8'), 'plain\n');
});

test('getConflict: a file that is not UTF-8 takes a whole side', async () => {
  const latin1 = (s) => Buffer.from(s, 'latin1');
  const { dir } = await conflicted(latin1('caf\xe9\n'), latin1('caf\xe9 ours\n'), latin1('caf\xe9 theirs\n'));
  const info = await git.getConflict(dir, 'f.txt');
  assert.deepEqual([info.kind, info.text], ['encoding', null]);
  const utf8 = await conflicted('\ufeffcafé\n', 'café ours\n', 'café theirs\n');
  assert.equal((await git.getConflict(utf8.dir, 'f.txt')).kind, 'text');
});

test('keepLineEndings: an edited CRLF file is saved with CRLF', async () => {
  const { keepLineEndings } = await load();
  assert.equal(keepLineEndings('a\r\n<<<<<<< HEAD\r\n', 'a\nb\n'), 'a\r\nb\r\n');
  assert.equal(keepLineEndings('a\r\nb\n', 'a\r\nb\n'), 'a\r\nb\n', 'picks already keep their endings');
  assert.equal(keepLineEndings('a\nb\n', 'a\nb\n'), 'a\nb\n');
  assert.equal(keepLineEndings(null, 'a\n'), 'a\n');
});

test('IPC: conflict and resolveConflict take a repository path', () => {
  assert.deepEqual(checkGit('conflict', ['a/b.txt']).args, ['a/b.txt']);
  assert.deepEqual(checkGit('resolveConflict', ['f.txt', '']).args, ['f.txt', '']);
  assert.throws(() => checkGit('conflict', ['../x']), /\.\./);
  assert.throws(() => checkGit('resolveConflict', ['/etc/passwd', 'x']), /relative/);
  assert.throws(() => checkGit('resolveConflict', ['f.txt', 'a\0b']), /NUL/);
});
