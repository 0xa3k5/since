'use strict';
// Merge and rebase that stop on a conflict, resolved with ours / theirs / a
// manual edit, then continued or aborted, and undone; and a checkout that waits on a stopped merge.

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./fixtures');

async function startConflict(app, op) {
  // Local branches have no sidebar row since AK-491, so start from feature's tip in the Map.
  const item = op === 'merge' ? 'Merge into Current' : 'Rebase Current onto This';
  await app.contextMenu(app.row('feature change'), ['Into main', item]);
  await app.toast(op === 'merge' ? 'Merge feature stopped on 1 conflict' : /^Rebase onto [0-9a-f]{7} stopped on 1 conflict/, 'info');
  const banner = app.page.locator('.banner');
  await expect(banner).toContainText(op === 'merge' ? MERGE_STOPPED : 'Rebasing main onto feature is stopped at 1 of 1: main change.');
  await expect(banner.locator('.btn.primary', { hasText: 'Continue' })).toBeDisabled();
  return banner;
}

const MERGE_STOPPED = 'Merging feature into main is stopped on 1 conflict.';
const continueButton = (app) => app.page.locator('.banner .btn.primary', { hasText: 'Continue' });

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
  await expect(continueButton(app)).toBeEnabled();
}

test('merge conflict → ours → continue, then undo and redo', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('merge-ours');
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  await startConflict(app, 'merge');
  await resolve(app, 'ours');
  await continueButton(app).click();
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
  await continueButton(app).click();
  await app.toast('Continue merge');
  expect(sandbox.git(repo, 'show', 'HEAD:conflict.txt')).toBe('main and feature');
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
});

test('merge conflict → built-in editor → both (keyboard) → mark resolved; undo waits on the merge', async ({ sandbox, launch }) => {
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
  await expect(app.page.locator('.banner')).toContainText('Merging feature into main is stopped.');
  await expect(continueButton(app)).toBeEnabled();
  expect(sandbox.git(repo, 'show', ':conflict.txt')).toBe('main\nfeature');

  // ⌘Z can't step under the stopped merge (AK-585): the toast says so and nothing changes.
  await app.undoButton().click();
  const t = await app.toast("Can't undo while this merge is stopped", 'info');
  await expect(t.locator('.toast-detail')).toHaveText('Merging feature into main is stopped.');
  await expect(t.locator('button', { hasText: 'Continue merge' })).toBeVisible();
  await expect(t.locator('button', { hasText: 'Abort and undo…' })).toBeVisible();
  expect(sandbox.git(repo, 'show', ':conflict.txt')).toBe('main\nfeature');
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

// A checkout can't run under a stopped merge (AK-577): its toast offers the conflicts, or aborting the
// merge (confirmed, it can't be undone) and then checking out.
test('checkout while a merge is stopped → open conflicts, or abort merge and checkout', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('merge-checkout');
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  await startConflict(app, 'merge');
  const waiting = async () => {
    await app.page.locator('button.btn.subtle', { hasText: /^Checkout$/ }).click();
    const t = await app.toast('Checkout feature is waiting', 'warn');
    await expect(t.locator('.toast-detail')).toHaveText(MERGE_STOPPED);
    return t;
  };

  await (await waiting()).locator('button', { hasText: 'Open conflicts' }).click();
  await expect(app.page.locator('.content')).toHaveAttribute('data-view', 'commit');
  await expect(app.page.locator('.cv-section', { hasText: 'Conflicts' }).locator('.file-row', { hasText: 'conflict.txt' })).toBeVisible();
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');

  await app.view('map');
  await app.selectRow('feature change');
  await (await waiting()).locator('button', { hasText: 'Abort merge and checkout…' }).click();
  await app.dialog({ submit: 'Abort merge and checkout' });
  await app.toast('Switched to feature');
  await expect(app.page.locator('.banner')).toHaveCount(0);
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
  expect(sandbox.sha(repo, 'main')).toBe(before);

  await app.undo('Checkout feature');
  expect(sandbox.git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(sandbox.sha(repo)).toBe(before);
});

test('rebase conflict → theirs → continue, then undo', async ({ sandbox, launch }) => {
  const repo = sandbox.conflicted('rebase-theirs');
  const before = sandbox.sha(repo);
  const feature = sandbox.sha(repo, 'feature');
  const app = await launch(repo);
  await startConflict(app, 'rebase');
  // During a rebase "theirs" is the commit being replayed: main's change.
  await resolve(app, 'theirs');
  await continueButton(app).click();
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
  await continueButton(app).click();
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
