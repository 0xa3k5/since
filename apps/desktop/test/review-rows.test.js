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

test('stuck: failing checks, GitHub conflicts or forecast conflicts, whatever else holds', async () => {
  assert.equal(await stageOf(pr(1, { checks: 'failure' })), 'stuck');
  assert.equal(await stageOf(pr(1, { mergeable: false })), 'stuck');
  assert.equal(await stageOf(pr(1), { conflicts: [{ with: 'other', base: false, files: ['a'] }] }), 'inProgress');
  assert.equal(await stageOf(pr(1, { checks: 'failure', draft: true })), 'stuck');
  assert.equal(await stageOf(pr(1, { checks: 'failure' }), { requested: [1] }), 'stuck');
  // The local forecast vetoes "ready".
  assert.equal(await stageOf(pr(1, READY), { conflicts: [{ with: 'main', base: true, files: ['a'] }] }), 'stuck');
  assert.equal(await stageOf(pr(1, { ...READY, mergeable: false })), 'stuck');
});

test('ready to merge: approved, CI green (or no checks), not a draft', async () => {
  assert.equal(await stageOf(pr(1, READY)), 'ready');
  assert.equal(await stageOf(pr(1, { ...READY, checks: null })), 'ready'); // no checks at all
  assert.equal(await stageOf(pr(1, { ...READY, mergeable: null })), 'ready'); // GitHub still working it out
  assert.equal(await stageOf(pr(1, { ...READY, draft: true })), 'inProgress');
  assert.equal(await stageOf(pr(1, { ...READY, checks: 'pending' })), 'inProgress');
  assert.equal(await stageOf(pr(1, { ...READY, review: 'required' })), 'inProgress');
});

test('in progress: every other open PR, old or new, requested or not', async () => {
  assert.equal(await stageOf(pr(1, { draft: true })), 'inProgress');
  assert.equal(await stageOf(pr(1, { updatedAt: ago(1) })), 'inProgress');
  assert.equal(await stageOf(pr(1)), 'inProgress'); // updated long ago
  assert.equal(await stageOf(pr(1, { review: 'changes' })), 'inProgress');
  assert.equal(await stageOf(pr(1), { requested: [1] }), 'inProgress');
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
  assert.equal(remoteOnly.stages.inProgress[0].lane, null);
  assert.equal(remoteOnly.stages.inProgress[0].branch, 'b8');
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
  assert.equal(r.stages.stuck[0].key, 'pr:1');
  assert.equal(r.stages.stuck[0].conflicts[0].with, 'main');
});

test('sort: base conflicts, failing CI; oldest ready first; review requests first in progress; a local-only overlap stages nothing', async () => {
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
      pr(14, { ...READY, updatedAt: ago(5) }),
      pr(15, { updatedAt: ago(0.1) }),
    ],
  });
  assert.deepEqual(r.stages.stuck.map((x) => x.pr.number), [13, 10, 12]);
  assert.deepEqual(r.stages.ready.map((x) => x.pr.number), [3, 14]);
  // #11 only overlaps a local branch (x): no stage change, no overlap note (AK-321).
  assert.deepEqual(r.stages.inProgress.map((x) => x.pr.number), [1, 2, 15, 11]);
  assert.deepEqual(r.all.find((x) => x.pr.number === 11).overlaps, []);
  // `all` lists staged rows in stage order first.
  assert.deepEqual(r.all.map((x) => x.pr.number), [13, 10, 12, 3, 14, 1, 2, 15, 11]);
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
  assert.deepEqual(r.stages.ready, []);
  assert.deepEqual(r.stages.stuck.map((x) => x.key), ['b:conflicted']);
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

test('PR header data: reviews (no bodies) and size', () => {
  const p = github.normalizePr({
    number: 5, title: 't', headRefName: 'x', additions: 12, deletions: 3, changedFiles: 2,
    latestReviews: [
      { author: { login: 'ana' }, state: 'APPROVED', body: 'secret' },
      { author: { login: 'bo' }, state: 'CHANGES_REQUESTED', body: 'no' },
      { author: { login: 'cy' }, state: 'COMMENTED', body: 'hm' },
      { author: { login: 'ana' }, state: 'CHANGES_REQUESTED' },
    ],
  });
  assert.deepEqual(p.reviews.map((r) => [r.login, r.state]), [['ana', 'approved'], ['bo', 'changes'], ['cy', 'commented']]);
  assert.deepEqual(p.size, { additions: 12, deletions: 3, files: 2 });
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.deepEqual(github.normalizePr({ number: 6 }).size, { additions: null, deletions: null, files: null });
  for (const f of ['latestReviews', 'additions', 'deletions', 'changedFiles']) assert.ok(github.PR_FIELDS.includes(f));
});

