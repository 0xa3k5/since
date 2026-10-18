'use strict';
// Merging with a failing check (AK-521, renderer/check-confirm.js): a confirm that names the
// failing checks, never a block. Plus the merge gate it reads (github.mergeGate).
const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../github');

const load = () => import('../renderer/check-confirm.js');
const VIEW = (o = {}) => JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', reviewDecision: '', headRefName: 'b', headRefOid: 'a'.repeat(40), ...o });
const REPO = JSON.stringify({ squashMergeAllowed: true, viewerPermission: 'WRITE' });
const ROLLUP = [
  { name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED' },
  { name: 'unit', conclusion: 'SUCCESS', status: 'COMPLETED' },
  { context: 'deploy', state: 'ERROR' },
  { name: 'e2e', conclusion: 'SKIPPED', status: 'COMPLETED' },
];

test('merge info: failing check names and counts; failing checks alone are not a soft gate', () => {
  const info = github.parseMergeInfo(VIEW({ statusCheckRollup: ROLLUP }), REPO);
  assert.deepEqual(info.failing, ['lint', 'deploy']);
  assert.deepEqual(info.checkCounts, { passed: 2, total: 4 });
  const gate = github.mergeGate(info);
  assert.deepEqual(gate.soft, []);
  assert.equal(gate.failing, true);
  // GitHub itself blocking (required checks) still takes "merge anyway".
  const blocked = github.mergeGate(github.parseMergeInfo(VIEW({ mergeStateStatus: 'BLOCKED', statusCheckRollup: ROLLUP }), REPO));
  assert.equal(blocked.soft.length, 1);
  assert.equal(blocked.failing, true);
});

test('mergeConfirm: failing checks keep Merge as the default button; GitHub blocks keep Merge anyway', async () => {
  const { mergeConfirm, failingChecks } = await load();
  const failing = failingChecks({ names: ['lint'] });
  const plain = mergeConfirm({ gate: { soft: [], failing: true }, failing, passed: 5 });
  assert.equal(plain.submit, 'Merge');
  assert.equal(plain.destructive, false);
  assert.equal(plain.anyway, false);
  assert.deepEqual(plain.checks.lines, [{ name: 'lint', text: 'failed' }]);
  assert.equal(plain.checks.passed, '5 other checks passed');
  const blocked = mergeConfirm({ gate: { soft: ['Branch protection rules block this merge.'] }, failing, passed: null });
  assert.equal(blocked.submit, 'Merge anyway');
  assert.equal(blocked.anyway, true);
  assert.ok(blocked.checks, 'still names the failing check');
  const clean = mergeConfirm({ gate: { soft: [] }, failing: [], passed: 3 });
  assert.equal(clean.checks, null);
  assert.equal(clean.submit, 'Merge');
});

test('failingChecks: evidence durations win over names; checkLines caps at two', async () => {
  const { failingChecks, passedCount, checkLines } = await load();
  const evidence = { checks: [{ name: 'lint', result: 'failure', duration: 72 }, { name: 'unit', result: 'success', duration: 30 }, { name: 'build', result: 'pending' }] };
  assert.deepEqual(failingChecks({ names: ['other'], evidence }), [{ name: 'lint', duration: 72 }]);
  assert.deepEqual(failingChecks({ names: ['a', '', 3] }), [{ name: 'a', duration: null }]);
  assert.deepEqual(failingChecks(), []);
  assert.equal(passedCount({ evidence }), 1);
  assert.equal(passedCount({ counts: { passed: 4, total: 6 } }), 4);
  assert.equal(passedCount(), null);
  assert.deepEqual(checkLines([{ name: 'lint', duration: 72 }]).lines, [{ name: 'lint', text: 'failed after 1m 12s' }]);
  const many = checkLines([{ name: 'a', duration: null }, { name: 'b', duration: null }, { name: 'c', duration: null }, { name: 'd', duration: null }], 1);
  assert.equal(many.lines.length, 2);
  assert.equal(many.more, 'and 2 more failing checks');
  assert.equal(many.passed, '1 other check passed');
  assert.equal(checkLines([]), null);
});

test('needsCheckConfirm: one more confirm only when checks failed after the first one opened', async () => {
  const { needsCheckConfirm } = await load();
  assert.equal(needsCheckConfirm(false, ['lint']), true);
  assert.equal(needsCheckConfirm(true, ['lint']), false);
  assert.equal(needsCheckConfirm(false, []), false);
  assert.equal(needsCheckConfirm(false, undefined), false);
});
