'use strict';
// Welcome playground state: moving the pretend branch, undo and redo (renderer/tour.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/tour.js');

test('moving the branch is one undoable step and clears redo', async () => {
  const { createTour, moveTip, undoTip, redoTip } = await load();
  let s = moveTip(createTour(), 'f1');
  assert.equal(s.tip, 'f1');
  s = moveTip(s, 'c1');
  s = undoTip(s);
  assert.deepEqual([s.tip, s.redo], ['f1', ['c1']]);
  s = moveTip(s, 'f2');
  assert.deepEqual([s.tip, s.undo, s.redo], ['f2', ['c3', 'f1'], []]);
  s = undoTip(undoTip(s));
  assert.equal(s.tip, 'c3');
  assert.equal(redoTip(redoTip(s)).tip, 'f2');
});

test('no-op moves and empty undo/redo leave the branch alone', async () => {
  const { createTour, moveTip, undoTip, redoTip } = await load();
  const s = createTour();
  assert.equal(moveTip(s, s.tip), s);
  assert.equal(moveTip(s, 'nope'), s);
  assert.equal(undoTip(s).tip, s.tip);
  assert.equal(undoTip(s).last, 'empty-undo');
  assert.equal(redoTip(s).last, 'empty-redo');
});

test('the hint always says what happened and offers the next key', async () => {
  const { createTour, moveTip, undoTip, tourHint } = await load();
  assert.equal(tourHint(createTour()).keys, null);
  const moved = moveTip(createTour(), 'c1');
  assert.match(tourHint(moved).text, /Initial commit/);
  assert.equal(tourHint(moved).keys, 'undo');
  assert.equal(tourHint(undoTip(moved)).keys, 'redo');
});

test('every commit in the playground has a known parent and lane', async () => {
  const { TOUR_COMMITS } = await load();
  const shas = new Set(TOUR_COMMITS.map((c) => c.sha));
  for (const c of TOUR_COMMITS) {
    assert.ok(c.parent === null || shas.has(c.parent), c.sha);
    assert.ok([0, 1].includes(c.lane), c.sha);
  }
});