test('one primary button per stage', async () => {
  const { primaryAction, STEPS } = await load();
  const row = (stage, o = {}) => ({ stage, pr: null, lane: null, conflicts: [], ...o });
  // Ready to merge: Merge.
  assert.equal(primaryAction(row('ready', { pr: pr(1, READY) })), 'merge');
  assert.equal(primaryAction(row('ready', { pr: pr(1, READY) }), { requested: new Set([1]) }), 'merge');
  // Stuck: Rebase when it conflicts with its base and the branch is here, else Send back.
  const conflicts = [{ with: 'main', base: true, files: ['a'] }];
  assert.equal(primaryAction(row('stuck', { lane: lane('x'), conflicts }), { base: 'main' }), 'rebase');
  assert.equal(primaryAction(row('stuck', { pr: pr(1, { mergeable: false }), lane: lane('b1') }), { base: 'main' }), 'rebase');
  assert.equal(primaryAction(row('stuck', { pr: pr(1, { checks: 'failure', url: 'https://x/pull/1' }) }), { base: 'main' }), 'sendBack');
  assert.equal(primaryAction(row('stuck', { pr: pr(1, { mergeable: false }) }), { base: 'main' }), 'sendBack'); // not checked out here
  assert.equal(primaryAction(row('stuck', { pr: pr(1, { mergeState: 'blocked', review: 'changes' }), lane: lane('b1') }), { base: 'main' }), 'sendBack');
  // In progress: Review when your review is requested, else Open.
  assert.equal(primaryAction(row('inProgress', { pr: pr(1) }), { requested: new Set([1]) }), 'review');
  assert.equal(primaryAction(row('inProgress', { pr: pr(1) })), 'open');
  assert.equal(primaryAction(row(null, { lane: lane('x') })), 'open');
  for (const id of ['review', 'merge', 'rebase', 'checks', 'open', 'sendBack']) assert.ok(STEPS[id].label && STEPS[id].keyId.startsWith('lanes.'));
});

test('badges: CI and review state, conflicts and uncommitted changes', async () => {
  const { rowBadges } = await load();
  const texts = (r, o) => rowBadges({ conflicts: [], worktree: null, ...r }, o).map((b) => b.text);
  assert.deepEqual(texts({ pr: pr(1, { checks: 'success', review: 'approved' }) }), ['CI passed', 'Approved']);
  assert.deepEqual(texts({ pr: pr(1, { checks: 'failure', mergeable: false }) }), ['CI failing', 'Conflicts']);
  assert.deepEqual(texts({ pr: pr(1, { draft: true }) }, { requested: new Set([1]) }), ['Draft', 'CI running', 'Your review']);
  assert.deepEqual(texts({ pr: null, worktree: { path: '/w', changes: 2 } }), ['2 changed']);
});

test('agent-made: lane guesses and bot authors, only while marks are on', async () => {
  const { rowBadges, rowAgent } = await load();
  const texts = (r, o) => rowBadges({ conflicts: [], worktree: null, ...r }, o).map((b) => b.text);
  const botPr = pr(1, { checks: null, bot: true, author: 'app/renovate', authorName: 'renovate' });
  assert.deepEqual(texts({ pr: botPr }), []);
  assert.deepEqual(texts({ pr: botPr }, { agents: true }), [], 'no Agent badge: agents show as authors (AK-390)');
  assert.equal(rowAgent({ pr: botPr }), 'Opened by a bot (renovate)');
  assert.match(rowAgent({ lane: { agent: { reason: 'branch', match: 'claude/' } }, pr: pr(2) }), /Looks agent-made/);
  assert.equal(rowAgent({ pr: pr(3) }), null);
  assert.deepEqual(rowBadges({ conflicts: [], pr: pr(4, { checks: null, review: 'required' }) }).map((b) => b.icon), ['pending']);
});

