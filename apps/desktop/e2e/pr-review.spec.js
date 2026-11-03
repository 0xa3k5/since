'use strict';
// Review's split view with pull requests on (AK-272, AK-277), against a fake `gh` and a bare
// repository standing in for GitHub (fixtures.js Sandbox.github): read a PR's diff in the pane,
// tick its file, approve it, merge it on GitHub, tidy the local branch, then ⌘Z brings the branch back.

const fs = require('node:fs');
const { test, expect } = require('./fixtures');

// What the app asked `gh`, next to the failure screenshot.
let gh = null;
test.afterEach(async ({}, testInfo) => {
  if (gh && testInfo.status !== testInfo.expectedStatus) fs.writeFileSync(testInfo.outputPath('gh-calls.json'), JSON.stringify(gh.calls(), null, 1));
  gh = null;
});

test('Review a PR in the pane: read, tick, approve, merge on GitHub, tidy, undo the tidy', async ({ sandbox, launch }) => {
  gh = sandbox.github({ prs: [{ number: 7, title: 'Add widget', branch: 'widget', files: { 'widget.txt': 'a widget\n' }, local: true }] });
  const tip = sandbox.sha(gh.repo, 'widget');
  const app = await launch(gh.repo, { env: gh.env, settings: { github: { on: true } } });
  const { page } = app;
  await app.view('lanes');
  // Waiting on your review is In progress, not Needs you.
  await page.getByRole('tab', { name: /^All open/ }).click();

  const row = page.locator('.review-row', { has: page.locator('.review-row-num', { hasText: '#7' }) });
  await row.click({ position: { x: 8, y: 8 } });
  await expect(row).toHaveClass(/active/);

  // Read: the pane shows the PR's one file.
  const pane = page.locator('.review-pane');
  await expect(pane.getByRole('listitem', { name: 'widget.txt' })).toContainText('a widget');

  // Tick it.
  const tick = pane.getByRole('checkbox', { name: 'Reviewed widget.txt' });
  await tick.click();
  await expect(tick).toBeChecked();
  await app.settle(); // ticking folds the file away

  // Approve on GitHub.
  await pane.getByRole('button', { name: 'Approve…' }).click();
  await app.dialog({ submit: 'Approve' });
  await app.toast('Approved #7');
  expect(gh.calls()).toContainEqual(['pr', 'review', '7', '--repo', 'github.com/acme/widgets', '--approve']);

  // Merge on GitHub, then tidy the local branch.
  await pane.getByRole('button', { name: 'Merge…' }).click();
  await app.dialog({ submit: 'Merge and tidy' });
  await app.toast('Tidied widget');
  expect(gh.calls()).toContainEqual(['pr', 'merge', '7', '--repo', 'github.com/acme/widgets', '--squash']);
  expect(gh.pr(7).state).toBe('MERGED');
  expect(sandbox.log(gh.bare, 'main')[0]).toBe('Add widget (#7)');
  expect(sandbox.git(gh.repo, 'branch', '--list', 'widget')).toBe('');

  // Undo brings the branch back; the merge on GitHub stays.
  await app.undo('Tidy widget');
  expect(sandbox.sha(gh.repo, 'widget')).toBe(tip);
  expect(gh.pr(7).state).toBe('MERGED');
});

