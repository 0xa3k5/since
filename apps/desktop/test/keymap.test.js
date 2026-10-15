'use strict';
// The keymap registry (renderer/keymap.js): every shortcut, its scope, menu accelerators and keycap labels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../renderer/keymap.js');
const ev = (key, mods = {}) => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

// A binding step as one comparable string: letters fold case, so "Shift+S" and "Shift+s" collide.
const norm = (step) => [...[...step.mods].sort(), /^[a-z]$/i.test(step.key) ? step.key.toLowerCase() : step.key].join('+');

test('no key is bound twice within a scope', async () => {
  const { COMMANDS, SCOPES, bindings, parse } = await load();
  for (const mac of [true, false]) {
    for (const scope of Object.keys(SCOPES)) {
      const seen = new Map();
      for (const cmd of COMMANDS.filter((c) => c.scope === scope)) {
        for (const b of bindings(cmd.id, mac)) {
          const k = parse(b).map(norm).join(' ');
          assert.ok(!seen.has(k), `${scope}: ${b} is bound to both ${seen.get(k)} and ${cmd.id}`);
          seen.set(k, cmd.id);
        }
      }
    }
  }
});

test('the window-wide keys do not collide with menu accelerators', async () => {
  const { COMMANDS, bindings, parse } = await load();
  const keysOf = (scope) => new Map(COMMANDS.filter((c) => c.scope === scope).flatMap((c) => bindings(c.id).map((b) => [parse(b).map(norm).join(' '), c.id])));
  const menu = keysOf('menu');
  for (const [k, id] of keysOf('global')) assert.ok(!menu.has(k), `${id} uses ${k}, which the menu gives to ${menu.get(k)}`);
});

test('every command has an id, label, known scope and parseable keys', async () => {
  const { COMMANDS, SCOPES, parse } = await load();
  const ids = new Set();
  for (const c of COMMANDS) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.label && SCOPES[c.scope], `${c.id}: missing label or unknown scope ${c.scope}`);
    assert.ok(c.keys.length, `${c.id} has no keys`);
    for (const b of [...c.keys, ...[].concat(c.other ?? [])]) assert.doesNotThrow(() => parse(b), `${c.id}: ${b}`);
  }
});

test('macOS-reserved keys are marked not rebindable', async () => {
  const { command } = await load();
  for (const id of ['app.quit', 'app.hide', 'file.close', 'app.settings']) assert.equal(command(id).reserved, true, id);
  assert.ok(!command('repo.fetch').reserved);
});

// AK rule: navigation is arrow keys only. J/K (or H/L) must never move to the next or previous item.
test('no next/previous command is bound to a vim letter', async () => {
  const { COMMANDS, bindings, parse } = await load();
  for (const mac of [true, false]) {
    for (const cmd of COMMANDS.filter((c) => /\.(next|prev)/.test(c.id))) {
      for (const b of bindings(cmd.id, mac)) {
        for (const step of parse(b)) assert.ok(!/^[hjkl]$/i.test(step.key), `${cmd.id} is bound to ${b}`);
      }
    }
  }
});

// Every command id the app's source refers to must exist, and every command must be used somewhere.
const SOURCES = ['main.js', ...fs.readdirSync(path.join(__dirname, '../renderer')).filter((f) => f.endsWith('.js') && f !== 'keymap.js').map((f) => `renderer/${f}`)];
const source = SOURCES.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');

