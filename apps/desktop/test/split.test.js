'use strict';
// Commit splitter: git.rewrite(cwd, 'split', sha, { files, messages }). Every test runs in a throwaway repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
async function commit(dir, files, msg, { author } = {}) {
  for (const [f, c] of Object.entries(files)) {
    const abs = path.join(dir, f);
    if (c == null) fs.rmSync(abs);
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c); }
  }
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', msg, ...(author ? [`--author=${author}`] : [])], { env: { GIT_AUTHOR_DATE: '1700000000 +0200' } });
  return rev(dir, 'HEAD');
}
const rev = async (dir, r) => (await git.run(dir, ['rev-parse', r])).trim();
const subjects = async (dir) => (await git.run(dir, ['log', '--format=%s'])).trim().split('\n');
const show = (dir, spec) => git.run(dir, ['show', spec]);
const diff = (dir, a, b) => git.run(dir, ['diff', '--no-renames', a, b]);

// Keys of the changed lines in `file` whose text matches `re`.
async function keysFor(dir, sha, file, re) {
  const d = (await git.commitDiffs(dir, sha)).find((x) => x.path === file);
  const keys = [];
  d.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (l.t !== ' ' && re.test(l.s)) keys.push(`${hi}:${li}`); }));
  return keys;
}

const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
const CHANGED = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n';

test('split the HEAD commit: selected lines become the first commit, the rest the second', async () => {
  const dir = await repo();
  const base = await commit(dir, { 'f.txt': BASE }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED, 'new.txt': 'new\n' }, 'change both ends', { author: 'Ada <ada@example.com>' });
  const keys = await keysFor(dir, orig, 'f.txt', /^[aA]$/);
  assert.equal(keys.length, 2);

  await git.rewrite(dir, 'split', orig, { files: { 'f.txt': keys, 'new.txt': 'all' }, messages: ['first half', 'second half\n\nwith a body'] });

  assert.deepEqual(await subjects(dir), ['second half', 'first half', 'base']);
  // The two commits together equal the original.
  assert.equal(await diff(dir, base, 'HEAD'), await diff(dir, base, orig));
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${orig}^{tree}`));
  assert.equal(await show(dir, 'HEAD~1:f.txt'), BASE.replace('a\n', 'A\n'));
  assert.equal(await show(dir, 'HEAD~1:new.txt'), 'new\n');
  assert.equal(await rev(dir, 'HEAD~2'), base);
  assert.equal((await git.run(dir, ['log', '-1', '--format=%B'])).trim(), 'second half\n\nwith a body');
  // Both keep the original author and date.
  for (const r of ['HEAD', 'HEAD~1']) assert.equal((await git.run(dir, ['log', '-1', '--format=%an <%ae> %at', r])).trim(), 'Ada <ada@example.com> 1700000000');
  assert.equal(await git.run(dir, ['status', '--porcelain']), '');
});

test('split an older commit: descendants are replayed unchanged, and undo/redo work', async () => {
  const dir = await repo();
  const base = await commit(dir, { 'f.txt': BASE }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED }, 'middle');
  await commit(dir, { 'later.txt': 'later\n' }, 'later');
  const head = await commit(dir, { 'f.txt': CHANGED.replace('e\n', 'E\n') }, 'top');
  const journal = new Journal(await git.openRepo(dir));
  const before = await git.captureRefState(dir);

  const keys = await keysFor(dir, orig, 'f.txt', /^[jJ]$/);
  await journal.record('Split commit', 'rewrite', () => git.rewrite(dir, 'split', orig, { files: { 'f.txt': keys }, messages: ['J only', 'A only'] }));

  assert.deepEqual(await subjects(dir), ['top', 'later', 'A only', 'J only', 'base']);
  assert.equal(await diff(dir, base, 'HEAD~2'), await diff(dir, base, orig));
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${head}^{tree}`));
  assert.equal(await show(dir, 'HEAD~3:f.txt'), BASE.replace('j\n', 'J\n'));
  const after = await git.captureRefState(dir);

  assert.equal(await journal.step('undo'), 'Split commit');
  assert.deepEqual(await git.captureRefState(dir), before);
  assert.equal(await rev(dir, 'HEAD'), head);
  assert.deepEqual(await subjects(dir), ['top', 'later', 'middle', 'base']);

  await journal.step('redo');
  assert.deepEqual(await git.captureRefState(dir), after);
  assert.equal(await git.run(dir, ['status', '--porcelain']), '');
});

