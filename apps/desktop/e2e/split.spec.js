'use strict';
// Split a commit into two from the Map, then undo and redo.

const { test, expect } = require('./fixtures');

const BASE = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n';

function splitRepo(sandbox) {
  const repo = sandbox.init('split');
  sandbox.commit(repo, 'base', { 'notes.txt': BASE });
  sandbox.commit(repo, 'two changes', { 'notes.txt': BASE.replace('alpha', 'ALPHA').replace('kappa', 'KAPPA'), 'extra.txt': 'extra\n' });
  sandbox.commit(repo, 'later', { 'later.txt': 'later\n' });
  return repo;
}

// Lines of the open diff whose text is exactly `text`.
const line = (app, text) => app.page.locator('.quick-main .dl.pick', { has: app.page.locator('.code', { hasText: new RegExp(`^${text}$`) }) });

async function split(app, { open }) {
  await open();
  await expect(app.page.locator('.crumb')).toHaveText('Split Commit');
  await expect(app.page.locator('.split-files .file-row')).toHaveCount(2);
  await app.page.locator('.split-files .file-row', { hasText: 'notes.txt' }).click();
  await line(app, 'alpha').click();
  await line(app, 'ALPHA').click();
  await expect(app.page.locator('.split-files .file-row', { hasText: 'notes.txt' }).locator('.split-count')).toHaveText('2/4');
  const [first, second] = await app.page.locator('.split-msg').all();
  await expect(first).toHaveValue('two changes');
  await first.fill('uppercase alpha');
  await second.fill('uppercase kappa and add extra');
  await app.page.locator('.split-composer button.primary').click();
}

for (const [name, open] of [
  ['with ⇧S', async (app) => { await app.selectRow('two changes'); await app.page.keyboard.press('Shift+S'); }],
  ['from the context menu', async (app) => { await app.contextMenu(app.row('two changes'), 'Split Commit…'); }],
  ['from the command menu', async (app) => { await app.selectRow('two changes'); await app.palette('Split selected commit…'); }],
]) {
  test(`split a commit ${name}, then undo and redo`, async ({ sandbox, launch }) => {
    const repo = splitRepo(sandbox);
    const before = sandbox.sha(repo);
    const tree = sandbox.sha(repo, 'HEAD^{tree}');
    const app = await launch(repo);
    await split(app, { open: () => open(app) });
    await app.toast('Split commit');

    expect(sandbox.log(repo)).toEqual(['later', 'uppercase kappa and add extra', 'uppercase alpha', 'base']);
    expect(sandbox.git(repo, 'show', 'HEAD~2:notes.txt')).toBe(BASE.replace('alpha', 'ALPHA').trim());
    expect(sandbox.sha(repo, 'HEAD^{tree}')).toBe(tree);
    await expect(app.page.locator('.content')).toHaveAttribute('data-view', 'map');
    await expect(app.row('uppercase alpha')).toBeVisible();
    const after = sandbox.sha(repo);

    await app.undo('Split commit');
    expect(sandbox.sha(repo)).toBe(before);
    await expect(app.row('two changes')).toBeVisible();
    await app.redo('Split commit');
    expect(sandbox.sha(repo)).toBe(after);
    expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
  });
}

test('split needs changes on both sides and both messages', async ({ sandbox, launch }) => {
  const repo = splitRepo(sandbox);
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  await app.selectRow('two changes');
  await app.page.keyboard.press('Shift+S');
  const btn = app.page.locator('.split-composer button.primary');
  const summary = app.page.locator('.split-summary');
  const box = (f) => app.page.locator('.split-files .file-row', { hasText: f }).locator('input');
  await expect(summary).toHaveText('Select the changes for the first commit.');
  await expect(btn).toBeDisabled();
  await box('notes.txt').check();
  await box('extra.txt').check();
  await expect(summary).toHaveText('Leave at least one change for the second commit.');
  await expect(btn).toBeDisabled();
  await box('extra.txt').uncheck();
  await expect(summary).toHaveText('First commit: changes in 1 of 2 files. The rest go into the second.');
  await expect(btn).toBeDisabled(); // no second message yet
  await app.page.locator('.split-msg').nth(1).fill('second');
  await expect(btn).toBeEnabled();

  await app.page.locator('.split-msg').nth(1).press('Escape');
  await expect(app.page.locator('.crumb')).toHaveText('Split Commit');
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('.crumb')).toHaveText('Map');
  expect(sandbox.sha(repo)).toBe(before);
});

test('merge commits, and commits below a merge, cannot be split', async ({ sandbox, launch }) => {
  const repo = splitRepo(sandbox);
  sandbox.git(repo, 'checkout', '-q', '-b', 'side', 'HEAD~1');
  sandbox.commit(repo, 'side');
  sandbox.git(repo, 'checkout', '-q', 'main');
  sandbox.git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'side');
  const before = sandbox.sha(repo);
  const app = await launch(repo);

  await app.row("Merge branch 'side'").click({ button: 'right' });
  await expect(app.page.locator('.menu .menu-item', { hasText: 'Split Commit…' })).toBeDisabled();
  await app.page.keyboard.press('Escape');

  // A commit below a merge on HEAD: the dead-ends guard (commit-guards.js) blocks the shortcut
  // with a plain toast before the split sheet, so git's "merge commits between" check never runs.
  await app.selectRow('two changes');
  await app.page.keyboard.press('Shift+S');
  await expect(app.page.locator('.toast', { hasText: 'A merge commit is in the way' })).toBeVisible();
  await expect(app.page.locator('.crumb')).toHaveText('Map');
  expect(sandbox.sha(repo)).toBe(before);
});
