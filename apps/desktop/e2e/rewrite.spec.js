'use strict';
// History rewriting from the Map, each followed by undo and redo.

const { test, expect } = require('./fixtures');

const ORIGINAL = ['four', 'three', 'two', 'one'];

async function rewriteAndUndo({ sandbox, launch }, { run, label, expected }) {
  const repo = sandbox.linear('rewrite');
  const before = sandbox.sha(repo);
  const app = await launch(repo);
  await run(app);
  await app.toast(label);
  expect(sandbox.log(repo)).toEqual(expected);
  const after = sandbox.sha(repo);
  await expect(app.row(expected[0])).toBeVisible();

  await app.undo(label);
  expect(sandbox.sha(repo)).toBe(before);
  expect(sandbox.log(repo)).toEqual(ORIGINAL);
  await expect(app.row('four')).toHaveClass(/is-head/);

  await app.redo(label);
  expect(sandbox.sha(repo)).toBe(after);
  expect(sandbox.log(repo)).toEqual(expected);
  expect(sandbox.git(repo, 'status', '--porcelain')).toBe('');
}

test('reword a commit with E', async ({ sandbox, launch }) => {
  await rewriteAndUndo({ sandbox, launch }, {
    label: 'Edit message',
    expected: ['four', 'three', 'two, reworded', 'one'],
    run: async (app) => {
      await app.selectRow('two');
      await app.page.keyboard.press('e');
      const input = app.page.locator('.dialog textarea');
      await expect(input).toHaveValue('two');
      await input.fill('two, reworded');
      await app.page.locator('.dialog button[type=submit]').click();
    },
  });
});

test('squash with parent with S', async ({ sandbox, launch }) => {
  await rewriteAndUndo({ sandbox, launch }, {
    label: 'Squash with parent',
    expected: ['four', 'two', 'one'],
    run: async (app) => { await app.selectRow('three'); await app.page.keyboard.press('s'); },
  });
});

test('fixup with parent from the context menu', async ({ sandbox, launch }) => {
  await rewriteAndUndo({ sandbox, launch }, {
    label: 'Fixup with parent',
    expected: ['four', 'two', 'one'],
    run: async (app) => { await app.contextMenu(app.row('three'), ['Rewrite', 'Fixup with Parent']); },
  });
});

test('delete a commit with Backspace', async ({ sandbox, launch }) => {
  await rewriteAndUndo({ sandbox, launch }, {
    label: 'Delete commit',
    expected: ['four', 'three', 'one'],
    run: async (app) => { await app.selectRow('two'); await app.page.keyboard.press('Backspace'); },
  });
});

test('swap with parent from the context menu', async ({ sandbox, launch }) => {
  await rewriteAndUndo({ sandbox, launch }, {
    label: 'Swap with parent',
    expected: ['four', 'two', 'three', 'one'],
    run: async (app) => { await app.contextMenu(app.row('three'), ['Rewrite', 'Swap with Parent']); },
  });
});

test('squash keeps both changes in the tree', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('squash-tree');
  const app = await launch(repo);
  await app.selectRow('three');
  await app.page.keyboard.press('s');
  await app.toast('Squash with parent');
  expect(sandbox.git(repo, 'show', '--format=', '--name-only', 'HEAD~1').split('\n').sort()).toEqual(['three.txt', 'two.txt']);
  expect(sandbox.git(repo, 'log', '-1', '--format=%B', 'HEAD~1')).toContain('three');
});
