'use strict';
// Review stages (renderer/review-rows.js reviewRows) and the PR fields they read (github.normalizePr).
const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../github');

const load = () => import('../renderer/review-rows.js');
const NOW = Date.parse('2026-10-15T12:00:00Z');
const HOUR = 3600e3;
const OLD = new Date(NOW - 10 * 24 * HOUR).toISOString();
const ago = (h) => new Date(NOW - h * HOUR).toISOString();
const pr = (number, o = {}) => ({ number, title: `PR ${number}`, branch: `b${number}`, base: 'main', author: 'kim', draft: false, review: null, checks: 'pending', mergeable: null, updatedAt: OLD, ...o });
const lane = (name, o = {}) => ({ name, branch: name, head: 'a'.repeat(40), worktree: null, changes: null, activity: NOW - 10 * 24 * HOUR, ahead: 1, isBase: false, done: null, pr: null, ...o });
const READY = { review: 'approved', checks: 'success', mergeable: true };
const stageOf = async (p, o = {}) => {
  const { rowStage } = await load();
  return rowStage({ pr: p, lane: null, conflicts: o.conflicts || [] }, { requested: new Set(o.requested || []), now: NOW });
};

test('needs you: a requested review, or approved + green + mergeable', async () => {
  assert.equal(await stageOf(pr(1), { requested: [1] }), 'needsYou');
  assert.equal(await stageOf(pr(1, READY)), 'needsYou');
  assert.equal(await stageOf(pr(1, { ...READY, checks: null })), 'needsYou'); // no checks at all
  assert.equal(await stageOf(pr(1, { ...READY, draft: true })), 'inProgress');
  assert.equal(await stageOf(pr(1, { ...READY, mergeable: null })), 'elsewhere'); // GitHub still working it out
  // The local forecast vetoes "ready": it's blocked instead.
  assert.equal(await stageOf(pr(1, READY), { conflicts: [{ with: 'main', base: true, files: ['a'] }] }), 'blocked');
  // A requested review wins over failing checks.
  assert.equal(await stageOf(pr(1, { checks: 'failure' }), { requested: [1] }), 'needsYou');
});

test('blocked: failing checks, GitHub conflicts or forecast conflicts', async () => {
  assert.equal(await stageOf(pr(1, { checks: 'failure' })), 'blocked');
  assert.equal(await stageOf(pr(1, { mergeable: false })), 'blocked');
  assert.equal(await stageOf(pr(1), { conflicts: [{ with: 'other', base: false, files: ['a'] }] }), 'blocked');
  assert.equal(await stageOf(pr(1, { checks: 'failure', draft: true })), 'blocked');
});

test('in progress: drafts and recent pushes; everything else is handled elsewhere', async () => {
  const { RECENT_FOR } = await load();
  assert.equal(await stageOf(pr(1, { draft: true })), 'inProgress');
  assert.equal(await stageOf(pr(1, { updatedAt: ago(1) })), 'inProgress');
  assert.equal(await stageOf(pr(1, { updatedAt: new Date(NOW - RECENT_FOR - 1).toISOString() })), 'elsewhere');
  assert.equal(await stageOf(pr(1, { review: 'changes' })), 'elsewhere');
});

test('one row per PR: its branch, worktree and commits ride along', async () => {
  const { reviewRows } = await load();
  const p = pr(7, { title: 'Add lanes', branch: 'lanes', draft: true });
  const l = lane('lanes', { title: 'wip', worktree: { path: '/w/lanes' }, changes: 3, ahead: 4, pr: { number: 7 } });
  const r = reviewRows({ lanes: [l, lane('other')], prs: [p], prsOn: true, now: NOW });
  const row = r.stages.inProgress[0];
  assert.equal(row.key, 'pr:7');
  assert.equal(row.title, 'Add lanes');
  assert.equal(row.lane, l);
  assert.deepEqual(row.worktree, { path: '/w/lanes', changes: 3 });
  assert.equal(row.ahead, 4);
  assert.equal(row.branch, 'lanes');
  // The lane isn't a second row; the PR-less old lane is only in Show all.
  assert.equal(r.all.length, 2);
  assert.equal(r.all.filter((x) => x.lane === l).length, 1);
  assert.equal(r.all[1].key, 'b:other');
  assert.equal(r.all[1].stage, null);
  // A PR with no local lane is still a row.
  const remoteOnly = reviewRows({ lanes: [], prs: [pr(8)], prsOn: true, now: NOW });
  assert.equal(remoteOnly.stages.elsewhere[0].lane, null);
  assert.equal(remoteOnly.stages.elsewhere[0].branch, 'b8');
});

