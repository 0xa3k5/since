'use strict';
// PR inbox buckets (renderer/prs.js inboxBuckets).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/prs.js');
const pr = (number, o = {}) => ({ number, title: `PR ${number}`, branch: `b${number}`, base: 'main', author: 'kim', draft: false, review: null, checks: 'pending', mergeable: null, ...o });
const READY = { review: 'approved', checks: 'success', mergeable: true };

test('ready needs approval, green checks, a clean merge and no draft', async () => {
  const { inboxBucket } = await load();
  assert.equal(inboxBucket(pr(1, READY)), 'ready');
  assert.equal(inboxBucket(pr(1, { ...READY, draft: true })), null);
  assert.equal(inboxBucket(pr(1, { ...READY, checks: 'pending' })), null);
  assert.equal(inboxBucket(pr(1, { ...READY, review: 'required' })), null);
  // GitHub still working it out, or a conflict: not ready.
  assert.equal(inboxBucket(pr(1, { ...READY, mergeable: null })), null);
  assert.equal(inboxBucket(pr(1, { ...READY, mergeable: false })), null);
  // A local conflict forecast can veto it; without one, GitHub's answer stands.
  assert.equal(inboxBucket(pr(1, READY), { conflicts: new Set(['b1']) }), null);
  assert.equal(inboxBucket(pr(1, READY), { conflicts: new Set(['other']) }), 'ready');
});

test('first match wins: ready, review requested, failing, then yours and your agents’', async () => {
  const { inboxBucket } = await load();
  const o = { me: 'Kim', requested: [1, 2], agents: [4] };
  assert.equal(inboxBucket(pr(1, READY), o), 'ready');
  assert.equal(inboxBucket(pr(2, { checks: 'failure' }), o), 'requested');
  assert.equal(inboxBucket(pr(3, { checks: 'failure' }), o), 'failing');
  assert.equal(inboxBucket(pr(4, { author: 'someone' }), o), 'mine');
  assert.equal(inboxBucket(pr(5), o), 'mine'); // authored by me, case-insensitive
  assert.equal(inboxBucket(pr(6, { author: 'someone' }), o), null);
  assert.equal(inboxBucket(pr(6), {}), null); // login unknown: nothing is "yours"
});

test('buckets group by author in list order, mark agent batches and drop empty buckets', async () => {
  const { inboxBuckets } = await load();
  const prs = [pr(1, { ...READY, author: 'bot' }), pr(2, { ...READY, author: 'ana' }), pr(3, { ...READY, author: 'bot' }), pr(4, { author: 'bot' }), pr(5, { author: 'zed' })];
  const out = inboxBuckets(prs, { me: 'kim', agents: [1, 4] });
  assert.deepEqual(out.map((b) => [b.id, b.count]), [['ready', 3], ['mine', 1]]);
  assert.deepEqual(out[0].groups.map((g) => [g.author, g.agent, g.prs.map((p) => p.number)]), [['bot', true, [1, 3]], ['ana', false, [2]]]);
  assert.deepEqual(out[1].groups[0].prs.map((p) => p.number), [4]);
  assert.deepEqual(inboxBuckets([]), []);
});
