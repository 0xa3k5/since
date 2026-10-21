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
