'use strict';
// Send back (Review): a stuck row's sheet builds a prompt from local facts, and only Copy prompt
// writes the clipboard. Screenshots of the sheet in light and dark go to the test report.

const { execFileSync } = require('node:child_process');
const { test, expect } = require('./fixtures');

test('Send back a stuck lane: P opens the sheet, Copy prompt copies it, nothing earlier', async ({ sandbox, launch }, testInfo) => {
  const repo = sandbox.conflicted('sendback');
  // The sandbox clock is in 1970; the forecast skips lanes untouched for two weeks, so re-date the branch tip.
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--allow-empty'], { cwd: repo, env: sandbox.env });
  sandbox.git(repo, 'checkout', '-q', 'feature');
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--reset-author'], { cwd: repo, env: sandbox.env });
  sandbox.git(repo, 'checkout', '-q', 'main');
  const app = await launch(repo);
  const { page } = app;
  await app.app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await app.view('lanes');
  await expect(page.locator('.lanes-group[data-stage="stuck"]')).toHaveText('Stuck 1');
  const row = page.locator('.review-row', { has: page.locator('.lanes-name', { hasText: 'feature' }) });
  await row.click({ position: { x: 8, y: 8 } });
  await expect(row.locator('button', { hasText: 'Fix prompt…' })).toBeVisible();
  await page.keyboard.press('p');

  const sheet = page.locator('.dialog.sendback');
  await expect(sheet.locator('.dialog-title')).toHaveText('Fix prompt for feature');
  await expect(sheet.locator('.sendback-reason')).toContainText('conflicts with main in conflict.txt');
  const prompt = sheet.locator('.sendback-prompt');
  await expect(prompt).toHaveValue(/^Branch feature \(→ main\) can't merge/);
  await expect(prompt).toHaveValue(/- conflict\.txt \(with main; changed on main by [0-9a-f]{7,}\)/);
  // No PR features here: no gh buttons.
  await expect(sheet.locator('button', { hasText: 'Post as PR comment' })).toHaveCount(0);
  expect(await app.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('before');

  for (const theme of ['light', 'dark']) {
    await app.app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
    await page.waitForTimeout(300);
    const file = testInfo.outputPath(`send-back-${theme}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(`send-back-${theme}`, { path: file, contentType: 'image/png' });
  }

  const text = await prompt.inputValue();
  await sheet.locator('button', { hasText: 'Copy prompt' }).click();
  await expect(sheet).toHaveCount(0);
  expect(await app.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
});
