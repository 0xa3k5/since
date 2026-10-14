'use strict';
// File history & blame: open it from ⌘K, follow a rename, blame versions, click through to the Map.

const { test, expect } = require('./fixtures');

test('file history follows renames, blames each version and shows commits in the Map', async ({ sandbox, launch }) => {
  const repo = sandbox.init('file-history');
  sandbox.commit(repo, 'add notes', { 'notes.txt': 'alpha\nbeta\n' });
  sandbox.commit(repo, 'unrelated', { 'other.txt': 'x\n' });
  sandbox.git(repo, 'mv', 'notes.txt', 'docs.txt');
  sandbox.git(repo, 'commit', '-q', '-m', 'rename notes');
  sandbox.commit(repo, 'edit docs', { 'docs.txt': 'alpha\nBETA\n' });
  sandbox.write(repo, 'docs.txt', 'alpha\nBETA\ngamma\n');
  const app = await launch(repo);
  const { page } = app;

  // ⌘K entry, then the file picker (a second palette).
  await page.locator('.sb-top button[title^="Command menu"]').click();
  await page.locator('.palette-input').fill('File history & blame…');
  await page.locator('.palette-input').press('Enter');
  await expect(page.locator('.palette-input')).toHaveAttribute('placeholder', /pick a file/);
  await page.locator('.palette-input').fill('docs.txt');
  await expect(page.locator('.palette-item.active .palette-label')).toHaveText('docs.txt');
  await page.locator('.palette-input').press('Enter');

  const rows = page.locator('.fh-row .fh-subject');
  await expect(rows).toHaveText(['Working tree', 'edit docs', 'rename notes', 'add notes']);
  await expect(page.locator('.fh-meta').filter({ hasText: 'renamed' })).toHaveCount(1);
  await expect(page.locator('.fh-row.active .fh-subject')).toHaveText('edit docs');
  await expect(page.locator('.fh-text')).toHaveText(['alpha', 'BETA']);

  // Oldest version, under its old name.
  await page.locator('.fh').press('ArrowDown');
  await page.locator('.fh').press('ArrowDown');
  await expect(page.locator('.fh-row.active .fh-subject')).toHaveText('add notes');
  await expect(page.locator('.quick-main .diff-head .mono')).toHaveText('notes.txt');
  await expect(page.locator('.fh-text')).toHaveText(['alpha', 'beta']);

  // The working tree includes the uncommitted line.
  await page.locator('.fh-row', { hasText: 'Working tree' }).click();
  await expect(page.locator('.fh-text')).toHaveText(['alpha', 'BETA', 'gamma']);
  await expect(page.locator('.fh-gutter-text', { hasText: 'Not committed yet' })).toHaveCount(1);

  // Click a blame line's commit: the Map selects it.
  await page.locator('.fh-gutter').first().click(); // alpha, from "add notes"
  await expect(page.locator('.fh')).toHaveCount(0);
  await expect(page.locator('.map-list .row.selected .subject')).toHaveText('add notes');
});
