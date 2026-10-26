'use strict';
// Lanes → Clean up: grouping stale lanes (renderer/cleanup.js over git.lanes), bulk removal
// (git.cleanupLanes) and its single undo step (Journal.runCleanup), remote deletion.
// Every test runs in throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const { Journal } = require('../journal');
const { checkGit } = require('../ipc');

const load = () => import('../renderer/cleanup.js');
let clock = 1700000000;
const g = (dir, args, opts = {}) => git.run(dir, args, { ...opts, env: { GIT_COMMITTER_DATE: `${clock} +0000`, GIT_AUTHOR_DATE: `${clock} +0000`, ...opts.env } });
async function commit(dir, file, content, msg = `edit ${file}`) {
  clock += 60;
  fs.writeFileSync(path.join(dir, file), content);
  await g(dir, ['add', file]);
  await g(dir, ['commit', '-q', '-m', msg]);
}
async function repo() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-cleanup-')));
  const dir = path.join(parent, 'app');
  fs.mkdirSync(dir);
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.name', 'Test']);
  await g(dir, ['config', 'user.email', 't@example.com']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  await commit(dir, 'a.txt', 'a\n', 'base');
  return { parent, dir };
}
const tip = async (dir, ref) => (await git.run(dir, ['rev-parse', '-q', '--verify', ref], { allowCodes: [0, 1] })).trim() || null;
const names = async (dir) => (await git.getWorktrees(dir)).map((w) => w.name).sort();
const byName = (lanes) => Object.fromEntries(lanes.map((l) => [l.name, l]));

// One lane per cleanup group, plus lanes that must never be offered or pre-ticked.
async function staleRepo() {
  const { parent, dir } = await repo();
  // merged: fast-forwarded into main
  await g(dir, ['switch', '-q', '-c', 'merged']); await commit(dir, 'm.txt', 'm\n');
  await g(dir, ['switch', '-q', 'main']); await g(dir, ['merge', '-q', '--ff-only', 'merged']);
  await commit(dir, 'b.txt', 'b\n');
  // squashed: its changes land on main as one squash commit
  await g(dir, ['switch', '-q', '-c', 'squashed']); await commit(dir, 's1.txt', '1\n'); await commit(dir, 's2.txt', '2\n');
  await g(dir, ['switch', '-q', 'main']); await g(dir, ['merge', '-q', '--squash', 'squashed']); await g(dir, ['commit', '-q', '-m', 'squash']);
  // wt-merged: a worktree whose branch was merged
  await git.addWorktree(dir, { branch: 'wt-merged', base: 'merged' });
  // missing: a worktree whose folder was deleted by hand
  await git.addWorktree(dir, { branch: 'missing' });
  fs.rmSync(path.join(parent, 'app-missing'), { recursive: true });
  // gone: tracked a remote branch that was deleted
  await g(dir, ['switch', '-q', '-c', 'gone']); await commit(dir, 'g.txt', 'g\n');
  await g(dir, ['config', 'branch.gone.remote', 'origin']);
  await g(dir, ['config', 'branch.gone.merge', 'refs/heads/gone']);
  await g(dir, ['remote', 'add', 'origin', 'https://example.invalid/x.git']);
  // empty: at main's tip, nothing ahead
  await g(dir, ['switch', '-q', 'main']); await g(dir, ['branch', 'empty']);
  // old: ahead, untouched for 60 days
  await g(dir, ['switch', '-q', '-c', 'old']);
  clock -= 60 * 86400; await commit(dir, 'o.txt', 'o\n'); clock += 60 * 86400;
  // fresh: ahead and recent (not stale); dirty: a worktree of a merged branch with an edit
  await g(dir, ['switch', '-q', '-c', 'fresh', 'main']); await commit(dir, 'f.txt', 'f\n');
  await git.addWorktree(dir, { branch: 'dirty', base: 'merged' });
  fs.writeFileSync(path.join(parent, 'app-dirty', 'a.txt'), 'edited\n');
  await g(dir, ['switch', '-q', 'main']);
  return { parent, dir };
}

