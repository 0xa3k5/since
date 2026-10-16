'use strict';
// Branches (renderer/branches.js): which tab a lane is on, and its quiet line (AK-396).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/branches.js');
const NOW = Date.UTC(2026, 9, 16, 12);
const H = 3600e3;
const DAY = 24 * H;
const lane = (name, extra = {}) => ({ name, branch: name, head: 'a'.repeat(40), isBase: false, worktree: null, activity: NOW - H, ahead: 1, behind: 0, changes: null, merged: null, done: null, agent: null, pr: null, upstream: 'origin/' + name, ...extra });

test('tabs: finished lanes only on Finished; agent-made and would-conflict are views across the rest', async () => {
  const { branchTabs } = await load();
  const lanes = [
    lane('busy'),
    lane('old', { activity: NOW - 40 * DAY }),
    lane('agent', { agent: { reason: 'branch prefix', match: 'claude/' } }),
    lane('clash', { conflicts: [{ with: 'main', base: true, files: ['app.js'] }] }),
    lane('shipped', { done: { reason: 'pr', pr: 9 } }),
    lane('gone', { upstreamGone: true, activity: NOW - 40 * DAY }),
    lane('bot', { pr: { number: 3, bot: true } }),
    lane('main', { isBase: true }),
  ];
  const t = branchTabs(lanes.map((l) => ({ ...l })), { now: NOW });
  const names = (id) => t[id].map((l) => l.name);
  assert.deepEqual(names('active'), ['busy', 'agent', 'clash', 'bot']);
  assert.deepEqual(names('agents'), ['agent', 'bot']);
  assert.deepEqual(names('conflict'), ['clash']);
  assert.deepEqual(names('idle'), ['old', 'main']);
  assert.deepEqual(names('finished'), ['shipped', 'gone']);
  assert.deepEqual(branchTabs(lanes, { agents: false, now: NOW }).agents, [], 'marks off: no agent-made tab rows');
});

test('the quiet line: ahead/behind, worktree, PR, uncommitted; idle lanes say how long', async () => {
  const { branchLine, branchDot } = await load();
  assert.equal(branchLine(lane('x', { ahead: 3, behind: 0, worktree: { path: '/w/x' }, changes: 2 }), { now: NOW }), '↑3 · worktree · 2 uncommitted');
  assert.equal(branchLine(lane('x', { ahead: 12, behind: 4, pr: { number: 162 } }), { now: NOW }), '↑12 ↓4 · PR #162 open');
  assert.equal(branchLine(lane('x', { ahead: 2, behind: 40, upstream: null }), { now: NOW }), '↑2 ↓40 · local only');
  assert.equal(branchLine(lane('x', { ahead: 0, behind: 0, activity: NOW - 41 * DAY }), { now: NOW }), 'no commits for 41 days');
  assert.equal(branchDot(lane('x', { conflicts: [{}] })), 'warn');
  assert.equal(branchDot(lane('x', { pr: { checks: 'failure' } })), 'red');
  assert.equal(branchDot(lane('x', { changes: 1 })), 'green');
  assert.equal(branchDot(lane('x')), '');
});

test('filter by branch, title, worktree or PR', async () => {
  const { filterBranches } = await load();
  const lanes = [lane('feature/map', { title: 'Speed up the graph' }), lane('fix/login', { pr: { number: 12, title: 'Fix login' } })];
  assert.deepEqual(filterBranches(lanes, 'graph').map((l) => l.name), ['feature/map']);
  assert.deepEqual(filterBranches(lanes, '#12').map((l) => l.name), ['fix/login']);
  assert.equal(filterBranches(lanes, '').length, 2);
});
