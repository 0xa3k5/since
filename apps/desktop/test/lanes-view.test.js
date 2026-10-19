'use strict';
// Lanes overview triage list helpers (renderer/lanes.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/lanes.js');
const NOW = Date.UTC(2026, 9, 15, 12);
const H = 3600e3;
const lane = (name, extra = {}) => ({ name, branch: name, head: 'a'.repeat(40), isBase: false, worktree: null, activity: NOW - H, ahead: 1, behind: 0, changes: null, merged: null, agent: null, pr: null, ...extra });

test('lanes that need you sort first, in the documented order', async () => {
  const { sortLanes } = await load();
  const lanes = [
    lane('idle', { activity: NOW - 30 * 24 * H }),
    lane('active', { activity: NOW - 5 * 60e3 }),
    lane('ready', { pr: { number: 4, checks: 'success', review: 'approved', draft: false } }),
    lane('stalled', { changes: 3, activity: NOW - 5 * H, worktree: { path: '/w/s' } }),
    lane('review', { pr: { number: 2, checks: 'pending', review: 'changes' } }),
    lane('failing', { pr: { number: 1, checks: 'failure', review: 'approved' } }),
    lane('main', { isBase: true, activity: NOW }),
    lane('shipped', { done: { reason: 'pr', pr: 9 }, activity: NOW }),
    lane('other', { conflicts: [{ with: 'x', base: false, files: ['a'] }], activity: NOW }),
    lane('rebase', { conflicts: [{ with: 'main', base: true, files: ['a'] }], activity: NOW - 2 * H }),
  ];
  const sorted = sortLanes(lanes, NOW);
  assert.deepEqual(sorted.map((l) => l.name), ['rebase', 'other', 'failing', 'review', 'ready', 'stalled', 'active', 'shipped', 'main', 'idle']);
  assert.deepEqual(sorted.map((l) => l.bucket), ['conflicts', 'conflicts', 'failing', 'review', 'ready', 'stalled', 'active', 'merged', 'idle', 'idle']);
});

test('recent dirty work, drafts and merged lanes are not flagged', async () => {
  const { laneBucket } = await load();
  assert.equal(laneBucket(lane('x', { changes: 2, activity: NOW - 60e3 }), NOW), 'active');
  assert.equal(laneBucket(lane('x', { pr: { checks: 'success', review: 'approved', draft: true } }), NOW), 'active');
  assert.equal(laneBucket(lane('x', { merged: 'squash' }), NOW), 'idle');
  assert.equal(laneBucket(lane('x', { pr: { checks: 'pending', review: 'required' } }), NOW), 'review');
  assert.equal(laneBucket(lane('x', { done: { reason: 'key' }, pr: { checks: 'failure' } }), NOW), 'failing', 'an open PR on a shipped-looking lane');
  assert.equal(laneBucket(lane('x', { done: { reason: 'key' }, pr: { checks: 'success', review: 'approved' } }), NOW), 'merged');
});

test('within a bucket the newest activity comes first', async () => {
  const { sortLanes } = await load();
  const sorted = sortLanes([lane('old', { activity: NOW - 2 * H }), lane('new', { activity: NOW - 60e3 }), lane('b', { activity: NOW - 60e3 })], NOW);
  assert.deepEqual(sorted.map((l) => l.name), ['b', 'new', 'old']);
});

test('filter as you type, and agent lanes only', async () => {
  const { filterLanes } = await load();
  const lanes = [lane('claude/fix-login', { agent: { reason: 'branch prefix' } }), lane('feature/login'), lane('docs', { pr: { number: 12, title: 'Fix login docs' } })];
  assert.deepEqual(filterLanes(lanes, 'login').map((l) => l.name), ['claude/fix-login', 'feature/login', 'docs']);
  assert.deepEqual(filterLanes(lanes, 'fix log').map((l) => l.name), ['claude/fix-login', 'docs']);
  assert.deepEqual(filterLanes(lanes, '#12').map((l) => l.name), ['docs']);
  assert.deepEqual(filterLanes(lanes, '', { agentsOnly: true }).map((l) => l.name), ['claude/fix-login']);
});

