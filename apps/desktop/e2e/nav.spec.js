'use strict';
// Back and forward (‹ › in the top bar, ⌘[ ⌘]): a jump from Review to the Map and back again, and
// from one Review row to another (the split view's pane follows the selection).

const { execFileSync } = require('node:child_process');
const { test, expect } = require('./fixtures');

// A branch off main with one commit of its own, dated now: Review lists a local branch only while
// it's recent (the sandbox clock is in 1970). Review names the row by that commit's subject.
function branch(sandbox, repo, name) {
  sandbox.git(repo, 'checkout', '-q', '-b', name, 'main');
  sandbox.write(repo, `${name}.txt`, `${name}\n`);
  sandbox.git(repo, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', `${name} work`], { cwd: repo, env: sandbox.env });
  sandbox.git(repo, 'checkout', '-q', 'main');
}

test('Review → open a branch → Map → Back returns to Review with the same row and filter → Forward', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('nav');
  branch(sandbox, repo, 'feature-a');
  branch(sandbox, repo, 'feature-b');
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
  const row = page.locator('.lanes-row', { has: page.locator('.lanes-name', { hasText: 'feature-b work' }) });
  await row.click();
  await expect(row).toHaveClass(/active/);
  await expect(page.locator('.review-pane .reader-title')).toContainText('feature-b work');
  await row.dblclick();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await expect(app.row('feature-b work')).toHaveClass(/selected/);

  await back.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await expect(filter).toHaveValue('feature');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('feature-b work');
  await expect(forward).toBeEnabled();

  await forward.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await expect(app.row('feature-b work')).toHaveClass(/selected/);
  await expect(forward).toBeDisabled();

  // Picking a row in Review is a step too (its pane shows it): Back returns to the row before it.
  await back.click();
  await back.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('feature-a work');
  await back.click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await expect(back).toBeDisabled();
});

test('a repository opens on Review: Needs you, In progress, then the Map and Back', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('home');
  branch(sandbox, repo, 'feature-a');
  const app = await launch(repo, { env: { GITLANES_START_VIEW: '' } });
  const { page } = app;
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await expect(page.getByRole('tab', { name: 'Needs you' })).toHaveAttribute('aria-selected', 'true');
  const row = page.locator('.lanes-row', { has: page.locator('.lanes-name', { hasText: 'feature-a work' }) });
  await expect(row).toHaveCount(0);
  const inProgress = page.getByRole('tab', { name: 'In progress' });
  await expect(inProgress).toHaveText('In progress1');
  await inProgress.click();
  await expect(row).toHaveCount(1);
  await row.dblclick();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
  await page.locator('.topbar .nav-btns button[aria-label="Back"]').click();
  await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('feature-a work');
});
