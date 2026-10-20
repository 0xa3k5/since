'use strict';
// AK-446: every pull request action sends a remote (renderer/prs.js prActionRemote/prActionCall),
// resolved from the PR, the caller, the PR list or the picked GitHub remote; none means no call.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/prs.js');
const pr = { number: 7, title: 'Add x', branch: 'x' };
const ACTIONS = [
  ['pr-approve', { body: 'lgtm' }],
  ['pr-request-changes', { body: 'fix y' }],
  ['pr-merge-info', undefined],
  ['pr-merge', { method: 'squash', deleteBranch: false, admin: false }],
  ['pr-close', { body: '' }],
  ['pr-ready', undefined],
  ['pr-draft', undefined],
  ['pr-comment', { body: 'hi' }],
  ['pr-failed-log', undefined],
];
const recorder = () => { const calls = []; const call = async (...a) => { calls.push(a); return { ok: true }; }; return { calls, call }; };

for (const [channel, opts] of ACTIONS) {
  test(`${channel}: passes the remote`, async () => {
    const { prActionCall } = await load();
    const { calls, call } = recorder();
    // Only app:pr-state's remote known: the PR list isn't loaded yet (the reported failure).
    assert.deepEqual(await prActionCall(call, channel, pr, opts, { prs: { active: true, data: null, remote: { name: 'origin' } } }), { ok: true });
    assert.deepEqual(calls, [[channel, 'origin', 7, opts]]);
  });
}

test('prActionRemote: the PR, then the caller, then the PR list, then the picked GitHub remote', async () => {
  const { prActionRemote } = await load();
  const prs = { data: { remote: { name: 'listed' } }, remote: { name: 'picked' } };
  assert.equal(prActionRemote({ ...pr, remote: 'own' }, prs, 'inbox'), 'own');
  assert.equal(prActionRemote(pr, prs, 'inbox'), 'inbox');
  assert.equal(prActionRemote(pr, prs), 'listed');
  assert.equal(prActionRemote(pr, { data: null, remote: { name: 'github' } }), 'github');
  assert.equal(prActionRemote(pr, { data: null, remote: null }), null);
  assert.equal(prActionRemote(pr, null), null);
});

test('no GitHub remote: no call, a readable error instead of the guard', async () => {
  const { prActionCall, NO_GITHUB_REMOTE } = await load();
  const { calls, call } = recorder();
  const res = await prActionCall(call, 'pr-approve', pr, { body: '' }, { prs: { active: true, data: null, remote: null } });
  assert.deepEqual(res, { error: NO_GITHUB_REMOTE });
  assert.match(res.error.message, /no GitHub remote/);
  assert.equal(calls.length, 0);
});

test('prActionCall: a rejected call becomes { error }', async () => {
  const { prActionCall } = await load();
  const res = await prActionCall(async () => { throw new Error('boom'); }, 'pr-close', pr, {}, { remote: 'origin' });
  assert.deepEqual(res, { error: { message: 'boom' } });
});

test('prRef: finds the local branch for a copy of the PR (review page, Inbox rows)', async () => {
  const { prRef, prsByRef } = await load();
  const data = { remote: { name: 'origin', owner: 'acme' }, prs: [pr] };
  const refs = [{ kind: 'branch', short: 'x' }];
  assert.equal(prRef({ ...pr, remote: 'origin' }, refs, prsByRef(data, refs)), refs[0]);
});

test('draftSwitch: only the switch that applies, greyed only without write access on someone else’s PR (AK-610)', async () => {
  const { draftSwitch } = await load();
  const open = { number: 4, author: 'ann', draft: false };
  const d = draftSwitch(open, null);
  assert.deepEqual([d.channel, d.draft, d.label, d.menu, d.command, d.done, d.back, d.why], ['pr-draft', true, 'Convert to draft', 'Convert to Draft', 'Convert #4 to draft', 'Converted #4 to draft', 'Mark ready for review', null]);
  const r = draftSwitch({ ...open, draft: true }, null);
  assert.deepEqual([r.channel, r.draft, r.label, r.menu, r.command, r.done, r.back], ['pr-ready', false, 'Mark ready for review', 'Mark Ready for Review', 'Mark #4 ready for review', 'Marked #4 ready for review', 'Convert back to draft']);
  // Closed or merged: nothing to switch.
  for (const state of ['closed', 'merged']) assert.equal(draftSwitch({ ...open, state }, null), null, state);
  assert.equal(draftSwitch({ ...open, state: 'open' }, null).channel, 'pr-draft');
  // The author or a writer can; no own-PR block.
  assert.equal(draftSwitch(open, { login: 'Ann', write: false }).why, null);
  assert.equal(draftSwitch(open, { login: 'bo', write: true }).why, null);
  assert.equal(draftSwitch(open, { login: 'bo', write: false }).why, 'Needs write access');
});

test('switching draft calls gh through the PR’s remote, then the row updates (AK-610)', async () => {
  const { draftSwitch, withDraft, prActionCall } = await load();
  const list = [{ number: 4, title: 'a', draft: true }, { number: 5, title: 'b', draft: false }];
  const { calls, call } = recorder();
  const d = draftSwitch(list[0], null);
  assert.deepEqual(await prActionCall(call, d.channel, list[0], undefined, { prs: { data: { remote: { name: 'upstream' } } } }), { ok: true });
  assert.deepEqual(calls, [['pr-ready', 'upstream', 4, undefined]]);
  const after = withDraft(list, 4, d.draft);
  assert.deepEqual(after.map((p) => p.draft), [false, false]);
  assert.equal(list[0].draft, true); // not mutated
  assert.deepEqual(withDraft(list, 9, true), list);
  assert.deepEqual(withDraft(null, 4, true), []);
});