test('reviewers: requests are pending, then by state, dismissed left out', async () => {
  const { reviewers } = await load();
  const list = reviewers({
    reviews: [
      { login: 'ana', name: 'Ana', state: 'approved', submittedAt: 'x' },
      { login: 'bo', name: '', state: 'changes' },
      { login: 'copilot[bot]', name: '', state: 'commented' },
      { login: 'dee', name: '', state: 'dismissed' },
      { login: 'fay', name: '', state: 'approved' },
    ],
    reviewRequests: [{ login: 'fay', name: '', team: false }, { login: 'core', name: 'Core', team: true }],
  });
  assert.deepEqual(list.map((r) => [r.name, r.state]), [['bo', 'changes'], ['Ana', 'approved'], ['copilot', 'commented'], ['fay', 'pending'], ['Core', 'pending']]);
  assert.equal(list.find((r) => r.name === 'Core').login, null);
  assert.deepEqual(reviewers(null), []);
});

test('filter: every word in the title, branch, number or author', async () => {
  const { reviewRows, filterRows } = await load();
  const r = reviewRows({ lanes: [lane('feature-a'), lane('fix-b')], prs: [pr(12, { title: 'Speed up the graph', author: 'agent' })], prsOn: true, now: NOW });
  const titles = (q) => filterRows(r.all, q).map((x) => x.title);
  assert.deepEqual(titles(''), r.all.map((x) => x.title));
  assert.deepEqual(titles('#12'), ['Speed up the graph']);
  assert.deepEqual(titles('graph agent'), ['Speed up the graph']);
  assert.deepEqual(titles('feature'), ['feature-a']); // Everything else rows too: a local branch with no PR
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
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/sidebar.js'), 'utf8'), /\{ id: 'lanes', label: 'Review'/);
});

// Split view (AK-272): what an action does to the row, and where the selection goes next.
test('approve re-stages a requested PR: ready to merge when green, else in progress', async () => {
  const { applyAction, reviewRows } = await load();
  const before = { prs: [pr(1, { checks: 'success', mergeable: true }), pr(2)], requested: [1, 2] };
  const after = applyAction(before, 1, 'approve');
  assert.deepEqual(after.requested, [2]);
  assert.equal(after.prs[0].review, 'approved');
  assert.equal(before.prs[0].review, null); // not mutated
  const staged = reviewRows({ prs: after.prs, reviewRequested: after.requested, prsOn: true, now: NOW });
  assert.deepEqual(staged.stages.ready.map((r) => r.key), ['pr:1']);
  assert.deepEqual(staged.stages.inProgress.map((r) => r.key), ['pr:2']);
  const red = applyAction({ prs: [pr(3, { checks: 'pending' })], requested: [3] }, 3, 'approve');
  assert.deepEqual(reviewRows({ prs: red.prs, reviewRequested: red.requested, prsOn: true, now: NOW }).stages.inProgress.map((r) => r.key), ['pr:3']);
});

test('merge and close take the PR row away; its lane goes to the finished line once shipped', async () => {
  const { applyAction, reviewRows } = await load();
  for (const id of ['merge', 'close']) {
    const after = applyAction({ prs: [pr(1, READY), pr(2, READY)], requested: [1] }, 1, id);
    assert.deepEqual(after.prs.map((p) => p.number), [2]);
    assert.deepEqual(after.requested, []);
  }
  const shipped = reviewRows({ lanes: [lane('b1', { done: { reason: 'pr', pr: 1 } })], prs: [], prsOn: true, now: NOW });
  assert.equal(shipped.finished.count, 1);
  // Unknown PRs and local actions change nothing.
  const same = { prs: [pr(1)], requested: [1] };
  assert.deepEqual(applyAction(same, 9, 'merge'), same);
  assert.deepEqual(applyAction(same, 1, 'checkout'), same);
});

test('rowPrNumber reads PR row keys only', async () => {
  const { rowPrNumber } = await load();
  assert.equal(rowPrNumber('pr:12'), 12);
  assert.equal(rowPrNumber('feature'), null);
  assert.equal(rowPrNumber(null), null);
});