test('split keeps uncommitted changes (autostash)', async () => {
  const dir = await repo();
  await commit(dir, { 'f.txt': BASE, 'w.txt': 'w\n' }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED }, 'change');
  fs.writeFileSync(path.join(dir, 'w.txt'), 'dirty\n');
  await git.rewrite(dir, 'split', orig, { files: { 'f.txt': await keysFor(dir, orig, 'f.txt', /^[aA]$/) }, messages: ['one', 'two'] });
  assert.deepEqual(await subjects(dir), ['two', 'one', 'base']);
  assert.equal(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'), 'dirty\n');
});

test('split the root commit, partial deletions, and whole binary files', async () => {
  const dir = await repo();
  const root = await commit(dir, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'root');
  assert.equal(root, await rev(dir, 'HEAD'));
  await git.rewrite(dir, 'split', root, { files: { 'a.txt': 'all' }, messages: ['add a', 'add b'] });
  assert.deepEqual(await subjects(dir), ['add b', 'add a']);
  assert.equal((await git.run(dir, ['ls-tree', '--name-only', 'HEAD~1'])).trim(), 'a.txt');
  assert.equal((await git.run(dir, ['rev-list', '--count', 'HEAD'])).trim(), '2');

  // Deleting a file: keep some of its lines in the first commit, the deletion in the second.
  await commit(dir, { 'del.txt': 'x\ny\nz\n' }, 'add del');
  const del = await commit(dir, { 'del.txt': null, 'bin.dat': Buffer.from([0, 1, 2, 0, 255]) }, 'delete and binary');
  const keys = await keysFor(dir, del, 'del.txt', /^x$/);
  await git.rewrite(dir, 'split', del, { files: { 'del.txt': keys, 'bin.dat': 'all' }, messages: ['partial', 'rest'] });
  assert.equal(await show(dir, 'HEAD~1:del.txt'), 'y\nz\n');
  assert.ok((await git.run(dir, ['ls-tree', '--name-only', 'HEAD~1'])).includes('bin.dat'));
  assert.ok(!(await git.run(dir, ['ls-tree', '--name-only', 'HEAD'])).includes('del.txt'));
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${del}^{tree}`));
});

test('split refuses empty halves, merges, and other branches, changing nothing', async () => {
  const dir = await repo();
  await commit(dir, { 'f.txt': BASE }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED, 'bin.dat': Buffer.from([0, 1, 0]) }, 'change');
  const head = await rev(dir, 'HEAD');
  const split = (sha, extra) => git.rewrite(dir, 'split', sha, { messages: ['one', 'two'], ...extra });

  await assert.rejects(split(orig, { files: {} }), /at least one change for the first commit/);
  await assert.rejects(split(orig, { files: { 'f.txt': 'all', 'bin.dat': 'all' } }), /at least one change for the second commit/);
  await assert.rejects(split(orig, { files: { 'f.txt': 'all' }, messages: ['one', ' '] }), /Both commits need a message/);
  await assert.rejects(split(orig, { files: { 'nope.txt': 'all' } }), /not changed in this commit/);

  await git.run(dir, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
  const side = await commit(dir, { 's.txt': 's\n', 't.txt': 't\n' }, 'side');
  await git.run(dir, ['checkout', '-q', 'main']);
  await assert.rejects(split(side, { files: { 's.txt': 'all' } }), /not on the current branch/);
  await git.run(dir, ['merge', '-q', '--no-edit', 'side']);
  const merge = await rev(dir, 'HEAD');
  await assert.rejects(split(merge, { files: { 's.txt': 'all' } }), /merge commits is not supported/);
  await assert.rejects(split(orig, { files: { 'f.txt': 'all' } }), /merge commits between/);

  assert.equal(await rev(dir, 'HEAD'), merge);
  assert.equal(await rev(dir, 'HEAD^1'), head);
  assert.equal(await git.run(dir, ['status', '--porcelain']), '');
});

test('split files with spaces and non-ASCII characters in their names', async () => {
  const dir = await repo();
  await commit(dir, { 'my notes.txt': BASE, 'über/çay.txt': BASE }, 'base');
  const orig = await commit(dir, { 'my notes.txt': CHANGED, 'über/çay.txt': CHANGED }, 'change');
  assert.deepEqual((await git.commitDiffs(dir, orig)).map((d) => d.path).sort(), ['my notes.txt', 'über/çay.txt']);
  await git.rewrite(dir, 'split', orig, { files: { 'my notes.txt': await keysFor(dir, orig, 'my notes.txt', /^[aA]$/), 'über/çay.txt': 'all' }, messages: ['one', 'two'] });
  assert.equal(await show(dir, 'HEAD~1:my notes.txt'), BASE.replace('a\n', 'A\n'));
  assert.equal(await show(dir, 'HEAD~1:über/çay.txt'), CHANGED);
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${orig}^{tree}`));
});

