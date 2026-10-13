'use strict';
// Worktrees: create, show on the graph, switch the window, lock, remove, and undo.

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./fixtures');

const worktrees = (sb, repo) => sb.git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.basename(l.slice(9)));

async function shot(app, testInfo, name) {
  await app.page.waitForTimeout(250);
  const file = testInfo.outputPath(`${name}.png`);
  await app.page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

test('create from ⌘K, see it on the graph, undo and redo', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('app', ['one', 'two']);
  const app = await launch(repo);

  await app.palette('New worktree…');
  await app.dialog({ fields: { Branch: 'feature' }, submit: 'Create worktree' });
  await app.toast('New worktree for feature');
  expect(worktrees(sandbox, repo)).toEqual(['app', 'app-feature']);
  expect(sandbox.git(sandbox.path('app-feature'), 'symbolic-ref', '--short', 'HEAD')).toBe('feature');

  // The branch pill on the graph is marked as checked out in that worktree.
  await expect(app.row('two').locator('.pill.branch.in-worktree', { hasText: 'feature' })).toBeVisible();
  await expect(app.page.locator('.sb-section', { hasText: 'Worktrees' }).locator('.sb-item')).toHaveCount(2);

  await app.undo('New worktree for feature');
  expect(worktrees(sandbox, repo)).toEqual(['app']);
  expect(sandbox.git(repo, 'branch', '--list', 'feature')).toBe('');
  expect(fs.existsSync(sandbox.path('app-feature'))).toBe(false);

  await app.redo('New worktree for feature');
  expect(worktrees(sandbox, repo)).toEqual(['app', 'app-feature']);
});

test('a detached worktree HEAD shows on the graph; W on a commit creates one there', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('app', ['one', 'two', 'three']);
  const app = await launch(repo);
  await app.selectRow('one');
  await app.page.keyboard.press('w');
  await app.dialog({ submit: 'Create worktree' });
  await app.toast('New worktree');
  const one = sandbox.sha(repo, 'HEAD~2');
  const dir = sandbox.path(`app-${one.slice(0, 7)}`);
  expect(sandbox.sha(dir)).toBe(one);
  await expect(app.row('one').locator('.pill.worktree')).toHaveText(path.basename(dir));

  // A commit made there (on no branch) still appears in this window's graph.
  sandbox.commit(dir, 'detached work');
  await expect(app.row('detached work').locator('.pill.worktree')).toBeVisible();
});

test('switch the window between worktrees, keeping the view', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('app', ['one', 'two']);
  sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'feature', sandbox.path('app-feature'));
  sandbox.commit(sandbox.path('app-feature'), 'on feature');
  const app = await launch(repo);

  await app.view('commit');
  await app.page.locator('.sb-section', { hasText: 'Worktrees' }).locator('.sb-item', { hasText: 'app-feature' }).click();
  await expect(app.page.locator('.sidebar .repo-name')).toHaveText('app-feature');
  await expect(app.page.locator('.content')).toHaveAttribute('data-view', 'commit');
  await expect(app.page.locator('.topbar .head-chip').first()).toHaveText('feature');

  // The topbar chip opens the switcher, like ⌥⌘W.
  await app.page.locator('.topbar .wt-chip').click();
  await app.page.locator('.palette-input').fill('app');
  await app.page.locator('.palette-item', { hasText: /^app/ }).filter({ hasNotText: 'feature' }).click();
  await expect(app.page.locator('.sidebar .repo-name')).toHaveText('app');
  await expect(app.page.locator('.topbar .head-chip').first()).toHaveText('main');
});

test('remove is blocked while dirty, asks first, and undo brings it back', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('app', ['one']);
  const wt = sandbox.path('app-feature');
  sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  sandbox.write(wt, 'wip.txt', 'wip\n');
  const app = await launch(repo);
  await app.view('worktrees');
  const row = app.page.locator('.wt-row', { hasText: 'app-feature' });
  await expect(row.locator('.wt-changes')).toHaveText('1 changed');

  await row.click();
  await app.page.keyboard.press('Backspace');
  await app.toast('Can’t remove “app-feature”', 'error');
  await expect(app.page.locator('.toast.error')).toContainText('1 uncommitted change');
  expect(worktrees(sandbox, repo)).toEqual(['app', 'app-feature']);

  // Other worktrees' folders aren't watched; counts refresh on focus or when the view opens.
  fs.rmSync(path.join(wt, 'wip.txt'));
  await app.view('map');
  await app.view('worktrees');
  await expect(row.locator('.wt-changes')).toHaveText('Clean');
  await app.contextMenu(row, 'Remove Worktree…');
  await app.dialog({ submit: 'Remove' });
  await app.toast('Remove worktree app-feature');
  expect(worktrees(sandbox, repo)).toEqual(['app']);
  expect(fs.existsSync(wt)).toBe(false);
  await expect(app.page.locator('.wt-row')).toHaveCount(1);

  await app.undo('Remove worktree app-feature');
  expect(worktrees(sandbox, repo)).toEqual(['app', 'app-feature']);
  expect(sandbox.git(wt, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
  await expect(app.page.locator('.wt-row')).toHaveCount(2);
});

test('lock with a reason blocks removal until unlocked', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('app', ['one']);
  sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'feature', sandbox.path('app-feature'));
  const app = await launch(repo);
  await app.view('worktrees');
  const row = app.page.locator('.wt-row', { hasText: 'app-feature' });
  await row.click();
  await app.page.keyboard.press('l');
  await app.dialog({ fields: { Reason: 'agent running' }, submit: 'Lock' });
  await app.toast('Lock app-feature');
  expect(sandbox.git(repo, 'worktree', 'list', '--porcelain')).toContain('locked agent running');
  await expect(row.locator('.badge', { hasText: 'Locked' })).toBeVisible();

  await row.click();
  await app.page.keyboard.press('Backspace');
  await app.toast('“app-feature” is locked', 'error');

  await row.click();
  await app.page.keyboard.press('l');
  await app.toast('Unlock app-feature');
  expect(sandbox.git(repo, 'worktree', 'list', '--porcelain')).not.toContain('locked');
});

for (const theme of ['light', 'dark']) {
  test(`${theme} worktree screenshots`, async ({ sandbox, launch }, testInfo) => {
    const repo = sandbox.linear('app', ['one', 'two', 'three']);
    sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'feature/agent-1', sandbox.path('app-agent-1'), 'HEAD~1');
    sandbox.commit(sandbox.path('app-agent-1'), 'agent 1 work');
    sandbox.git(repo, 'worktree', 'add', '-q', '--detach', sandbox.path('app-review'), 'HEAD~2');
    sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'spike', sandbox.path('app-spike'));
    sandbox.git(repo, 'worktree', 'lock', '--reason', 'on external drive', sandbox.path('app-spike'));
    sandbox.write(sandbox.path('app-agent-1'), 'notes.txt', 'wip\n');
    const app = await launch(repo, { theme });
    await app.selectRow('agent 1 work');
    await shot(app, testInfo, `${theme}-worktrees-map`);
    await app.view('worktrees');
    await expect(app.page.locator('.wt-row', { hasText: 'app-agent-1' }).locator('.wt-changes')).toHaveText('1 changed');
    await shot(app, testInfo, `${theme}-worktrees-view`);
    await app.page.locator('.page-actions button', { hasText: 'New worktree' }).click();
    await expect(app.page.locator('.overlay .dialog')).toBeVisible();
    await shot(app, testInfo, `${theme}-worktrees-new`);
    await app.page.keyboard.press('Escape');
  });
}
