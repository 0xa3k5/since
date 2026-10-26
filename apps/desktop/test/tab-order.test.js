'use strict';
// Which tab ⌘1–⌘9 and ⌃Tab pick, and which shows after a close or at launch (AK-634).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { byNumber, step, afterClose, reopenActive, remember, takeClosed } = require('../tab-order');

test('⌘1–⌘8 pick a tab by place, ⌘9 the last one', () => {
  assert.equal(byNumber(3, 1), 0);
  assert.equal(byNumber(3, 3), 2);
  assert.equal(byNumber(3, 4), -1);
  assert.equal(byNumber(3, 9), 2);
  assert.equal(byNumber(12, 9), 11);
});

test('⌃Tab and ⌃⇧Tab wrap round', () => {
  assert.equal(step(3, 2, 1), 0);
  assert.equal(step(3, 0, -1), 2);
  assert.equal(step(3, 1, 1), 2);
  assert.equal(step(0, -1, 1), -1);
});

test('closing a tab shows the one that takes its place, else the one before it', () => {
  assert.equal(afterClose(3, 0), 0);
  assert.equal(afterClose(3, 1), 1);
  assert.equal(afterClose(3, 2), 1);
  assert.equal(afterClose(2, 1), 0);
});

test('launch shows the tab that was showing, else the last one', () => {
  assert.equal(reopenActive(['/a', '/b'], '/a'), 0);
  assert.equal(reopenActive(['/a', '/b'], '/gone'), 1);
  assert.equal(reopenActive(['/a', '/b'], null), 1);
});

test('tabs are views in one window; tab keys and IPC go through the keymap and ipc.js', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.doesNotMatch(main, /BrowserWindow/, 'every page is a tab in a BaseWindow');
  assert.match(main, /check\.tabAction\(action\)/);
  const { tabAction } = require('../ipc');
  assert.equal(tabAction('next', 'tab action'), 'next');
  assert.throws(() => tabAction('reload', 'tab action'));
  const { defaults } = await import('../renderer/keymap.js');
  assert.deepEqual(defaults('file.newTab', true), ['Mod+T']);
  assert.deepEqual(defaults('file.close', true), ['Mod+W']);
  assert.deepEqual(defaults('file.reopenTab', true), ['Mod+Shift+T']);
  assert.deepEqual(defaults('repo.terminal', true), ['Mod+Alt+Shift+T']);
  assert.deepEqual(defaults('tab.next', true), ['Ctrl+Tab']);
  assert.deepEqual(defaults('tab.prev', true), ['Ctrl+Shift+Tab']);
});

test('⇧⌘T reopens the newest closed tab or window, skipping folders that are gone or open', () => {
  let closed = [];
  closed = remember(closed, { roots: ['/a'], active: null, window: false });
  closed = remember(closed, { roots: [], active: null, window: true });
  closed = remember(closed, { roots: ['/b', '/c'], active: '/c', window: true });
  assert.equal(closed.length, 2, 'a window with no repositories is not kept');
  let { entry, rest } = takeClosed(closed, () => true);
  assert.deepEqual(entry, { roots: ['/b', '/c'], active: '/c', window: true });
  assert.deepEqual(rest, [{ roots: ['/a'], active: null, window: false }]);
  ({ entry, rest } = takeClosed(closed, (d) => d === '/b' || d === '/a'));
  assert.deepEqual(entry.roots, ['/b']);
  ({ entry, rest } = takeClosed(closed, (d) => d === '/a'));
  assert.deepEqual(entry.roots, ['/a']);
  assert.deepEqual(rest, []);
  assert.deepEqual(takeClosed(closed, () => false), { entry: null, rest: [] });
  assert.deepEqual(takeClosed([], () => true), { entry: null, rest: [] });
  for (let i = 0; i < 25; i++) closed = remember(closed, { roots: [`/r${i}`], active: null, window: false });
  assert.equal(closed.length, 20);
  assert.deepEqual(closed.at(-1).roots, ['/r24']);
});