test('every handler refers to a registered command', async () => {
  const { COMMANDS, SCOPES } = await load();
  const ids = new Set(COMMANDS.map((c) => c.id));
  const prefixes = [...new Set(COMMANDS.map((c) => c.id.split('.')[0]))].join('|');
  const used = [...source.matchAll(new RegExp(`'((?:${prefixes})\\.[a-zA-Z]+)'`, 'g'))].map((m) => m[1]).filter((id) => !/\.(json|js|md|txt)$/.test(id)); // file names, not commands
  assert.ok(used.length > 100, `only ${used.length} command ids found in the source`);
  for (const id of used) assert.ok(ids.has(id), `the source uses ${id}, which isn't in the keymap`);
  for (const m of source.matchAll(/keymap\.(?:match|chordStart)\('(\w+)'/g)) assert.ok(SCOPES[m[1]], `unknown scope ${m[1]}`);
  // Built ids: keymap.keys(`view.${v.id}`) and the "g c" → view.commit chords.
  const built = (id) => /^view\./.test(id);
  for (const c of COMMANDS) {
    if (c.role || built(c.id)) continue;
    assert.ok(source.includes(`'${c.id}'`), `${c.id} is in the keymap but nothing handles it`);
  }
});

test('no inline key checks remain outside text inputs', () => {
  // The only e.key comparisons left are on <input> fields (map search, licence key, tour search) and the
  // shortcut recorder's fixed Esc (cancel) and ⌫ (remove), which must work whatever the keymap says.
  const inline = SOURCES.flatMap((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n')
    .map((l, i) => [`${f}:${i + 1}`, l]).filter(([, l]) => /\be\.(key|code) ===/.test(l)));
  assert.deepEqual(inline.map(([at]) => at.split(':')[0]).sort(), [
    'renderer/app.js', 'renderer/app.js', 'renderer/app.js', 'renderer/licence.js', 'renderer/shortcuts-view.js', 'renderer/shortcuts-view.js', 'renderer/tour-view.js',
  ], inline.map(([at, l]) => `${at} ${l.trim()}`).join('\n'));
});

test('matches letters with Shift exactly, and other keys with or without it', async () => {
  const { match } = await load();
  assert.equal(match('map', ev('s')), 'commit.squash');
  assert.equal(match('map', ev('S', { shiftKey: true })), 'commit.split');
  assert.equal(match('map', ev('h', { metaKey: true })), null);
  assert.equal(match('map', ev('ArrowDown', { shiftKey: true })), 'map.next');
  assert.equal(match('commit', ev('ArrowDown', { shiftKey: true })), 'cv.extendNext');
  assert.equal(match('commit', ev('ArrowDown')), 'cv.next');
  assert.equal(match('map', ev('Delete')), 'commit.drop');
  assert.equal(match('map', ev('Enter', { metaKey: true, shiftKey: true })), null);
  assert.equal(match('map', ev('c', { ctrlKey: true })), 'map.copySha');
  assert.equal(match('quick', ev(' ')), 'quick.close');
});

test('matches e.code bindings whatever character ⌥ or ⇧ types', async () => {
  const { match } = await load();
  assert.equal(match('global', ev('<', { code: 'Comma', metaKey: true, shiftKey: true })), 'global.setup');
  assert.equal(match('global', ev('«', { code: 'Backslash', metaKey: true, altKey: true })), 'global.detail');
  assert.equal(match('global', ev(',', { code: 'Comma', metaKey: true })), null);
});

test('chords: G, then a view letter', async () => {
  const { match, chordStart } = await load();
  assert.equal(chordStart('menu', ev('g')), 'g');
  assert.equal(chordStart('menu', ev('m')), null);
  assert.equal(match('menu', ev('c'), 'g'), 'view.commit');
  assert.equal(match('menu', ev('h'), 'g'), 'view.snapshots');
  assert.equal(match('menu', ev('x'), 'g'), null);
  assert.equal(match('menu', ev('c')), null);
});

test('menu accelerators and keycaps per platform', async () => {
  const { accelerator, keys } = await load();
  assert.equal(accelerator('repo.fetch', true), 'CmdOrCtrl+Shift+F');
  assert.equal(accelerator('view.sidebar', true), 'CmdOrCtrl+\\');
  assert.equal(accelerator('view.map', true), 'CmdOrCtrl+1');
  assert.equal(accelerator('view.cycleTheme', true), 'Ctrl+Cmd+T');
  assert.equal(accelerator('view.cycleTheme', false), 'Ctrl+Alt+Shift+T');
  assert.equal(accelerator('app.settings', true), 'CmdOrCtrl+,');
  assert.deepEqual(keys('repo.prRefresh', { mac: true }), ['⌥', '⇧', '⌘', 'P']);
  assert.deepEqual(keys('repo.prRefresh', { mac: false }), ['Ctrl', '⌥', '⇧', 'P']);
  assert.deepEqual(keys('view.cycleTheme', { mac: true }), ['⌃', '⌘', 'T']);
  assert.deepEqual(keys('view.worktrees', { mac: true, index: 1 }), ['G', 'W']);
  assert.deepEqual(keys('commit.split', { mac: true }), ['⇧', 'S']);
  assert.deepEqual(keys('commit.drop', { mac: true }), ['⌫']);
  assert.deepEqual(keys('global.setup', { mac: true }), ['⇧', '⌘', ',']);
});

test('main.js takes every menu accelerator from the keymap', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.doesNotMatch(main, /'(CmdOrCtrl|Cmd|Ctrl)\+/, 'a hard-coded accelerator is left in main.js');
});

// ---------------------------------------------------------------------------
// Custom key bindings (AK-203).

const kev = (key, code, mods = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('overrides replace a command’s keys everywhere: match, labels, accelerator; reset restores them', async () => {
  const k = await load();
  try {
    k.setOverrides({ 'commit.checkout': ['x'], 'repo.fetch': ['Mod+Alt+Shift+F'] });
    assert.equal(k.match('map', kev('x', 'KeyX'), null, true), 'commit.checkout');
    assert.equal(k.match('map', kev('o', 'KeyO'), null, true), null, 'the old key stops working');
    assert.deepEqual(k.keys('commit.checkout', { mac: true }), ['X']);
    assert.equal(k.accelerator('repo.fetch', true), 'CmdOrCtrl+Alt+Shift+F');
    assert.ok(k.isCustom('commit.checkout') && !k.isCustom('commit.diffHead'));
    k.setOverrides({ 'commit.checkout': [] });
    assert.equal(k.match('map', kev('o', 'KeyO'), null, true), null, 'a cleared command has no keys');
    k.setOverrides({});
    assert.equal(k.match('map', kev('o', 'KeyO'), null, true), 'commit.checkout');
    assert.equal(k.accelerator('repo.fetch', true), 'CmdOrCtrl+Shift+F');
  } finally { k.setOverrides({}); }
});

test('sanitize keeps only known, non-reserved commands with valid bindings', async () => {
  const { sanitize } = await load();
  assert.deepEqual(sanitize({ 'commit.checkout': ['x', 'x'], 'app.quit': ['Mod+Y'], nope: ['a'], 'commit.tag': ['Hyper+T'], 'commit.branch': 'b' }), { 'commit.checkout': ['x'] });
  assert.deepEqual(sanitize(null), {});
  assert.deepEqual(sanitize(['x']), {});
  // The recorder's refusals apply too (AK-234): a bare-key menu command, a chord on a non-view.
  assert.deepEqual(sanitize({ 'repo.fetch': ['f'], 'commit.checkout': ['g c'] }), {});
  assert.deepEqual(sanitize({ 'repo.fetch': ['Mod+Alt+F'] }), { 'repo.fetch': ['Mod+Alt+F'] });
});

test('withBinding stores overrides only, dropping a list equal to the defaults', async () => {
  const { withBinding } = await load();
  assert.deepEqual(withBinding({}, 'commit.checkout', ['x'], true), { 'commit.checkout': ['x'] });
  assert.deepEqual(withBinding({ 'commit.checkout': ['x'] }, 'commit.checkout', ['o'], true), {});
  assert.deepEqual(withBinding({}, 'repo.fileHistory', ['Mod+Shift+h'], true), {}, 'spelling doesn’t matter');
});

test('fromEvent records keys in the keymap’s spelling', async () => {
  const { fromEvent } = await load();
  assert.equal(fromEvent(kev('K', 'KeyK', { metaKey: true, shiftKey: true }), true), 'Mod+Shift+k');
  assert.equal(fromEvent(kev('å', 'KeyA', { metaKey: true, altKey: true }), true), 'Mod+Alt+KeyA');
  assert.equal(fromEvent(kev('?', 'Slash', { shiftKey: true }), true), 'Shift+Slash');
  assert.equal(fromEvent(kev('!', 'Digit1', { shiftKey: true }), true), 'Shift+Digit1');
  assert.equal(fromEvent(kev(' ', 'Space'), true), 'Space');
  assert.equal(fromEvent(kev('k', 'KeyK', { metaKey: true, ctrlKey: true }), true), 'Mod+Ctrl+k');
  assert.equal(fromEvent(kev('k', 'KeyK', { ctrlKey: true }), false), 'Mod+k');
  assert.equal(fromEvent(kev('Shift', 'ShiftLeft', { shiftKey: true }), true), null);
});

test('recorded keys match the events that recorded them', async () => {
  const k = await load();
  const cases = [kev('K', 'KeyK', { metaKey: true, shiftKey: true }), kev('å', 'KeyA', { metaKey: true, altKey: true }), kev('?', 'Slash', { shiftKey: true }), kev(']', 'BracketRight'), kev('ArrowDown', 'ArrowDown', { altKey: true })];
  try {
    for (const e of cases) {
      k.setOverrides({ 'commit.checkout': [k.fromEvent(e, true)] });
      assert.equal(k.match('map', e, null, true), 'commit.checkout', k.fromEvent(e, true));
    }
  } finally { k.setOverrides({}); }
});

test('conflicts: same scope, the always-on menu and global keys, and chord starts', async () => {
  const { conflicts } = await load();
  assert.deepEqual(conflicts('commit.checkout', 'd', true), ['commit.diffHead']);
  assert.deepEqual(conflicts('commit.checkout', 'Mod+K', true), ['view.palette'], 'menu keys work in every view');
  assert.deepEqual(conflicts('commit.checkout', '/', true), ['global.search']);
  assert.deepEqual(conflicts('conflict.ours', 'd', true), [], 'other views don’t clash');
  assert.ok(conflicts('commit.checkout', 'g', true).includes('view.commit'), 'G starts the view chords');
  assert.deepEqual(conflicts('view.map', 'g d', true), [], 'a free chord');
  assert.deepEqual(conflicts('repo.fetch', 'Mod+Alt+KeyO', true), ['file.repoSwitch'], 'key codes compare by key');
});

test('refusal: reserved commands and keys, macOS keys, and menu keys without a modifier', async () => {
  const { refusal } = await load();
  assert.match(refusal('app.quit', 'Mod+Y', true), /can’t be changed/);
  assert.match(refusal('repo.fetch', 'Mod+Q', true), /Quit GitLanes/);
  assert.match(refusal('repo.fetch', 'Mod+Tab', true), /macOS/);
  assert.match(refusal('repo.fetch', 'Mod+Shift+Digit4', true), /screenshot/);
  assert.match(refusal('repo.fetch', 'f', true), /need ⌘/);
  assert.match(refusal('repo.fetch', 'g f', true), /Only the views/);
  assert.match(refusal('map.head', 'x y', true), /Only the views/);
  assert.match(refusal('map.head', 'Mod+g c', true), /plain keys/);
  assert.equal(refusal('view.map', 'g x', true), null);
  assert.equal(refusal('map.head', 'x', true), null);
  assert.equal(refusal('repo.fetch', 'Mod+Alt+Shift+F', true), null);
});

test('Ctrl+Mod needs ⌘ on macOS, so plain ⌃T doesn’t match ⌃⌘T (AK-207)', async () => {
  const { match } = await load();
  const ev = (key, o = {}) => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(match('menu', ev('t', { ctrlKey: true }), null, true), null);
  assert.equal(match('menu', ev('t', { ctrlKey: true, metaKey: true }), null, true), 'view.cycleTheme');
});
