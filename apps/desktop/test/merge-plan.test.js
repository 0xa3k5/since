'use strict';
// Merge plan (renderer/merge-plan.js): the order search over simulated squash merges, forced-order
// explanations, after-merge conflict warnings and the stop/re-plan checks, plus the git and gh
// calls behind them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const github = require('../github');

const load = () => import('../renderer/merge-plan.js');

// A fake merge: `conflicts` maps "tip head" to conflicting files; clean merges make tip+head.
const fake = (conflicts = {}) => async (tip, head) => (conflicts[`${tip} ${head}`] ? { files: conflicts[`${tip} ${head}`], commit: null } : { files: [], commit: `${tip}+${head}` });

test('planOrder keeps the natural order when everything merges clean', async () => {
  const { planOrder } = await load();
  const plan = await planOrder({ prs: [{ number: 1, head: 'a' }, { number: 2, head: 'b' }], baseSha: 'B', merge: fake() });
  assert.deepEqual(plan.order, [{ number: 1, after: null }, { number: 2, after: null }]);
  assert.deepEqual([plan.forced, plan.blocked, plan.warnings, plan.tip, plan.complete], [[], [], [], 'B+a+b', true]);
});

test('planOrder reorders around a conflict and explains it', async () => {
  const { planOrder, forcedText } = await load();
  // 1 then 2 conflicts in global.css; 2 then 1 is clean.
  const plan = await planOrder({ prs: [{ number: 1, head: 'a' }, { number: 2, head: 'b' }], baseSha: 'B', merge: fake({ 'B+a b': ['global.css'] }) });
  assert.deepEqual(plan.order.map((s) => s.number), [2, 1]);
  assert.deepEqual(plan.forced, [{ first: 1, then: 2, files: ['global.css'] }]);
  assert.equal(forcedText(plan.forced[0]), '#1 before #2 would conflict in global.css');
});

test('planOrder marks a PR clean after the one it needs, and leaves out what never fits', async () => {
  const { planOrder, statusText, blockedText } = await load();
  // 2 conflicts on the base alone but merges clean once 1 is in; 3 conflicts with 1 either way.
  const merge = fake({ 'B b': ['x.js'], 'B+a c': ['y.js'], 'B+a+b c': ['y.js'], 'B+c a': ['y.js'], 'B+c b': ['x.js'] });
  const plan = await planOrder({ prs: [{ number: 1, head: 'a' }, { number: 2, head: 'b' }, { number: 3, head: 'c' }], baseSha: 'B', merge });
  assert.deepEqual(plan.order, [{ number: 1, after: null }, { number: 2, after: 1 }]);
  assert.equal(statusText(plan.order[1]), 'clean after #1');
  assert.deepEqual(plan.blocked, [{ number: 3, files: ['y.js'] }]);
  assert.match(blockedText(plan.blocked[0]), /^Conflicts in y\.js/);
});

test('planOrder warns about open PRs that would conflict only after the plan', async () => {
  const { planOrder, warningText } = await load();
  const merge = fake({ 'B+a d': ['app.css', 'b.css', 'c.css'], 'B e': ['old.txt'], 'B+a e': ['old.txt'] });
  const plan = await planOrder({ prs: [{ number: 1, head: 'a' }], others: [{ number: 4, head: 'd' }, { number: 5, head: 'e' }, { number: 6, head: null }], baseSha: 'B', merge });
  assert.deepEqual(plan.warnings, [{ number: 4, files: ['app.css', 'b.css', 'c.css'] }]); // 5 already conflicts: it's Stuck
  assert.equal(warningText(plan.warnings[0]), '#4 will conflict in app.css, b.css and 1 more file after these merge');
});

test('planOrder stops at its merge budget and says the search was incomplete', async () => {
  const { planOrder } = await load();
  const prs = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, head: `h${i}` }));
  const conflicts = Object.fromEntries(prs.map((p) => [`B ${p.head}`, ['f']])); // nothing merges at all
  const plan = await planOrder({ prs, baseSha: 'B', merge: fake(conflicts), budget: 3 });
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.order, []);
});

