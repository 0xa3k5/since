'use strict';
// Map double-click / ⌘↵ checkout decision (renderer/checkout-plan.js, AK-456).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/checkout-plan.js');
const b = (short, target) => ({ kind: 'branch', short, target });
const rb = (short, target) => ({ kind: 'remote', short, target });
const head = { branch: 'main', oid: 'h' };

test('a branch tip switches to the branch, an already-current tip does nothing', async () => {
  const { checkoutPlan } = await load();
  assert.deepEqual(checkoutPlan({ sha: 'a' }, [b('main', 'h'), b('feat', 'a')], head), { kind: 'switch', branch: 'feat' });
  assert.equal(checkoutPlan({ sha: 'h' }, [b('main', 'h')], head), null);
  assert.deepEqual(checkoutPlan({ sha: 'h' }, [b('main', 'h'), b('other', 'h')], head), { kind: 'switch', branch: 'other' });
  assert.deepEqual(checkoutPlan({ sha: 'h' }, [b('main', 'h')], { branch: null, oid: 'h' }), { kind: 'switch', branch: 'main' });
});

test('a remote-only branch offers a local tracking branch', async () => {
  const { checkoutPlan } = await load();
  assert.deepEqual(checkoutPlan({ sha: 'a' }, [b('main', 'h'), rb('origin/feat/x', 'a')], head), { kind: 'remote', remote: 'origin/feat/x', local: 'feat/x' });
  // A local branch with that name already exists elsewhere: treat it as a plain commit.
  assert.deepEqual(checkoutPlan({ sha: 'a' }, [b('feat', 'z'), rb('origin/feat', 'a')], head), { kind: 'commit' });
});

test('a plain commit offers a new branch or a detached checkout; HEAD does nothing', async () => {
  const { checkoutPlan } = await load();
  assert.deepEqual(checkoutPlan({ sha: 'a' }, [b('main', 'h'), { kind: 'tag', short: 'v1', target: 'a' }], head), { kind: 'commit' });
  assert.equal(checkoutPlan({ sha: 'h' }, [], { branch: null, oid: 'h' }), null);
  assert.equal(checkoutPlan(null, [], head), null);
});
