'use strict';
// Undo and redo for operations that destroy uncommitted work, the Snapshots
// view, and the menu's ⌘Z path.

const { test, expect } = require('./fixtures');

test('discard a file, undo brings the edit back, redo discards again', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('discard', ['one', 'two']);
  sandbox.write(repo, 'one.txt', 'one, edited\n');
  const app = await launch(repo);
  await app.view('commit');
  const row = app.page.locator('.cv-section', { hasText: 'Unstaged' }).locator('.file-row', { hasText: 'one.txt' });
  await app.hoverClick(row, 'button[title="Discard changes"]');
  await app.dialog({ submit: 'Discard' });
  await app.toast('Discard changes to one.txt');
  expect(sandbox.read(repo, 'one.txt')).toBe('one\n');
  await expect(app.page.locator('.cv-empty', { hasText: 'Working tree clean' })).toBeVisible();

  await app.undo('Discard changes to one.txt');
  expect(sandbox.read(repo, 'one.txt')).toBe('one, edited\n');
  await expect(row).toBeVisible();
  await app.redo('Discard changes to one.txt');
  expect(sandbox.read(repo, 'one.txt')).toBe('one\n');
});

test('discard an untracked file and undo', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('discard-untracked', ['one']);
  sandbox.write(repo, 'scratch.txt', 'notes\n');
  const app = await launch(repo);
  await app.view('commit');
  await app.page.locator('.cv-section', { hasText: 'Unstaged' }).locator('button', { hasText: 'Discard all' }).click();
  await app.dialog({ submit: 'Discard' });
  await app.toast('Discard changes to scratch.txt');
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
  await app.undo();
  expect(sandbox.read(repo, 'scratch.txt')).toBe('notes\n');
});

test('discard selected lines and undo', async ({ sandbox, launch }) => {
  const repo = sandbox.init('discard-lines');
  sandbox.commit(repo, 'base', { 'list.txt': 'a\nb\nc\n' });
  sandbox.write(repo, 'list.txt', 'a\nB\nc\nd\n');
  const app = await launch(repo);
  await app.view('commit');
  await expect(app.page.locator('.cv-diff .diff-head', { hasText: 'list.txt' })).toBeVisible();
  // Select the added "d" line only.
  await app.page.locator('.cv-diff .dl.add').filter({ has: app.page.locator('.code', { hasText: /^d$/ }) }).click();
  await expect(app.page.locator('.sel-bar')).toContainText('1 line selected');
  await app.page.locator('.sel-bar button', { hasText: 'Discard' }).click();
  await app.dialog({ submit: 'Discard' });
  await app.toast('Discard 1 line in list.txt');
  expect(sandbox.read(repo, 'list.txt')).toBe('a\nB\nc\n');
  await app.undo('Discard 1 line in list.txt');
  expect(sandbox.read(repo, 'list.txt')).toBe('a\nB\nc\nd\n');
});

test('reset hard from the command menu, then undo', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('reset', ['one', 'two']);
  sandbox.write(repo, 'one.txt', 'one, edited\n');
  sandbox.write(repo, 'two.txt', 'two, edited\n');
  sandbox.git(repo, 'add', 'two.txt');
  const app = await launch(repo);
  await app.palette('Reset hard to HEAD…');
  await app.dialog({ submit: 'Reset' });
  await app.toast('Reset hard to HEAD');
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');

  await app.undo('Reset hard to HEAD');
  expect(sandbox.read(repo, 'one.txt')).toBe('one, edited\n');
  expect(sandbox.read(repo, 'two.txt')).toBe('two, edited\n');
  expect(sandbox.git(repo, 'diff', '--cached', '--name-only')).toBe('two.txt');
});

