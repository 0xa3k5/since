'use strict';
// Autostash on branch switch (renderer/autostash.js, Journal.autostash). Throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');

const load = () => import('../renderer/autostash.js');

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, a);
  const write = (f, c) => fs.writeFileSync(path.join(dir, f), c);
  const commit = async (f, c, m) => { write(f, c); await git.run(dir, ['add', f]); await git.run(dir, ['commit', '-q', '-m', m]); };
  await commit('app.js', 'base\n', 'base');
  await git.run(dir, ['branch', 'feature']);
  await git.run(dir, ['checkout', '-q', 'feature']);
  await commit('app.js', 'feature\n', 'feature');
  await git.run(dir, ['checkout', '-q', 'main']);
  return { dir, write, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'), journal: new Journal(await git.openRepo(dir)), head: async () => (await git.run(dir, ['branch', '--show-current'])).trim() };
}
const checkoutErr = (dir, b) => git.run(dir, ['checkout', b]).then(() => null, (e) => `${e.stderr}\n${e.message}`);

test('carry-over: changes git can carry switch without a prompt', async () => {
  const { blockedCheckout } = await load();
  const { dir, write, read, head } = await repo();
  write('notes.txt', 'untracked\n');
  await git.run(dir, ['add', 'notes.txt']);
  assert.equal(await checkoutErr(dir, 'feature'), null);
  assert.equal(await head(), 'feature');
  assert.equal(read('notes.txt'), 'untracked\n');
  assert.equal(blockedCheckout(''), null);
  assert.equal(blockedCheckout('error: pathspec \'nope\' did not match any file(s) known to git'), null, 'other failures are plain errors');
});

test('prompt on conflict: a change the switch would overwrite is detected', async () => {
  const { blockedCheckout } = await load();
  const { dir, write, head } = await repo();
  write('app.js', 'mine\n');
  const out = await checkoutErr(dir, 'feature');
  assert.deepEqual(blockedCheckout(out), { untracked: false });
  assert.equal(await head(), 'main');
  // git's output is cut to its last lines in GitError.message; the tail still matches.
  assert.deepEqual(blockedCheckout('Please commit your changes or stash them before you switch branches.\nAborting'), { untracked: false });
});

test('untracked option: untracked files in the way force it on', async () => {
  const { blockedCheckout, autostashPlan } = await load();
  const { dir, write, journal, read, head } = await repo();
  await git.run(dir, ['checkout', '-q', 'feature']);
  write('extra.txt', 'tracked on feature\n');
  await git.run(dir, ['add', 'extra.txt']);
  await git.run(dir, ['commit', '-q', '-m', 'extra']);
  await git.run(dir, ['checkout', '-q', 'main']);
  write('extra.txt', 'mine, untracked\n');
  const blocked = blockedCheckout(await checkoutErr(dir, 'feature'));
  assert.deepEqual(blocked, { untracked: true });
  assert.deepEqual(autostashPlan({}, blocked), { ask: true, untracked: true });
  assert.deepEqual(autostashPlan({}, { untracked: false }), { ask: true, untracked: false }, 'off by default');
  const a = await journal.autostash('Checkout feature', 'feature', 'Auto-stash on main before switching to feature', true);
  assert.equal(await head(), 'feature');
  assert.equal(read('extra.txt'), 'tracked on feature\n');
  assert.equal(a.branch, 'main');
  assert.equal((await git.getStashes(dir))[0].message, 'On main: Auto-stash on main before switching to feature');
});

test("don't ask again: the saved preference skips the prompt and keeps the untracked choice", async () => {
  const { autostashPlan, AUTOSTASH_DEFAULT } = await load();
  assert.deepEqual(AUTOSTASH_DEFAULT, { ask: true, untracked: false });
  assert.deepEqual(autostashPlan({ ask: false, untracked: true }, { untracked: false }), { ask: false, untracked: true });
  assert.deepEqual(autostashPlan({ ask: false, untracked: false }, { untracked: false }), { ask: false, untracked: false });
});

