'use strict';
// Back and forward (‹ › in the top bar, ⌘[ ⌘]): a jump from Lanes to the Map and back again.

const { test, expect } = require('./fixtures');

test('Lanes → open a lane → Map → Back returns to Lanes with the same row and filter → Forward', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('nav');
  sandbox.git(repo, 'branch', 'feature-a', 'HEAD~1');
  sandbox.git(repo, 'branch', 'feature-b', 'HEAD~2');
  const app = await launch(repo);
  const { page } = app;
  const back = page.locator('.topbar .nav-btns button[aria-label="Back"]');
  const forward = page.locator('.topbar .nav-btns button[aria-label="Forward"]');
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  await app.view('lanes');
  await expect(back).toBeEnabled();
  const filter = page.locator('.lanes-filter');
  await filter.fill('feature');
  const row = page.locator('.lanes-row', { has: page.locator('.lanes-name', { hasText: 'feature-b' }) });
  await row.click();
  await expect(row).toHaveClass(/active/);
  await row.dblclick();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await expect(app.row('two')).toHaveClass(/selected/);

  await back.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await expect(filter).toHaveValue('feature');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('feature-b');
  await expect(forward).toBeEnabled();

  await forward.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await expect(app.row('two')).toHaveClass(/selected/);
  await expect(forward).toBeDisabled();

  await back.click();
  await back.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await expect(back).toBeDisabled();
});
