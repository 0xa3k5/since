'use strict';
// The renderer is locked down (docs/security.md): no Node, no network, no navigation, no new
// windows, and IPC refuses malformed arguments. The app itself opens no network connections: the
// only session allowed out is the updater's, to its feed host (unit-tested in test/ipc.test.js), and
// a development build has no feed unless SINCE_UPDATE_FEED is set.

const { execFileSync } = require('node:child_process');
const { test, expect } = require('./fixtures');

test('the renderer has no Node, no network and cannot navigate', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('repo');
  const app = await launch(repo);
  const { page } = app;
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });

  expect(await page.evaluate(() => [typeof require, typeof process, typeof module, Object.keys(window.since).sort().join()])).toEqual(['undefined', 'undefined', 'undefined', 'app,git,on']);

  // fetch / XHR / WebSocket to anywhere outside the bundle fail.
  const net = await page.evaluate(async () => {
    const out = {};
    try { await fetch('https://example.com/'); out.fetch = 'allowed'; } catch (e) { out.fetch = 'blocked'; }
    out.ws = await new Promise((resolve) => {
      try { const ws = new WebSocket('wss://example.com/'); ws.onopen = () => resolve('allowed'); ws.onerror = () => resolve('blocked'); } catch { resolve('blocked'); }
    });
    out.img = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('allowed'); i.onerror = () => resolve('blocked'); i.src = 'https://example.com/x.png'; });
    // Videos only through the main process's since-media: scheme (PR media, AK-519), never straight from the web.
    out.video = await new Promise((resolve) => { const v = document.createElement('video'); v.onloadeddata = () => resolve('allowed'); v.onerror = () => resolve('blocked'); v.src = 'https://example.com/x.mp4'; });
    return out;
  });
  expect(net).toEqual({ fetch: 'blocked', ws: 'blocked', img: 'blocked', video: 'blocked' });

  // Inline script is refused by the CSP.
  expect(await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s); return window.__inline; })).toBeUndefined();

  // window.open and navigation go nowhere; the app page stays put. Navigation is triggered from
  // the main process because Playwright would otherwise wait forever for the blocked load.
  // shell.openExternal is stubbed so the test itself makes no request.
  const url = page.url();
  await app.app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
  await page.evaluate(() => { window.open('https://example.com/'); window.open('file:///etc/passwd'); });
  await expect.poll(() => app.app.evaluate(() => globalThis.__opened)).toEqual(['https://example.com/']);
  const after = await app.app.evaluate(async ({ BaseWindow, webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('file:'));
    await wc.executeJavaScript("location.href = 'https://example.com/'; 0");
    await new Promise((r) => setTimeout(r, 1000));
    return { windows: BaseWindow.getAllWindows().length, url: wc.getURL(), repo: await wc.executeJavaScript("document.querySelector('.sidebar .repo-name')?.textContent") };
  });
  expect(after).toEqual({ windows: 1, url, repo: 'repo' });
  expect(violations.length).toBeGreaterThan(0); // the probes above were reported, not silently allowed
});

test('IPC refuses malformed arguments before they reach git', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('repo');
  const app = await launch(repo);
  const head = sandbox.sha(repo);
  const res = await app.page.evaluate(async () => {
    const g = window.since.git;
    return {
      option: await g('checkout', '--orphan=evil'),
      unknown: await g('run', ['status']),
      path: await g('stageFiles', ['../../etc/passwd']),
      rewrite: await g('rewrite', 'exec', 'HEAD'),
      ok: await g('refs'),
      external: await window.since.app('external', 'file:///Applications/Calculator.app').then(() => 'opened', (e) => e.message),
      openFile: await window.since.app('open-file', '../../../../Applications/Calculator.app').then(() => 'opened', (e) => e.message),
    };
  });
  expect(res.option.error.message).toMatch(/must not start with "-"/);
  expect(res.unknown.error.message).toMatch(/Unknown method/);
  expect(res.path.error.message).toMatch(/\.\./);
  expect(res.rewrite.error.message).toMatch(/expected one of/);
  expect(res.ok.ok.head.oid).toBe(head);
  expect(res.external).toMatch(/only http\(s\) links/);
  expect(res.openFile).toMatch(/\.\./);
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
});

test('the app opens no network connections of its own', async ({ sandbox, launch }) => {
  test.skip(process.platform !== 'darwin', 'uses lsof');
  const repo = sandbox.linear('repo');
  const app = await launch(repo);
  for (const view of ['commit', 'stashes', 'snapshots', 'reflog', 'map']) await app.view(view);
  await app.selectRow('two');
  await app.settle();

  // The main process and every helper (renderer, GPU, network service) it spawned.
  const pids = [app.app.process().pid];
  for (let i = 0; i < pids.length; i++) {
    try { pids.push(...execFileSync('pgrep', ['-P', String(pids[i])], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)); } catch { /* no children */ }
  }
  let sockets = '';
  try { sockets = execFileSync('lsof', ['-a', '-n', '-P', '-i', '-p', pids.join(',')], { encoding: 'utf8' }); } catch (e) { sockets = e.stdout || ''; }
  // Playwright's own debugger connections are on loopback; anything else would be ours.
  const remote = sockets.split('\n').slice(1).filter((l) => l.trim() && !/\s(127\.0\.0\.1|\[::1\]|localhost):\d+(->(127\.0\.0\.1|\[::1\]|localhost):\d+)?\s/.test(l + ' '));
  expect(remote, sockets).toEqual([]);
});
