'use strict';
// Launch reopens the last repository in the window closed last's size and place (AK-633).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../git');
const recent = require('../recent-store');
const { readState, saveState, fitState } = require('../window-state');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
const init = (dir) => { fs.mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q', dir]); return dir; };

test('launch reopens the newest recent repository', async () => {
  const dir = tmp();
  const file = path.join(dir, 'recent.json');
  assert.equal(await recent.lastRepo(file, git.openRepo), null);
  const a = init(path.join(dir, 'a'));
  const b = init(path.join(dir, 'b'));
  recent.addRecent(file, { root: a, name: 'a' });
  recent.addRecent(file, { root: b, name: 'b' });
  assert.equal(await recent.lastRepo(file, git.openRepo), b);
});

test('launch reopens the repository the window closed last showed, and the welcome screen when it showed none', async () => {
  const dir = tmp();
  const file = path.join(dir, 'recent.json');
  const a = init(path.join(dir, 'a'));
  const b = init(path.join(dir, 'b'));
  recent.addRecent(file, { root: a, name: 'a' });
  recent.addRecent(file, { root: b, name: 'b' });
  assert.equal(await recent.lastRepo(file, git.openRepo, a), a);
  assert.equal(await recent.lastRepo(file, git.openRepo, null), null);
  // Closed with Close Repository: no longer recent, so not reopened.
  recent.removeRecent(file, a);
  assert.equal(await recent.lastRepo(file, git.openRepo, a), null);
});

test('launch shows the welcome screen when the last repository is gone or no longer a repository', async () => {
  const dir = tmp();
  const file = path.join(dir, 'recent.json');
  const gone = init(path.join(dir, 'gone'));
  recent.addRecent(file, { root: gone, name: 'gone' });
  fs.rmSync(gone, { recursive: true });
  assert.equal(await recent.lastRepo(file, git.openRepo), null);

  // A plain folder inside another repository isn't that repository.
  const outer = init(path.join(dir, 'outer'));
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner);
  recent.addRecent(file, { root: inner, name: 'inner' });
  assert.equal(await recent.lastRepo(file, git.openRepo), null);

  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  recent.addRecent(file, { root: plain, name: 'plain' });
  assert.equal(await recent.lastRepo(file, async () => { throw Object.assign(new Error('not a repo'), { code: 'not-repo' }); }), null);
});

test('the window state round-trips and tolerates a missing or broken file', () => {
  const file = path.join(tmp(), 'window-state.json');
  assert.equal(readState(file), null);
  saveState(file, { bounds: { x: 10, y: 40, width: 1200, height: 800 }, maximized: true });
  assert.deepEqual(readState(file), { bounds: { x: 10, y: 40, width: 1200, height: 800 }, maximized: true });
  fs.writeFileSync(file, '{');
  assert.equal(readState(file), null);
});

test('saved bounds keep their place on a display, fit its size, and centre when off every display', () => {
  const main = { x: 0, y: 25, width: 1512, height: 920 };
  const side = { x: 1512, y: 0, width: 1920, height: 1080 };
  const state = (bounds, maximized) => ({ bounds, maximized });

  assert.deepEqual(fitState(state({ x: 100, y: 60, width: 1300, height: 800 }), [main]),
    { bounds: { x: 100, y: 60, width: 1300, height: 800 }, maximized: false });
  assert.deepEqual(fitState(state({ x: 1600, y: 100, width: 1400, height: 900 }, true), [main, side]),
    { bounds: { x: 1600, y: 100, width: 1400, height: 900 }, maximized: true });
  // The side display is unplugged: same size, no position (centred).
  assert.deepEqual(fitState(state({ x: 1600, y: 100, width: 1400, height: 900 }), [main]),
    { bounds: { width: 1400, height: 900 }, maximized: false });
  // Only a sliver on screen, or the top edge off the bottom: centred.
  assert.equal(fitState(state({ x: 1450, y: 60, width: 800, height: 600 }), [main]).bounds.x, undefined);
  assert.equal(fitState(state({ x: 100, y: 930, width: 800, height: 600 }), [main]).bounds.x, undefined);
  // Larger than the display: shrunk to fit.
  assert.deepEqual(fitState(state({ x: 1600, y: 0, width: 2400, height: 1400 }), [main, side]).bounds,
    { x: 1600, y: 0, width: 1920, height: 1080 });

  assert.equal(fitState(null, [main]), null);
  assert.equal(fitState({}, [main]), null);
  assert.equal(fitState(state({ x: 0, y: 0, width: 'wide', height: 800 }), [main]), null);
  assert.equal(fitState(state({ x: 0, y: 30, width: 900, height: 600 }), []), null);
});