test('next selection: the next row below that still needs you, else the first, else stay', async () => {
  const { nextSelection, reviewRows, applyAction } = await load();
  const inbox = { prs: [pr(1, READY), pr(2, READY), pr(3, { checks: 'failure' }), pr(4, { draft: true })], requested: [] };
  const before = reviewRows({ ...inbox, reviewRequested: inbox.requested, prsOn: true, now: NOW }).all.map((r) => r.key);
  assert.deepEqual(before, ['pr:3', 'pr:1', 'pr:2', 'pr:4']);
  const staged = (i) => reviewRows({ prs: i.prs, reviewRequested: i.requested, prsOn: true, now: NOW });
  // Merging #1: #2 is next.
  assert.equal(nextSelection(before, staged(applyAction(inbox, 1, 'merge')), 'pr:1'), 'pr:2');
  // Merging #2, the last that needs you: wrap to the first that does (the stuck #3).
  assert.equal(nextSelection(before, staged(applyAction(inbox, 2, 'merge')), 'pr:2'), 'pr:3');
  // Closing the stuck #3: #1 below it.
  assert.equal(nextSelection(before, staged(applyAction(inbox, 3, 'close')), 'pr:3'), 'pr:1');
  // Nothing else needs you: stay on the row if it's still listed, else let the list choose.
  const one = { prs: [pr(5, READY), pr(6, { draft: true })], requested: [] };
  assert.equal(nextSelection(['pr:5', 'pr:6'], staged(applyAction(one, 5, 'checkout')), 'pr:5'), 'pr:5');
  assert.equal(nextSelection(['pr:5', 'pr:6'], staged(applyAction(one, 5, 'merge')), 'pr:5'), null);
  // A row that wasn't listed before (filter changed): the first that needs you.
  assert.equal(nextSelection([], staged(inbox), 'pr:9'), 'pr:3');
});

test('pane actions: every PR action with a primary by stage; local branches merge and tidy', async () => {
  const { paneActions } = await import('../renderer/pr-review.js');
  const ids = (r, s) => paneActions(r, s).actions.map((a) => a.id);
  const p = { pr: pr(1, { url: 'https://github.com/o/r/pull/1' }), lane: null };
  assert.deepEqual(ids(p, 'review'), ['merge', 'approve', 'close', 'checkout', 'github']);
  assert.equal(paneActions(p, 'review').primary, 'approve');
  assert.equal(paneActions(p, 'merge').primary, 'merge');
  assert.equal(paneActions(p, 'open').primary, 'checkout'); // not here yet: check it out
  assert.equal(paneActions({ ...p, lane: lane('b1') }, 'open').primary, null);
  assert.ok(paneActions(p, 'review').actions.filter((a) => ['merge', 'approve', 'close'].includes(a.id)).every((a) => a.remote));
  assert.equal(paneActions(p, 'review').actions.find((a) => a.id === 'checkout').remote, false);
  // PR features off: a local branch, nothing remote, no request-changes anywhere.
  const local = paneActions({ pr: null, lane: lane('feat', { worktree: { path: '/x', current: false } }) }, 'open');
  assert.deepEqual(local.actions.map((a) => [a.id, a.label, a.remote]), [['merge', 'Merge and tidy…', false], ['checkout', 'Open worktree', false]]);
  assert.deepEqual(ids({ pr: null, lane: lane('main', { isBase: true }) }, 'open'), ['checkout']);
  assert.ok(!ids(p, 'review').includes('changes'));
});

