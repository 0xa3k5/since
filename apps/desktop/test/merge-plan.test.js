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