test('Enter switches worktree, or shows the tip', async () => {
  const { laneTarget } = await load();
  assert.deepEqual(laneTarget(lane('x', { worktree: { path: '/w/x', current: false } })), { kind: 'worktree', path: '/w/x' });
  assert.deepEqual(laneTarget(lane('x', { worktree: { path: '/w/x', current: true } })), { kind: 'commit', sha: 'a'.repeat(40) });
  assert.deepEqual(laneTarget(lane('x', { worktree: { path: '/w/x', prunable: true } })), { kind: 'commit', sha: 'a'.repeat(40) });
  assert.equal(laneTarget(lane('x', { head: null })), null);
});

test('ahead/behind label and PR carry-over on local refreshes', async () => {
  const { aheadBehind, keepPrs } = await load();
  assert.equal(aheadBehind(lane('x', { ahead: 3, behind: 12 })), '↑3 ↓12');
  assert.equal(aheadBehind(lane('x', { ahead: 0, behind: 0 })), 'even');
  assert.equal(aheadBehind(lane('x', { isBase: true })), '');
  const pr = { number: 7 };
  const kept = keepPrs([lane('a'), lane('b')], [lane('a', { pr })]);
  assert.equal(kept[0].pr, pr);
  assert.equal(kept[1].pr, null);
  // A merged PR's reason survives a git-only load while the head is the same (AK-338).
  const done = { reason: 'pr', pr: 12 };
  const again = keepPrs([lane('a', { done: { reason: 'net-patch', sha: 'b'.repeat(40) } }), lane('b', { head: 'c'.repeat(40) })], [lane('a', { done, prTitle: 'Fix' }), lane('b', { done })]);
  assert.deepEqual([again[0].done, again[0].prTitle], [done, 'Fix']);
  assert.equal(again[1].done, undefined);
});

test('predicted conflicts: both lanes of a pair get them, they sort with "needs you" and block ready', async () => {
  const { conflictsByLane, withConflicts, sortLanes, filterLanes, conflictText, laneBucket } = await load();
  const by = conflictsByLane([
    { a: { name: 'left', branch: 'left', worktree: null }, b: { name: 'right', branch: 'right', worktree: null }, files: ['a.js'] },
    { a: { name: 'left', branch: 'left', worktree: null }, b: null, files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] },
  ], 'main');
  assert.deepEqual(by.get('b:left').map((c) => c.with), ['main', 'right']);
  assert.deepEqual(by.get('b:right'), [{ with: 'left', base: false, key: 'b:left', files: ['a.js'] }]);
  assert.equal(conflictText(by.get('b:left')[0]), 'Conflicts with main on a.js, b.js, c.js and 2 more');
  const ready = { pr: { number: 4, checks: 'success', review: 'approved', draft: false } };
  const lanes = withConflicts([lane('left', ready), lane('right'), lane('quiet')], by);
  assert.equal(laneBucket(lanes[0], NOW), 'conflicts', 'a green, approved PR with conflicts is not ready');
  assert.deepEqual(sortLanes(lanes, NOW).map((l) => l.bucket), ['conflicts', 'conflicts', 'active']);
  assert.deepEqual(filterLanes(lanes, '', { conflictsOnly: true }).map((l) => l.name), ['left', 'right']);
  assert.equal(lanes[2].conflicts, null);
});