test('cleanup groups: every finished lane by default; age is an opt-in filter; dirty lanes apart and unticked', async () => {
  const { dir } = await staleRepo();
  const { groupLanes, preselect, blocked, dirty, reason } = await load();
  const { lanes } = await git.lanes(dir);
  const now = (clock + 60) * 1000;
  const ids = (gs) => Object.fromEntries(gs.flatMap((x) => x.lanes.map((l) => [l.name, x.group.id])));
  // Default: no age filter. Finished lanes show whatever their age; fresh, empty and old-but-open don't.
  assert.deepEqual(ids(groupLanes(lanes, { now })), { merged: 'merged', squashed: 'merged', 'wt-merged': 'mergedWorktree', dirty: 'dirty', missing: 'missing', gone: 'gone' });
  const groups = groupLanes(lanes, { days: 30, now });
  assert.deepEqual(ids(groups), { merged: 'merged', squashed: 'merged', 'wt-merged': 'mergedWorktree', dirty: 'dirty', missing: 'missing', gone: 'gone', old: 'old' });
  assert.equal(groupLanes(lanes, { days: 90, now }).some((x) => x.group.id === 'old'), false);
  assert.equal(groups.at(-1).group.id, 'dirty');
  assert.ok(groups.at(-1).group.warn);
  // Shipped without a merge git can see (a PR merge, a matching subject), however old: offered with the merged ones.
  const { cleanupGroup } = await load();
  const pr = { name: 'pr', head: 'a'.repeat(40), done: { reason: 'pr', pr: 3 }, merged: null, worktree: null, activity: 1 };
  assert.equal(cleanupGroup(pr, { now }), 'merged');
  assert.equal(cleanupGroup({ ...pr, worktree: { path: '/w' }, changes: 2 }, { now }), 'dirty');
  const l = byName(groups.flatMap((x) => x.lanes));
  // Reasons: the PR, the base commit with the same change, a gone remote, a missing folder.
  assert.equal(reason(pr), 'Merged in #3');
  const squash = await tip(dir, 'main'); // the squash commit
  assert.equal(l.squashed.mergedAs, squash);
  assert.equal(reason(l.squashed), `Same change as ${squash.slice(0, 7)}`);
  assert.equal(reason({ done: { reason: 'key', key: 'AK-7', sha: squash } }), `AK-7 landed in ${squash.slice(0, 7)}`, 'a key match names the key, not the change');
  assert.equal(reason(l.gone), 'Remote gone');
  assert.equal(reason(l.missing), 'Folder missing');
  assert.equal(reason(l.merged), 'Merged');
  assert.equal(reason(l.old, { days: 30 }), 'Untouched for 30+ days');
  assert.equal(dirty(l.dirty), 1);
  assert.equal(preselect(l.dirty), false);
  assert.equal(preselect(l['wt-merged']), true);
  assert.equal(preselect(l.missing), true);
  assert.equal(blocked({ worktree: { current: true } }), 'Open in this window');
  assert.equal(blocked({ worktree: { main: true } }), 'Checked out in the main worktree');
});

