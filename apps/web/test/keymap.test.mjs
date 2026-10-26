// The /shortcuts page is built from the desktop app's keymap registry. These tests check the page model reads it
// correctly; the registry's own tests (apps/desktop/test/keymap.test.js) check every handler has an entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSources, loadKeymap, paletteCommands } from '../src/lib/keymap.mjs';

const src = readSources();
const { groups } = loadKeymap(src);
const group = (id) => groups.find((g) => g.id === id).items;
const find = (items, label) => items.find((i) => i.label === label);

test('every page group has rows with keys', () => {
  for (const g of groups) {
    assert.ok(g.items.length, `group ${g.id} is empty`);
    for (const s of g.items) assert.ok(s.keys.length && s.keys.every(Boolean), `empty key in ${g.id}: ${s.label}`);
  }
});

test('shows macOS keys, pairs and alternatives', () => {
  assert.deepEqual(find(group('edit'), 'Undo')?.keys, ['⌘', 'Z']);
  assert.deepEqual(find(group('view'), 'Command Menu')?.keys, ['⌘', 'K']);
  assert.deepEqual(find(group('view'), 'Cycle Theme')?.keys, ['⌃', '⌘', 'T']);
  assert.deepEqual(find(group('map'), 'Next / previous commit')?.keys, ['↓', '↑']);
  assert.deepEqual(find(group('quick-view'), 'Back to the map')?.alt, ['Space']);
  assert.deepEqual(find(group('commit-actions'), 'Split Commit…')?.keys, ['⇧', 'S']);
  assert.equal(find(group('commit-actions'), 'Delete Commit')?.alt, null);
});

test('views have ⌥⌘ numbers and G shortcuts', () => {
  const v = group('views');
  assert.equal(v.length, 12); // Repository Settings has no keys (⌘K and the View menu only)
  assert.deepEqual(find(v, 'Worktrees')?.keys, ['G', 'W']);
  assert.deepEqual(find(v, 'Stashes')?.keys, ['⌥', '⌘', '6']);
  assert.deepEqual(find(v, 'Branches')?.keys, ['⌥', '⌘', '5']);
  assert.equal(find(v, 'Branches')?.alt, null); // ⌥⌘ numbers only, no G chord
  assert.deepEqual(find(group('window'), 'Tab 1')?.keys, ['⌘', '1']);
  assert.deepEqual(find(v, 'Since')?.keys, ['⌥', '⌘', '1']);
  assert.deepEqual(find(v, 'Review')?.keys, ['⌥', '⌘', '2']);
  assert.deepEqual(find(v, 'History')?.keys, ['⌥', '⌘', '7']);
  assert.equal(find(v, 'History')?.alt, null);
  assert.equal(find(v, 'Repository Settings'), undefined);
  assert.deepEqual(find(v, 'Submodules')?.keys, ['⌥', '⌘', '8']);
});

test('menu groups have the menu bar shortcuts', () => {
  assert.ok(group('repository').length >= 20);
  assert.deepEqual(find(group('repository'), 'Fetch All')?.keys, ['⇧', '⌘', 'F']);
  assert.ok(find(group('file'), 'New Window'));
  assert.ok(!find(group('file'), 'Switch Repository…'), 'commands with no keys stay off the page');
  assert.ok(!find(group('file'), 'Quit Since'), 'system menu roles stay off the page');
});

test('reads the ⌘K command list', () => {
  const p = paletteCommands(src.app);
  assert.ok(p.length >= 15, `only ${p.length} palette commands found`);
  assert.ok(find(p, 'Fetch all remotes'));
});