test('finished: shipped lanes are a count plus a Clean up list; the base is never staged', async () => {
  const { reviewRows } = await load();
  const lanes = [lane('main', { isBase: true }), lane('shipped', { done: { reason: 'pr', pr: 3 } }), lane('shipped2', { done: { reason: 'merged' }, activity: NOW })];
  const r = reviewRows({ lanes, prs: [], prsOn: true, now: NOW });
  assert.equal(r.finished.count, 2);
  assert.deepEqual(r.finished.items.map((x) => x.key), ['b:shipped2', 'b:shipped']);
  assert.ok(Object.values(r.stages).every((s) => !s.length));
  assert.equal(r.all.find((x) => x.lane.isBase).stage, null);
});

test('forecast conflicts come from the forecast map when given', async () => {
  const { reviewRows } = await load();
  const forecast = new Map([['b:x', [{ with: 'main', base: true, files: ['a.js'] }]]]);
  const r = reviewRows({ lanes: [lane('x', { pr: { number: 1 } })], prs: [pr(1, READY)], forecast, prsOn: true, now: NOW });
  assert.equal(r.stages.blocked[0].key, 'pr:1');
  assert.equal(r.stages.blocked[0].conflicts[0].with, 'main');
});

test('sort: oldest review request first, then ready; base conflicts, failing CI, other conflicts', async () => {
  const { reviewRows } = await load();
  const forecast = new Map([['b:base', [{ with: 'main', base: true, files: ['a'] }]], ['b:pair', [{ with: 'x', base: false, files: ['a'] }]]]);
  const lanes = [lane('base', { pr: { number: 10 } }), lane('pair', { pr: { number: 11 } })];
  const r = reviewRows({
    lanes,
    forecast,
    prsOn: true,
    now: NOW,
    reviewRequested: [1, 2],
    prs: [
      pr(3, { ...READY, updatedAt: ago(100) }),
      pr(1, { updatedAt: ago(1) }),
      pr(2, { updatedAt: ago(50) }),
      pr(12, { checks: 'failure', updatedAt: ago(1) }),
      pr(11, { updatedAt: ago(2) }),
      pr(10, { updatedAt: ago(300) }),
      pr(13, { mergeable: false, updatedAt: ago(0.5) }),
    ],
  });
  assert.deepEqual(r.stages.needsYou.map((x) => x.pr.number), [2, 1, 3]);
  assert.deepEqual(r.stages.blocked.map((x) => x.pr.number), [10, 12, 13, 11]);
  // `all` lists staged rows in stage order first.
  assert.deepEqual(r.all.slice(0, 7).map((x) => x.pr.number), [2, 1, 3, 10, 12, 13, 11]);
});

test('PRs off: rows from local data only, PR data ignored', async () => {
  const { reviewRows } = await load();
  const lanes = [
    lane('dirty', { worktree: { path: '/w/d' }, changes: 2, pr: { number: 1 } }),
    lane('recent', { activity: NOW - HOUR }),
    lane('stale'),
    lane('conflicted', { conflicts: [{ with: 'main', base: true, files: ['a'] }] }),
    lane('shipped', { done: { reason: 'key' } }),
    lane('main', { isBase: true }),
  ];
  const r = reviewRows({ lanes, prs: [pr(1, READY)], reviewRequested: [1], prsOn: false, now: NOW });
  assert.ok(r.all.every((x) => x.pr === null));
  assert.equal(r.all.length, 6);
  assert.deepEqual(r.stages.needsYou, []);
  assert.deepEqual(r.stages.elsewhere, []);
  assert.deepEqual(r.stages.blocked.map((x) => x.key), ['b:conflicted']);
  assert.deepEqual(r.stages.inProgress.map((x) => x.key), ['b:recent', 'b:dirty']);
  assert.equal(r.finished.count, 1);
  assert.equal(r.all.find((x) => x.key === 'b:stale').stage, null);
});

test('PRs off: no gh call is made for any of the data the stages read', async () => {
  const calls = [];
  const exec = async (...a) => { calls.push(a); return '[]'; };
  const off = { enabled: false, remotes: [{ name: 'origin', web: 'https://github.com/acme/app' }], dirs: [], exec };
  assert.equal(await github.listPrs(off), null);
  await assert.rejects(github.inbox(off), { code: 'gh-off' });
  await assert.rejects(github.mergedPrs(off), { code: 'gh-off' });
  assert.equal(calls.length, 0);
});

test('PR header data: review verdicts (login and state only) and size', () => {
  const p = github.normalizePr({
    number: 5, title: 't', headRefName: 'x', additions: 12, deletions: 3, changedFiles: 2,
    latestReviews: [
      { author: { login: 'ana' }, state: 'APPROVED', body: 'secret' },
      { author: { login: 'bo' }, state: 'CHANGES_REQUESTED', body: 'no' },
      { author: { login: 'cy' }, state: 'COMMENTED', body: 'hm' },
      { author: { login: 'ana' }, state: 'CHANGES_REQUESTED' },
    ],
  });
  assert.deepEqual(p.reviews, [{ login: 'ana', state: 'approved' }, { login: 'bo', state: 'changes' }]);
  assert.deepEqual(p.size, { additions: 12, deletions: 3, files: 2 });
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.deepEqual(github.normalizePr({ number: 6 }).size, { additions: null, deletions: null, files: null });
  for (const f of ['latestReviews', 'additions', 'deletions', 'changedFiles']) assert.ok(github.PR_FIELDS.includes(f));
});

