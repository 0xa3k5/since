'use strict';
// Resizable panes: clamping, keyboard steps and saved sizes (renderer/pane-size.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/pane-size.js');

test('widths stay between the floor and the ceiling', async () => {
  const { clampPane, PANES } = await load();
  assert.equal(clampPane('sidebar', 10), PANES.sidebar.min);
  assert.equal(clampPane('sidebar', 9999), PANES.sidebar.max);
  assert.equal(clampPane('commit', 300.4), 300);
});

test('a pane always leaves room for the content beside it, but never drops below its floor', async () => {
  const { clampPane, PANES } = await load();
  assert.equal(clampPane('commit', 600, 800), 800 - PANES.commit.keep);
  assert.equal(clampPane('commit', 600, 300), PANES.commit.min);
});

test('arrow keys step, shift steps further, Home/End/Enter jump', async () => {
  const { stepPane, PANES, STEP, BIG_STEP } = await load();
  assert.equal(stepPane('sidebar', 232, 'ArrowRight'), 232 + STEP);
  assert.equal(stepPane('sidebar', 232, 'ArrowLeft', true), 232 - BIG_STEP);
  assert.equal(stepPane('sidebar', 232, 'Home'), PANES.sidebar.min);
  assert.equal(stepPane('sidebar', 232, 'End'), PANES.sidebar.max);
  assert.equal(stepPane('commit', 500, 'Enter'), PANES.commit.def);
  assert.equal(stepPane('commit', 500, 'ArrowUp'), null);
});

test('saved sizes load clamped, with defaults for missing or broken values', async () => {
  const { loadSizes, defaultSizes, PANES } = await load();
  assert.deepEqual(defaultSizes(), { sidebar: PANES.sidebar.def, commit: PANES.commit.def });
  assert.deepEqual(loadSizes({ sidebar: 5000, commit: 'x' }), { sidebar: PANES.sidebar.max, commit: PANES.commit.def });
  assert.deepEqual(loadSizes(null), defaultSizes());
});
