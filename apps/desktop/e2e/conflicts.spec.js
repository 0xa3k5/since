'use strict';
// Merge and rebase that stop on a conflict, resolved with ours / theirs / a
// manual edit, then continued or aborted, and undone.

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./fixtures');

const branchItem = (app, name) => app.page.locator('.sidebar .sb-item', { has: app.page.locator('.sb-label', { hasText: new RegExp(`^${name}$`) }) });

async function startConflict(app, op) {
  const item = op === 'merge' ? 'Merge into main' : 'Rebase main onto feature';
  await app.contextMenu(branchItem(app, 'feature'), item);
  await app.toast(op === 'merge' ? 'Merge feature failed' : 'Rebase onto feature failed', 'error');
  const banner = app.page.locator('.banner');
  await expect(banner).toContainText(`${op === 'merge' ? 'Merge' : 'Rebase'} in progress`);
  await expect(banner).toContainText('1 conflicted file');
  await expect(banner.locator('.btn.primary', { hasText: 'Continue' })).toBeDisabled();
  return banner;
}

async function resolve(app, how) {
  await app.view('commit');
  const row = app.page.locator('.cv-section', { hasText: 'Conflicts' }).locator('.file-row', { hasText: 'conflict.txt' });
  await expect(row).toBeVisible();
  if (how === 'ours') { await app.hoverClick(row, 'button:has-text("Ours")'); await app.toast('Use our version of conflict.txt'); }
  else if (how === 'theirs') { await app.hoverClick(row, 'button:has-text("Theirs")'); await app.toast('Use their version of conflict.txt'); }
  else {
    fs.writeFileSync(path.join(app.sb.dir, how.repo, 'conflict.txt'), how.content);
    await app.hoverClick(row, 'button[title="Mark as resolved"]');
  }
  await expect(app.page.locator('.banner')).toContainText('ready to continue');
}

test('merge conflict → ours → continue, then undo and redo', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('merge-ours');
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  await startConflict(app, 'merge');
  await resolve(app, 'ours');
  await app.page.locator('.banner .btn.primary', { hasText: 'Continue' }).click();
  await app.toast('Continue merge');
  await expect(app.page.locator('.banner')).toHaveCount(0);

  expect(sandbox.git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
  expect(sandbox.read(repo, 'conflict.txt')).toBe('main\n');
  const merged = sandbox.sha(repo);

  await app.undo('Continue merge');
  expect(sandbox.sha(repo)).toBe(before);
  await app.redo('Continue merge');
  expect(sandbox.sha(repo)).toBe(merged);
});

test('merge conflict → manual edit → mark resolved → continue', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('merge-manual');
  const app = await launch(repo);
  await startConflict(app, 'merge');
  await resolve(app, { repo: 'merge-manual', content: 'main and feature\n' });
  await app.page.locator('.banner .btn.primary', { hasText: 'Continue' }).click();
  await app.toast('Continue merge');
  expect(sandbox.git(repo, 'show', 'HEAD:conflict.txt')).toBe('main and feature');
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
});

test('merge conflict → built-in editor → both (keyboard) → mark resolved, then undo', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('merge-editor');
  const app = await launch(repo);
  await startConflict(app, 'merge');
  await app.view('commit');
  await app.page.locator('.cv-section', { hasText: 'Conflicts' }).locator('.file-row', { hasText: 'conflict.txt' }).click();
  const block = app.page.locator('.cf-block');
  await expect(block).toHaveCount(1);
  await block.locator('.cf-title').click();
  await app.page.keyboard.press('b');
  await expect(app.page.locator('.cf-progress')).toHaveText('1/1 resolved');
  await app.page.keyboard.press('Meta+s');
  await app.toast('Resolve conflicts in conflict.txt');
  await expect(app.page.locator('.banner')).toContainText('ready to continue');
  expect(sandbox.git(repo, 'show', ':conflict.txt')).toBe('main\nfeature');

  await app.undo('Resolve conflicts in conflict.txt');
  await expect(app.page.locator('.banner')).toContainText('1 conflicted file');
  expect(sandbox.read(repo, 'conflict.txt')).toContain('<<<<<<<');
});

test('merge conflict → abort restores the branch', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('merge-abort');
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  const banner = await startConflict(app, 'merge');
  await banner.locator('button', { hasText: 'Abort' }).click();
  await app.toast('Abort merge');
  await expect(app.page.locator('.banner')).toHaveCount(0);
  expect(sandbox.sha(repo)).toBe(before);
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
  expect(sandbox.read(repo, 'conflict.txt')).toBe('main\n');
});

test('rebase conflict → theirs → continue, then undo', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('rebase-theirs');
  const before = sandbox.sha(repo);
  const feature = sandbox.sha(repo, 'feature');
  const app = await launch(repo);
  await startConflict(app, 'rebase');
  // During a rebase "theirs" is the commit being replayed: main's change.
  await resolve(app, 'theirs');
  await app.page.locator('.banner .btn.primary', { hasText: 'Continue' }).click();
  await app.toast('Continue rebase');
  await expect(app.page.locator('.banner')).toHaveCount(0);

  expect(sandbox.log(repo)).toEqual(['main change', 'feature change', 'base']);
  expect(sandbox.sha(repo, 'HEAD~1')).toBe(feature);
  expect(sandbox.read(repo, 'conflict.txt')).toBe('main\n');
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');

  await app.undo();
  expect(sandbox.sha(repo, 'main')).toBe(before);
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
});

// The start, resolve and continue steps of a conflicted rebase undo as one step.
test('undo after a conflicted rebase puts you back on the branch', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('rebase-undo-head');
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  await startConflict(app, 'rebase');
  await resolve(app, 'theirs');
  await app.page.locator('.banner .btn.primary', { hasText: 'Continue' }).click();
  await app.toast('Continue rebase');
  await app.undo();
  expect(sandbox.git(repo, 'status', '--porcelain', '--branch')).toBe('## main');
  expect(sandbox.sha(repo)).toBe(before);
});

test('rebase conflict → abort', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('rebase-abort');
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  const banner = await startConflict(app, 'rebase');
  await banner.locator('button', { hasText: 'Abort' }).click();
  await app.toast('Abort rebase');
  await expect(app.page.locator('.banner')).toHaveCount(0);
  expect(sandbox.sha(repo)).toBe(before);
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
});
