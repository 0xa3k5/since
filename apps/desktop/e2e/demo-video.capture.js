'use strict';
// Launch videos (SNC-658), recorded from the real app the way site-shots.capture.js takes the
// landing page shots: the made-up orbit repository (orbit-demo.js), a fake `gh`, no network.
// Not part of the e2e suite (its testMatch is *.spec.js). One command re-renders everything:
//
//   pnpm demo-video                     (from the repository root; needs ffmpeg)
//   pnpm demo-video -g "hero video (dark)"   just one of them
//
// Writes, from a 1440×900 window recorded at the display's scale:
//   apps/web/public/media/hero-{dark,light}.{mp4,webm}   the site (≤ 8 MB each)
//   docs/media/hero-{dark,light}.gif                      the README (900 px wide, ≤ 5 MB)
//   apps/web/public/media/kernel.mp4                      a large repository opening and scrolling
//
// The hero is driven with the keyboard only; captions and the keys pressed are drawn in the window
// for the capture (demo-recorder.js). Menu shortcuts (⌘⌥1 views, ⌘Z) are handled by the native menu,
// which synthetic key presses don't reach, so those send the command the menu item sends.
// The large repository: DEMO_LARGE_REPO=<path> (e.g. a Linux kernel clone), else a synthetic
// 250k-commit repository with made-up authors, generated once into ~/.cache/since-demo/atlas.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('./fixtures');
const { seedOrbit, H } = require('./orbit-demo');
const { record, overlay, glyph, encode } = require('./demo-recorder');

const ROOT = path.join(__dirname, '..', '..', '..');
const SITE = path.join(ROOT, 'apps', 'web', 'public', 'media');
const README = path.join(ROOT, 'docs', 'media');
const ICON = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
const LEAKS = ['E2E', 'tmp', '/var/', '/Users', '/private', 'since-e2e', 'Tester', 'orbit-remote', '.cache'];
const END = { svg: ICON, title: 'Since', line: 'Free and open source · gitsince.com' };

// The window at 1440×900, its clipboard left alone (Copy prompt would overwrite yours), and the
// keys/caption overlay. → helpers that pace the video like a person.
async function stage(app) {
  const { page } = app;
  await app.app.evaluate(({ BaseWindow, clipboard }) => {
    const w = BaseWindow.getAllWindows()[0];
    w.setContentSize(1440, 900);
    w.center();
    clipboard.writeText = () => {};
  });
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await overlay(page);
  const hold = (ms) => page.waitForTimeout(ms);
  const caption = (text) => page.evaluate((t) => window.__demo.caption(t), text);
  const show = (key) => page.evaluate((l) => window.__demo.key(l), glyph(key));
  return {
    hold, caption,
    async press(key, after = 600) { await show(key); await page.keyboard.press(key); await hold(after); },
    async type(text, after = 400) { await show(text); await page.keyboard.type(text, { delay: 70 }); await hold(after); },
    // A menu shortcut: what the native menu item sends to the tab.
    async menu(key, cmd, ...args) {
      await show(key);
      await app.app.evaluate(({ webContents }, [c, a]) => {
        for (const w of webContents.getAllWebContents()) if (w.getURL().split('?')[0].endsWith('/renderer/index.html')) w.send('command', c, ...a);
      }, [cmd, args]);
    },
    async clean(step) {
      const text = await page.evaluate(() => document.getElementById('app').innerText);
      for (const bad of LEAKS) expect(text, `${step}: “${bad}” is on screen`).not.toContain(bad);
    },
  };
}

