'use strict';
// Update checks against a local feed. A dev build can check (SINCE_UPDATE_FEED) but never installs,
// so a newer version shows "available"; the download and install path is covered by scripts/update-e2e.js
// against two packaged builds.

const http = require('node:http');
const { test, expect } = require('./fixtures');
const { buildFeed } = require('../updater');
const { version: CURRENT } = require('../package.json');

async function feedServer(version) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (!/^\/update-mac-(arm64|x64)\.json$/.test(req.url)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildFeed({ version, url: `https://example.invalid/Since-${version}.zip` })));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

async function shot(app, testInfo, name) {
  await app.page.waitForTimeout(250);
  const file = testInfo.outputPath(`${name}.png`);
  await app.page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

test('⌘K "Check for updates" reports an up-to-date app', async ({ sandbox, launch }) => {
  const feed = await feedServer(CURRENT);
  try {
    const app = await launch(sandbox.linear('current', ['one']), { env: { SINCE_UPDATE_FEED: feed.url } });
    await app.palette('Check for updates');
    await expect(app.page.locator('.toast.success', { hasText: 'Since is up to date' })).toBeVisible();
    // The request is a bare GET for the arch's feed: no query string, no cookies, no identifiers.
    const arch = await app.app.evaluate(({ app: a }) => (a.runningUnderARM64Translation ? 'arm64' : process.arch));
    expect(feed.requests.map((r) => r.url)).toContain(`/update-mac-${arch}.json`);
    for (const r of feed.requests) expect(r.headers.cookie).toBeUndefined();
  } finally { feed.close(); }
});

test('a newer version is announced at launch, with a download link', async ({ sandbox, launch }) => {
  const feed = await feedServer('99.0.0');
  try {
    const app = await launch(sandbox.linear('newer', ['one']), { env: { SINCE_UPDATE_FEED: feed.url } });
    const t = app.page.locator('.toast', { hasText: 'Since 99.0.0 is available' });
    await expect(t).toBeVisible({ timeout: 20_000 }); // the launch check runs a few seconds after start
    await expect(t.locator('.toast-action')).toHaveText('Download');
    // Opening the release page goes through shell.openExternal; stub it to capture the URL.
    await app.app.evaluate(({ shell }) => { globalThis.opened = []; shell.openExternal = async (u) => { globalThis.opened.push(u); }; });
    await t.locator('.toast-action').click();
    expect(await app.app.evaluate(() => globalThis.opened)).toEqual([require('../package.json').updates.page]);
  } finally { feed.close(); }
});

test('dev builds without a feed make no update request', async ({ sandbox, launch }) => {
  const app = await launch(sandbox.linear('dev', ['one']));
  await app.palette('Check for updates');
  await expect(app.page.locator('.toast', { hasText: 'Updates come with the packaged app' })).toBeVisible();
});

test('⌘K turns automatic update checks off and on; manual checks still work', async ({ sandbox, launch }) => {
  const feed = await feedServer(CURRENT);
  try {
    const app = await launch(sandbox.linear('auto', ['one']), { env: { SINCE_UPDATE_FEED: feed.url } });
    const menuChecked = () => app.app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label === 'Automatically Check for Updates')?.checked);
    expect(await menuChecked()).toBe(true);
    await app.palette('Turn off automatic update checks');
    await expect(app.page.locator('.toast', { hasText: 'Automatic update checks are off' })).toBeVisible();
    expect(await menuChecked()).toBe(false);
    await app.palette('Check for updates');
    await expect(app.page.locator('.toast.success', { hasText: 'Since is up to date' })).toBeVisible();
    await app.palette('Turn on automatic update checks');
    await expect(app.page.locator('.toast', { hasText: 'Automatic update checks are on' })).toBeVisible();
    expect(await menuChecked()).toBe(true);
  } finally { feed.close(); }
});

for (const theme of ['light', 'dark']) {
  test(`update toasts in the ${theme} theme`, async ({ sandbox, launch }, testInfo) => {
    const app = await launch(sandbox.linear(`toast-${theme}`, ['one', 'two']), { theme });
    // Drive the renderer with the states the packaged updater sends.
    const send = (s) => app.app.evaluate(({ webContents }, st) => webContents.getAllWebContents().find((w) => w.getURL().startsWith('file:')).send('update', st), s);
    await send({ status: 'available', version: '0.2.0', current: CURRENT, page: 'https://example.invalid' });
    await send({ status: 'ready', version: '0.2.0', current: CURRENT });
    const ready = app.page.locator('.toast', { hasText: 'Since 0.2.0 is ready' });
    await expect(ready.locator('.toast-action')).toHaveText('Restart to update');
    await expect(app.page.locator('.toast', { hasText: 'is available' })).toHaveCount(0);
    await shot(app, testInfo, `${theme}-update-toasts`);
    await app.page.locator('.sb-top button[title^="Command menu"]').click();
    await app.page.locator('.palette-input').fill('update');
    await expect(app.page.locator('.palette-item .palette-label', { hasText: 'Restart to update to 0.2.0' })).toBeVisible();
    await expect(app.page.locator('.palette-item .palette-label', { hasText: 'Turn off automatic update checks' })).toBeVisible();
    await shot(app, testInfo, `${theme}-update-palette`);
    await app.page.keyboard.press('Escape');
  });
}
