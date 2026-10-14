'use strict';
// Custom key bindings: rebind a commit action and a menu command in the Keyboard Shortcuts window, check the new
// keys work (and the old ones don't), the menu and ⌘K show them, a clash offers Replace, and Reset All restores
// the defaults.

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./fixtures');

const accelerator = (app, label) => app.app.evaluate(({ Menu }, l) => {
  const find = (items) => { for (const i of items) { if (i.label === l) return i; const s = i.submenu && find(i.submenu.items); if (s) return s; } return null; };
  return find(Menu.getApplicationMenu().items)?.accelerator ?? null;
}, label);

async function rebind(app, label, keys) {
  const row = app.page.locator('.shortcuts-row', { hasText: label }).first();
  await row.click();
  await app.page.locator('.shortcuts-edit .shortcuts-binding').first().click();
  await expect(app.page.locator('.shortcuts-binding.recording')).toBeFocused();
  await app.page.keyboard.press(keys);
}

test('rebinding a shortcut moves it everywhere, and Reset All restores the defaults', async ({ sandbox, launch }) => {
  const repo = sandbox.linear('keys');
  const app = await launch(repo);
  const { page } = app;

  await app.palette('Keyboard shortcuts');
  await rebind(app, 'Diff with HEAD', 'x');
  await expect(page.locator('.shortcuts-row', { hasText: 'Diff with HEAD' }).locator('.shortcuts-custom')).toBeVisible();

  // A clash: Checkout (detached) → X offers Replace, which takes X from Diff with HEAD.
  await rebind(app, 'Checkout (detached)', 'x');
  await expect(page.locator('.shortcuts-note', { hasText: 'is used by “Diff with HEAD”' })).toBeVisible();
  await page.locator('.shortcuts-note button', { hasText: 'Cancel' }).click();
  await expect(page.locator('.shortcuts-note')).toHaveCount(0);

  // A menu command: the menu accelerator and ⌘K follow.
  await rebind(app, 'Fetch All', 'Meta+Alt+Shift+F');
  await expect.poll(() => accelerator(app, 'Fetch All')).toBe('CmdOrCtrl+Alt+Shift+F');
  await page.keyboard.press('Escape'); // close the editor
  await page.keyboard.press('Escape'); // close the window
  await expect(page.locator('.shortcuts-overlay')).toHaveCount(0);

  const settings = JSON.parse(fs.readFileSync(path.join(sandbox.path('userdata-0'), 'settings.json'), 'utf8'));
  expect(settings.keymap).toEqual({ 'commit.diffHead': ['x'], 'repo.fetch': ['Mod+Alt+Shift+KeyF'] });

  await page.locator('.sb-top button[title^="Command menu"]').click();
  await page.locator('.palette-input').fill('Fetch all remotes');
  await expect(page.locator('.palette-item.active .kbd-group')).toHaveText('⌘⌥⇧F');
  await page.keyboard.press('Escape');

  // The old key does nothing on a commit; the new one opens the diff.
  await app.selectRow('one');
  await page.keyboard.press('d');
  await expect(page.locator('.diff-head')).toHaveCount(0);
  await page.keyboard.press('x');
  await expect(page.locator('.diff-head')).toBeVisible();
  await page.keyboard.press('Escape');

  await app.palette('Reset all shortcuts to defaults');
  await page.locator('.overlay .dialog-foot button[type=submit]').click();
  await expect.poll(() => accelerator(app, 'Fetch All')).toBe('CmdOrCtrl+Shift+F');
  await app.selectRow('one');
  await page.keyboard.press('d');
  await expect(page.locator('.diff-head')).toBeVisible();
});