// AK-305: the conflict with the base gets its own note in Review, counted, and jumps to the files.
test('conflict note: counts the files, prefers what the pane read, falls back to GitHub', async () => {
  const { conflictNote, stuckReason } = await load();
  const row = (o) => ({ pr: null, conflicts: [], ...o });
  const forecast = row({ pr: pr(1, { checks: 'failure', failing: ['test'] }), conflicts: [{ with: 'main', base: true, files: ['a.js', 'b.js', 'c.js'] }, { with: 'feature', base: false, files: ['x.js'] }] });
  assert.equal(conflictNote(forecast), 'Conflicts in 3 files');
  assert.equal(conflictNote(forecast, { files: ['a.js'] }), 'Conflicts in 1 file');
  assert.equal(stuckReason(forecast, { noBase: true }), 'conflicts with feature in x.js · CI ✗ test');
  const github = row({ pr: pr(1, { mergeable: false, base: 'develop' }) });
  assert.equal(conflictNote(github), 'Conflicts with develop');
  assert.equal(conflictNote(github, { files: ['a.js', 'b.js'] }), 'Conflicts in 2 files');
  assert.equal(stuckReason(github, { noBase: true }), null);
  assert.equal(conflictNote(row({ pr: pr(1, READY), conflicts: [{ with: 'feature', base: false, files: ['x.js'] }] })), null);
});

// AK-280: why a row is stuck, in plain words from facts (Send back builds on this).
test('stuck reason: forecast conflicts by file name, GitHub conflicts, failing checks by name', async () => {
  const { stuckReason } = await load();
  const row = (o) => ({ pr: null, conflicts: [], ...o });
  assert.equal(stuckReason(row({ pr: pr(1, READY) })), null);
  assert.equal(stuckReason(row({ conflicts: [{ with: 'main', base: true, files: ['apps/web/src/pages/changelog.astro'] }] })), 'conflicts with main in changelog.astro');
  assert.equal(stuckReason(row({ conflicts: [{ with: 'main', base: true, files: ['a/x.js', 'b/y.js', 'c/z.js', 'd.js'] }, { with: 'feature', base: false, files: ['x.js'] }] })),
    'conflicts with main in x.js, y.js +2 more · conflicts with feature in x.js');
  assert.equal(stuckReason(row({ pr: pr(1, { mergeable: false, base: 'develop' }) })), 'conflicts with develop');
  assert.equal(stuckReason(row({ pr: pr(1, { mergeable: false, base: '' }) }), { base: 'main' }), 'conflicts with main');
  // The forecast names the files, so GitHub's yes/no isn't repeated.
  assert.equal(stuckReason(row({ pr: pr(1, { mergeable: false }), conflicts: [{ with: 'main', base: true, files: ['a.css'] }] })), 'conflicts with main in a.css');
  assert.equal(stuckReason(row({ pr: pr(1, { checks: 'failure', failing: ['test', 'lint', 'build'] }) })), 'CI ✗ test, lint +1 more');
  assert.equal(stuckReason(row({ pr: pr(1, { checks: 'failure' }) })), 'CI ✗ checks failing');
  assert.equal(stuckReason(row({ pr: pr(1, { checks: 'failure', failing: ['test'], mergeable: false }) })), 'conflicts with main · CI ✗ test');
  assert.equal(stuckReason(row({ pr: pr(1, { checks: 'failure', failing: ['a', 'b', 'c'] }) }), { max: 20 }), 'CI ✗ a, b, c');
});

test('failing check names: check runs by name, statuses by context, once each', () => {
  const p = github.normalizePr({
    number: 1,
    statusCheckRollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { context: 'ci/build', state: 'ERROR' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'e2e', status: 'IN_PROGRESS' },
    ],
  });
  assert.equal(p.checks, 'failure');
  assert.deepEqual(p.failing, ['test', 'ci/build']);
  assert.deepEqual(github.normalizePr({ number: 2 }).failing, []);
});

test('Review is home: a repository opens on Review, the Map keeps its own key', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  assert.match(app, /let startView = 'lanes';/);
  assert.match(app, /state\.view = startView;/);
  const keymap = await import('../renderer/keymap.js');
  assert.ok(keymap.keys('view.map').length);
  assert.ok(keymap.keys('view.lanes').length);
});