// The tree `files` would give on top of `base`, built independently in a scratch index.
// Values are file contents (string or Buffer), or null to delete.
async function expectedTree(dir, base, files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'since-expect-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    await git.run(dir, ['read-tree', base], { env });
    for (const [f, c] of Object.entries(files)) {
      if (c == null) { await git.run(dir, ['update-index', '--force-remove', '--', f], { env }); continue; }
      const oid = (await git.run(dir, ['hash-object', '-w', '--stdin'], { input: c })).trim();
      await git.run(dir, ['update-index', '--add', '--replace', '--cacheinfo', `100644,${oid},${f}`], { env });
    }
    return (await git.run(dir, ['write-tree'], { env })).trim();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const blob = (dir, spec) => git.run(dir, ['cat-file', 'blob', spec], { encoding: 'buffer' });

// Split, then check both halves byte-for-byte: the first commit's tree is exactly
// `first` on top of the base, the second's is the original's.
async function splitAndCheck(dir, base, orig, files, first) {
  await git.rewrite(dir, 'split', orig, { files, messages: ['one', 'two'] });
  assert.equal(await rev(dir, 'HEAD~1^{tree}'), await expectedTree(dir, base, first));
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${orig}^{tree}`));
  assert.equal(await rev(dir, 'HEAD~2'), base);
}

test('a file replaced by a folder of the same name: the file deletion alone removes it', async () => {
  const dir = await repo();
  const base = await commit(dir, { foo: 'file\n', 'k.txt': 'k\n' }, 'base');
  fs.rmSync(path.join(dir, 'foo'));
  const orig = await commit(dir, { 'foo/bar': 'bar\n', 'k.txt': 'K\n' }, 'file to folder');
  await splitAndCheck(dir, base, orig, { foo: 'all' }, { foo: null });
  assert.equal((await git.run(dir, ['ls-tree', '-r', '--name-only', 'HEAD~1'])).trim(), 'k.txt');
});

test('a file replaced by a folder: selecting both, or only the folder side', async () => {
  const dir = await repo();
  const base = await commit(dir, { foo: 'file\n', 'k.txt': 'k\n' }, 'base');
  fs.rmSync(path.join(dir, 'foo'));
  const orig = await commit(dir, { 'foo/bar': 'bar\n', 'k.txt': 'K\n' }, 'file to folder');
  // The folder's file sorts after the deletion in neither order of `files`.
  await splitAndCheck(dir, base, orig, { 'foo/bar': 'all', foo: 'all' }, { foo: null, 'foo/bar': 'bar\n' });

  await git.run(dir, ['reset', '-q', '--hard', orig]);
  await assert.rejects(git.rewrite(dir, 'split', orig, { files: { 'foo/bar': 'all' }, messages: ['one', 'two'] }), /file and a folder with the same name/);
  assert.equal(await rev(dir, 'HEAD'), orig);
});

test('a folder replaced by a file of the same name', async () => {
  const dir = await repo();
  const base = await commit(dir, { 'foo/bar': 'bar\n', 'k.txt': 'k\n' }, 'base');
  fs.rmSync(path.join(dir, 'foo'), { recursive: true });
  const orig = await commit(dir, { foo: 'file\n', 'k.txt': 'K\n' }, 'folder to file');
  await splitAndCheck(dir, base, orig, { foo: 'all', 'foo/bar': 'all' }, { 'foo/bar': null, foo: 'file\n' });
  await git.run(dir, ['reset', '-q', '--hard', orig]);
  await splitAndCheck(dir, base, orig, { 'foo/bar': 'all' }, { 'foo/bar': null });
});

test('selected lines of a non-UTF-8 file stay byte-exact in the first commit', async () => {
  const dir = await repo();
  const latin = (s) => Buffer.from(s, 'latin1');
  const base = await commit(dir, { 'l1.txt': latin('na\xefve\nx\ny\nz\nend\n') }, 'base');
  const orig = await commit(dir, { 'l1.txt': latin('na\xefve\ncaf\xe9\nx\ny\nz\nend\nr\xe9sum\xe9\n') }, 'latin-1');
  const keys = await keysFor(dir, orig, 'l1.txt', /^caf/);
  assert.equal(keys.length, 1);
  await splitAndCheck(dir, base, orig, { 'l1.txt': keys }, { 'l1.txt': latin('na\xefve\ncaf\xe9\nx\ny\nz\nend\n') });
  assert.equal((await blob(dir, 'HEAD~1:l1.txt')).toString('hex'), latin('na\xefve\ncaf\xe9\nx\ny\nz\nend\n').toString('hex'));
  assert.ok((await blob(dir, 'HEAD:l1.txt')).equals(await blob(dir, `${orig}:l1.txt`)));
});

test('adding lines after a last line without a newline keeps them on their own lines', async () => {
  const dir = await repo();
  const base = await commit(dir, { 'n.txt': 'a\nb' }, 'base');
  const orig = await commit(dir, { 'n.txt': 'A\nb\nc' }, 'no final newline');
  await splitAndCheck(dir, base, orig, { 'n.txt': await keysFor(dir, orig, 'n.txt', /^c$/) }, { 'n.txt': 'a\nb\nc' });
  await git.run(dir, ['reset', '-q', '--hard', orig]);
  await splitAndCheck(dir, base, orig, { 'n.txt': await keysFor(dir, orig, 'n.txt', /^a$/) }, { 'n.txt': 'b' });
});

test('names git quotes ("quotes", backslash, tab, newline) can be split', async () => {
  const dir = await repo();
  const names = ['q"uote.txt', 'back\\slash.txt', 'tab\there.txt', 'new\nline.txt', 'emoji 🍊.txt'];
  const base = await commit(dir, Object.fromEntries(names.map((n) => [n, BASE])), 'base');
  const orig = await commit(dir, Object.fromEntries(names.map((n) => [n, CHANGED])), 'change');
  assert.deepEqual((await git.commitDiffs(dir, orig)).map((d) => d.path).sort(), [...names].sort());
  const files = {}, first = {};
  for (const [i, n] of names.entries()) {
    if (i % 2) { files[n] = 'all'; first[n] = CHANGED; }
    else { files[n] = await keysFor(dir, orig, n, /^[aA]$/); first[n] = BASE.replace('a\n', 'A\n'); }
  }
  await splitAndCheck(dir, base, orig, files, first);
});

test('submodule bumps go in whole, never line by line', async () => {
  const dir = await repo();
  const sub = await repo();
  const s1 = await commit(sub, { 's.txt': '1\n' }, 's1');
  const s2 = await commit(sub, { 's.txt': '2\n' }, 's2');
  const commitIndex = async (oid, k, msg) => {
    await git.run(dir, ['update-index', '--add', '--cacheinfo', `160000,${oid},mod`]);
    fs.writeFileSync(path.join(dir, 'k.txt'), k);
    await git.run(dir, ['add', 'k.txt']);
    await git.run(dir, ['commit', '-q', '-m', msg]);
    return rev(dir, 'HEAD');
  };
  const base = await commitIndex(s1, 'k\n', 'base');
  const orig = await commitIndex(s2, 'K\n', 'bump');
  const d = (await git.commitDiffs(dir, orig)).find((x) => x.path === 'mod');
  assert.ok(d.gitlink);
  assert.equal(d.hunks.length, 0);
  await git.rewrite(dir, 'split', orig, { files: { mod: 'all' }, messages: ['one', 'two'] });
  assert.equal((await git.run(dir, ['rev-parse', 'HEAD~1:mod'])).trim(), s2);
  assert.equal((await git.run(dir, ['rev-parse', 'HEAD~1:k.txt'])).trim(), (await git.run(dir, ['rev-parse', `${base}:k.txt`])).trim());
  assert.equal(await rev(dir, 'HEAD^{tree}'), await rev(dir, `${orig}^{tree}`));
});

test('both halves are signed when commit.gpgsign is on', async () => {
  const dir = await repo();
  const base = await commit(dir, { 'f.txt': BASE }, 'base');
  const orig = await commit(dir, { 'f.txt': CHANGED }, 'change');
  // A stand-in for gpg: emits a fixed signature and the status line git checks for.
  const fake = path.join(dir, '.git', 'fake-gpg');
  fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED D 1 8 00 0 X" >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n"\n', { mode: 0o755 });
  await git.run(dir, ['config', 'gpg.program', fake]);
  await git.run(dir, ['config', 'user.signingkey', 'TEST']);
  await git.run(dir, ['config', 'commit.gpgsign', 'true']);
  await git.rewrite(dir, 'split', orig, { files: { 'f.txt': await keysFor(dir, orig, 'f.txt', /^[aA]$/) }, messages: ['one', 'two'] });
  for (const r of ['HEAD', 'HEAD~1']) assert.match(await git.run(dir, ['cat-file', 'commit', r]), /^gpgsig -----BEGIN PGP SIGNATURE-----/m);
  assert.equal(await rev(dir, 'HEAD~2'), base);
});
