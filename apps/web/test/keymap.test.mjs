// The /shortcuts page is built from the desktop source. These tests fail when the app's keys change
// and the page would go out of date, or when the extractor stops finding what it used to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSources, loadKeymap, menuShortcuts, commitActions, views, paletteCommands, INLINE, COMMIT_MESSAGE, slice, handlerKeys, formatAccelerator } from '../src/lib/keymap.mjs';

const src = readSources();
const find = (items, label) => items.find((i) => i.label === label);

test('formats accelerators in macOS modifier order', () => {
  assert.deepEqual(formatAccelerator('CmdOrCtrl+Shift+Z'), ['⇧', '⌘', 'Z']);
  assert.deepEqual(formatAccelerator('Cmd+Ctrl+T'), ['⌃', '⌘', 'T']);
  assert.deepEqual(formatAccelerator('CmdOrCtrl+\\\\'), ['⌘', '\\']);
});

test('reads the menu bar shortcuts', () => {
  const menu = menuShortcuts(src.main);
  assert.ok(menu.length >= 20, `only ${menu.length} menu shortcuts found`);
  assert.deepEqual(find(menu, 'Undo')?.keys, ['⌘', 'Z']);
  assert.deepEqual(find(menu, 'Command Menu')?.keys, ['⌘', 'K']);
  assert.deepEqual(find(menu, 'Cycle Theme')?.keys, ['⌃', '⌘', 'T']);
  assert.equal(find(menu, 'Cycle Theme')?.menu, 'View');
  for (const s of menu) assert.ok(s.keys.every(Boolean), `empty key in ${s.label}`);
});

test('commit menu keys and the map key handler agree', () => {
  const actions = commitActions(src.app);
  assert.ok(actions.length >= 12, `only ${actions.length} commit actions found`);
  const handler = slice(src.app, 'function commitShortcut', '\n}\n');
  const handled = new Set([...handler.matchAll(/\b(\w+): \(\) =>/g)].map((m) => m[1]));
  const mapKeys = handlerKeys(slice(src.app, INLINE.map.anchor));
  const toKey = (keys) => (keys[0] === '⇧' ? keys[1].toUpperCase() : ({ '⌫': 'Backspace', '↵': 'Enter' })[keys[0]] ?? keys[0].toLowerCase());
  for (const a of actions) {
    const k = toKey(a.keys);
    assert.ok(handled.has(k) || mapKeys.has(k), `"${a.label}" shows ${a.keys.join('')} but no handler reacts to it`);
  }
  const shown = new Set(actions.map((a) => toKey(a.keys)));
  for (const k of handled) {
    if (k === 'Delete') continue; // same action as Backspace
    assert.ok(shown.has(k), `commitShortcut handles "${k}" but the commit menu (and so /shortcuts) doesn't list it`);
  }
});

test('views have ⌘ numbers and G shortcuts', () => {
  const v = views(src.app);
  assert.equal(v.length, 7);
  assert.deepEqual(find(v, 'Worktrees')?.keys, ['⌘', '7']);
  assert.deepEqual(find(v, 'Snapshots')?.alt, ['G', 'H']);
});

for (const [name, scope] of Object.entries(INLINE)) {
  test(`inline keys in ${name} match the source, both ways`, () => {
    const keys = handlerKeys(slice(src.app, scope.anchor, scope.close));
    const documented = new Set(scope.keys.flatMap((k) => k.src));
    for (const k of documented) assert.ok(keys.has(k), `/shortcuts lists "${k}" for ${name}, but the handler no longer uses it`);
    for (const k of keys) assert.ok(documented.has(k), `the ${name} handler reacts to "${k}", but /shortcuts doesn't list it`);
  });
}

test('⌘↵ commits from the message box', () => {
  assert.ok(handlerKeys(slice(src.app, COMMIT_MESSAGE.anchor, '\n')).has('Enter'));
});

test('reads the ⌘K command list', () => {
  const p = paletteCommands(src.app);
  assert.ok(p.length >= 15, `only ${p.length} palette commands found`);
  assert.ok(find(p, 'Fetch all remotes'));
});

test('the page model has no empty groups', () => {
  for (const g of loadKeymap(src).groups) assert.ok(g.items.length, `group ${g.id} is empty`);
});
