'use strict';
// Stash save / apply / pop / drop, with undo for the destructive ones.

const { test, expect } = require('./fixtures');

const stashes = (sb, repo) => sb.git(repo, 'stash', 'list', '--format=%H %gs').split('\n').filter(Boolean);

async function saveStash(app, message) {
  await app.view('commit');
  await app.page.locator('.topbar button', { hasText: 'Stash' }).click();
  await app.dialog({ fields: { Message: message, 'Include untracked files': true }, submit: 'Stash' });
  await app.toast('Stash changes');
}

function dirtyRepo(sandbox, name) {
  const repo = sandbox.linear(name, ['one', 'two']);
  sandbox.write(repo, 'one.txt', 'one, edited\n');
  sandbox.write(repo, 'new.txt', 'untracked\n');
  return repo;
}

test('save, apply and undo the apply', async ({ sandbox, launch }) => {
  const repo = dirtyRepo(sandbox, 'stash-apply');
  const app = await launch(repo);
  await saveStash(app, 'wip');
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
  expect(stashes(sandbox, repo)).toHaveLength(1);
  await expect(app.page.locator('.sb-nav [data-view="stashes"] .nav-badge')).toHaveText('1');

  await app.view('stashes');
  const row = app.page.locator('.list-row', { hasText: 'wip' });
  await expect(row).toBeVisible();
  await app.page.locator('.detail-pane .diff-head button', { hasText: 'Apply' }).click();
  await app.toast('Apply stash@{0}');
  expect(sandbox.read(repo, 'one.txt')).toBe('one, edited\n');
  expect(sandbox.read(repo, 'new.txt')).toBe('untracked\n');
  expect(stashes(sandbox, repo)).toHaveLength(1);

  await app.undo('Apply stash@{0}');
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
  await app.redo('Apply stash@{0}');
  expect(sandbox.read(repo, 'one.txt')).toBe('one, edited\n');
});

test('pop, then undo brings the stash and the clean tree back', async ({ sandbox, launch }) => {
  const repo = dirtyRepo(sandbox, 'stash-pop');
  const app = await launch(repo);
  await saveStash(app, 'wip');
  const [saved] = stashes(sandbox, repo);

  await app.view('stashes');
  await app.page.locator('.detail-pane .diff-head button', { hasText: 'Pop' }).click();
  await app.toast('Pop stash@{0}');
  expect(stashes(sandbox, repo)).toHaveLength(0);
  expect(sandbox.read(repo, 'one.txt')).toBe('one, edited\n');

  await app.undo('Pop stash@{0}');
  expect(stashes(sandbox, repo)).toEqual([saved]);
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
});

test('drop asks first, and undo restores the stash', async ({ sandbox, launch }) => {
  const repo = dirtyRepo(sandbox, 'stash-drop');
  const app = await launch(repo);
  await saveStash(app, 'keep me');
  const [saved] = stashes(sandbox, repo);

  await app.view('stashes');
  await app.contextMenu(app.page.locator('.list-row', { hasText: 'keep me' }), 'Drop…');
  await app.dialog({ submit: 'Drop' });
  await app.toast('Drop stash@{0}');
  expect(stashes(sandbox, repo)).toHaveLength(0);
  await expect(app.page.locator('.list-pane .empty', { hasText: 'No stashes' })).toBeVisible();

  await app.undo();
  expect(stashes(sandbox, repo)).toEqual([saved]);
  await expect(app.page.locator('.list-row', { hasText: 'keep me' })).toBeVisible();
  await app.redo();
  expect(stashes(sandbox, repo)).toHaveLength(0);
});

test('arrow keys move the selection through the stash list', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('stash-keys', ['one']);
  for (const msg of ['first', 'second']) {
    sandbox.write(repo, 'one.txt', `${msg}\n`);
    sandbox.git(repo, 'stash', 'push', '-m', msg);
  }
  const app = await launch(repo);
  await app.view('stashes');
  const active = app.page.locator('.list-pane .list-row.active');
  await expect(active).toContainText('second');
  await app.page.keyboard.press('ArrowDown');
  await expect(active).toContainText('first');
  await expect(app.page.locator('.detail-pane .diff-head .title')).toHaveText(/first/);
  await app.page.keyboard.press('ArrowDown');
  await expect(active).toContainText('first');
  await app.page.keyboard.press('ArrowUp');
  await expect(active).toContainText('second');
});
