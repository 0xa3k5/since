'use strict';
// Review's catch-up card (AK-281): what landed since a tag, grouped by issue key or folder, the
// walk-through in the split pane, and Mark caught up (with Undo). PR features stay off: git only.

const { test, expect } = require('./fixtures');

test('catch-up: since a tag, grouped, walk through, mark caught up', async ({ sandbox, launch }, testInfo) => {
  const repo = sandbox.init('catchup');
  sandbox.commit(repo, 'start', { 'README.md': 'start\n' });
  sandbox.git(repo, 'tag', 'v0.1');
  sandbox.commit(repo, 'feat(desktop): catch-up card (AK-281)', { 'apps/desktop/card.js': 'card\n' });
  sandbox.commit(repo, 'fix(desktop): count merged work once (AK-281)', { 'apps/desktop/count.js': 'count\n' });
  sandbox.commit(repo, 'style(web): tighten the hero', { 'apps/web/hero.css': 'a {}\n', 'apps/web/page.css': 'b {}\n' });
  sandbox.commit(repo, 'docs: release notes', { 'docs/notes.md': 'notes\n' });
  const app = await launch(repo);
  const { page } = app;
  await app.view('lanes');
  const card = page.locator('.review-catchup-card');
  await expect(card.locator('.catchup-title')).toBeVisible();

  // Since… → the tag.
  await page.locator('.review-split').press('Shift+T');
  await page.locator('.menu').getByRole('button', { name: 'Tag v0.1' }).click();
  await expect(card.locator('.catchup-title')).toHaveText('Since tag v0.1');
  await expect(card.locator('.catchup-counts')).toContainText('4 commits landed');
  await expect(card.locator('.catchup-group').first()).toContainText('AK-281');
  await expect(card.locator('.catchup-group').first()).toContainText('· 2');

  const shot = async (name) => {
    await page.waitForTimeout(250);
    const file = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(name, { path: file, contentType: 'image/png' });
  };
  for (const theme of ['light', 'dark']) {
    await app.palette(`Theme: ${theme === 'light' ? 'Light' : 'Dark'}`);
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
    await shot(`${theme}-catchup`);
  }

  // Walk through: one row per commit (no PRs), the pane shows the first one's diff.
  await page.locator('.review-split').focus();
  await page.locator('.review-split').press('Shift+Enter');
  await expect(page.locator('.lanes-group[data-stage="landed"]')).toContainText('What landed 4');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('docs: release notes');
  await expect(page.locator('.review-pane .quick-title')).toContainText('docs: release notes');
  await page.locator('.review-split').press('ArrowDown');
  await expect(page.locator('.review-pane .quick-title')).toContainText('style(web): tighten the hero');
  await shot('dark-walk');
  await page.locator('.review-split').focus();
  await page.locator('.review-split').press('Escape');
  await expect(page.locator('.lanes-group[data-stage="landed"]')).toHaveCount(0);

  // Mark caught up: the checkpoint moves to the tip, nothing is new; Undo puts it back.
  await page.locator('.review-split').press('Shift+C');
  const t = await app.toast('Caught up to');
  await expect(card.locator('.catchup-title')).toContainText('Caught up to');
  await expect(card).toContainText('Nothing new on main.');
  await t.locator('.toast-action').click();
  await expect(card.locator('.catchup-title')).not.toContainText('Caught up to');
});
