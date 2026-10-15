'use strict';
// Back and forward (‹ › in the top bar, ⌘[ ⌘]): a jump from Review to the Map and back again, and
// from one Review row to another (the split view's pane follows the selection).

const { test, expect } = require('./fixtures');

test('Review → open a branch → Map → Back returns to Review with the same row and filter → Forward', async ({ sandbox, launch }) => {
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
  await expect(page.locator('.review-pane .quick-title')).toContainText('feature-b');
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

  // Picking a row in Review is a step too (its pane shows it): Back returns to the row before it.
  await back.click();
  await back.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('feature-a');
  await back.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await expect(back).toBeDisabled();
});