test('undo over newer changes stashes them and offers to discard', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('undo-guard', ['one']);
  sandbox.write(repo, 'one.txt', 'first edit\n');
  const app = await launch(repo);
  await app.view('commit');
  await app.page.locator('.cv-section', { hasText: 'Unstaged' }).locator('button', { hasText: 'Discard all' }).click();
  await app.dialog({ submit: 'Discard' });
  await app.toast('Discard changes to one.txt');
  sandbox.write(repo, 'one.txt', 'second edit\n');

  // The safe default (AK-598): the newer edit is stashed, the undo is taken, and the toast
  // offers to discard the stash instead.
  await app.undoButton().click();
  const undone = await app.toast('Undid “Discard changes to one.txt”');
  await expect(undone).toContainText('Your newer edit to one.txt is stashed.');
  expect(sandbox.read(repo, 'one.txt')).toBe('first edit\n');
  const stashes = () => sandbox.git(repo, 'stash', 'list', '--format=%gs').split('\n').filter(Boolean);
  expect(stashes()).toHaveLength(1);
  expect(stashes()[0].endsWith('Set aside to undo “Discard changes to one.txt”')).toBe(true);

  await undone.locator('.toast-actions button', { hasText: 'Discard it instead' }).click();
  await app.toast('Discarded your newer edit to one.txt');
  expect(stashes()).toEqual([]);
  expect(sandbox.read(repo, 'one.txt')).toBe('first edit\n');
});

test('Snapshots lists every step and restores an earlier state', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('snapshots');
  const original = sandbox.sha(repo);
  const app = await launch(repo);
  await app.selectRow('two');
  await app.page.keyboard.press('Backspace');
  await app.toast('Delete commit');
  await app.selectRow('four');
  await app.page.keyboard.press('s');
  await app.toast('Squash with parent');
  expect(sandbox.log(repo)).toEqual(['three', 'one']);

  await app.view('snapshots');
  const rows = app.page.locator('.timeline .tl-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Squash with parent');
  await expect(rows.nth(1)).toContainText('Delete commit');
  await rows.nth(1).locator('button', { hasText: 'Restore before' }).click();
  await app.dialog({ submit: 'Restore' });
  await app.toast('Restore before “Delete commit”');
  expect(sandbox.sha(repo)).toBe(original);
  await expect(rows).toHaveCount(3);

  await app.page.locator('.page-actions button', { hasText: 'Undo' }).click();
  await expect(app.page.locator('.toast', { hasText: 'Undid' }).last()).toBeVisible();
  expect(sandbox.log(repo)).toEqual(['three', 'one']);
  await expect(app.page.locator('.timeline .tl-row.undone')).toHaveCount(1);
});

test('⌘Z from the menu undoes, but not while typing in a field', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('menu-undo', ['one', 'two']);
  const app = await launch(repo);
  await app.selectRow('two');
  await app.page.keyboard.press('Backspace');
  await app.toast('Delete commit');

  // The Edit menu's Undo item sends this command to the focused window.
  const sendCommand = (cmd) => app.app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), cmd);
  const search = app.page.locator('#map-search');
  await search.focus();
  // A change made outside the app refreshes the UI without stealing focus from the field.
  sandbox.write(repo, 'outside.txt', 'x\n');
  await expect(app.page.locator('.sb-nav [data-view="commit"] .nav-badge')).toHaveText('1');
  await app.settle();
  await expect(search).toBeFocused();
  await sendCommand('undo');
  await app.page.waitForTimeout(300);
  expect(sandbox.log(repo)).toEqual(['one']);

  await app.page.locator('.map-list').focus();
  await sendCommand('undo');
  await expect(app.page.locator('.toast', { hasText: 'Undid “Delete commit”' })).toBeVisible();
  expect(sandbox.log(repo)).toEqual(['two', 'one']);
  await sendCommand('redo');
  await expect(app.page.locator('.toast', { hasText: 'Redid “Delete commit”' })).toBeVisible();
  expect(sandbox.log(repo)).toEqual(['one']);
});

test('the Edit menu names the next undo and redo', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('menu-labels', ['one', 'two']);
  const app = await launch(repo);
  // Menu labels follow the focused window; parallel test apps steal OS focus from each other.
  await app.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; BrowserWindow.getFocusedWindow = () => (w.isDestroyed() ? null : w); });
  await app.selectRow('two');
  await app.page.keyboard.press('Backspace');
  await app.toast('Delete commit');
  const labels = () => app.app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu().items.find((i) => i.label === 'Edit').submenu.items;
    return edit.slice(0, 2).map((i) => i.label);
  });
  await expect.poll(labels).toEqual(['Undo Delete commit', 'Redo']);
  await app.undo('Delete commit');
  await expect.poll(labels).toEqual(['Undo', 'Redo Delete commit']);
});