for (const theme of ['dark', 'light']) {
  test(`hero video (${theme})`, async ({ sandbox, launch }) => {
    test.setTimeout(300_000);
    // Caught up yesterday morning; 21 PRs merged over the last day, 2 stuck, 3 ready.
    const { repo, bin, checkpoint, checkpointAt } = seedOrbit(sandbox, { checkpointAgo: 30 * H, extra: true });
    const app = await launch(repo, { theme, env: { SINCE_START_VIEW: '', PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    const { page } = app;

    // --- Off camera: the checkpoint, pull requests loaded (as in site-shots), then Since loaded.
    await page.evaluate((cp) => window.since.app('catchup-mark', cp), { sha: checkpoint, base: 'origin/main', date: checkpointAt, source: 'mark' });
    await app.palette('Refresh pull requests');
    await expect(page.locator('.toast', { hasText: '7 open pull requests' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.sidebar .repo-name')).toHaveText('orbit');
    await page.locator('.review-reload').click(); // stage counts need a PR load (#143)
    await expect(page.locator('.review-tab[data-tab="stuck"] .review-tab-n')).toHaveText('2', { timeout: 40_000 });
    await expect(page.locator('.review-tab[data-tab="ready"] .review-tab-n')).toHaveText('3');
    await app.view('catchup');
    const catchup = page.locator('.page.catchup');
    await catchup.press('Meta+R');
    await expect(catchup.locator('.catchup-sentence')).toContainText('21 PRs merged', { timeout: 40_000 });
    await expect(catchup.locator('.catchup-day').first()).toBeVisible();
    await app.settle(600);
    const s = await stage(app);
    await s.clean('catch up');
    const rec = await record(page, sandbox.path('frames'));

    // 0–3 s: what landed while you were away, by day.
    await rec.resume();
    await s.hold(400);
    await s.caption('Away for a day. 21 PRs landed.');
    await s.hold(2200);

    // 3–7 s: step through the merged PRs, read one.
    await s.caption('Walk through what landed.');
    await s.press('ArrowDown', 550);
    await s.press('ArrowDown', 550);
    await s.press('Enter', 500);
    for (let i = 0; i < 4; i++) await s.press('Shift+ArrowDown', 320);
    await s.press('ArrowRight', 700);
    await s.clean('reader');

    // 7–12 s: Review → Stuck → the PR with failing checks → its fix prompt → copy.
    await s.caption('Stuck? A fix prompt for its agent in two keystrokes.');
    await s.menu('Meta+Alt+2', 'view', 'lanes');
    await expect(page.locator('.content')).toHaveAttribute('data-view', 'lanes');
    await page.locator('.review-split').focus();
    await s.hold(500);
    await s.press('2', 600);
    await expect(page.locator('.review-tab[data-tab="stuck"]')).toHaveAttribute('aria-selected', 'true');
    const rows = await page.locator('.lanes-row').evaluateAll((els) => els.map((e) => ({ key: e.dataset.key, on: /selected|active|\bon\b/.test(e.className) || e.getAttribute('aria-selected') === 'true' })));
    const from = Math.max(0, rows.findIndex((r) => r.on));
    const to = rows.findIndex((r) => r.key === 'pr:230');
    expect(to, 'the PR with failing checks is under Stuck').toBeGreaterThanOrEqual(0);
    for (let i = from; i < to; i++) await s.press('ArrowDown', 500);
    await s.hold(300);
    await s.press('p', 0);
    await expect(page.locator('.sendback')).toBeVisible();
    await s.hold(1100);
    await s.clean('fix prompt');
    await s.press('Enter', 900); // Copy prompt has focus
    await expect(page.locator('.sendback')).toHaveCount(0);

    // 12–18 s: Ready → merge plan → merged in order.
    await s.caption('Ready ones, merged in order.');
    await s.press('3', 600);
    await s.press('Shift+P', 0);
    const plan = page.locator('.mergeplan-sheet');
    rec.pause();
    await expect(plan.locator('.mergeplan-row')).toHaveCount(3, { timeout: 30_000 });
    await app.settle(300);
    await rec.resume();
    await s.hold(1100);
    await s.clean('merge plan');
    // The plan opens on its Pick step and ↵ merges only on the last: the step button (⇥ to it) moves on.
    // Then the focus drops to the page and ⇥ lands on the merge button.
    const has = (l) => l.evaluate((b) => b === document.activeElement).catch(() => false);
    const onward = plan.locator('.dialog-foot > button.btn:not(.primary)').filter({ hasText: /^(Fix|Merge)$/ });
    for (let i = 0; i < 6 && !(await has(onward)); i++) await s.press('Tab', 300);
    await s.press('Enter', 450);
    await s.press('Enter', 450);
    const mergeBtn = plan.locator('.dialog-foot button.btn.primary[type="submit"]');
    for (let i = 0; i < 6 && !(await has(mergeBtn)); i++) await s.press('Tab', 300);
    await expect(mergeBtn).toContainText('Merge 3 in order');
    await s.press('Enter', 0);
    const t0 = Date.now();
    await expect(page.locator('.toast', { hasText: 'Merged 3 in order' })).toBeVisible({ timeout: 60_000 });
    console.log(`merging took ${Date.now() - t0} ms`);
    await s.hold(900);
    await s.press('Escape', 300);

    // 18–22 s: a wrong merge on the Map, then ⌘Z.
    await s.caption('Undo anything.');
    await s.menu('Meta+Alt+3', 'view', 'map');
    await expect(page.locator('.content')).toHaveAttribute('data-view', 'map');
    await page.locator('.map-list').focus();
    await s.hold(500);
    await s.press('/', 150);
    await s.type('ledger', 250);
    await s.press('Enter', 500);
    await expect(page.locator('.map-list .row.selected .subject')).toHaveText('spike: double-entry ledger tables');
    await s.press('m', 600);
    const wrong = page.locator('.map-list .row .subject', { hasText: /^Merge branch 'spike\/ledger-v2'/ });
    await s.press('h', 0); // jump to HEAD: the merge just made
    await expect(wrong).toHaveCount(1, { timeout: 15_000 });
    await s.hold(900);
    await s.menu('Meta+Z', 'undo');
    await expect(wrong).toHaveCount(0, { timeout: 15_000 });
    await s.hold(1100);
    await s.clean('map');

    // 22–25 s: end card.
    await page.evaluate((e) => window.__demo.end(e), END);
    await s.hold(2700);
    const video = await rec.stop();
    console.log(`hero ${theme}: ${video.seconds.toFixed(1)} s, ${video.frames.length} frames`);
    const sizes = encode(video, sandbox.dir, {
      mp4: path.join(SITE, `hero-${theme}.mp4`), webm: path.join(SITE, `hero-${theme}.webm`), gif: path.join(README, `hero-${theme}.gif`),
    });
    for (const [f, b] of Object.entries(sizes)) console.log(`${path.relative(ROOT, f)}: ${(b / 1024 / 1024).toFixed(2)} MB`);
  });
}

const AUTHORS = ['Maya Chen', 'Theo Park', 'Priya Raman', 'Jonas Weber', 'Lena Hart', 'Omar Haddad', 'Sofia Brandt', 'Kenji Mori', 'Ava Lindqvist', 'Rui Costa', 'Nadia Ivers', 'Felix Moreau'];

test('kernel clip: a large repository opens and scrolls', async ({ launch }) => {
  test.setTimeout(900_000);
  let big = process.env.DEMO_LARGE_REPO;
  if (!big) {
    big = path.join(os.homedir(), '.cache', 'since-demo', 'atlas');
    if (!fs.existsSync(path.join(big, '.git'))) {
      fs.rmSync(big, { recursive: true, force: true });
      await require('../bench/synth').generate(big, 250_000, { authors: AUTHORS });
    }
  }
  const commits = Number(execFileSync('git', ['-C', big, 'rev-list', '--count', '--all'], { encoding: 'utf8' }).trim());
  const chip = (() => { try { return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  const app = await launch(big, { theme: 'dark' });
  const { page } = app;
  const s = await stage(app);
  const rows = page.locator('.map-list .row');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const rec = await record(page, path.join(os.tmpdir(), `since-demo-kernel-${process.pid}`));

  // Open it again (a reload reopens the repository): first rows, then fast scrolling. Timed in the
  // page from the window loading, every frame, as the benchmark does (bench/harness.js).
  await rec.resume();
  await page.reload({ waitUntil: 'commit' });
  const first = await page.waitForFunction(() => document.querySelector('.map-list .row') && performance.now(), null, { polling: 'raf', timeout: 60_000 });
  const secs = (await first.jsonValue()) / 1000;
  await overlay(page);
  await page.locator('.map-list').focus();
  const count = commits >= 1e6 ? `${(commits / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(commits / 1000)}k`;
  const on = /^Apple M/.test(chip) ? ` on an ${chip.replace(/^Apple /, '')}` : '';
  await s.caption(`${count} commits. First rows in ~${secs.toFixed(1)} s${on}.`);
  console.log(`${big}: ${commits} commits, first rows after ${secs.toFixed(2)} s (${chip})`);
  await s.hold(1200);
  for (let i = 0; i < 18; i++) await s.press('PageDown', 110);
  await s.press('End', 1100);
  await s.press('Home', 900);
  await s.clean('large repository');
  const video = await rec.stop();
  console.log(`kernel: ${video.seconds.toFixed(1)} s, ${video.frames.length} frames`);
  const sizes = encode(video, path.dirname(video.frames[0].file), { mp4: path.join(SITE, 'kernel.mp4') });
  for (const [f, b] of Object.entries(sizes)) console.log(`${path.relative(ROOT, f)}: ${(b / 1024 / 1024).toFixed(2)} MB`);
  fs.rmSync(path.dirname(video.frames[0].file), { recursive: true, force: true });
});
