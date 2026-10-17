'use strict';
// Submodules: listing with state, undoable init/update, and the diff pointer summary.
// Every test runs in throwaway repos in the temp dir.
// Local file:// submodule clones are off by default since git 2.38; allow them for these repos.
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
process.env.GIT_CONFIG_VALUE_0 = 'always';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const ipc = require('../ipc');
const load = () => import('../renderer/submodule.js');

async function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await git.run(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) await git.run(dir, ['config', k, v]);
}
const commit = async (dir, file, text) => {
  fs.writeFileSync(path.join(dir, file), text);
  await git.run(dir, ['add', file]);
  await git.run(dir, ['commit', '-q', '-m', text]);
  return (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
};
const head = async (dir) => (await git.run(dir, ['rev-parse', 'HEAD'])).trim();

// app/ with submodule lib/ (from ../lib-src) recorded at its first commit; then clone that as
// `fresh` so the submodule starts uninitialised.
async function setup() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-sub-')));
  const src = path.join(parent, 'lib-src'), app = path.join(parent, 'app');
  await init(src);
  const c1 = await commit(src, 'lib.txt', 'one\n');
  const c2 = await commit(src, 'lib.txt', 'two\n');
  await git.run(src, ['checkout', '-q', c1]);
  await init(app);
  await commit(app, 'a.txt', 'a\n');
  await git.run(app, ['submodule', 'add', '-q', src, 'lib']);
  await git.run(app, ['commit', '-q', '-m', 'add lib']);
  await git.run(src, ['checkout', '-q', 'main']);
  const fresh = path.join(parent, 'fresh');
  await git.run(parent, ['clone', '-q', app, fresh]);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 't@example.com']]) await git.run(fresh, ['config', k, v]);
  return { app, fresh, src, c1, c2 };
}

test('getSubmodules reports name, url and each state', async () => {
  const { app, fresh, src, c1, c2 } = await setup();
  let [m] = await git.getSubmodules(app);
  assert.deepEqual({ ...m }, { path: 'lib', name: 'lib', url: src, recorded: c1, head: c1, branch: null, state: 'clean' });
  [m] = await git.getSubmodules(fresh);
  assert.equal(m.state, 'uninitialized');
  assert.equal(m.head, null);
  fs.writeFileSync(path.join(app, 'lib', 'new.txt'), 'x');
  assert.equal((await git.getSubmodules(app))[0].state, 'modified');
  fs.rmSync(path.join(app, 'lib', 'new.txt'));
  await git.run(path.join(app, 'lib'), ['checkout', '-q', c2]);
  assert.equal((await git.getSubmodules(app))[0].state, 'outdated');
  assert.deepEqual(await git.getSubmodules(src), []);
});

test('parseGitmodules maps paths to names and urls', () => {
  const m = git.parseGitmodules('submodule.a b.path\nvendor/a b\0submodule.a b.url\nhttps://x/a.git\0submodule.nopath.url\nu\0');
  assert.deepEqual([...m], [['vendor/a b', { name: 'a b', url: 'https://x/a.git' }]]);
});

