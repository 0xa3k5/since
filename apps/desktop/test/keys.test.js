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

test('a Map double-click means the row pressed first, even when it lands on the list', async () => {
  const { rowDoubleClick } = await load();
  const node = (cls) => ({ closest: (sel) => (sel.split(', ').includes(cls) || sel === cls ? {} : null) });
  const row = node('.row'), list = node('.map-list'), pill = node('.pill');
  const d = rowDoubleClick();
  d.rowDown({ detail: 1, target: row }, 'A');
  d.listDown({ detail: 1, target: row });
  d.listDown({ detail: 2, target: list });
  assert.equal(d.dblclick({ button: 0, target: list }), 'A');
  // Starting on a pill, on empty list space, or with another button checks nothing out.
  d.rowDown({ detail: 1, target: pill }, 'B');
  assert.equal(d.dblclick({ button: 0, target: list }), null);
  d.rowDown({ detail: 1, target: row }, 'C');
  d.listDown({ detail: 1, target: list });
  assert.equal(d.dblclick({ button: 0, target: list }), null);
  d.rowDown({ detail: 1, target: row }, 'D');
  assert.equal(d.dblclick({ button: 2, target: row }), null);
});
