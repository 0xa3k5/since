'use strict';
// Recovering lost commits from the Reflog, and editing local git config (Preferences → Repository).

const { test, expect } = require('./fixtures');

function lostCommits(sandbox, name) {
  const repo = sandbox.linear(name);
  const lost = sandbox.sha(repo);
  sandbox.git(repo, 'reset', '-q', '--hard', 'HEAD~2');
  return { repo, lost };
}

const reflogRow = (app, sha) => app.page.locator('.table-row', { has: app.page.locator('.mono', { hasText: sha.slice(0, 7) }) }).first();

test('restore a lost commit to a new branch from the Reflog, then undo', async ({ sandbox, launch }) => {
  const { repo, lost } = lostCommits(sandbox, 'reflog-branch');
  const app = await launch(repo);
  await expect(app.row('four')).toHaveCount(0);

  await app.view('reflog');
  const row = reflogRow(app, lost);
  await expect(row.locator('.badge.warn', { hasText: 'Unreachable' })).toBeVisible();
  await app.contextMenu(row, 'Create Branch Here…');
  await app.dialog({ fields: { Name: 'rescued', 'Check out after creating': false }, submit: 'Create branch' });
  await app.toast('Create branch rescued');
  expect(sandbox.sha(repo, 'rescued')).toBe(lost);
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  await expect(reflogRow(app, lost).locator('.badge.warn')).toHaveCount(0);

  await app.view('map');
  await expect(app.row('four').locator('.pill.branch', { hasText: 'rescued' })).toBeVisible();

  await app.undo('Create branch rescued');
  expect(sandbox.git(repo, 'branch', '--list', 'rescued')).toBe('');
  await expect(app.row('four')).toHaveCount(0);
  await app.redo('Create branch rescued');
  expect(sandbox.sha(repo, 'rescued')).toBe(lost);
});

test('check out a lost commit from the Reflog, then undo', async ({ sandbox, launch }) => {
  const { repo, lost } = lostCommits(sandbox, 'reflog-checkout');
  const head = sandbox.sha(repo);
  const app = await launch(repo);
  await app.view('reflog');
  await app.contextMenu(reflogRow(app, lost), 'Checkout (detached)');
  await app.toast(`Checkout ${lost.slice(0, 7)}`);
  expect(sandbox.sha(repo)).toBe(lost);
  await expect(app.page.locator('.topbar .head-chip.detached')).toContainText(lost.slice(0, 7));

  await app.undo();
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(sandbox.sha(repo)).toBe(head);
});

test('add, filter, edit and delete a local config value', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('config', ['one']);
  const app = await launch(repo);
  await app.palette('Repository settings…');
  await expect(app.page.locator('.prefs')).toBeVisible();
  const row = (key) => app.page.locator('.prefs-config', { has: app.page.locator('.prefs-key', { hasText: new RegExp(`^${key.replace('.', '\\.')}$`) }) });

  // Global values are read-only here.
  await row('user.name').click({ button: 'right' });
  await expect(app.page.locator('.menu .menu-item', { hasText: 'Edit…' })).toBeDisabled();
  await app.page.keyboard.press('Escape');

  await app.page.locator('.prefs-row[data-id="addConfig"] button').click();
  await app.dialog({ fields: { Key: 'since.e2e', Value: 'one' }, submit: 'Save', under: 1 });
  await app.toast('Set since.e2e');
  expect(sandbox.git(repo, 'config', '--local', 'since.e2e')).toBe('one');
  await expect(row('since.e2e').locator('.config-val')).toHaveText('one');

  await app.page.locator('.prefs-search').fill('since.e2e');
  await expect(app.page.locator('.prefs-config')).toHaveCount(1);

  await row('since.e2e').click();
  await app.dialog({ fields: { Value: 'two' }, submit: 'Save', under: 1 });
  await app.toast('Set since.e2e');
  expect(sandbox.git(repo, 'config', '--local', 'since.e2e')).toBe('two');
  // The refresh after the edit keeps the search.
  await expect(row('since.e2e').locator('.config-val')).toHaveText('two');
  await expect(app.page.locator('.prefs-config')).toHaveCount(1);

  await app.contextMenu(row('since.e2e'), 'Delete');
  await app.toast('Unset since.e2e');
  expect(sandbox.git(repo, 'config', '--local', '--get-all', 'core.bare')).toBe('false');
  expect(() => sandbox.git(repo, 'config', '--local', 'since.e2e')).toThrow();
  await expect(row('since.e2e')).toHaveCount(0);

  // Delete in a local value's context menu unsets it.
  await app.page.locator('.prefs-search').fill('');
  await app.page.locator('.prefs-row[data-id="addConfig"] button').click();
  await app.dialog({ fields: { Key: 'since.other', Value: 'x' }, submit: 'Save', under: 1 });
  await app.toast('Set since.other');
  await app.page.locator('.prefs-search').fill('since.other');
  await expect(app.page.locator('.prefs-config')).toHaveCount(1);
  await app.contextMenu(row('since.other'), 'Delete');
  await app.toast('Unset since.other');
  expect(() => sandbox.git(repo, 'config', '--local', 'since.other')).toThrow();
  expect(sandbox.git(repo, 'config', '--local', '--get-all', 'core.bare')).toBe('false');

  // Config edits are not ref changes, so they don't enter the undo history.
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('.prefs')).toHaveCount(0);
  await expect(app.undoButton()).toBeDisabled();
});
