import * as keymap from '../palette/keymap.ts';
import { api } from '../lib/app-helpers.ts';
import type { Theme } from '../../shared/ipc-contract.ts';

// Theme (System / Light / Dark). The main process owns the setting and applies it via
// nativeTheme, which flips prefers-color-scheme here; we only repaint the canvas graph.

const THEMES: { id: Theme; label: string; icon: string }[] = [
  { id: 'system', label: 'System', icon: 'theme' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];
const THEME_KBD = keymap.keys('view.cycleTheme');
const themeLabel = (id: string): string => THEMES.find((t) => t.id === id)?.label || id;
const setTheme = (mode: Theme) => api.app('set-theme', mode);
const cycleTheme = () => api.app('cycle-theme');

export { THEMES, setTheme, cycleTheme, THEME_KBD, themeLabel };
