'use strict';
// Double-clicking a Map row checks it out: a branch tip switches to the branch, a plain commit opens
// a popover (Enter = new branch here, or check out detached). It must never crash the window or the
// app: failures show as a toast.

const { test, expect } = require('./fixtures');

test('double-click on a branch row and on a plain commit row checks out, undoably, without a crash', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('dbl');
  sandbox.git(repo, 'branch', 'feature-a', 'HEAD~1');
  const app = await launch(repo);
  const { page } = app;
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('crash', () => errors.push('renderer crashed'));

  await app.row('three').dblclick();
  await expect(page.locator('.toast', { hasText: 'Switched to feature-a' })).toBeVisible();
  await app.settle();
  expect(sandbox.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature-a');

  await app.row('two').dblclick();
  const menu = page.locator('.menu');
  await expect(menu.locator('.menu-item.active', { hasText: 'New branch here' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(sandbox.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature-a');

  await app.row('two').dblclick();
  await menu.locator('.menu-item', { hasText: 'Check out detached' }).click();
  await expect(page.locator('.toast', { hasText: 'HEAD detached at' })).toBeVisible();
  await app.settle();
  expect(sandbox.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');

  await app.undo();
  expect(sandbox.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature-a');
  expect(errors).toEqual([]);
  expect(await app.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
});
