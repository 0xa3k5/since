'use strict';
// Map-view checkout shortcut (renderer/keymap.js) and double-click guard (renderer/keys.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/keys.js');
const isCheckoutKey = async (e) => (await import('../renderer/keymap.js')).match('map', e) === 'commit.checkoutBranch';
const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('⌘↵ and Ctrl+↵ are the checkout key', async () => {
  assert.equal(await isCheckoutKey(key('Enter', { metaKey: true })), true);
  assert.equal(await isCheckoutKey(key('Enter', { ctrlKey: true })), true);
});

test('plain ↵ and other combos are not the checkout key', async () => {
  assert.equal(await isCheckoutKey(key('Enter')), false);
  assert.equal(await isCheckoutKey(key('Enter', { metaKey: true, shiftKey: true })), false);
  assert.equal(await isCheckoutKey(key('Enter', { metaKey: true, altKey: true })), false);
  assert.equal(await isCheckoutKey(key('o', { metaKey: true })), false);
});

test('double-clicks on pills and avatars are not row double-clicks', async () => {
  const { isRowControl } = await load();
  const el = (match) => ({ closest: (sel) => (sel.split(', ').includes(match) ? {} : null) });
  assert.equal(isRowControl(el('.pill')), true);
  assert.equal(isRowControl(el('.avatar-stack')), true);
  assert.equal(isRowControl(el('.subject')), false);
  assert.equal(isRowControl(null), false);
});

test('a Map double-click is the second press on the same row, even after the row is redrawn', async () => {
  const { rowDoubleClick } = await load();
  const node = (cls) => ({ closest: (sel) => (sel.split(', ').includes(cls) || sel === cls ? {} : null) });
  const row = node('.row'), list = node('.map-list'), pill = node('.pill');
  const d = rowDoubleClick();
  assert.equal(d.rowDown({ button: 0, detail: 1, target: row }, 'A'), null);
  d.listDown({ button: 0, detail: 1, target: row });
  assert.equal(d.rowDown({ button: 0, detail: 2, target: row }, 'A'), 'A');
  // A third press does not check out again.
  assert.equal(d.rowDown({ button: 0, detail: 3, target: row }, 'A'), null);
  // Second press on another row, on a pill, after empty list space, or with another button: nothing.
  d.rowDown({ button: 0, detail: 1, target: row }, 'B');
  assert.equal(d.rowDown({ button: 0, detail: 2, target: row }, 'C'), null);
  d.rowDown({ button: 0, detail: 1, target: row }, 'D');
  assert.equal(d.rowDown({ button: 0, detail: 2, target: pill }, 'D'), null);
  d.rowDown({ button: 0, detail: 1, target: row }, 'E');
  d.listDown({ button: 0, detail: 1, target: list });
  assert.equal(d.rowDown({ button: 0, detail: 2, target: row }, 'E'), null);
  d.rowDown({ button: 0, detail: 1, target: row }, 'F');
  assert.equal(d.rowDown({ button: 2, detail: 2, target: row }, 'F'), null);
});