test('Review PRs that aren’t checked out here: the pane fetches each head, then merge one on GitHub', async ({ sandbox, launch }) => {
  gh = sandbox.github({ prs: [
    { number: 8, title: 'Fix gadget', branch: 'gadget', files: { 'gadget.txt': 'a gadget\n' } },
    { number: 9, title: 'Add gizmo', branch: 'gizmo', files: { 'gizmo.txt': 'a gizmo\n' } },
  ] });
  const app = await launch(gh.repo, { env: gh.env, settings: { github: { on: true } } });
  const { page } = app;
  await app.view('lanes');
  await page.getByRole('tab', { name: /^All open/ }).click();
  const row = (n) => page.locator('.review-row', { has: page.locator('.review-row-num', { hasText: `#${n}` }) });
  const pane = page.locator('.review-pane');

  // One fetch right after another: each pane shows its own PR, also on the way back.
  await row(8).click({ position: { x: 8, y: 8 } });
  await row(9).click({ position: { x: 8, y: 8 } });
  await expect(pane.getByRole('listitem', { name: 'gizmo.txt' })).toContainText('a gizmo');
  await row(8).click({ position: { x: 8, y: 8 } });
  await expect(pane.getByRole('listitem', { name: 'gadget.txt' })).toContainText('a gadget');
  await expect(pane.getByRole('listitem', { name: 'gizmo.txt' })).toHaveCount(0);
  // Fetched for reading only: no branch or worktree appeared.
  expect(sandbox.git(gh.repo, 'branch', '--format=%(refname:short)')).toBe('main');

  await pane.getByRole('button', { name: 'Approve…' }).click();
  await app.dialog({ submit: 'Approve' });
  await app.toast('Approved #8');
  await expect(page.getByRole('tab', { name: 'Ready 1' })).toBeVisible();

  // Merge on GitHub (it deletes the branch there); the fetch afterwards brings the squash commit.
  await row(8).click({ position: { x: 8, y: 8 } });
  await pane.getByRole('button', { name: 'Merge…' }).click();
  await app.dialog();
  await app.toast('Merged #8');
  expect(gh.calls()).toContainEqual(['pr', 'merge', '8', '--repo', 'github.com/acme/widgets', '--squash', '--delete-branch']);
  expect(gh.pr(8).state).toBe('MERGED');
  expect(gh.pr(9).state).toBe('OPEN');
  await expect.poll(() => sandbox.log(gh.repo, 'origin/main')[0]).toBe('Fix gadget (#8)');
});

test('Narrow window: the pane gives way, so its actions, the head row and Merge stay inside the window', async ({ sandbox, launch }) => {
  gh = sandbox.github({ prs: [{ number: 5, title: 'Keep pre-release builds on the pre-release feed until the final release is out, then move them over', branch: 'agent/since-engineer/keep-pre-release-builds-on-their-feed-until-the-final-release', files: { 'apps/desktop/test/updater.test.js': 'test\n' } }] });
  const app = await launch(gh.repo, { env: gh.env, settings: { github: { on: true } } });
  const { page } = app;
  await app.view('lanes');
  await page.getByRole('tab', { name: /^All open/ }).click();
  await page.locator('.review-row', { has: page.locator('.review-row-num', { hasText: '#5' }) }).click({ position: { x: 8, y: 8 } });
  const pane = page.locator('.review-pane');
  await pane.getByRole('button', { name: 'Approve…' }).click();
  await app.dialog({ submit: 'Approve' });
  await app.toast('Approved #5');
  const merge = pane.locator('.review-pane-status').getByRole('button', { name: 'Merge…' });
  await expect(merge).toBeVisible();

  // The widest sidebar, and the pane dragged out as far as it goes, as in a big window.
  await page.locator('.pane-handle[data-pane="sidebar"]').focus();
  await page.keyboard.press('End');
  const hb = await page.locator('.review-split-handle').boundingBox();
  await page.mouse.move(hb.x + 3, hb.y + 40);
  await page.mouse.down();
  await page.mouse.move(0, hb.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(hb.x + 200, hb.y + 40);

  // Unzoomed: 1100 px keeps the sidebar open (at its widest), 900 px is the window's minimum (sidebar rail).
  await app.app.evaluate(({ webContents }) => { for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(1); });
  for (const width of [1100, 900]) {
    await app.app.evaluate(({ BaseWindow }, w) => BaseWindow.getAllWindows()[0].setContentSize(w, 640), width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
    await app.settle();
    const out = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const split = box('.review-split');
      const host = box('.review-pane-host');
      const right = Math.min(split.right, window.innerWidth) + 0.5;
      const over = (s) => { const e = document.querySelector(s); return e.scrollWidth > e.clientWidth + 1; };
      const merge = [...document.querySelectorAll('.review-pane-status button')].find((b) => b.getAttribute('aria-label') === 'Merge…');
      const m = merge.getBoundingClientRect();
      return [
        host.right > right && 'pane',
        box('.review-reload').right > right && 'Reload',
        (m.left < host.left || m.right > Math.min(host.right, right) || !m.width) && 'Merge',
        box('.reader-branch').right > host.right && 'branch',
        over('.review-split') && 'split overflows',
        over('.review-tabs') && 'tabs overflow',
        over('.review-pane-head') && 'pane head overflows',
      ].filter(Boolean);
    });
    expect(out, `at ${width} px`).toEqual([]);
  }

  // Merge is clickable there.
  await merge.click();
  await app.dialog();
  await app.toast('Merged #5');
});
