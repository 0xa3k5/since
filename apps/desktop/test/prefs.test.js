'use strict';
// The Preferences window's rows and search (renderer/prefs.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/prefs.js');
const THEMES = [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];
const base = { autoUpdate: undefined, autostash: { ask: true, untracked: false }, theme: 'dark', themes: THEMES, show: { tags: true, remotes: false }, sidebarExpanded: true };

test('every section from the brief is there, in order', async () => {
  const { PREF_SECTIONS } = await load();
  assert.deepEqual(PREF_SECTIONS.map((s) => s.label), ['General', 'Git', 'Appearance', 'Sidebar', 'Pull requests', 'Keyboard', 'Repository']);
});

test('rows read the saved values, with unknown meaning on as before', async () => {
  const { prefRows } = await load();
  const rows = Object.fromEntries(prefRows(base).map((r) => [r.id, r]));
  assert.equal(rows.autoUpdate.value, true);
  assert.equal(rows.autostashAsk.value, true);
  assert.equal(rows.autostashUntracked.value, false);
  assert.equal(rows.theme.value, 'dark');
  assert.equal(rows.tags.value, true);
  assert.equal(rows.remotes.value, false);
  assert.equal(rows.swatches.value, true);
  assert.equal(rows.prsOn.value, false);
  // Every row sits in a known section.
  const { PREF_SECTIONS } = await load();
  for (const r of Object.values(rows)) assert.ok(PREF_SECTIONS.some((s) => s.id === r.section), r.id);
});

test('repository rows only show with a repository open', async () => {
  const { prefRows } = await load();
  const config = [{ key: 'user.name', value: 'Ada', scope: 'global' }, { key: 'core.autocrlf', value: 'false', scope: 'local' }];
  const prs = { enabled: true, hidden: false, remote: { name: 'origin', owner: 'o', repo: 'r' } };
  const without = prefRows({ ...base, config, prs }).map((r) => r.id);
  assert.ok(!without.some((id) => id.startsWith('config:') || id === 'addConfig' || id === 'identity' || id === 'prsHidden' || id === 'prRemote'));
  const rows = prefRows({ ...base, repo: true, config, prs });
  assert.deepEqual(rows.filter((r) => r.kind === 'config').map((r) => r.label), ['user.name', 'core.autocrlf']);
  assert.equal(rows.find((r) => r.id === 'prRemote').value, 'origin (o/r)');
  assert.ok(rows.some((r) => r.id === 'prsHidden'));
});

test('search keeps matching rows grouped by section and drops empty sections', async () => {
  const { prefRows, prefSections } = await load();
  const rows = prefRows({ ...base, repo: true, config: [{ key: 'user.email', value: 'ada@example.com', scope: 'local' }] });
  assert.equal(prefSections(rows).length, 7);
  const dark = prefSections(rows, 'dark mode');
  assert.deepEqual(dark.map((s) => s.id), ['appearance']);
  assert.deepEqual(dark[0].rows.map((r) => r.id), ['theme']);
  // Config entries match on key and value; section names match too.
  assert.deepEqual(prefSections(rows, 'example.com').flatMap((s) => s.rows.map((r) => r.id)), ['config:local:user.email']);
  assert.ok(prefSections(rows, 'sidebar').some((s) => s.id === 'sidebar'));
  assert.deepEqual(prefSections(rows, 'nothing matches this'), []);
});

test('choices step through their options and wrap', async () => {
  const { prefRows, nextChoice } = await load();
  const theme = prefRows(base).find((r) => r.id === 'theme');
  assert.equal(nextChoice(theme, 1), 'system');
  assert.equal(nextChoice(theme, -1), 'light');
});

test('AK-461: with two GitHub remotes, the PR remote is a choice of Automatic or a remote', async () => {
  const { prefRows, PR_REMOTE_AUTO } = await load();
  const choices = [{ name: 'origin', owner: 'o', repo: 'r' }, { name: 'fork', owner: 'k', repo: 'r' }];
  const prs = { enabled: true, hidden: false, remote: choices[1], choices, chosen: 'fork' };
  const row = prefRows({ ...base, repo: true, prs }).find((r) => r.id === 'prRemote');
  assert.equal(row.kind, 'choice');
  assert.equal(row.value, 'fork');
  assert.deepEqual(row.options.map((o) => o.id), [PR_REMOTE_AUTO, 'origin', 'fork']);
  assert.match(row.detail, /k\/r/);
  const auto = prefRows({ ...base, repo: true, prs: { ...prs, remote: choices[0], chosen: null } }).find((r) => r.id === 'prRemote');
  assert.equal(auto.value, PR_REMOTE_AUTO);
});

test('Sidebar lists the refs-tree sections in order, as movable switches (AK-464)', async () => {
  const { prefRows } = await load();
  const sections = [{ id: 'tags', label: 'Tags', icon: 'tag', hidden: true }, { id: 'branches', label: 'Branches', icon: 'branch', hidden: false }];
  const rows = prefRows({ ...base, sections }).filter((r) => r.id.startsWith('section:'));
  assert.deepEqual(rows.map((r) => [r.id, r.value, r.move, r.section]), [['section:tags', false, true, 'sidebar'], ['section:branches', true, true, 'sidebar']]);
  assert.equal(rows[0].first, true);
  assert.equal(rows[1].last, true);
});

test('preferences command while open: ⌘, closes, a section jumps there', async () => {
  const { openPrefsCommand } = await load();
  assert.equal(openPrefsCommand(undefined), 'close');
  assert.equal(openPrefsCommand('repository'), 'show');
});
