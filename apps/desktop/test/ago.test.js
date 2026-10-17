'use strict';
// The shared "… ago" label (renderer/ui.js), used by Review, Catch up, the review pane and PR details (AK-318).
const test = require('node:test');
const assert = require('node:assert/strict');

test('ago: "5m ago" and "2h ago", but "just now" and dates as they are', async () => {
  const { ago } = await import('../renderer/ui.js');
  const now = Date.now() / 1000;
  assert.equal(ago(now - 5), 'just now');
  assert.equal(ago(now - 5 * 60), '5m ago');
  assert.equal(ago(now - 2 * 3600), '2h ago');
  assert.equal(ago(now - 3 * 86400), '3d ago');
  assert.doesNotMatch(ago(now - 90 * 86400), /ago$/);
});