// AK-321: GitHub's merge box decides the stage; overlaps with open PRs are information only.
test('mergeStateStatus: each state stages the way GitHub would let it merge', async () => {
  const s = (o, prev) => load().then(({ rowStage }) => rowStage({ pr: pr(1, o), lane: null, conflicts: [] }, { now: NOW, previous: prev || null }));
  assert.equal(await s({ mergeState: 'dirty', mergeable: false }), 'stuck');
  assert.equal(await s({ mergeState: 'blocked', checks: 'failure' }), 'stuck');
  assert.equal(await s({ mergeState: 'blocked', review: 'changes', checks: 'success' }), 'stuck');
  assert.equal(await s({ mergeState: 'blocked', review: 'required', checks: 'success' }), 'inProgress');
  assert.equal(await s({ mergeState: 'blocked', checks: 'pending' }), 'inProgress');
  assert.equal(await s({ mergeState: 'behind', checks: 'success' }), 'ready');
  assert.equal(await s({ mergeState: 'unstable', checks: 'failure' }), 'ready');
  assert.equal(await s({ mergeState: 'clean', checks: 'success' }), 'ready');
  assert.equal(await s({ mergeState: 'has_hooks', checks: 'success' }), 'ready');
  assert.equal(await s({ mergeState: 'draft', draft: true, checks: 'success' }), 'inProgress');
  assert.equal(await s({ mergeState: 'draft', draft: true, checks: 'failure' }), 'stuck');
  // Unknown keeps the previous stage; with none, the rules for an older gh.
  assert.equal(await s({ mergeState: 'unknown', checks: 'success' }, 'ready'), 'ready');
  assert.equal(await s({ mergeState: 'unknown', checks: 'success' }, 'stuck'), 'stuck');
  assert.equal(await s({ mergeState: 'unknown', ...READY }), 'ready');
  assert.equal(await s({ mergeState: 'unknown', checks: 'success' }), 'inProgress');
});

test('stageMemory: the sidebar dot keeps a PR\'s last stage while GitHub is checking it (AK-388)', async () => {
  const { stageMemory } = await load();
  const dot = stageMemory();
  const checking = { mergeState: 'unknown', checks: 'failure' };
  assert.equal(dot(pr(1, { mergeState: 'unstable', checks: 'failure' })), 'ready');
  assert.equal(dot(pr(1, checking)), 'ready');
  assert.equal(dot(pr(2, checking)), 'stuck'); // no stage yet: the older rules
  assert.equal(stageMemory()(pr(1, checking)), 'stuck'); // a new repository starts empty
  assert.equal(dot(pr(1, { mergeState: 'dirty', mergeable: false, checks: 'success' })), 'stuck');
  assert.equal(dot(pr(1, checking)), 'stuck');
});

test('mergeStateStatus: tags, primary action and reason follow the state', async () => {
  const { reviewRows, rowBadges, primaryAction, stuckReason } = await load();
  const texts = (o) => rowBadges({ pr: pr(1, o), conflicts: [], worktree: null }).map((b) => b.text);
  assert.deepEqual(texts({ mergeState: 'unstable', checks: 'failure' }), ['CI failing']);
  assert.deepEqual(texts({ mergeState: 'behind', checks: 'success' }), ['CI passed', 'Behind main']);
  assert.deepEqual(texts({ mergeState: 'dirty', checks: 'success' }), ['CI passed', 'Conflicts']);
  assert.ok(rowBadges({ pr: pr(1, { mergeState: 'unknown' }), conflicts: [] }).some((b) => b.text === 'Checking' && b.spin));
  // A stale local forecast against the base doesn't override GitHub's clean.
  const forecast = new Map([['b:b1', [{ with: 'main', base: true, files: ['a'] }]]]);
  const run = (o) => reviewRows({ lanes: [lane('b1', { pr: { number: 1 } })], prs: [pr(1, o)], forecast, prsOn: true, now: NOW }).all[0];
  const clean = run({ mergeState: 'clean', checks: 'success' });
  assert.equal(clean.stage, 'ready');
  assert.deepEqual(clean.conflicts, []);
  assert.equal(primaryAction(clean, { base: 'main' }), 'merge');
  const dirty = run({ mergeState: 'dirty', mergeable: false });
  assert.equal(primaryAction(dirty, { base: 'main' }), 'rebase');
  assert.equal(stuckReason(dirty), 'conflicts with main in a');
  const failing = run({ mergeState: 'blocked', checks: 'failure', failing: ['test'] });
  assert.equal(primaryAction(failing, { base: 'main' }), 'sendBack');
  assert.equal(stuckReason(run({ mergeState: 'blocked', review: 'changes', checks: 'success' })), 'changes requested');
  // Unknown: the previous call's stage holds.
  const prev = new Map([['pr:1', 'ready']]);
  assert.equal(reviewRows({ prs: [pr(1, { mergeState: 'unknown' })], prsOn: true, now: NOW, previous: prev }).stages.ready.length, 1);
});

