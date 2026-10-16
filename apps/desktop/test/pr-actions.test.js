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
