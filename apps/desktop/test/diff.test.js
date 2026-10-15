'use strict';
// Diff line drag-select auto-scroll (renderer/diff.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/diff.js');

test('dragging near the pane edges scrolls it, faster further out', async () => {
  const { edgeScroll } = await load();
  assert.equal(edgeScroll(300, 100, 500), 0, 'middle of the pane: no scroll');
  assert.equal(edgeScroll(132, 100, 500), 0, 'just outside the edge zone');
  assert.ok(edgeScroll(110, 100, 500) < 0, 'near the top scrolls up');
  assert.ok(edgeScroll(490, 100, 500) > 0, 'near the bottom scrolls down');
  assert.ok(edgeScroll(50, 100, 500) < edgeScroll(110, 100, 500), 'past the edge scrolls faster');
  assert.equal(edgeScroll(-1000, 100, 500), -32, 'capped');
  assert.equal(edgeScroll(5000, 100, 500), 32, 'capped');
});