test('cleanupLanes removes worktrees and branches; one undo puts them all back, redo removes again', async () => {
  const { parent, dir } = await staleRepo();
  const { groupLanes, preselect, cleanupItem } = await load();
  const journal = new Journal(await git.openRepo(dir));
  const { lanes } = await git.lanes(dir);
  const picked = groupLanes(lanes, { days: 30, now: (clock + 60) * 1000 }).flatMap((x) => x.lanes).filter(preselect);
  const before = Object.fromEntries(await Promise.all(picked.map(async (l) => [l.name, await tip(dir, `refs/heads/${l.name}`)])));
  const progress = [];
  const res = await journal.runCleanup('Clean up', picked.map(cleanupItem), { onProgress: (p) => progress.push(p) });
  assert.deepEqual(res.failed, []);
  assert.deepEqual(res.deleted.sort(), Object.keys(before).sort());
  assert.deepEqual(res.removed.map((w) => [path.basename(w.path), w.pruned]).sort(), [['app-missing', true], ['app-wt-merged', false]]);
  assert.deepEqual(progress.at(-1), { done: 3, total: 3 }); // two worktrees, one branch batch
  for (const b of Object.keys(before)) assert.equal(await tip(dir, `refs/heads/${b}`), null);
  assert.deepEqual(await names(dir), ['app', 'app-dirty']);
  assert.equal(journal.undo.length, 1);

  // Another branch moving in between doesn't block undo.
  await g(dir, ['branch', '-f', 'fresh', 'main']);
  assert.equal(await journal.step('undo'), 'Clean up');
  for (const [b, sha] of Object.entries(before)) assert.equal(await tip(dir, `refs/heads/${b}`), sha);
  assert.deepEqual(await names(dir), ['app', 'app-dirty', 'app-wt-merged']); // the missing one stays pruned
  assert.ok(fs.existsSync(path.join(parent, 'app-wt-merged', 'm.txt')));

  assert.equal(await journal.step('redo'), 'Clean up');
  for (const b of Object.keys(before)) assert.equal(await tip(dir, `refs/heads/${b}`), null);
  assert.deepEqual(await names(dir), ['app', 'app-dirty']);
});

test('cleanupLanes: dirty worktrees need force, and undo brings them back with their changes', async () => {
  const { parent, dir } = await staleRepo();
  const journal = new Journal(await git.openRepo(dir));
  const head = await tip(dir, 'refs/heads/dirty');
  const wt = path.join(parent, 'app-dirty');
  let res = await journal.runCleanup('Clean up dirty', [{ branch: 'dirty', head, worktree: wt }]);
  assert.match(res.failed[0].message, /1 uncommitted change/);
  assert.equal(await tip(dir, 'refs/heads/dirty'), head); // its branch is kept with it
  assert.equal(journal.undo.length, 0);
  res = await journal.runCleanup('Clean up dirty', [{ branch: 'dirty', head, worktree: wt, force: true }]);
  assert.deepEqual(res.failed, []);
  assert.equal(res.removed[0].lost, 1);
  assert.equal(fs.existsSync(wt), false);
  await journal.step('undo');
  assert.equal(await git.worktreeChanges(wt), 1); // from the stash taken (and dropped) when it was removed
  assert.equal((await git.getStashes(dir)).length, 0);
});

