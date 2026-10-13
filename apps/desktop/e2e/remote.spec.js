'use strict';
// Clone, fetch, pull and push, all against local bare repositories.

const { test, expect } = require('./fixtures');

test('clone from a local bare repository', async ({ sandbox, launch }) => {
  const bare = sandbox.remote();
  const dest = sandbox.path('cloned');
  const app = await launch();
  await expect(app.page.locator('.welcome')).toBeVisible();
  await app.stubDialog('showSaveDialog', { canceled: false, filePath: dest });
  await app.page.locator('.welcome-actions button', { hasText: 'Clone' }).click();
  await app.dialog({ fields: { 'Repository URL': bare }, submit: 'Choose location' });
  await expect(app.page.locator('.sidebar .repo-name')).toHaveText('cloned');
  await expect(app.row('second')).toHaveClass(/is-head/);
  await expect(app.row('first')).toBeVisible();
  expect(sandbox.git(dest, 'remote', 'get-url', 'origin')).toBe(bare);
  expect(sandbox.sha(dest)).toBe(sandbox.sha(bare, 'main'));
});

test('fetch and pull a new remote commit, then undo the pull', async ({ sandbox, launch }) => {
  const bare = sandbox.remote();
  const work = sandbox.clone(bare, 'work');
  const other = sandbox.clone(bare, 'other');
  const third = sandbox.commit(other, 'third');
  sandbox.git(other, 'push', '-q', 'origin', 'main');
  const before = sandbox.sha(work);

  const app = await launch(work);
  await app.page.locator('.sb-foot button', { hasText: 'Fetch' }).click();
  await app.toast('Fetched all remotes');
  expect(sandbox.sha(work, 'origin/main')).toBe(third);
  await expect(app.row('third').locator('.pill.remote', { hasText: 'origin/main' })).toBeVisible();
  expect(sandbox.sha(work)).toBe(before);

  await app.page.locator('.sb-foot button', { hasText: 'Pull' }).click();
  await app.toast('Pulled');
  expect(sandbox.sha(work)).toBe(third);
  await expect(app.row('third')).toHaveClass(/is-head/);

  await app.undo('Pull');
  expect(sandbox.sha(work)).toBe(before);
  await expect(app.row('second')).toHaveClass(/is-head/);
  await app.redo('Pull');
  expect(sandbox.sha(work)).toBe(third);
});

test('commit in the Commit view and push it', async ({ sandbox, launch }) => {
  const bare = sandbox.remote();
  const work = sandbox.clone(bare, 'work');
  sandbox.write(work, 'notes.txt', 'pushed from the app\n');
  const app = await launch(work);

  await app.view('commit');
  await app.page.locator('.cv-section', { hasText: 'Unstaged' }).locator('button', { hasText: 'Stage all' }).click();
  await expect(app.page.locator('.cv-section', { hasText: 'Staged' }).locator('.file-row', { hasText: 'notes.txt' })).toBeVisible();
  await app.page.locator('.composer-input').fill('add notes');
  await app.page.locator('.composer button', { hasText: 'Commit' }).click();
  await app.toast('Committed');
  expect(sandbox.log(work)[0]).toBe('add notes');

  await app.page.locator('.sb-foot button', { hasText: 'Push' }).click();
  await app.toast('Pushed main');
  expect(sandbox.sha(bare, 'main')).toBe(sandbox.sha(work));
});

test('push a new branch sets its upstream', async ({ sandbox, launch }) => {
  const bare = sandbox.remote();
  const work = sandbox.clone(bare, 'work');
  const app = await launch(work);
  await app.selectRow('second');
  await app.page.keyboard.press('b');
  await app.dialog({ fields: { Name: 'topic' }, submit: 'Create branch' });
  await app.toast('Create branch topic');
  expect(sandbox.git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('topic');

  await app.page.locator('.sb-foot button', { hasText: 'Push' }).click();
  await app.toast('Pushed topic');
  expect(sandbox.sha(bare, 'topic')).toBe(sandbox.sha(work));
  expect(sandbox.git(work, 'rev-parse', '--abbrev-ref', 'topic@{upstream}')).toBe('origin/topic');
});