test('updating an out-of-date submodule is undoable and redoable, back onto its branch', async () => {
  const { app, c1, c2 } = await setup();
  const lib = path.join(app, 'lib');
  await git.run(lib, ['checkout', '-q', '-B', 'work', c2]);
  const journal = new Journal(await git.openRepo(app));
  assert.equal(await journal.runSubmodules('Update lib', ['lib']), 1);
  assert.equal(await head(lib), c1);
  assert.equal((await git.getSubmodules(app))[0].state, 'clean');
  assert.equal(await journal.step('undo'), 'Update lib');
  assert.equal(await head(lib), c2);
  assert.equal((await git.run(lib, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'work');
  await journal.step('redo');
  assert.equal(await head(lib), c1);
});

test('initialising is undone by deinit and redone without the source', async () => {
  const { fresh, src, c1 } = await setup();
  const journal = new Journal(await git.openRepo(fresh));
  await journal.runSubmodules('Update submodules', []);
  assert.equal((await git.getSubmodules(fresh))[0].head, c1);
  await journal.step('undo');
  assert.equal((await git.getSubmodules(fresh))[0].state, 'uninitialized');
  fs.rmSync(src, { recursive: true, force: true });
  await journal.step('redo');
  assert.equal((await git.getSubmodules(fresh))[0].state, 'clean');
});

test('update refuses a submodule with local changes, and undo refuses one that moved', async () => {
  const { app, c2 } = await setup();
  const lib = path.join(app, 'lib');
  const journal = new Journal(await git.openRepo(app));
  fs.writeFileSync(path.join(lib, 'lib.txt'), 'edited\n');
  await assert.rejects(journal.runSubmodules('Update', ['lib']), /local changes/);
  await git.run(lib, ['checkout', '-q', '--', 'lib.txt']);
  await git.run(lib, ['checkout', '-q', c2]);
  await journal.runSubmodules('Update', ['lib']);
  await git.run(lib, ['checkout', '-q', c2]);
  await assert.rejects(journal.step('undo'), /moved since/);
  await assert.rejects(git.updateSubmodules(app, ['nope']), /no longer exists/);
});

test('updateSubmodules arguments must be repository paths', () => {
  assert.deepEqual(ipc.checkGit('updateSubmodules', []).args, []);
  assert.deepEqual(ipc.checkGit('updateSubmodules', [['lib']]).args, [['lib']]);
  assert.throws(() => ipc.checkGit('updateSubmodules', [['../x']]));
  assert.throws(() => ipc.checkGit('updateSubmodules', ['lib']));
});

test('submoduleChange reads pointer moves from a submodule diff', async () => {
  const { submoduleChange, describeSubmoduleChange } = await load();
  const diff = (header, lines) => ({ header: ['diff --git a/lib b/lib', ...header], hunks: [{ lines }] });
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const moved = submoduleChange(diff(['index aaaaaaa..bbbbbbb 160000'], [{ t: '-', s: `Subproject commit ${a}` }, { t: '+', s: `Subproject commit ${b}-dirty` }]));
  assert.deepEqual(moved, { from: a, to: b, dirty: true });
  assert.equal(describeSubmoduleChange(moved), 'aaaaaaa → bbbbbbb · has uncommitted changes');
  assert.equal(describeSubmoduleChange(submoduleChange(diff(['new file mode 160000'], [{ t: '+', s: `Subproject commit ${b}` }]))), 'Added at bbbbbbb');
  assert.equal(describeSubmoduleChange({ from: a, to: null, dirty: false }), 'Removed (was aaaaaaa)');
  assert.equal(submoduleChange(diff(['index 1..2 100644'], [{ t: '+', s: `Subproject commit ${b}` }])), null);
});

test('a real submodule bump diff parses into a pointer change', async () => {
  const { submoduleChange } = await load();
  const { app, c1, c2 } = await setup();
  await git.run(path.join(app, 'lib'), ['checkout', '-q', c2]);
  const d = await git.workingDiff(app, { path: 'lib', status: 'M' }, { staged: false });
  assert.deepEqual(submoduleChange(d), { from: c1, to: c2, dirty: false });
});

test('update checks out the recorded commit even with submodule.<name>.update=rebase, so undo is exact', async () => {
  const { app, c1, c2 } = await setup();
  const lib = path.join(app, 'lib');
  await git.run(app, ['config', 'submodule.lib.update', 'rebase']);
  await git.run(lib, ['checkout', '-q', '-B', 'work', c2]);
  const journal = new Journal(await git.openRepo(app));
  assert.equal(await journal.runSubmodules('Update lib', ['lib']), 1);
  assert.equal(await head(lib), c1);
  assert.equal((await git.run(lib, ['rev-parse', 'refs/heads/work'])).trim(), c2);
  await journal.step('undo');
  assert.equal((await git.run(lib, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'work');
  assert.equal(await head(lib), c2);
});
