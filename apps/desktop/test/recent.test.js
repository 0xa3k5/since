'use strict';
// Recent repositories in ⌘K and the ⌘⌥O switcher (renderer/recent.js, renderer/keys.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const repos = (n) => Array.from({ length: n }, (_, i) => ({ name: `r${i}`, root: `/repos/r${i}` }));

test('⌘K lists recent repositories other than the open one, newest first, capped at 8', async () => {
  const { otherRecent, PALETTE_RECENT_LIMIT } = await import('../renderer/recent.js');
  assert.equal(PALETTE_RECENT_LIMIT, 8);
  const list = otherRecent(repos(12), '/repos/r0', PALETTE_RECENT_LIMIT);
  assert.deepEqual(list.map((x) => x.name), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
  assert.equal(otherRecent(repos(3), '/repos/r1').length, 2);
  assert.deepEqual(otherRecent([{ root: '/a' }], '/a'), []);
  assert.deepEqual(otherRecent(undefined, '/a'), []);
});

test('the switcher shows every other recent repository and keeps all when none is open', async () => {
  const { otherRecent } = await import('../renderer/recent.js');
  assert.equal(otherRecent(repos(12), '/repos/r5').length, 11);
  assert.equal(otherRecent(repos(12), undefined).length, 12);
});

test('⌘⌥O (Ctrl+Alt+O) opens the repository switcher; other O chords do not', async () => {
  const { isRepoSwitchKey } = await import('../renderer/keys.js');
  const k = (o) => ({ code: 'KeyO', key: 'ø', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(isRepoSwitchKey(k({ metaKey: true, altKey: true })), true);
  assert.equal(isRepoSwitchKey(k({ ctrlKey: true, altKey: true })), true);
  assert.equal(isRepoSwitchKey(k({ metaKey: true })), false); // ⌘O: open
  assert.equal(isRepoSwitchKey(k({ metaKey: true, shiftKey: true })), false); // ⌘⇧O: clone
  assert.equal(isRepoSwitchKey(k({ metaKey: true, altKey: true, shiftKey: true })), false);
  assert.equal(isRepoSwitchKey(k({ altKey: true })), false);
  assert.equal(isRepoSwitchKey(k({ code: 'KeyP', metaKey: true, altKey: true })), false);
});

test('the File menu has Switch Repository… on ⌘⌥O', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  assert.match(src, /item\('Switch Repository…', 'CmdOrCtrl\+Alt\+O', 'repoSwitch'\)/);
});
