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
  const row = app.page.locator('.sb-section', { hasText: 'Worktrees' }).locator('.sb-item', { hasText: 'app-feature' });
  await row.click();
  await expect(row).toHaveClass(/selected/);
  await expect(app.page.locator('.sidebar .repo-name')).toHaveText('app');
  await row.dblclick();
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

test('remove a dirty worktree: its changes are stashed, undo brings both back', async ({ sandbox, launch }) => {
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
  await app.toast('Removed app-feature');
  expect(worktrees(sandbox, repo)).toEqual(['app']);
  expect(fs.existsSync(wt)).toBe(false);
  expect(sandbox.git(repo, 'stash', 'list')).toContain('app-feature before removing it');
  await expect(app.page.locator('.wt-row')).toHaveCount(1);

  await app.undo('Remove worktree app-feature');
  expect(worktrees(sandbox, repo)).toEqual(['app', 'app-feature']);
  expect(sandbox.git(wt, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
  expect(fs.readFileSync(path.join(wt, 'wip.txt'), 'utf8')).toBe('wip\n');
  await expect(app.page.locator('.wt-row')).toHaveCount(2);
});

// AK-577: removing a worktree that's open in another window closes that window, stashes its changes
// and removes it, from the other window's list and from its own window (handed to the main window).
for (const from of ['main', 'own']) {
  test(`remove a dirty worktree open in another window, from the ${from} window`, async ({ sandbox, launch }) => {
    const repo = sandbox.linear('app', ['one']);
    const wt = sandbox.path('app-dirty');
    sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'dirty', wt);
    sandbox.write(wt, 'wip.txt', 'wip\n');
    const app = await launch(repo);
    await app.view('worktrees');
    const row = app.page.locator('.wt-row', { hasText: 'app-dirty' });
    const opened = app.app.waitForEvent('window');
    await app.contextMenu(row, 'Open in New Window');
    const other = await opened;
    await expect(other.locator('.sidebar .repo-name')).toHaveText('app-dirty');
    const closed = other.waitForEvent('close');
    if (from === 'main') {
      await app.page.bringToFront();
      await app.contextMenu(row, 'Remove Worktree…');
    } else {
      const own = new app.constructor(app.app, other, sandbox);
      await own.view('worktrees');
      await own.contextMenu(other.locator('.wt-row', { hasText: 'app-dirty' }), 'Remove Worktree…');
    }
    await closed;
    await app.toast('Removed app-dirty');
    expect(worktrees(sandbox, repo)).toEqual(['app']);
    expect(sandbox.git(repo, 'stash', 'list')).toContain('app-dirty before removing it');
  });
}

test('lock with a reason: remove asks to unlock first', async ({ sandbox, launch }) => {
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

  // Remove asks to unlock first; Escape keeps it.
  await row.click();
  await app.page.keyboard.press('Backspace');
  await expect(app.page.getByText(/(It’s|“app-feature” is) locked\./)).toBeVisible();
  await app.page.keyboard.press('Escape');
  expect(worktrees(sandbox, repo)).toEqual(['app', 'app-feature']);

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
    await app.page.locator('.sb-section', { hasText: 'Worktrees' }).locator('.sb-item', { hasText: 'app-agent-1' }).click();
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