test('each state gets one next step, then its menu actions', async () => {
  const { laneActions, sortLanes } = await load();
  const wt = { path: '/w/x', short: '~/w/x' };
  const next = (l) => laneActions(sortLanes([l], NOW)[0]);
  assert.deepEqual(next(lane('x', { conflicts: [{ with: 'main', base: true, files: ['a'] }] })), ['rebase', 'review', 'delete']);
  assert.deepEqual(next(lane('x', { conflicts: [{ with: 'y', base: false, files: ['a'] }] })), ['review', 'rebase', 'delete']);
  assert.deepEqual(next(lane('x', { pr: { checks: 'failure', url: 'https://github.com/o/r/pull/1' } })), ['checks', 'review']);
  assert.deepEqual(next(lane('x', { pr: { checks: 'failure' } })), ['review'], 'no PR link: no Open checks');
  assert.deepEqual(next(lane('x', { pr: { checks: 'pending', review: 'required' } })), ['review']);
  assert.deepEqual(next(lane('x', { pr: { checks: 'success', review: 'approved', draft: false } })), ['merge', 'review']);
  assert.deepEqual(next(lane('x', { changes: 2, activity: NOW - 5 * H, worktree: wt })), ['open', 'discard']);
  assert.deepEqual(next(lane('x', { done: { reason: 'subject' } })), ['cleanup']);
  assert.deepEqual(next(lane('x', { activity: NOW - 60e3 })), [], 'active lanes need nothing');
  // Never offer to delete what this window, or the main worktree, shows.
  assert.deepEqual(next(lane('x', { conflicts: [{ with: 'main', base: true, files: ['a'] }], worktree: { ...wt, current: true } })), ['rebase', 'review']);
  assert.deepEqual(next(lane('x', { changes: 2, activity: NOW - 5 * H, worktree: { ...wt, main: true } })), ['open']);
});

test('rows lead with the title; conflicts name the other lane by title', async () => {
  const { laneTitle, conflictsByLane, conflictText } = await load();
  assert.equal(laneTitle(lane('ak-1-x', { title: 'Fix the login' })), 'Fix the login');
  assert.equal(laneTitle(lane('ak-1-x')), 'ak-1-x');
  const a = lane('a', { title: 'Add search' });
  const b = lane('b', { title: 'Speed up graph' });
  const by = conflictsByLane([{ a, b, files: ['x.js'] }], 'main');
  assert.equal(conflictText(by.get('b:a')[0]), 'Conflicts with Speed up graph on x.js');
});

test('a local refresh during a PR load keeps the PR result, and a newer PR load wins', async () => {
  const { loadGuard, takePrs, keepPrs } = await load();
  const g = loadGuard();
  const prLoad = g.start(true);
  const local = g.start(false); // the file watcher fires while `gh` runs
  assert.equal(g.prs(prLoad), true);
  assert.equal(g.lanes(prLoad), false);
  assert.equal(g.lanes(local), true);
  assert.equal(g.prs(local), false);
  const pr = { number: 3 };
  const merged = takePrs([lane('a', { changes: 2 }), lane('b', { pr: { number: 1 } }), lane('new')], [lane('a', { pr }), lane('b')]);
  assert.deepEqual(merged.map((l) => [l.name, l.pr, l.changes]), [['a', pr, 2], ['b', null, null], ['new', null, null]]);
  // That local refresh lands after the PR load with a brand-new branch: it gets its PR from the PR load (AK-315).
  const fresh = keepPrs([lane('a'), lane('new2')], [lane('a', { pr }), lane('new2', { pr: { number: 4 } }), ...merged]);
  assert.deepEqual(fresh.map((l) => l.pr?.number ?? null), [3, 4]);
  const again = g.start(true);
  assert.equal(g.prs(prLoad), false);
  assert.equal(g.prs(again), true);
});

test('a PR load that never answers times out', async () => {
  const { withTimeout } = await load();
  await assert.rejects(withTimeout(new Promise(() => {}), 10, 'slow'), /slow/);
  assert.equal(await withTimeout(Promise.resolve(4), 10), 4);
});