test('changedSince stops the merge when the PR or its state moved since the plan', async () => {
  const { changedSince, isReady } = await load();
  const snap = { head: 'a'.repeat(40), checks: 'success', review: 'approved' };
  const now = { state: 'open', headOid: snap.head, checks: 'success', review: 'approved', draft: false, conflicts: false };
  assert.equal(changedSince(snap, now), null);
  assert.equal(changedSince(snap, { ...now, headOid: 'b'.repeat(40) }), 'new commits were pushed');
  assert.equal(changedSince(snap, { ...now, checks: 'failure' }), 'its checks are failing now');
  assert.equal(changedSince(snap, { ...now, checks: 'pending' }), 'its checks are pending now');
  assert.equal(changedSince(snap, { ...now, review: 'changes' }), 'changes were requested');
  assert.equal(changedSince(snap, { ...now, state: 'merged' }), 'it’s merged now');
  assert.equal(changedSince(snap, { ...now, conflicts: true }), 'GitHub reports conflicts with the base now');
  assert.equal(isReady(now), true);
  assert.equal(isReady({ ...now, checks: null }), true);
  assert.equal(isReady({ ...now, review: 'required' }), false);
});

test('simulateSquash + planOrder on a real repo: forced order, warnings, no refs touched', async () => {
  const { planOrder } = await load();
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-mergeplan-'))), 'app');
  fs.mkdirSync(dir);
  const g = (...a) => git.run(dir, a);
  const commit = async (file, text, msg) => { fs.writeFileSync(path.join(dir, file), text); await g('add', file); await g('commit', '-q', '-m', msg); };
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'Test');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'commit.gpgsign', 'false');
  await commit('global.css', 'a\n', 'base');
  // #87 left main early and makes the same change main made since.
  await g('checkout', '-q', '-b', 'y');
  await commit('global.css', 'b\n', 'y: a to b');
  await g('checkout', '-q', 'main');
  await commit('global.css', 'b\n', 'main: a to b');
  await g('checkout', '-q', '-b', 'x');
  await commit('global.css', 'c\n', 'x: b to c');
  await g('checkout', '-q', 'main');
  await g('checkout', '-q', '-b', 'w');
  await commit('global.css', 'w\n', 'w: b to w');
  await g('checkout', '-q', 'main');
  const sha = async (ref) => (await g('rev-parse', ref)).trim();
  const [base, x, y, w] = await Promise.all(['main', 'x', 'y', 'w'].map(sha));
  const refsBefore = await g('for-each-ref');

  const clean = await git.simulateSquash(dir, base, x);
  assert.deepEqual(clean.files, []);
  assert.match(clean.commit, /^[0-9a-f]{40}$/);
  assert.equal((await g('rev-parse', `${clean.commit}^`)).trim(), base);
  assert.deepEqual(await git.simulateSquash(dir, base, x), clean); // fixed identity and date: same commit
  assert.deepEqual(await git.simulateSquash(dir, clean.commit, y), { files: ['global.css'], commit: null });

  const merge = (tip, head) => git.simulateSquash(dir, tip, head);
  const plan = await planOrder({ prs: [{ number: 86, head: x }, { number: 87, head: y }], others: [{ number: 90, head: w }], baseSha: base, merge });
  assert.deepEqual(plan.order, [{ number: 87, after: null }, { number: 86, after: null }]);
  assert.deepEqual(plan.forced, [{ first: 86, then: 87, files: ['global.css'] }]);
  assert.deepEqual(plan.warnings, [{ number: 90, files: ['global.css'] }]);
  assert.equal(await g('for-each-ref'), refsBefore);
  assert.equal((await g('status', '--porcelain')).trim(), '');
});

test('mergedCommit reads the squash commit; PR rows carry their head commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-gh-test-'));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  const ORIGIN = { name: 'origin', url: 'git@github.com:acme/app.git', web: git.remoteWebUrl('git@github.com:acme/app.git') };
  const calls = [];
  const exec = async (bin, args) => { calls.push(args); return JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'A'.repeat(40) } }); };
  assert.deepEqual(await github.mergedCommit({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [dir], exec }), { state: 'merged', commit: 'a'.repeat(40) });
  assert.deepEqual(calls, [['pr', 'view', '7', '--repo', 'github.com/acme/app', '--json', 'state,mergeCommit']]);
  await assert.rejects(github.mergedCommit({ enabled: false, remotes: [ORIGIN], number: 7, dirs: [dir], exec }), { code: 'gh-off' });
  assert.ok(github.PR_FIELDS.includes('headRefOid'));
  assert.equal(github.normalizePr({ number: 3, headRefOid: 'b'.repeat(40) }).head, 'b'.repeat(40));
  assert.equal(github.normalizePr({ number: 3, headRefOid: 'nope' }).head, null);
});

