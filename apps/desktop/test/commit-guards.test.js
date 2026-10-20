'use strict';
// Map rewrite keys use the menu's enable check (AK-580, renderer/commit-guards.js): a key on a commit
// whose menu item is greyed shows the reason instead of running into git's error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../renderer/commit-guards.js');
const HEAD = 'h'.repeat(40);
const root = { sha: 'r'.repeat(40), parents: [] };
const plain = { sha: 'p'.repeat(40), parents: ['r'.repeat(40)] };
const merge = { sha: 'm'.repeat(40), parents: ['a'.repeat(40), 'b'.repeat(40)] };
const head = { sha: HEAD, parents: ['p'.repeat(40)] };

test('rewrite actions are blocked on merge commits with a reason', async () => {
  const { commitBlock } = await load();
  for (const id of ['commit.squash', 'commit.fixup', 'swapParent', 'commit.split', 'commit.drop']) {
    assert.match(commitBlock(id, merge, HEAD), /^Merge commits can’t be /, id);
    assert.equal(commitBlock(id, plain, HEAD), null, id);
  }
  assert.equal(commitBlock('commit.squash', merge, HEAD), 'Merge commits can’t be squashed');
  assert.equal(commitBlock('commit.fixup', merge, HEAD), 'Merge commits can’t be fixed up');
});

test('rewrites that would replay a merge on HEAD say a merge is in the way', async () => {
  const { commitBlock } = await load();
  // init ← header ← M(header, side) ← tip (HEAD); side ← init.
  const g = {};
  const add = (sha, parents) => { g[sha] = { sha, parents }; return g[sha]; };
  const init = add('init', []), header = add('header', ['init']), side = add('side', ['init']);
  add('M', ['header', 'side']); const tip = add('tip', ['M']);
  const get = (sha) => g[sha];
  for (const id of ['commit.edit', 'commit.split', 'commit.drop']) assert.equal(commitBlock(id, init, 'tip', get), 'A merge commit is in the way', id);
  assert.equal(commitBlock('commit.squash', header, 'tip', get), 'A merge commit is in the way');
  assert.equal(commitBlock('commit.edit', side, 'tip', get), 'A merge commit is in the way');
  assert.equal(commitBlock('commit.edit', tip, 'tip', get), null);
  assert.equal(commitBlock('commit.drop', tip, 'tip', get), null);
  assert.equal(commitBlock('commit.squash', tip, 'tip', get), 'A merge commit is in the way');
  // Not on HEAD: the rewrite runs on its own branch, so no verdict here.
  const other = add('other', ['init']);
  assert.equal(commitBlock('commit.edit', other, 'tip', get), null);
  // No lookup: unchanged.
  assert.equal(commitBlock('commit.edit', init, 'tip'), null);
});

test('squash, fixup and swap need a parent; split and delete work on the first commit', async () => {
  const { commitBlock } = await load();
  for (const id of ['commit.squash', 'commit.fixup', 'swapParent']) assert.ok(commitBlock(id, root, HEAD), id);
  for (const id of ['commit.split', 'commit.drop', 'commit.edit']) assert.equal(commitBlock(id, root, HEAD), null, id);
});

test('actions onto HEAD are blocked on HEAD itself', async () => {
  const { commitBlock } = await load();
  for (const id of ['commit.cherryPick', 'commit.merge', 'commit.rebase', 'commit.diffHead']) {
    assert.match(commitBlock(id, head, HEAD), /^HEAD can’t be /, id);
    assert.equal(commitBlock(id, plain, HEAD), null, id);
  }
  assert.equal(commitBlock('commit.squash', head, HEAD), null);
});

test('each guarded action key and its menu item use the same check', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const shortcut = src.slice(src.indexOf('function commitShortcut('), src.indexOf('function commitMenu('));
  assert.match(shortcut, /guarded\(id, c, run\)/);
  const menu = src.slice(src.indexOf('function commitMenu('), src.indexOf('function refMenu('));
  // off() returns { disabled, why }, so a greyed item shows its reason (AK-582).
  assert.match(menu, /const off = \(id\) => \{ const why = commitBlock\(id, c, state\.head\.oid, get\); return \{ disabled: !!why, why \}; \};/);
  for (const id of ['commit.squash', 'commit.fixup', 'commit.split', 'commit.drop', 'commit.cherryPick', 'commit.merge', 'commit.rebase', 'commit.diffHead', 'commit.edit']) {
    assert.ok(menu.includes(`...off('${id}')`), id);
    assert.ok(shortcut.includes(`'${id}':`), id);
  }
  assert.ok(menu.includes("...off('swapParent')"));
  assert.doesNotMatch(menu, /disabled: off\(/);
  assert.doesNotMatch(menu, /disabled: c\.parents/);
});

test('a merge commit can only be reworded when it is HEAD', async () => {
  const { commitBlock } = await load();
  assert.equal(commitBlock('commit.edit', merge, HEAD), 'Merge commits can’t be reworded');
  assert.equal(commitBlock('commit.edit', { ...merge, sha: HEAD }, HEAD), null);
});
