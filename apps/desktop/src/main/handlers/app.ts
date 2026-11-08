// Window and app level IPC: recent repositories, theme, which git to use, updates.
import electron from 'electron';
const { dialog } = electron;
import fs from 'node:fs';
import path from 'node:path';
import * as git from '../git/index.ts';
import * as updater from '../updater.ts';
import * as check from '../ipc.ts';
import { menuChanged } from '../app-events.ts';
import { readRecent, removeRecent, currentTheme, writeSettings, THEMES } from '../settings.ts';
import { sessions } from '../session.ts';
import { handle, okCall } from './handle.ts';
import { windowOf, broadcast, setTheme, cycleTheme } from '../windows.ts';
import type { GitInfo } from '../../shared/git-types.ts';
import type { UpdateState } from '../../shared/ipc-contract.ts';

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
export function useGit(p: unknown): void {
  const ok = typeof p === 'string' && path.isAbsolute(p) && (() => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } })();
  git.setGitPath(ok ? (p as string) : null); // `ok` checked it is an absolute path string
}
handle('app:git-info', okCall(() => git.gitInfo()));
handle('app:git-choose', okCall(async (e) => {
  const opts: Electron.OpenDialogOptions = { properties: ['openFile', 'treatPackageAsDirectory'], defaultPath: '/opt/homebrew/bin', message: 'Choose a git program' };
  const win = windowOf(e);
  const res = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
  if (res.canceled || !res.filePaths[0]) return null;
  chosenGit = await git.gitInfo(res.filePaths[0]);
  return chosenGit;
}));
// Keep using the git just chosen (once the renderer has checked its version), or go back to the
// system git ('system').
let chosenGit: GitInfo | null = null;
handle('app:git-use', okCall(async (_e, which) => {
  const use = check.oneOf('chosen', 'system')(which, 'git');
  if (use === 'chosen' && !chosenGit) throw new Error('No git chosen.');
  const p = use === 'chosen' ? chosenGit?.path ?? null : null;
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
export function setAutoUpdate(on: boolean): UpdateState {
  writeSettings({ autoUpdate: Boolean(on) });
  return updater.refresh();
}