test('one primary button per stage', async () => {
  const { primaryAction, STEPS } = await load();
  const row = (stage, o = {}) => ({ stage, pr: null, lane: null, conflicts: [], ...o });
  // Needs you: Review when your review is requested, Merge when it's approved and green.
  assert.equal(primaryAction(row('needsYou', { pr: pr(1) }), { requested: new Set([1]) }), 'review');
  assert.equal(primaryAction(row('needsYou', { pr: pr(1, READY) })), 'merge');
  assert.equal(primaryAction(row('needsYou', { pr: pr(1, READY) }), { requested: new Set([1]) }), 'review');
  // Blocked: Rebase when it conflicts and the branch is here, else the failing checks, else Open.
  const conflicts = [{ with: 'main', base: true, files: ['a'] }];
  assert.equal(primaryAction(row('blocked', { lane: lane('x'), conflicts }), { base: 'main' }), 'rebase');
  assert.equal(primaryAction(row('blocked', { pr: pr(1, { mergeable: false }), lane: lane('b1') }), { base: 'main' }), 'rebase');
  assert.equal(primaryAction(row('blocked', { pr: pr(1, { checks: 'failure', url: 'https://x/pull/1' }) }), { base: 'main' }), 'checks');
  assert.equal(primaryAction(row('blocked', { pr: pr(1, { mergeable: false }) }), { base: 'main' }), 'open'); // not checked out here
  for (const s of ['inProgress', 'elsewhere']) assert.equal(primaryAction(row(s, { pr: pr(1) })), 'open');
  for (const id of ['review', 'merge', 'rebase', 'checks', 'open']) assert.ok(STEPS[id].label && STEPS[id].keyId.startsWith('lanes.'));
});

test('badges: CI and review state, conflicts and uncommitted changes', async () => {
  const { rowBadges } = await load();
  const texts = (r, o) => rowBadges({ conflicts: [], worktree: null, ...r }, o).map((b) => b.text);
  assert.deepEqual(texts({ pr: pr(1, { checks: 'success', review: 'approved' }) }), ['CI passed', 'Approved']);
  assert.deepEqual(texts({ pr: pr(1, { checks: 'failure', mergeable: false }) }), ['CI failing', 'Conflicts']);
  assert.deepEqual(texts({ pr: pr(1, { draft: true }) }, { requested: new Set([1]) }), ['Draft', 'CI running', 'Your review']);
  assert.deepEqual(texts({ pr: null, worktree: { path: '/w', changes: 2 } }), ['2 changed']);
});

test('filter: every word in the title, branch, number or author', async () => {
  const { reviewRows, filterRows } = await load();
  const r = reviewRows({ lanes: [lane('feature-a'), lane('fix-b')], prs: [pr(12, { title: 'Speed up the graph', author: 'agent' })], prsOn: true, now: NOW });
  const titles = (q) => filterRows(r.all, q).map((x) => x.title);
  assert.deepEqual(titles(''), r.all.map((x) => x.title));
  assert.deepEqual(titles('#12'), ['Speed up the graph']);
  assert.deepEqual(titles('graph agent'), ['Speed up the graph']);
  assert.deepEqual(titles('feature'), ['feature-a']); // Show all rows too: a local branch with no PR
});

test('rename: the view is "Review" and its user-visible strings never say "Lanes"', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const keymap = await import('../renderer/keymap.js');
  const labels = keymap.COMMANDS.filter((c) => c.id === 'view.lanes' || c.id?.startsWith('lanes.') || c.id === 'cleanup.back').map((c) => c.label);
  assert.ok(labels.length > 10);
  assert.ok(labels.includes('Review'));
  for (const l of labels) assert.doesNotMatch(l, /\blanes?\b/i, l);
  // String literals in the view, its keymap context and the menu: no "Lanes" (the brand "GitLanes" is fine).
  const visible = (file) => (fs.readFileSync(path.join(__dirname, '..', file), 'utf8').match(/(['`])(?:(?!\1)[^\\\n]|\\.)*\1/g) || [])
    .filter((s) => !/^['`][\w.:/-]*['`]$/.test(s)); // ids, keys, class names
  for (const file of ['renderer/lanes-view.js', 'renderer/review-rows.js']) {
    for (const s of visible(file)) assert.doesNotMatch(s.replace(/GitLanes/g, ''), /\bLanes\b|\bInbox\b/, `${file}: ${s}`);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/keymap.js'), 'utf8'), /lanes: 'Review',/);
  assert.match(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), /item\('Review', acc\('view\.lanes'\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), /Pull Request Inbox/);
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8'), /\{ id: 'lanes', label: 'Review'/);
});
