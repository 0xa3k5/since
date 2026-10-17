'use strict';
// Catch up (AK-365, was Review's catch-up card, AK-281): what landed since a tag as a timeline by day,
// the walk-through in Review's split pane (Esc comes back), and Mark caught up (with Undo; caught up
// shows the calm empty state). PR features stay off: git only.

const { test, expect } = require('./fixtures');

test('catch-up: since a tag, timeline, walk through, mark caught up', async ({ sandbox, launch }, testInfo) => {
  const repo = sandbox.init('catchup');
  sandbox.commit(repo, 'start', { 'README.md': 'start\n' });
  sandbox.git(repo, 'tag', 'v0.1');
  sandbox.commit(repo, 'feat(desktop): catch-up card (AK-281)', { 'apps/desktop/card.js': 'card\n' });
  sandbox.commit(repo, 'fix(desktop): count merged work once (AK-281)', { 'apps/desktop/count.js': 'count\n' });
  sandbox.commit(repo, 'style(web): tighten the hero', { 'apps/web/hero.css': 'a {}\n', 'apps/web/page.css': 'b {}\n' });
  sandbox.commit(repo, 'docs: release notes', { 'docs/notes.md': 'notes\n' });
  const app = await launch(repo);
  const { page } = app;
  await app.view('catchup');
  const view = page.locator('.page.catchup');
  await expect(view.locator('h1')).toHaveText('Catch up');

  // Since… → the tag.
  await expect(view.locator('.catchup-empty h2')).toHaveText('You’re caught up.');
  await view.press('Shift+T');
  await page.locator('.menu').getByRole('button', { name: 'Tag v0.1' }).click();
  await expect(view.locator('.catchup-since')).toContainText('since tag v0.1');
  await expect(view.locator('.catchup-number')).toContainText('4 commits landed');
  await expect(view.locator('.catchup-row')).toHaveCount(4);
  await expect(view.locator('.catchup-row').first()).toContainText('docs: release notes');
  await expect(view.locator('.catchup-row').nth(1).locator('.catchup-chip')).toHaveText('apps/web');
  await expect(view.locator('.catchup-row').nth(2).locator('.catchup-chip')).toHaveText('AK-281');
  await expect(view.locator('.catchup-bridge')).toHaveCount(0); // nothing stuck or ready: no line to Review

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

  // ↓ then ↵: Review walks through from that row; Esc comes back to Catch up.
  await view.focus();
  await view.press('ArrowDown');
  await view.press('Enter');
  await expect(page.locator('.lanes-group[data-stage="landed"]')).toContainText('Landed since tag v0.1 · 4');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('style(web): tighten the hero');
  await expect(page.locator('.review-pane .quick-title')).toContainText('style(web): tighten the hero');
  await shot('dark-walk');
  await page.locator('.review-split').focus();
  await page.locator('.review-split').press('Escape');
  await expect(view).toBeVisible();

  // ⇧↵ walks from the newest.
  await view.focus();
  await view.press('Shift+Enter');
  await expect(page.locator('.lanes-row.active .lanes-name')).toHaveText('docs: release notes');
  await page.locator('.review-split').focus();
  await page.locator('.review-split').press('Escape');
  await expect(view).toBeVisible();

  // Mark caught up: the checkpoint moves to the tip, nothing is new; Undo puts it back.
  await view.focus();
  await view.press('Shift+C');
  const t = await app.toast('Caught up to');
  await expect(view.locator('.catchup-empty h2')).toHaveText('You’re caught up.');
  await expect(page.locator('.sb-nav [data-view="catchup"] .nav-badge')).toHaveText('');
  for (const theme of ['light', 'dark']) {
    await app.palette(`Theme: ${theme === 'light' ? 'Light' : 'Dark'}`);
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
    await shot(`${theme}-caught-up`);
  }
  await t.locator('.toast-action').click();
  await expect(view.locator('.catchup-empty')).toBeVisible(); // the checkpoint it put back was the tip when the repo opened

  // Caught up again: ⇧C is a no-op with a toast.
  await view.press('Shift+C');
  await app.toast('Caught up to');
  await view.press('Shift+C');
  await app.toast('Already caught up');
});
