'use strict';
// Window and app level IPC: recent repositories, theme, which git to use, updates.
const { dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const git = require('../git/index.ts');
const updater = require('../updater');
const check = require('../ipc.ts');
const { menuChanged } = require('../app-events.ts');
const { readRecent, removeRecent, currentTheme, writeSettings, THEMES } = require('../settings');
const { sessions } = require('../session.ts');
const { handle, okCall } = require('./handle');
const { windowOf, broadcast, setTheme, cycleTheme } = require('../windows');

// ---------------------------------------------------------------------------
// Window / app level IPC

handle('app:recent', () => readRecent());
handle('app:remove-recent', (e, root) => {
  removeRecent(check.absDir(root, 'repository folder'));
  menuChanged();
});
handle('app:repo', (e) => sessions.get(e.sender.id)?.repo || null);
handle('app:theme', () => currentTheme());

// The git in use, and Use another git… (AK-586): pick a git program, which must run and say its
// version, and keep using it in every window. The path comes from the open dialog, not the renderer.
function useGit(p) {
  const ok = typeof p === 'string' && path.isAbsolute(p) && (() => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } })();
  git.setGitPath(ok ? p : null);
}
handle('app:git-info', okCall(() => git.gitInfo()));
handle('app:git-choose', okCall(async (e) => {
  const res = await dialog.showOpenDialog(windowOf(e), { properties: ['openFile', 'treatPackageAsDirectory'], defaultPath: '/opt/homebrew/bin', message: 'Choose a git program' });
  if (res.canceled || !res.filePaths[0]) return null;
  chosenGit = await git.gitInfo(res.filePaths[0]);
  return chosenGit;
}));
// Keep using the git just chosen (once the renderer has checked its version), or go back to the
// system git ('system').
let chosenGit = null;
handle('app:git-use', okCall(async (_e, which) => {
  check.oneOf('chosen', 'system')(which, 'git');
  if (which === 'chosen' && !chosenGit) throw new Error('No git chosen.');
  const p = which === 'chosen' ? chosenGit.path : null;
  git.setGitPath(p);
  writeSettings({ gitPath: p });
  chosenGit = null;
  const info = await git.gitInfo();
  broadcast('git', info);
  return info;
}));
handle('app:set-theme', (_e, mode) => setTheme(check.oneOf(...THEMES)(mode, 'theme')));
handle('app:cycle-theme', () => cycleTheme());
handle('app:update-state', () => ({ ...updater.getState(), page: updater.page() }));
handle('app:check-updates', () => updater.check({ manual: true }));
handle('app:install-update', () => updater.install());
handle('app:set-auto-update', (_e, on) => setAutoUpdate(check.bool(on, 'auto-update')));

// "Automatically check for updates" (on unless turned off). Manual checks always work.
function setAutoUpdate(on) {
  writeSettings({ autoUpdate: Boolean(on) });
  return updater.refresh();
}

module.exports = { setAutoUpdate, useGit };