test('cleanupLanes keeps a branch that moved since, and a folder in the way is reported on undo', async () => {
  const { parent, dir } = await staleRepo();
  const journal = new Journal(await git.openRepo(dir));
  const seen = await tip(dir, 'refs/heads/merged');
  await g(dir, ['branch', '-f', 'merged', 'fresh']);
  const res = await journal.runCleanup('Clean up', [{ branch: 'merged', head: seen }, { branch: 'wt-merged', head: await tip(dir, 'refs/heads/wt-merged'), worktree: path.join(parent, 'app-wt-merged') }]);
  assert.deepEqual(res.failed.map((f) => f.name), ['merged']);
  assert.ok(await tip(dir, 'refs/heads/merged'));
  fs.mkdirSync(path.join(parent, 'app-wt-merged'));
  fs.writeFileSync(path.join(parent, 'app-wt-merged', 'x'), 'x');
  assert.match(await journal.step('undo'), /couldn't re-add app-wt-merged/);
  assert.ok(await tip(dir, 'refs/heads/wt-merged'));
});

test('undo of a cleanup refuses when a deleted branch was recreated elsewhere', async () => {
  const { dir } = await staleRepo();
  const journal = new Journal(await git.openRepo(dir));
  await journal.runCleanup('Clean up', [{ branch: 'empty', head: await tip(dir, 'refs/heads/empty') }]);
  await g(dir, ['branch', 'empty', 'fresh']);
  await assert.rejects(journal.step('undo'), /empty changed since/);
});

test('cleanupLanes handles hundreds of branches in batched calls', async () => {
  const { dir } = await repo();
  const head = await tip(dir, 'HEAD');
  const many = Array.from({ length: 450 }, (_, i) => `agent/task-${i}`);
  await git.run(dir, ['update-ref', '--stdin'], { input: many.map((b) => `create refs/heads/${b} ${head}\n`).join('') });
  const journal = new Journal(await git.openRepo(dir));
  const progress = [];
  const res = await journal.runCleanup('Clean up 450', many.map((b) => ({ branch: b, head })), { onProgress: (p) => progress.push(p) });
  assert.equal(res.deleted.length, 450);
  assert.deepEqual(progress.map((p) => p.done), [1, 2, 3]); // 200 per `git branch -D`
  await journal.step('undo');
  assert.equal((await git.run(dir, ['for-each-ref', '--format=x', 'refs/heads/agent'])).trim().split('\n').length, 450);
});

test('deleteRemoteBranches deletes on the remote in one push per remote', async () => {
  const { parent, dir } = await repo();
  const bare = path.join(parent, 'remote.git');
  await git.run(parent, ['init', '-q', '--bare', bare]);
  await g(dir, ['remote', 'add', 'origin', bare]);
  await g(dir, ['branch', 'x']); await g(dir, ['branch', 'y']);
  await g(dir, ['push', '-q', 'origin', 'main', 'x', 'y']);
  await g(dir, ['fetch', '-q', 'origin']);
  const res = await git.deleteRemoteBranches(dir, ['origin/x', 'origin/y', 'nope/z']);
  assert.deepEqual(res.deleted.sort(), ['origin/x', 'origin/y']);
  assert.deepEqual(res.failed.map((f) => f.name), ['nope/z']);
  assert.equal(await tip(bare, 'refs/heads/x'), null);
  assert.ok(await tip(bare, 'refs/heads/main'));
});

test('deleteRemoteBranches never deletes the default branch or a tracked one (AK-576)', async () => {
  const { parent, dir } = await repo();
  const bare = path.join(parent, 'remote.git');
  await git.run(parent, ['init', '-q', '--bare', bare]);
  await g(dir, ['remote', 'add', 'origin', bare]);
  await g(dir, ['branch', 'x']); await g(dir, ['branch', 'y']);
  await g(dir, ['push', '-q', 'origin', 'main', 'x', 'y']);
  await g(dir, ['fetch', '-q', 'origin']);
  await g(dir, ['branch', '--set-upstream-to=origin/y', 'x']);
  const res = await git.deleteRemoteBranches(dir, ['origin/main', 'origin/main', 'origin/y', 'origin/x', 'origin/x']);
  assert.deepEqual(res.deleted, ['origin/x']);
  assert.deepEqual(res.failed.map((f) => f.name), ['origin/main', 'origin/y']);
  assert.ok(await tip(bare, 'refs/heads/main'));
  assert.ok(await tip(bare, 'refs/heads/y'));
});

test('only a branch\'s own remote branch is offered for deletion on GitHub (AK-576)', async () => {
  const { summarize, remoteOf } = await load();
  const lane = (name, upstream) => ({ name, branch: name, head: 'h', upstream, upstreamGone: false, worktree: null });
  const fromMain = lane('ak-530-a', 'origin/main');
  const renamed = lane('ak-530-b', 'origin/ak-530-other');
  const own = lane('feature/x', 'origin/feature/x');
  assert.equal(remoteOf(fromMain), null);
  assert.equal(remoteOf(renamed), null);
  assert.equal(remoteOf(own), 'origin/feature/x');
  assert.equal(remoteOf(lane('main', 'origin/main'), 'main'), null);
  // Two branches tracking the same remote branch: deleted once when both go, kept while one stays.
  const x = lane('x', 'origin/x');
  const y = lane('y', 'origin/x');
  assert.deepEqual(summarize([x, y], new Set(['b:x', 'b:y'])).remotes, ['origin/x']);
  assert.deepEqual(summarize([x], new Set(['b:x']), { all: [x, y] }).remotes, []);
  assert.deepEqual(summarize([own, own], new Set(['b:feature/x'])).remotes, ['origin/feature/x']);
  assert.deepEqual(summarize([fromMain, renamed], new Set(['b:ak-530-a', 'b:ak-530-b']), { all: [fromMain, renamed], base: 'main' }).remotes, []);
});

test('ipc: cleanupLanes items need a branch or a worktree; remote names need remote/branch', () => {
  const head = 'a'.repeat(40);
  assert.ok(checkGit('cleanupLanes', [[{ branch: 'x', head }, { worktree: '/tmp/w', force: true }]]));
  assert.throws(() => checkGit('cleanupLanes', [[{}]]), /branch or a worktree/);
  assert.throws(() => checkGit('cleanupLanes', [[{ branch: '-x' }]]), /must not start/);
  assert.throws(() => checkGit('cleanupLanes', [[{ branch: 'x', rm: true }]]), /unexpected field/);
  assert.ok(checkGit('deleteRemoteBranches', [['origin/x']]));
  assert.throws(() => checkGit('deleteRemoteBranches', [['x']]), /remote\/branch/);
  assert.throws(() => checkGit('deleteRemoteBranches', [['origin/--receive-pack=/tmp/x']]), /must not start/);
  assert.throws(() => checkGit('deleteRemoteBranch', ['origin/--exec=x']), /must not start/);
});

test('cleanupLanes deletes a branch that shares its name with a tag', async () => {
  const { dir } = await repo();
  await g(dir, ['branch', 'dup']);
  await g(dir, ['tag', 'dup']);
  const head = await tip(dir, 'refs/heads/dup');
  const res = await git.cleanupLanes(dir, [{ branch: 'dup', head }]);
  assert.deepEqual(res.deleted, ['dup']);
  assert.deepEqual(res.failed, []);
  assert.equal(await tip(dir, 'refs/heads/dup'), null);
  assert.ok(await tip(dir, 'refs/tags/dup'));
});

test('summarize counts worktrees, branches, dirty lanes and remote deletes', async () => {
  const { summarize, remoteOf, cleanupItem } = await load();
  const lanes = [
    { name: 'a', branch: 'a', head: 'h', upstream: 'origin/a', upstreamGone: false, worktree: { path: '/w/a' }, changes: 2 },
    { name: 'b', branch: 'b', head: 'h', upstream: 'origin/b', upstreamGone: true, worktree: null },
  ];
  const s = summarize(lanes, new Set(['b:a', 'b:b']));
  assert.deepEqual([s.worktrees, s.branches, s.dirty.map((l) => l.name), s.remotes], [1, 2, ['a'], ['origin/a']]);
  assert.equal(remoteOf(lanes[1]), null);
  assert.deepEqual(cleanupItem(lanes[0]), { branch: 'a', head: 'h', worktree: '/w/a', force: true });
});

test('the untouched days field takes whole days from 1 to 365 (AK-402)', async () => {
  const { daysValue } = await load();
  assert.equal(daysValue('14'), 14);
  assert.equal(daysValue(' 365 '), 365);
  for (const bad of ['', '0', '-3', '2.5', '366', 'abc', null]) assert.equal(daysValue(bad), null, String(bad));
});

test('remoteWhere: names the one remote, else "the remote"', async () => {
  const { remoteWhere } = await load();
  assert.equal(remoteWhere(['origin/a', 'origin/b']), 'origin');
  assert.equal(remoteWhere(['origin/a', 'fork/b']), 'the remote');
});

test('the clean-up confirm names worktree-only items and leaves conflicts an abort removes out of the count', async () => {
  const { cleanupWhat } = await import('../renderer/cleanup.js');
  assert.equal(cleanupWhat([{ worktree: { path: '/w' } }]), '1 worktree');
  assert.equal(cleanupWhat([{ branch: 'a' }, { branch: 'b' }]), '2 branches');
  assert.equal(cleanupWhat([{ branch: 'a' }, { worktree: { path: '/w' } }]), '1 branch and 1 worktree');
  const src = fs.readFileSync(path.join(__dirname, '../renderer/cleanup-view.js'), 'utf8');
  assert.match(src, /dirty\(l\) - \(ops\[k\] \? conflicted\[k\] : 0\)/);
  assert.match(src, /title: `Clean up \$\{cleanupWhat\(lanesToGo\)\}\?`/);
});
