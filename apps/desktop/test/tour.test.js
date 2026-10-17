'use strict';
// Welcome tour state: the pretend repository, its one-key rewrites, undo and redo (renderer/tour.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/tour.js');
const shas = (s) => s.commits.map((c) => c.sha);

test('moving the branch is one undoable step and clears redo', async () => {
  const { createTour, moveTip, undoTip, redoTip } = await load();
  let s = moveTip(createTour(), 'f1');
  assert.equal(s.tip, 'f1');
  s = moveTip(s, 'c1');
  s = undoTip(s);
  assert.equal(s.tip, 'f1');
  assert.equal(s.redo.length, 1);
  s = moveTip(s, 'f2');
  assert.deepEqual([s.tip, s.undo.length, s.redo.length], ['f2', 2, 0]);
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

test('squash folds a commit into its parent and re-points its children', async () => {
  const { createTour, select, squash, undoTip } = await load();
  const s = squash(select(createTour(), 'c2'));
  assert.deepEqual(shas(s), ['f2', 'c3', 'f1', 'c1']);
  assert.ok(s.commits.filter((c) => ['c3', 'f1'].includes(c.sha)).every((c) => c.parent === 'c1'));
  assert.equal(s.sel, 'c1');
  assert.equal(squash(select(createTour(), 'c1')).last, 'no-squash');
  assert.deepEqual(shas(undoTip(s)), shas(createTour()));
});

test('rebase replays the feature branch onto a main commit, once', async () => {
  const { createTour, select, rebase } = await load();
  const s = rebase(select(createTour(), 'c3'));
  assert.deepEqual(shas(s), ['f2', 'f1', 'c3', 'c2', 'c1']);
  assert.equal(s.commits.find((c) => c.sha === 'f1').parent, 'c3');
  assert.equal(rebase(s).last, 'no-rebase');
  assert.equal(rebase(select(createTour(), 'f1')).last, 'no-rebase');
});

test('cherry-pick copies a feature commit onto main and moves main there', async () => {
  const { createTour, select, cherryPick, undoTip } = await load();
  const s = cherryPick(select(createTour(), 'f1'));
  assert.equal(s.tip, "f1'");
  assert.deepEqual(s.commits[0], { sha: "f1'", lane: 0, parent: 'c3', message: 'Add file history view' });
  assert.equal(cherryPick(select(s, 'f1')).last, 'no-pick');
  assert.equal(cherryPick(select(createTour(), 'c2')).last, 'no-pick');
  const back = undoTip(s);
  assert.equal(back.tip, 'c3');
  assert.equal(back.sel, null);
});

test('lessons, commands and hints', async () => {
  const { createTour, setLesson, moveTip, undoTip, tourHint, filterCommands, LESSONS, TOUR_COMMANDS } = await load();
  assert.equal(setLesson(createTour(), 'nope').lesson, 'graph');
  assert.equal(setLesson(createTour(), 'palette').lesson, 'palette');
  assert.equal(tourHint(setLesson(createTour(), 'palette')).keys, 'palette');
  const moved = moveTip(createTour(), 'c1');
  assert.match(tourHint(moved).text, /Initial commit/);
  assert.equal(tourHint(undoTip(moved)).keys, 'redo');
  assert.deepEqual(filterCommands('squ').map((c) => c.key), ['S']);
  assert.equal(filterCommands('  ').length, TOUR_COMMANDS.length);
  for (const c of TOUR_COMMANDS) assert.ok(!c.lesson || LESSONS.some((l) => l.id === c.lesson), c.label);
});

test('every commit in the playground has a known parent and lane', async () => {
  const { TOUR_COMMITS } = await load();
  const all = new Set(TOUR_COMMITS.map((c) => c.sha));
  for (const c of TOUR_COMMITS) {
    assert.ok(c.parent === null || all.has(c.parent), c.sha);
    assert.ok([0, 1].includes(c.lane), c.sha);
  }
});
