'use strict';
// Unified changes (⌘K "Show changes as one list"): ticking a line stages exactly that line, the file's tick box
// follows, and ⌘Z puts the index back.

const { test, expect } = require('./fixtures');

test('tick a line, a file, then undo', async ({ sandbox, launch }) => {
  const repo = sandbox.init('unified');
  const base = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  sandbox.commit(repo, 'base', { 'app.txt': base.join('\n') + '\n' });
  const edited = [...base];
  edited[1] = 'line 2 changed';
  edited[9] = 'line 10 changed';
  sandbox.write(repo, 'app.txt', edited.join('\n') + '\n');
  sandbox.write(repo, 'new.txt', 'brand new\n');
  const app = await launch(repo);

  await app.view('commit');
  await app.palette('Show changes as one list');
  const file = app.page.locator('.ucv-file', { has: app.page.locator('.ucv-path', { hasText: 'app.txt' }) });
  await expect(file.locator('.ucv-file-head .ucv-staged')).toHaveText('4 lines, none staged');
  await expect(app.page.locator('.ucv-summary')).toHaveText('Nothing staged · 5 left');

  await file.locator('.ucv-line.add', { hasText: 'line 10 changed' }).locator('.ucv-tick').click();
  await expect(file.locator('.ucv-file-head .ucv-staged')).toHaveText('1 of 4 lines staged');
  await expect(file.locator('.ucv-file-head .ucv-tick')).toHaveAttribute('aria-checked', 'mixed');
  await expect(app.page.locator('.ucv-summary')).toHaveText('1 line in 1 file will be committed · 4 left');
  const cached = sandbox.git(repo, 'diff', '--cached', '--', 'app.txt');
  expect(cached).toContain('+line 10 changed');
  expect(cached).not.toContain('line 2 changed');

  const untracked = app.page.locator('.ucv-file', { has: app.page.locator('.ucv-path', { hasText: 'new.txt' }) });
  await untracked.locator('.ucv-file-head .ucv-tick').click();
  await expect(untracked.locator('.ucv-file-head .ucv-tick')).toHaveAttribute('aria-checked', 'true');
  expect(sandbox.git(repo, 'diff', '--cached', '--name-only')).toBe('app.txt\nnew.txt');

  await app.undo('Stage new.txt');
  await app.undo('Stage 1 line in app.txt');
  expect(sandbox.git(repo, 'diff', '--cached', '--name-only')).toBe('');
  await expect(file.locator('.ucv-file-head .ucv-staged')).toHaveText('4 lines, none staged');
});
