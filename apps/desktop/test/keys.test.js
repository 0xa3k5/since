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
