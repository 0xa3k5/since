'use strict';
// Unified changes: the combined staged/unstaged diff and staging by file, hunk and line
// (git.combinedDiff, git.setStaged, journal stageChanges/unstageChanges). Temp repos only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  const journal = new Journal(await git.openRepo(dir));
  return { dir, journal, write: (f, c) => fs.writeFileSync(path.join(dir, f), c) };
}
async function commit(dir, file, content) {
  fs.writeFileSync(path.join(dir, file), content);
  await git.run(dir, ['add', file]);
  await git.run(dir, ['commit', '-q', '-m', `add ${file}`]);
}
const index = (dir) => git.run(dir, ['ls-files', '-s']);
const file = { path: 'f.txt', status: 'M' };
const changed = (d) => d.hunks.flatMap((h, hi) => h.lines.map((l, li) => ({ ...l, key: `${hi}:${li}` }))).filter((l) => l.t !== ' ');
const id = (l) => `${l.t}${l.t === '-' ? l.o : l.n}:${l.s}`;
// The changed lines of `git diff --cached`, as "+text" / "-text" in order.
const cachedLines = async (dir) => (await git.run(dir, ['diff', '--cached', '--no-color', '-U0', '--', 'f.txt']))
  .split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));

// Small seeded PRNG so a failure is reproducible.
function rng(seed) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}
function edit(lines, rand, tag) {
  const out = [];
  lines.forEach((l, i) => {
    const r = rand();
    if (r < 0.15) return; // deleted
    if (r < 0.3) out.push(`${tag} changed ${i}`);
    else out.push(l);
    if (rand() < 0.12) out.push(`${tag} inserted after ${i}`);
  });
  return out;
}

