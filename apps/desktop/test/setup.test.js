'use strict';
// First-run defaults step on the welcome screen (renderer/setup.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/setup.js');

test('the step shows until it has been finished once', async () => {
  const { needsSetup } = await load();
  assert.equal(needsSetup(undefined), true);
  assert.equal(needsSetup({}), true);
  assert.equal(needsSetup({ done: false }), true);
  assert.equal(needsSetup({ done: true }), false);
});

test('every feature starts on unless it was turned off', async () => {
  const { setupValues, SETUP_FEATURES } = await load();
  const all = setupValues();
  for (const f of SETUP_FEATURES) assert.equal(all[f.id], true, f.id);
  const some = setupValues({ show: { tags: false, remotes: true }, autoUpdate: false });
  assert.deepEqual(some, { autoUpdate: false, tags: false, remotes: true, swatches: true });
});

test('the summary counts what is on', async () => {
  const { setupSummary } = await load();
  assert.match(setupSummary({ autoUpdate: true, tags: true, remotes: true, swatches: true }), /^All on/);
  assert.match(setupSummary({ autoUpdate: true, tags: false, remotes: true, swatches: false }), /^2 of 4 on/);
});

test('AI commit messages sit with the user-wide defaults, not the per-repository ones', async () => {
  const { SETUP_AI, SETUP_LATER } = await load();
  assert.equal(SETUP_AI.id, 'ai');
  assert.deepEqual(SETUP_LATER.map((f) => f.id), ['prs']);
});