// AK-545: merge methods and native stacks.
test('findStacks finds straight chains on the base, and skips forks and lone PRs', async () => {
  const { findStacks } = await load();
  const pr = (number, branch, baseBranch) => ({ number, branch, baseBranch, head: `h${number}` });
  const open = [pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b'), pr(4, 'd', 'main'), pr(5, 'e', 'main'), pr(6, 'f', 'e'), pr(7, 'g', 'e'), pr(8, 'x', 'other'), pr(9, 'y', 'x')];
  assert.deepEqual(findStacks(open, 'main'), [{ id: 'stack-1', prs: [1, 2, 3], heads: ['h1', 'h2', 'h3'] }]);
  // A branch that loops back on itself ends the chain.
  assert.deepEqual(findStacks([pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'a', 'b')], 'main').map((s) => s.prs), [[1, 2]]);
  assert.deepEqual(findStacks([], 'main'), []);
});

test('stackBlocker names the first PR that isn’t ready; startMethod picks saved, default, squash', async () => {
  const { stackBlocker, startMethod } = await load();
  const stack = { id: 'stack-1', prs: [1, 2, 3] };
  assert.equal(stackBlocker(stack, new Map()), null);
  assert.deepEqual(stackBlocker(stack, new Map([[3, 'Checks are failing.'], [2, 'A review is required.']])), { number: 2, reason: 'A review is required.' });
  assert.equal(startMethod({ saved: 'rebase', allowed: ['squash', 'rebase'], fallback: 'squash' }), 'rebase');
  assert.equal(startMethod({ saved: 'merge', allowed: ['squash', 'rebase'], fallback: 'rebase' }), 'rebase');
  assert.equal(startMethod({ saved: null, allowed: ['squash', 'merge'], fallback: null }), 'squash');
  assert.equal(startMethod({ allowed: ['merge'] }), 'merge');
});

test('planOrder places a stack as one unit and explains orders around it', async () => {
  const { planOrder, statusText, forcedText, blockedText, unitLabel } = await load();
  const stacks = [{ id: 'stack-4', prs: [4, 5, 6] }];
  // #1 then the stack conflicts; the stack then #1 is clean.
  const merge = fake({ 'B+a t': ['app.js'] });
  const plan = await planOrder({ prs: [{ number: 1, head: 'a' }, { stack: 'stack-4', prs: [4, 5, 6], head: 't' }], baseSha: 'B', merge });
  assert.deepEqual(plan.order, [{ stack: 'stack-4', prs: [4, 5, 6], after: null }, { number: 1, after: null }]);
  assert.deepEqual(plan.forced, [{ first: 1, then: 'stack-4', files: ['app.js'] }]);
  assert.equal(forcedText(plan.forced[0], stacks), '#1 before the stack #4–#6 would conflict in app.js');
  assert.equal(statusText({ number: 1, after: 'stack-4' }, stacks), 'clean after the stack #4–#6');
  assert.equal(unitLabel(7), '#7');
  // A stack that never fits is left out whole.
  const stuck = await planOrder({ prs: [{ number: 1, head: 'a' }, { stack: 'stack-4', prs: [4, 5, 6], head: 't' }], baseSha: 'B', merge: fake({ 'B+a t': ['app.js'], 'B t': ['app.js'] }) });
  assert.deepEqual(stuck.blocked, [{ stack: 'stack-4', files: ['app.js'] }]);
  assert.match(blockedText(stuck.blocked[0]), /^Conflicts in app\.js/);
});