test('stash and switch is one step: undo switches back and pops, redo stashes again', async () => {
  const { stashMessage } = await load();
  const { dir, write, read, journal, head } = await repo();
  write('app.js', 'mine\n');
  const msg = stashMessage('main', 'feature');
  assert.equal(msg, 'Auto-stash on main before switching to feature');
  await journal.autostash('Checkout feature', 'feature', msg, false);
  assert.equal(await head(), 'feature');
  assert.equal(read('app.js'), 'feature\n');
  assert.equal((await git.getStashes(dir)).length, 1);
  await journal.step('undo');
  assert.equal(await head(), 'main');
  assert.equal(read('app.js'), 'mine\n');
  assert.equal((await git.getStashes(dir)).length, 0);
  await journal.step('redo');
  assert.equal(await head(), 'feature');
  assert.equal(read('app.js'), 'feature\n');
  assert.equal((await git.getStashes(dir))[0].message, `On main: ${msg}`);
  await journal.step('undo');
  assert.equal(read('app.js'), 'mine\n');
});

test('redo with nothing to stash again refuses instead of adopting an unrelated stash', async () => {
  const { dir, write, read, journal, head } = await repo();
  write('app.js', 'other\n');
  await git.stashPush(dir, { message: 'unrelated' });
  write('app.js', 'mine\n');
  await journal.autostash('Checkout feature', 'feature', 'Auto-stash on main before switching to feature', false);
  await journal.step('undo');
  assert.equal(read('app.js'), 'mine\n');
  await git.run(dir, ['checkout', '--', 'app.js']); // the changes are cleared outside GitLanes
  await assert.rejects(journal.step('redo'), /no changes to stash/);
  assert.equal(await head(), 'main');
  const stashes = await git.getStashes(dir);
  assert.equal(stashes.length, 1, 'the unrelated stash is untouched');
  assert.equal(stashes[0].message, 'On main: unrelated');
});

test('a switch that still fails pops the stash back and records nothing', async () => {
  const { dir, write, read, journal, head } = await repo();
  write('app.js', 'mine\n');
  await assert.rejects(journal.autostash('Checkout nope', 'nope', 'm', false));
  assert.equal(await head(), 'main');
  assert.equal(read('app.js'), 'mine\n');
  assert.equal((await git.getStashes(dir)).length, 0);
  assert.equal(journal.list().undo.length, 0);
});

test('return toast: offered once on the stashed branch, dropped when the stash is gone', async () => {
  const { returnOffer } = await load();
  const stashes = [{ ref: 'stash@{0}', sha: 'aaa', message: 'On main: Auto-stash' }];
  const recs = [{ root: '/r', branch: 'main', sha: 'aaa' }, { root: '/r', branch: 'dev', sha: 'gone' }, { root: '/other', branch: 'main', sha: 'zzz' }];
  assert.equal(returnOffer(recs, '/r', 'feature', stashes).offer, null, 'another branch: nothing to offer');
  const r = returnOffer(recs, '/r', 'main', stashes);
  assert.deepEqual(r.offer, { root: '/r', branch: 'main', sha: 'aaa', ref: 'stash@{0}', message: 'On main: Auto-stash' });
  assert.deepEqual(r.records, [{ root: '/other', branch: 'main', sha: 'zzz' }], 'offered once; stale records of this repo pruned, other repos kept');
});

test('return toast: the stash is found by sha after others were stashed on top', async () => {
  const { stashRefBySha } = await load();
  const before = [{ ref: 'stash@{0}', sha: 'aaa' }];
  const after = [{ ref: 'stash@{0}', sha: 'new' }, { ref: 'stash@{1}', sha: 'aaa' }];
  assert.equal(stashRefBySha(before, 'aaa'), 'stash@{0}');
  assert.equal(stashRefBySha(after, 'aaa'), 'stash@{1}', 'position shifted: follow the sha, not the old index');
  assert.equal(stashRefBySha(after, 'gone'), null);
  assert.equal(stashRefBySha(null, 'aaa'), null);
});

test('undoing a plain checkout leaves the branch it switched to where it was', async () => {
  const { dir, journal, head } = await repo();
  const before = await git.captureRefState(dir);
  await journal.record('Checkout feature', 'checkout', () => git.run(dir, ['checkout', '-q', 'feature']));
  await journal.step('undo');
  assert.equal(await head(), 'main');
  assert.deepEqual(await git.captureRefState(dir), before);
});

test('stashing with untracked files removes them from the working tree', async () => {
  const { dir, write } = await repo();
  write('new.txt', 'untracked\n');
  await git.stashPush(dir, { message: 'm', untracked: true });
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
});
