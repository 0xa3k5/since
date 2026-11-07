// Settings and recent repositories on disk, and the theme they choose.
import electron from 'electron';
const { app, nativeTheme } = electron;
import fs from 'node:fs';
import path from 'node:path';
import * as recentStore from './stores/recent-store.ts';
import type { AiSettings } from './ai.ts';
import type { Theme } from '../shared/ipc-contract.ts';

/** settings.json in userData. */
export interface Settings { theme?: string; gitPath?: string | null; autoUpdate?: boolean; keymap?: unknown; ai?: Partial<AiSettings>; [key: string]: unknown }

export const isMac = process.platform === 'darwin';

// ---------------------------------------------------------------------------
// Recent repositories

export const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
export const readRecent = () => recentStore.readRecent(recentFile());
export function addRecent(repo: { root: string; name: string }): void {
  recentStore.addRecent(recentFile(), repo);
  if (isMac) app.addRecentDocument(repo.root);
}
// macOS keeps its own Open Recent list, which Electron can only clear as a whole; it is left as is.
export const removeRecent = (root: string): boolean => recentStore.removeRecent(recentFile(), root);
export const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// ---------------------------------------------------------------------------
// Theme: System / Light / Dark. nativeTheme.themeSource drives both native UI
// (menus, title bar, dialogs) and prefers-color-scheme in every renderer.

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
export const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
export function readSettings(): Settings {
  try { return (JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Settings | null) || {}; } catch { return {}; }
}
export function writeSettings(patch: Partial<Settings>): void {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}
export const currentTheme = (): Theme => (THEMES.includes(nativeTheme.themeSource) ? nativeTheme.themeSource : 'system');
// Window chrome colours, matching --bg in styles.css.
export const windowColors = () => (nativeTheme.shouldUseDarkColors
  ? { bg: '#080707', symbol: '#a19e9b' }
  : { bg: '#faf7f4', symbol: '#6b5e54' });