test('overlaps: an open PR gets a note and no stage change; merge order names the smaller one', async () => {
  const { reviewRows, overlapNote, mergeOrder, rowBadges } = await load();
  const forecast = new Map([
    ['b:b1', [{ with: 'b2', base: false, key: 'b:b2', files: ['src/lanes-view.js'] }, { with: 'wip', base: false, key: 'b:wip', files: ['x.js'] }]],
    ['b:b2', [{ with: 'b1', base: false, key: 'b:b1', files: ['src/lanes-view.js'] }]],
  ]);
  const size = (a, d) => ({ additions: a, deletions: d, files: 1 });
  const r = reviewRows({
    lanes: [lane('b1', { pr: { number: 1 } }), lane('b2', { pr: { number: 2 } }), lane('wip')],
    prs: [pr(1, { mergeState: 'clean', checks: 'success', size: size(28, 12) }), pr(2, { mergeState: 'clean', checks: 'success', size: size(300, 4) })],
    forecast, prsOn: true, now: NOW,
  });
  const one = r.all.find((x) => x.pr?.number === 1);
  assert.equal(one.stage, 'ready');
  assert.deepEqual(one.overlaps.map((o) => o.number), [2]); // the local branch "wip" doesn't count
  assert.ok(!rowBadges(one).some((b) => b.text === 'Conflicts'));
  assert.deepEqual(overlapNote(one), { text: 'Overlaps #2', title: '#2 PR 2: src/lanes-view.js' });
  assert.deepEqual(mergeOrder(one), [{ number: 2, files: 'lanes-view.js', smaller: { self: true, size: { additions: 28, deletions: 12 } } }]);
  const two = r.all.find((x) => x.pr?.number === 2);
  assert.equal(mergeOrder(two)[0].smaller.self, false);
  assert.equal(overlapNote({ overlaps: [{ number: 2, title: 'a', files: [] }, { number: 3, title: 'b', files: [] }] }).text, 'Overlaps 2 PRs');
  assert.equal(overlapNote({ overlaps: [] }), null);
});

test('Review tabs: Needs you is stuck then ready, All open is every stage, 1–5 each have a key', async () => {
  const { TABS, STAGES } = await load();
  const keymap = await import('../renderer/keymap.js');
  assert.deepEqual(TABS.map((t) => t.id), ['needs', 'stuck', 'ready', 'inProgress', 'open']);
  assert.deepEqual(TABS[0].stages, ['stuck', 'ready']);
  assert.deepEqual(TABS.at(-1).stages, STAGES.map((s) => s.id));
  assert.deepEqual(TABS.map((t) => keymap.keys(t.keyId).join()), ['1', '2', '3', '4', '5']);
});

