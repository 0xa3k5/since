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
  assert.deepEqual(some, { autoUpdate: false, tags: false, remotes: true, swatches: true, agentLanes: true, prs: false });
  assert.equal(setupValues({ prs: true }).prs, true);
});

test('the summary counts what is on', async () => {
  const { setupSummary } = await load();
  assert.match(setupSummary({ autoUpdate: true, tags: true, remotes: true, swatches: true, agentLanes: true, prs: true }), /^All on/);
  assert.match(setupSummary({ autoUpdate: true, tags: false, remotes: true, swatches: false, agentLanes: false, prs: false }), /^2 of 6 on/);
});

test('AI commit messages and pull requests sit with the user-wide defaults', async () => {
  const setup = await load();
  assert.equal(setup.SETUP_AI.id, 'ai');
  assert.equal(setup.SETUP_PRS.id, 'prs');
  assert.equal(setup.SETUP_LATER, undefined);
});