test('simulateRebase catches a commit that conflicts when the whole PR merges clean; stackLinear', async () => {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-mergeplan-'))), 'app');
  fs.mkdirSync(dir);
  const g = (...a) => git.run(dir, a);
  const commit = async (file, text, msg) => { fs.writeFileSync(path.join(dir, file), text); await g('add', file); await g('commit', '-q', '-m', msg); };
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'Test');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'commit.gpgsign', 'false');
  await commit('f.txt', 'a\n', 'base');
  await commit('g.txt', '1\n', 'base 2');
  const fork = (await g('rev-parse', 'HEAD')).trim();
  // The PR changes f.txt and changes it back: nothing to merge as a whole, but its first commit
  // clashes with main's own change to f.txt.
  await g('checkout', '-q', '-b', 'pr');
  await commit('f.txt', 'b\n', 'a to b');
  await commit('f.txt', 'a\n', 'b back to a');
  await commit('h.txt', 'new\n', 'add h');
  const pr = (await g('rev-parse', 'HEAD')).trim();
  await g('checkout', '-q', 'main');
  await commit('f.txt', 'c\n', 'main: a to c');
  const base = (await g('rev-parse', 'HEAD')).trim();

  assert.deepEqual((await git.simulateSquash(dir, base, pr)).files, []);
  assert.deepEqual(await git.simulateRebase(dir, base, pr), { files: ['f.txt'], commit: null });
  // A PR with no clash replays every commit on top of the tip.
  await g('checkout', '-q', '-b', 'ok', fork);
  await commit('h.txt', 'one\n', 'h one');
  await commit('h.txt', 'two\n', 'h two');
  const ok = (await g('rev-parse', 'HEAD')).trim();
  const r = await git.simulateRebase(dir, base, ok);
  assert.deepEqual(r.files, []);
  assert.equal((await g('rev-list', '--count', `${base}..${r.commit}`)).trim(), '2');
  assert.equal((await g('show', `${r.commit}:h.txt`)), 'two\n');
  assert.deepEqual(await git.simulateRebase(dir, base, ok), r); // fixed identity and date

  // Stacks: ok-2 sits on ok; a merge commit or a sideways head isn't linear.
  await commit('i.txt', 'i\n', 'stacked');
  const ok2 = (await g('rev-parse', 'HEAD')).trim();
  assert.equal(await git.stackLinear(dir, base, [ok, ok2]), true);
  assert.equal(await git.stackLinear(dir, base, [pr, ok2]), false);
  await g('merge', '-q', '--no-edit', 'main');
  const merged = (await g('rev-parse', 'HEAD')).trim();
  assert.equal(await git.stackLinear(dir, fork, [ok, merged]), false);
});

test('repoMergeMethods, openPrBranches and mergeStack call gh the way the plan needs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-gh-test-'));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  const ORIGIN = { name: 'origin', url: 'git@github.com:acme/app.git', web: git.remoteWebUrl('git@github.com:acme/app.git') };
  const calls = [];
  let reply = '';
  const exec = async (bin, args, _in, opts) => { calls.push({ args, env: opts.env }); if (reply instanceof Error) throw reply; return reply; };
  const t = { enabled: true, remotes: [ORIGIN], dirs: [dir], exec };

  reply = JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'REBASE' });
  assert.deepEqual(await github.repoMergeMethods(t), { allowed: ['squash', 'rebase'], default: 'rebase' });
  reply = JSON.stringify({ squashMergeAllowed: true, viewerDefaultMergeMethod: 'MERGE' }); // default turned off: none
  assert.deepEqual(await github.repoMergeMethods(t), { allowed: ['squash'], default: null });
  assert.deepEqual(calls[0].args.slice(0, 3), ['repo', 'view', 'github.com/acme/app']);

  reply = JSON.stringify([{ number: 4, headRefName: 'a', baseRefName: 'main', headRefOid: 'c'.repeat(40) }, { number: 0 }, { number: 5, headRefName: 'b', baseRefName: 'a', headRefOid: 'bad' }]);
  assert.deepEqual(await github.openPrBranches(t), [{ number: 4, branch: 'a', baseBranch: 'main', head: 'c'.repeat(40) }, { number: 5, branch: 'b', baseBranch: 'a', head: null }]);

  calls.length = 0;
  reply = '';
  assert.deepEqual(await github.mergeStack({ ...t, number: 6, method: 'rebase' }), { number: 6, method: 'rebase' });
  assert.deepEqual(calls[0].args, ['stack', 'merge', '6', '--merge-method=rebase', '--yes']);
  assert.equal(calls[0].env.GH_REPO, 'github.com/acme/app');
  assert.equal(calls[0].env.GH_PROMPT_DISABLED, '1');
  await assert.rejects(github.mergeStack({ ...t, number: 6, method: 'octopus' }), /Unknown merge method/);
  reply = new Error('unknown command "stack" for "gh"');
  await assert.rejects(github.mergeStack({ ...t, number: 6 }), /gh extension install github\/gh-stack/);
});