test('the PR load when a repo opens and Reload share one call per repo', async () => {
  const { sharedLoad } = await load();
  const s = sharedLoad();
  let calls = 0;
  let finish;
  const start = () => { calls++; return new Promise((r) => { finish = r; }); };
  const a = s.run('/a', start);
  const b = s.run('/a', start); // Reload while the open-time load runs: joins it
  assert.equal(calls, 1);
  assert.equal(s.pending('/a'), a);
  assert.equal(s.pending('/b'), null);
  finish(7);
  assert.equal(await a, 7);
  assert.equal(await b, 7);
  assert.equal(s.pending('/a'), null); // done: the next Reload asks again
  s.run('/a', start);
  s.run('/b', start); // another repo replaces it
  assert.equal(calls, 3);
  assert.equal(s.pending('/a'), null);
  await assert.rejects(s.run('/c', () => { throw new Error('gh'); }), /gh/);
  assert.equal(s.pending('/c'), null);
});

test('send back #N waits for the lanes, and for the PR inbox with PRs on (AK-289)', async () => {
  const { sendBackWaits } = await load();
  assert.equal(sendBackWaits({ loaded: false, prsOn: false, inbox: null, inboxFailed: false }), true);
  assert.equal(sendBackWaits({ loaded: true, prsOn: true, inbox: null, inboxFailed: false }), true);
  assert.equal(sendBackWaits({ loaded: true, prsOn: true, inbox: { prs: [] }, inboxFailed: false }), false);
  assert.equal(sendBackWaits({ loaded: true, prsOn: true, inbox: null, inboxFailed: true }), false);
  assert.equal(sendBackWaits({ loaded: true, prsOn: false, inbox: null, inboxFailed: false }), false);
});

test('Catch up recounts Review lines from local lanes once the commits move (AK-366)', async () => {
  const { reviewCounts, forgetCounts } = await import('../renderer/lanes-view.js');
  let calls = 0;
  const load = async () => { calls++; return { lanes: [lane('main', { isBase: true, activity: NOW })] }; };
  forgetCounts('/r');
  const counts = await reviewCounts({ repo: '/r', load, prsOn: () => false });
  assert.equal(calls, 1);
  assert.deepEqual(counts, { repo: '/r', stuck: 0, ready: 0, needs: 0 });
});

test('⇧W checks out a pull request even when its branch is local, unless it has its own worktree', async () => {
  const { checkoutHereMode } = await load();
  const pr = { number: 7, branch: 'feat' };
  assert.equal(checkoutHereMode({ pr, lane: null }), 'pr');
  assert.equal(checkoutHereMode({ pr, lane: lane('feat') }), 'pr');
  assert.equal(checkoutHereMode({ pr, lane: lane('feat', { worktree: { path: '/w/feat', current: true } }) }), 'pr');
  assert.equal(checkoutHereMode({ pr, lane: lane('feat', { worktree: { path: '/w/feat', current: false } }) }), 'switch');
  assert.equal(checkoutHereMode({ pr: null, lane: lane('feat') }), 'open');
  assert.equal(checkoutHereMode({}), null);
});

test('every pull request row lists Check Out; one open in another worktree has no New Worktree item', async () => {
  const { checkoutChoices } = await load();
  const pr = { number: 7, branch: 'feat' };
  assert.deepEqual(checkoutChoices({ pr, lane: null }), ['here', 'worktree']);
  assert.deepEqual(checkoutChoices({ pr, lane: lane('feat') }), ['here', 'worktree']);
  assert.deepEqual(checkoutChoices({ pr, lane: lane('feat', { worktree: { path: '/w/feat', current: false } }) }), ['here']);
  assert.deepEqual(checkoutChoices({ pr: null, lane: lane('feat') }), []);
});

test('removeWhy says in a few words why a lane can’t be deleted (AK-581)', async () => {
  const { removeWhy } = await load();
  assert.equal(removeWhy({ branch: 'f' }), null);
  assert.equal(removeWhy({ branch: 'main', isBase: true }), 'Base branch');
  assert.equal(removeWhy({ branch: 'f', worktree: { current: true } }), 'Open in this window');
  assert.equal(removeWhy({ branch: 'f', worktree: { main: true } }), 'In the main worktree');
  assert.equal(removeWhy({ branch: 'f', worktree: { locked: true } }), 'Worktree is locked');
});