test('agent names: trailers without email or notes, bots without [bot], branch prefixes capitalised (AK-390)', async () => {
  const { agentName } = await load();
  assert.equal(agentName({ reason: 'trailer', match: 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>' }), 'Claude Opus 5.5');
  assert.equal(agentName({ reason: 'trailer', match: 'Generated-with: Codex' }), 'Codex');
  assert.equal(agentName({ reason: 'trailer', match: 'Co-authored-by: <copilot@github.com>' }), 'copilot');
  assert.equal(agentName({ reason: 'bot author', match: 'renovate[bot]' }), 'renovate');
  assert.equal(agentName({ reason: 'bot author', match: 'app/dependabot' }), 'dependabot');
  assert.equal(agentName({ reason: 'branch prefix', match: 'codex/' }), 'Codex');
  assert.equal(agentName({ reason: 'branch prefix', match: 'ai/' }), 'AI');
  assert.equal(agentName(null), null);
  assert.equal(agentName({ reason: 'branch prefix', match: '' }), null);
});

test('authors: person + agent, a bot alone, agents only while marks are on (AK-390)', async () => {
  const { authorsOf, rowAuthors, messageAgent } = await load();
  const names = (list) => list.map((a) => `${a.agent ? 'agent' : 'person'}:${a.name}`);
  const trailer = { reason: 'trailer', match: 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>' };
  assert.deepEqual(names(rowAuthors({ pr: pr(1, { authorName: 'AK' }), lane: { agent: trailer } }, { agents: true })), ['person:AK', 'agent:Claude Opus 5.5']);
  assert.deepEqual(names(rowAuthors({ pr: pr(1, { authorName: 'AK' }), lane: { agent: trailer } })), ['person:AK'], 'marks off: the person alone');
  assert.deepEqual(names(rowAuthors({ pr: pr(2, { bot: true, author: 'app/renovate', authorName: 'renovate' }), lane: null }, { agents: true })), ['agent:renovate']);
  assert.deepEqual(names(rowAuthors({ pr: null, lane: { agent: { reason: 'branch prefix', match: 'codex/' } } }, { agents: true })), ['agent:Codex']);
  assert.deepEqual(names(rowAuthors({ pr: pr(3), lane: null }, { agents: true })), ['person:kim']);
  assert.deepEqual(names(authorsOf({ person: { name: 'dependabot[bot]' } })), ['agent:dependabot']);
  assert.deepEqual(names(authorsOf({ person: { name: 'Codex' }, agent: { reason: 'branch prefix', match: 'codex/' } })), ['person:Codex'], 'the same name once');
  const msg = 'Fix it\n\nBody\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>';
  assert.deepEqual(names(authorsOf({ person: { name: 'AK' }, agent: messageAgent(msg) })), ['person:AK', 'agent:Claude Opus 5.5']);
  assert.deepEqual(names(authorsOf({ person: { name: 'AK' }, agent: messageAgent(msg), agents: false })), ['person:AK'], 'Catch up with marks off (AK-392)');
  assert.equal(messageAgent('Fix\n\nCo-authored-by: Ana <ana@example.com>'), null);
});

// AK-411: failing checks and conflicts show as glyphs on the row line; the text drops "CI ✗".
test('row signals: failing checks count, conflict marker, bare check names', async () => {
  const { rowSignals, rowBadges, stuckReason } = await load();
  const row = (o) => ({ pr: null, conflicts: [], ...o });
  const failing = row({ pr: pr(1, { checks: 'failure', failing: ['test', 'lint'] }) });
  assert.deepEqual(rowSignals(failing), { checks: { text: '2', title: '2 checks are failing: test, lint' }, conflict: null });
  const counted = row({ pr: pr(1, { checks: 'failure', failing: ['test'], checkCounts: { passed: 3, total: 5 } }) });
  assert.equal(rowSignals(counted).checks.text, '3/5');
  assert.equal(rowSignals(row({ pr: pr(1, { checks: 'failure' }) })).checks.text, '');
  assert.deepEqual(rowSignals(row({ pr: pr(1, { mergeable: false, base: 'develop' }) })), { checks: null, conflict: { title: 'Conflicts with develop' } });
  assert.deepEqual(rowSignals(row({ pr: pr(1, READY) })), { checks: null, conflict: null });
  assert.equal(rowSignals(row({ pr: pr(1, { mergeable: false }) }), { conflictShown: true }).conflict, null, 'a stuck row whose note says it conflicts shows no marker too');
  assert.deepEqual(rowBadges(failing).filter((b) => b.signal).map((b) => b.text), ['CI failing']);
  assert.equal(stuckReason(failing, { bareChecks: true }), 'test, lint');
  assert.equal(stuckReason(row({ pr: pr(1, { checks: 'failure' }) }), { bareChecks: true }), null);
});

test('git.js and Catch up read agents from the same list (AK-393)', async () => {
  const git = require('../git');
  const { AGENT_HINTS } = await import('../renderer/agents.js');
  const { messageAgent } = await load();
  assert.equal(git.AGENT_HINTS, AGENT_HINTS);
  for (const w of AGENT_HINTS.coauthors) {
    assert.ok(messageAgent(`x\n\nCo-Authored-By: ${w} <a@b.c>`), w);
    assert.ok(git.agentGuess('main', [{ key: 'Co-Authored-By', value: `${w} <a@b.c>` }]), w);
  }
  for (const k of AGENT_HINTS.trailers) assert.ok(messageAgent(`x\n\n${k}: tool`), k);
});
