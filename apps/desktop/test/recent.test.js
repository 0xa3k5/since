'use strict';
// Recent repositories in ⌘K and the ⌘⌥O switcher (renderer/recent.js, renderer/keymap.js).
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

test('no O chord opens the repository switcher (Switch Repository… has no keys, AK-628)', async () => {
  const { match } = await import('../renderer/keymap.js');
  const isRepoSwitchKey = (e) => match('menu', e) === 'file.repoSwitch';
  const k = (o) => ({ code: 'KeyO', key: 'ø', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(isRepoSwitchKey(k({ metaKey: true, altKey: true })), false);
  assert.equal(isRepoSwitchKey(k({ ctrlKey: true, altKey: true })), false);
  assert.equal(isRepoSwitchKey(k({ metaKey: true })), false); // ⌘O: open
  assert.equal(isRepoSwitchKey(k({ metaKey: true, shiftKey: true })), false); // ⌘⇧O: clone
  assert.equal(isRepoSwitchKey(k({ metaKey: true, altKey: true, shiftKey: true })), false);
  assert.equal(isRepoSwitchKey(k({ altKey: true })), false);
  assert.equal(isRepoSwitchKey(k({ code: 'KeyP', metaKey: true, altKey: true })), false);
});

test('the File menu has Switch Repository…, with no accelerator', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  assert.match(src, /item\('Switch Repository…', acc\('file.repoSwitch'\), 'repoSwitch'\)/);
  const { accelerator } = await import('../renderer/keymap.js');
  assert.equal(accelerator('file.repoSwitch'), undefined);
});

test('recent.json: closing a repository removes it; others and the order stay', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../recent-store');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-recent-')));
  const file = path.join(tmp, 'data', 'recent.json');
  const dirs = ['a', 'b', 'c'].map((n) => { fs.mkdirSync(path.join(tmp, n)); return { root: path.join(tmp, n), name: n }; });
  try {
    for (const d of dirs) store.addRecent(file, d);
    assert.deepEqual(store.readRecent(file).map((r) => r.name), ['c', 'b', 'a']);
    assert.equal(store.removeRecent(file, dirs[1].root), true);
    assert.deepEqual(store.readRecent(file).map((r) => r.name), ['c', 'a']);
    assert.equal(store.removeRecent(file, dirs[1].root), false, 'already gone');
    assert.equal(store.removeRecent(path.join(tmp, 'none.json'), dirs[0].root), false, 'no file yet');
    store.addRecent(file, dirs[1]);
    assert.deepEqual(store.readRecent(file).map((r) => r.name), ['b', 'c', 'a']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('closing a repository cancels the Review, Branches and Catch up loads still running', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const main = read('main.js');
  const handler = (name) => { const start = main.indexOf(`handle('${name}'`); return main.slice(start, main.indexOf('\n}', start)); };
  // The session's `closed` signal is aborted on dispose (close, reopen, window closed).
  assert.match(main, /dispose\(\) \{\n\s+this\.closed\.abort\(\);/);
  for (const name of ['app:lanes-list', 'app:catchup', 'app:pr-list']) {
    const h = handler(name);
    // One session lookup, before anything is awaited: no "No repository open in this window" later.
    assert.equal(h.match(/session\(e\)/g).length, 1, name);
    assert.ok(h.indexOf('session(e)') < h.indexOf('await'), name);
    // Every gh call gets the signal; a cancelled load answers null instead of going on.
    assert.equal(h.match(/github\.(listPrs|inbox|mergedPrs|baseCi|mergedStacks)\(/g).length, h.match(/github\.\w+\(\{[^}]*\bsignal\b/g).length, name);
  }
  // git runs alongside gh (AK-639); a cancelled load answers null before either result is used.
  assert.match(handler('app:lanes-list'), /\]\);\n\s+if \(signal\.aborted\) return null;\n\s+const rest = /);
  // The renderer stops Review and Catch up before it closes the repository.
  const app = read('renderer/app.js');
  const close = app.slice(app.indexOf('async function closeRepo'), app.indexOf("await api.app('close-repo')"));
  assert.match(close, /lanesPage\?\.destroy\(\)/);
  assert.match(close, /catchupPage\?\.destroy\(\)/);
});