test('combinedDiff marks each changed line staged or unstaged and counts them', async () => {
  const { dir, write } = await repo();
  await commit(dir, 'f.txt', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\n');
  write('f.txt', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nM\nn\nextra\n');
  await git.run(dir, ['add', 'f.txt']);
  write('f.txt', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nM2\nn\nextra\nmore\n');
  const d = await git.combinedDiff(dir, file);
  assert.equal(d.wholeFile, null);
  assert.equal(d.hunks.length, 2);
  const [h0, h1] = d.hunks;
  assert.deepEqual(h0.lines.filter((l) => l.t !== ' ').map((l) => [l.t, l.s, l.staged]), [['-', 'b', true], ['+', 'B', true]]);
  assert.equal(h0.staged, 2); assert.equal(h0.total, 2);
  // "M" was staged, then edited to "M2": the staged line is hidden and M2 is flagged.
  const c1 = h1.lines.filter((l) => l.t !== ' ').map((l) => [l.t, l.s, l.staged, !!l.edited]);
  assert.deepEqual(c1, [['-', 'm', true, false], ['+', 'M2', false, true], ['+', 'extra', true, false], ['+', 'more', false, false]]);
  assert.equal(d.hidden, 1);
  assert.equal(d.staged, 4); assert.equal(d.total, 6); assert.equal(d.state, 'partial');
  assert.equal(h1.header, '@@ -10,5 +10,7 @@');

  // Staging the edited line replaces the staged "M" with "M2".
  const m2 = changed(d).find((l) => l.s === 'M2');
  await git.setStaged(dir, file, [m2.key], true);
  assert.equal((await git.run(dir, ['show', ':f.txt'])).includes('\nM2\n'), true);
  assert.equal((await git.run(dir, ['show', ':f.txt'])).includes('\nM\n'), false);
  const after = await git.combinedDiff(dir, file);
  assert.equal(after.hidden, 0);
  assert.equal(after.staged, 5);
});

test('random line selections stage and unstage exactly, and undo restores the index', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rand = rng(seed);
    const { dir, journal, write } = await repo();
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    await commit(dir, 'f.txt', base.join('\n') + '\n');
    write('f.txt', edit(base, rand, `s${seed}`).join('\n') + '\n');
    const all = changed(await git.combinedDiff(dir, file));
    if (!all.length) continue;
    const pick = all.filter(() => rand() < 0.5);
    const before = await index(dir);
    await journal.runWork('stageChanges', 'Stage lines', [file, pick.map((l) => l.key)]);
    const d = await git.combinedDiff(dir, file);
    const stagedNow = changed(d).filter((l) => l.staged);
    assert.deepEqual(stagedNow.map(id), pick.map(id), `seed ${seed}: staged lines`);
    assert.deepEqual(await cachedLines(dir), pick.map((l) => l.t + l.s), `seed ${seed}: git diff --cached`);
    assert.equal(d.staged, pick.length);
    assert.equal(d.total, all.length);

    // Unstage some of them; the rest stay staged.
    const mid = await index(dir);
    const drop = changed(d).filter((l) => l.staged && rand() < 0.5);
    await journal.runWork('unstageChanges', 'Unstage lines', [file, drop.map((l) => l.key)]);
    const dropped = new Set(drop.map(id));
    assert.deepEqual(changed(await git.combinedDiff(dir, file)).filter((l) => l.staged).map(id), pick.map(id).filter((x) => !dropped.has(x)), `seed ${seed}: unstaged`);

    // Re-staging the dropped lines puts the index back where it was.
    if (drop.length) {
      const back = changed(await git.combinedDiff(dir, file)).filter((l) => dropped.has(id(l)));
      await journal.runWork('stageChanges', 'Stage lines', [file, back.map((l) => l.key)]);
      assert.equal(await index(dir), mid, `seed ${seed}: restage`);
      await journal.step('undo');
    }
    await journal.step('undo');
    assert.equal(await index(dir), mid, `seed ${seed}: undo unstage`);
    await journal.step('undo');
    assert.equal(await index(dir), before, `seed ${seed}: undo stage`);
    await journal.step('redo');
    assert.equal(await index(dir), mid, `seed ${seed}: redo stage`);
  }
});

test('whole hunks and whole files stage and unstage as one undo step each', async () => {
  const { dir, journal, write } = await repo();
  const base = Array.from({ length: 30 }, (_, i) => `l${i}`);
  await commit(dir, 'f.txt', base.join('\n') + '\n');
  const next = [...base]; next[2] = 'X'; next[25] = 'Y';
  write('f.txt', next.join('\n') + '\n');
  const before = await index(dir);
  await journal.runWork('stageChanges', 'Stage hunk', [file, ['1:*']]);
  let d = await git.combinedDiff(dir, file);
  assert.deepEqual(d.hunks.map((h) => h.staged), [0, 2]);
  await journal.runWork('stageChanges', 'Stage file', [file, 'all']);
  d = await git.combinedDiff(dir, file);
  assert.equal(d.state, 'all');
  await journal.runWork('unstageChanges', 'Unstage file', [file, 'all']);
  assert.equal(await index(dir), before);
  await journal.step('undo');
  assert.equal((await git.combinedDiff(dir, file)).state, 'all');
  await journal.step('undo');
  assert.deepEqual((await git.combinedDiff(dir, file)).hunks.map((h) => h.staged), [0, 2]);
  // Editing the file after staging doesn't block undoing the staging.
  write('f.txt', next.join('\n') + '\nlater\n');
  await journal.step('undo');
  assert.equal(await index(dir), before);
  assert.ok(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8').endsWith('later\n'), 'undo leaves the working tree alone');
});

test('untracked files stage by line; binary, deleted, renamed and conflicted files are flagged', async () => {
  const { dir, write } = await repo();
  await commit(dir, 'f.txt', 'one\ntwo\n');
  write('new.txt', 'a\nb\nc\n');
  const nf = { path: 'new.txt', status: '?' };
  let d = await git.combinedDiff(dir, nf);
  assert.equal(d.untracked, true);
  assert.equal(d.total, 3);
  await git.setStaged(dir, nf, ['0:1'], true);
  assert.equal(await git.run(dir, ['show', ':new.txt']), 'b\n');
  d = await git.combinedDiff(dir, nf);
  assert.deepEqual(changed(d).map((l) => [l.s, l.staged]), [['a', false], ['b', true], ['c', false]]);

  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
  d = await git.combinedDiff(dir, { path: 'bin.dat', status: '?' });
  assert.equal(d.wholeFile, 'binary');
  assert.equal(d.total, 1);
  await assert.rejects(git.setStaged(dir, { path: 'bin.dat' }, ['0:0'], true), /whole file/);
  await git.setStaged(dir, { path: 'bin.dat' }, 'all', true);
  assert.equal((await git.combinedDiff(dir, { path: 'bin.dat' })).state, 'all');

  fs.rmSync(path.join(dir, 'f.txt'));
  d = await git.combinedDiff(dir, { path: 'f.txt', status: 'D' });
  assert.equal(d.wholeFile, 'deleted');
  assert.deepEqual(changed(d).map((l) => [l.t, l.s, l.staged]), [['-', 'one', false], ['-', 'two', false]]);
  await git.setStaged(dir, { path: 'f.txt' }, 'all', true);
  assert.equal((await git.combinedDiff(dir, { path: 'f.txt' })).state, 'all');

  await git.run(dir, ['commit', '-q', '-am', 'drop f']);
  await commit(dir, 'r.txt', 'x\ny\nz\n');
  await git.run(dir, ['mv', 'r.txt', 'r2.txt']);
  d = await git.combinedDiff(dir, { path: 'r2.txt', oldPath: 'r.txt', status: 'R' });
  assert.equal(d.wholeFile, 'renamed');
  assert.equal(d.oldPath, 'r.txt');
  await git.setStaged(dir, { path: 'r2.txt', oldPath: 'r.txt' }, 'all', false);
  assert.equal((await git.run(dir, ['ls-files'])).split('\n').includes('r.txt'), true, 'unstaging a rename puts the old path back');
});

test('conflicted files are flagged and left alone', async () => {
  const { dir, write } = await repo();
  await commit(dir, 'f.txt', 'base\n');
  await git.run(dir, ['checkout', '-q', '-b', 'other']);
  await commit(dir, 'f.txt', 'theirs\n');
  await git.run(dir, ['checkout', '-q', 'main']);
  await commit(dir, 'f.txt', 'ours\n');
  await git.run(dir, ['merge', 'other'], { allowCodes: [0, 1] });
  const d = await git.combinedDiff(dir, file);
  assert.equal(d.conflict, true);
  assert.equal(d.wholeFile, 'conflict');
  await assert.rejects(git.setStaged(dir, file, ['0:0'], true), /conflict/);
  write('f.txt', 'x\n');
});

test('files over 400 changed lines come back collapsed and load hunks on demand', async () => {
  const { dir, write } = await repo();
  const base = Array.from({ length: 1000 }, (_, i) => `l${i}`);
  await commit(dir, 'f.txt', base.join('\n') + '\n');
  write('f.txt', base.map((l, i) => (i % 2 ? l : `${l}!`)).join('\n') + '\n');
  const d = await git.combinedDiff(dir, file);
  assert.equal(d.collapsed, true);
  assert.equal(d.total, 1000);
  assert.ok(d.hunks.every((h) => h.lines === null && h.total > 0 && h.header.startsWith('@@')));
  const one = await git.combinedDiff(dir, file, { hunks: [0] });
  assert.equal(one.collapsed, false);
  assert.ok(one.hunks[0].lines.length > 0);
  assert.equal(one.hunks.slice(1).every((h) => h.lines === null), true);
  // Whole hunks stage without loading their lines.
  await git.setStaged(dir, file, ['0:*'], true);
  assert.equal((await git.combinedDiff(dir, file)).staged, d.hunks[0].total);
});