test('clean up after merging: removes worktrees and branches, skips dirty and checked-out ones, one undo', async () => {
  const { cleanupItems, cleanupSummary } = await load();
  const { Journal } = require('../journal');
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-mergeplan-')));
  const dir = path.join(parent, 'app');
  fs.mkdirSync(dir);
  const g = (...a) => git.run(dir, a);
  const tip = (b) => g('rev-parse', '-q', '--verify', `refs/heads/${b}`).then((x) => x.trim(), () => null);
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'Test');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await g('add', 'a.txt');
  await g('commit', '-q', '-m', 'base');
  for (const b of ['wt', 'plain', 'dirty', 'moved']) await g('branch', b);
  await g('worktree', 'add', '-q', path.join(parent, 'app-wt'), 'wt');
  await g('worktree', 'add', '-q', path.join(parent, 'app-dirty'), 'dirty');
  fs.writeFileSync(path.join(parent, 'app-dirty', 'a.txt'), 'changed\n');
  const head = await tip('main');
  const merged = [
    { number: 1, branch: 'wt', head }, { number: 2, branch: 'plain', head }, { number: 3, branch: 'dirty', head },
    { number: 4, branch: 'moved', head: 'f'.repeat(40) }, { number: 5, branch: 'main', head }, { number: 6, branch: 'gone', head },
  ];
  const local = new Set((await g('for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads')).split('\n').filter(Boolean));
  const { items, skipped } = cleanupItems(merged, local, await git.getWorktrees(dir));
  assert.deepEqual(skipped, [{ name: 'main', message: 'It’s checked out in this window.' }]);
  assert.deepEqual(items.map((i) => i.branch), ['wt', 'plain', 'dirty', 'moved']); // 'gone' has no local branch

  const journal = new Journal(await git.openRepo(dir));
  const sum = cleanupSummary(await journal.runCleanup('Clean up after merging', items), skipped);
  assert.deepEqual([sum.worktrees, sum.branches], [1, 2]);
  assert.deepEqual(sum.skipped.map((x) => x.name).sort(), ['app-dirty', 'main', 'moved']); // the dirty worktree's branch stays with it
  assert.match(sum.skipped.find((x) => x.name === 'app-dirty').message, /uncommitted/);
  assert.deepEqual([await tip('wt'), await tip('plain'), await tip('dirty'), await tip('moved')], [null, null, head, head]);
  assert.equal(fs.existsSync(path.join(parent, 'app-wt')), false);
  assert.equal(fs.readFileSync(path.join(parent, 'app-dirty', 'a.txt'), 'utf8'), 'changed\n');

  assert.equal(await journal.step('undo'), 'Clean up after merging');
  assert.deepEqual([await tip('wt'), await tip('plain')], [head, head]);
  assert.ok(fs.existsSync(path.join(parent, 'app-wt', 'a.txt')));
});

test('cleanupItems skips the main worktree, other windows and locked worktrees', async () => {
  const { cleanupItems } = await load();
  const wts = [
    { path: '/r', branch: 'm', main: true }, { path: '/r-e', branch: 'e', elsewhere: true },
    { path: '/r-l', branch: 'l', locked: true }, { path: '/r-ok', branch: 'ok' },
  ];
  const prs = ['m', 'e', 'l', 'ok'].map((branch, i) => ({ number: i + 1, branch, head: 'h' }));
  const { items, skipped } = cleanupItems(prs, new Set(['m', 'e', 'l', 'ok']), wts);
  assert.deepEqual(items, [{ branch: 'ok', head: 'h', worktree: '/r-ok' }]);
  assert.deepEqual(skipped.map((x) => x.name), ['m', 'e', 'l']);
});
