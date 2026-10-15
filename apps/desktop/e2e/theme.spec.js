'use strict';
// Light and dark smoke test: switch themes from ⌘K, check native and CSS state,
// and capture screenshots of the main views (attached to the test report).

const { test, expect } = require('./fixtures');

const BG = { light: '#faf7f4', dark: '#080707' };

async function shot(app, testInfo, name) {
  await app.page.waitForTimeout(250); // let fades and toasts settle
  const file = testInfo.outputPath(`${name}.png`);
  await app.page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

for (const theme of ['light', 'dark']) {
  test(`${theme} theme smoke screenshots`, async ({ sandbox, launch }, testInfo) => {
    const repo = sandbox.conflicted('themed');
    sandbox.git(repo, 'tag', 'v1.0', 'HEAD~1');
    sandbox.write(repo, 'readme.txt', 'hello\nworld\n');
    const app = await launch(repo);

    await app.palette(`Theme: ${theme === 'light' ? 'Light' : 'Dark'}`);
    await expect.poll(() => app.app.evaluate(({ nativeTheme }) => [nativeTheme.themeSource, nativeTheme.shouldUseDarkColors]))
      .toEqual([theme, theme === 'dark']);
    await expect.poll(() => app.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
    expect(await app.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe(BG[theme]);

    await app.selectRow('feature change');
    await shot(app, testInfo, `${theme}-map`);
    await app.view('commit');
    await expect(app.page.locator('.cv-diff .diff-head', { hasText: 'readme.txt' })).toBeVisible();
    await shot(app, testInfo, `${theme}-commit`);
    await app.page.locator('.sb-top button[title^="Command menu"]').click();
    await expect(app.page.locator('.palette')).toBeVisible();
    await shot(app, testInfo, `${theme}-palette`);
    await app.page.keyboard.press('Escape');
  });
}

test('the theme choice persists across launches', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('persist', ['one']);
  const app = await launch(repo);
  await app.palette('Theme: Dark');
  await expect.poll(() => app.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  const userData = await app.app.evaluate(({ app: a }) => a.getPath('userData'));
  await app.app.close();

  const fs = require('node:fs');
  const path = require('node:path');
  expect(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).theme).toBe('dark');
});

test('welcome screen in both themes', async ({ launch }, testInfo) => {
  for (const theme of ['light', 'dark']) {
    const app = await launch(null, { theme });
    await expect(app.page.locator('.welcome-card')).toBeVisible();
    expect(await app.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(theme);
    await shot(app, testInfo, `${theme}-welcome`);
    await app.app.close();
  }
});
