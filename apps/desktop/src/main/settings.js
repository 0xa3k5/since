'use strict';
// Settings and recent repositories on disk, and the theme they choose.
const { app, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const recentStore = require('./stores/recent-store.ts');

const isMac = process.platform === 'darwin';

// ---------------------------------------------------------------------------
// Recent repositories

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
const readRecent = () => recentStore.readRecent(recentFile());
function addRecent(repo) {
  recentStore.addRecent(recentFile(), repo);
  if (isMac) app.addRecentDocument(repo.root);
}
// macOS keeps its own Open Recent list, which Electron can only clear as a whole; it is left as is.
const removeRecent = (root) => recentStore.removeRecent(recentFile(), root);
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// ---------------------------------------------------------------------------
// Theme: System / Light / Dark. nativeTheme.themeSource drives both native UI
// (menus, title bar, dialogs) and prefers-color-scheme in every renderer.

const THEMES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}
const currentTheme = () => (THEMES.includes(nativeTheme.themeSource) ? nativeTheme.themeSource : 'system');
// Window chrome colours, matching --bg in styles.css.
const windowColors = () => (nativeTheme.shouldUseDarkColors
  ? { bg: '#080707', symbol: '#a19e9b' }
  : { bg: '#faf7f4', symbol: '#6b5e54' });

module.exports = { THEMES, currentTheme, writeSettings, windowColors, isMac, readRecent, removeRecent, readSettings, addRecent, windowStateFile, recentFile, THEME_LABELS };
