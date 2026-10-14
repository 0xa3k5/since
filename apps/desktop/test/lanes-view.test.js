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
  ];
  const sorted = sortLanes(lanes, NOW);
  assert.deepEqual(sorted.map((l) => l.name), ['failing', 'review', 'stalled', 'ready', 'active', 'main', 'idle']);
  assert.deepEqual(sorted.map((l) => l.bucket), ['failing', 'review', 'stalled', 'ready', 'active', 'idle', 'idle']);
});

test('recent dirty work, drafts and merged lanes are not flagged', async () => {
  const { laneBucket } = await load();
  assert.equal(laneBucket(lane('x', { changes: 2, activity: NOW - 60e3 }), NOW), 'active');
  assert.equal(laneBucket(lane('x', { pr: { checks: 'success', review: 'approved', draft: true } }), NOW), 'active');
  assert.equal(laneBucket(lane('x', { merged: 'squash' }), NOW), 'idle');
  assert.equal(laneBucket(lane('x', { pr: { checks: 'pending', review: 'required' } }), NOW), 'review');
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
});

test('predicted conflicts: both lanes of a pair get them, they sort with "needs you" and block ready', async () => {
  const { conflictsByLane, withConflicts, sortLanes, filterLanes, conflictText, laneBucket } = await load();
  const by = conflictsByLane([
    { a: { name: 'left', branch: 'left', worktree: null }, b: { name: 'right', branch: 'right', worktree: null }, files: ['a.js'] },
    { a: { name: 'left', branch: 'left', worktree: null }, b: null, files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] },
  ], 'main');
  assert.deepEqual(by.get('b:left').map((c) => c.with), ['main', 'right']);
  assert.deepEqual(by.get('b:right'), [{ with: 'left', base: false, files: ['a.js'] }]);
  assert.equal(conflictText(by.get('b:left')[0]), 'Conflicts with main on a.js, b.js, c.js and 2 more');
  const ready = { pr: { number: 4, checks: 'success', review: 'approved', draft: false } };
  const lanes = withConflicts([lane('left', ready), lane('right'), lane('quiet')], by);
  assert.equal(laneBucket(lanes[0], NOW), 'conflicts', 'a green, approved PR with conflicts is not ready');
  assert.deepEqual(sortLanes(lanes, NOW).map((l) => l.bucket), ['conflicts', 'conflicts', 'active']);
  assert.deepEqual(filterLanes(lanes, '', { conflictsOnly: true }).map((l) => l.name), ['left', 'right']);
  assert.equal(lanes[2].conflicts, null);
});
