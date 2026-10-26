'use strict';
// The Keyboard Shortcuts window's contents (renderer/shortcuts.js), built from the keymap.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = async () => ({ ...(await import('../renderer/keymap.js')), ...(await import('../renderer/shortcuts.js')) });
const find = (sections, id) => sections.flatMap((s) => s.rows.map((r) => ({ ...r, in: s.id }))).find((r) => r.ids.includes(id));

test('every keymap command with keys appears exactly once', async () => {
  const { COMMANDS, shortcutSections } = await load();
  const ids = shortcutSections({ mac: true }).flatMap((s) => s.rows.flatMap((r) => r.ids));
  assert.equal(ids.length, new Set(ids).size, 'a command is listed twice');
  assert.deepEqual([...ids].sort(), COMMANDS.filter((c) => c.keys.length).map((c) => c.id).sort());
});

test('rows show the current keys, every binding and both keys of a pair', async () => {
  const { shortcutSections } = await load();
  const s = shortcutSections({ mac: true });
  assert.deepEqual(find(s, 'help.shortcuts').keys, [['⌘', '/']]);
  assert.deepEqual(find(s, 'view.commit').keys, [['⌥', '⌘', '4']]);
  assert.deepEqual(find(s, 'quick.close').keys.length, 2, 'every binding');
  assert.deepEqual(find(s, 'map.next').keys, [['↓', '↑']]);
  assert.deepEqual(find(s, 'map.prev').ids, ['map.next', 'map.prev']);
  assert.deepEqual(find(shortcutSections({ mac: false }), 'view.cycleTheme').keys, [['Ctrl', '⌥', '⇧', 'T']]);
});

test('sections follow scopes, the menu bar split by menu', async () => {
  const { shortcutSections } = await load();
  const s = shortcutSections({ mac: true });
  assert.equal(find(s, 'repo.fetch').in, 'menu:repository');
  assert.equal(s.find((x) => x.id === 'menu:help').title, 'Help menu');
  assert.equal(find(s, 'conflict.ours').in, 'conflict');
  assert.ok(s.every((x) => x.title), 'a section has no title');
});

test('the active view comes first, then the keys that work anywhere', async () => {
  const { shortcutSections } = await load();
  assert.deepEqual(shortcutSections({ first: 'commit', mac: true }).slice(0, 2).map((s) => s.id), ['commit', 'global']);
  assert.equal(shortcutSections({ first: 'nope', mac: true })[0].id, 'global');
});

test('search by action, by key symbol or by key name', async () => {
  const { shortcutSections } = await load();
  const ids = (query, mac = true) => shortcutSections({ query, mac }).flatMap((s) => s.rows.flatMap((r) => r.ids));
  assert.ok(ids('cherry').includes('commit.cherryPick'));
  assert.ok(ids('previous commit').includes('map.prev'), 'the second label of a pair matches');
  assert.ok(ids('⌘⇧F').includes('repo.fetch'));
  assert.ok(ids('⇧⌘F').includes('repo.fetch'), 'modifier order does not matter');
  assert.ok(ids('cmd shift f').includes('repo.fetch'));
  assert.ok(ids('cmd+/').includes('help.shortcuts'));
  assert.ok(ids('g r').includes('view.reflog'));
  assert.ok(ids('ctrl shift f', false).includes('repo.fetch'));
  assert.ok(!ids('cmd shift f').includes('repo.pull'));
  assert.deepEqual(ids('zzzz'), []);
});

test('custom bindings are marked', async () => {
  const { shortcutSections } = await load();
  const s = shortcutSections({ custom: new Set(['repo.push', 'map.prev']), mac: true });
  assert.equal(find(s, 'repo.push').custom, true);
  assert.equal(find(s, 'map.next').custom, true);
  assert.equal(find(s, 'repo.pull').custom, false);
});

test('commands with no keys stay out of the list unless the user gave them some (AK-628)', async () => {
  const { shortcutSections } = await load();
  const ids = (custom) => shortcutSections({ custom, mac: true }).flatMap((s) => s.rows.flatMap((r) => r.ids));
  assert.ok(!ids(new Set()).includes('global.setup'));
  assert.ok(!ids(new Set()).includes('view.config'));
  assert.ok(ids(new Set()).includes('view.sidebar'));
});
