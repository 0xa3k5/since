// Windows and tabs: each window hosts one tab per repository.
import electron from 'electron';
const { app, BaseWindow, WebContentsView, nativeTheme, screen } = electron;
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as git from './git/index.ts';
import * as tabOrder from './stores/tab-order.ts';
import { menuChanged } from './app-events.ts';
import * as recentStore from './stores/recent-store.ts';
import * as windowState from './stores/window-state.ts';
import * as keymap from '../renderer/palette/keymap.ts';
import { THEMES, currentTheme, writeSettings, windowColors, isMac, windowStateFile, recentFile } from './settings.ts';
import { sessions, notifyWindows, handoffs, notRepoDirs, windowFor } from './session.ts';

import { createRequire } from 'node:module';
import type { ClosedEntry } from './stores/tab-order.ts';
import type { PushArgs, TabInfo, Theme } from '../shared/ipc-contract.ts';
import type { PushChannel } from '../shared/channels.ts';

// The benchmark harness (bench/, development only) drives the first window.
interface Bench { attach(o: { setBounds(b: Electron.Rectangle): void; webContents: Electron.WebContents | undefined }): void }
const bench = process.env.SINCE_BENCH ? (createRequire(import.meta.filename)('../../bench/harness') as (a: Electron.App) => Bench)(app) : null;

export function setTheme(mode: Theme, { announce = false }: { announce?: boolean } = {}): Theme {
  if (!(THEMES as readonly unknown[]).includes(mode)) return currentTheme();
  nativeTheme.themeSource = mode;
  try { writeSettings({ theme: mode }); } catch (e) { console.warn('could not save theme', (e as Error).message); }
  menuChanged();
  const front = activeTab();
  for (const t of tabs.values()) if (!t.isDestroyed()) t.webContents.send('theme', mode, { announce: announce && t === front });
  return mode;
}
export const cycleTheme = (): Theme => setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length] ?? 'system', { announce: true });

nativeTheme.on('updated', () => {
  const c = windowColors();
  for (const { win } of hosts) {
    win.setBackgroundColor(c.bg);
    if (!isMac) win.setTitleBarOverlay?.({ color: c.bg, symbolColor: c.symbol });
  }
  for (const t of tabs.values()) t.view.setBackgroundColor(c.bg);
});

// ---------------------------------------------------------------------------
// Windows, tabs & menu

// A window holds one tab per repository (AK-634). Each tab is its own page (a WebContentsView), so it keeps its
// own session, watcher and undo, all torn down when the tab closes; only the tab showing is visible. Every tab
// draws the window's tab strip from the list `changed()` sends it.
const WEB_PREFERENCES: Electron.WebPreferences = {
  preload: path.join(import.meta.dirname, '..', 'preload', 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  spellcheck: false,
  devTools: !app.isPackaged || Boolean(process.env.SINCE_DEVTOOLS),
};
// The traffic lights: beside the sidebar, or in the 36px tab strip once there are two tabs.
const LIGHTS = { x: 16, y: 16 }, TABBED_LIGHTS = { x: 16, y: 11 };
export const TAB_KEYS = ['tab.n1', 'tab.n2', 'tab.n3', 'tab.n4', 'tab.n5', 'tab.n6', 'tab.n7', 'tab.n8'];
export const hosts = new Set<TabHost>();
const tabs = new Map<number, Tab>(); // webContents.id -> Tab
let windowFocus = () => {};
export const setWindowFocus = (fn: () => void): void => { windowFocus = fn; };

export const tabOf = (e: { sender: { id: number } }): Tab | undefined => tabs.get(e.sender.id);
export const windowOf = (e: { sender: { id: number } }): Electron.BaseWindow | undefined => tabOf(e)?.host.win;
export const focusedHost = () => { const w = BaseWindow.getFocusedWindow(); return [...hosts].find((h) => h.win === w); };
export const activeTab = () => focusedHost()?.active;
export function broadcast<C extends PushChannel>(channel: C, ...args: PushArgs[C]): void { for (const t of tabs.values()) if (!t.isDestroyed()) t.webContents.send(channel, ...args); }

// What RepoSession, windowFor and the handoffs call a window: a tab, focused, titled and closed like one.
class Tab extends EventEmitter {
  host: TabHost;
  view: Electron.WebContentsView;
  webContents: Electron.WebContents;
  id: number;
  title: string;
  root: string;
  opening = false;
  // `dir`: the folder it opens (none: the welcome screen).
  constructor(host: TabHost, dir?: string | null) {
    super();
    this.host = host;
    this.view = new WebContentsView({ webPreferences: WEB_PREFERENCES });
    this.view.setBackgroundColor(windowColors().bg);
    this.webContents = this.view.webContents;
    this.id = this.webContents.id;
    this.title = 'Since';
    this.root = '';
    tabs.set(this.id, this);
    // Taken before the page sees them, so they work wherever the focus is; the Window menu only shows them.
    this.webContents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      const id = keymap.match('menu', { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }, null, isMac);
      if (id === 'tab.next' || id === 'tab.prev') { ev.preventDefault(); this.host.step(id === 'tab.next' ? 1 : -1); }
    });
    this.webContents.once('destroyed', () => this.gone());
    this.load(dir);
  }

  load(dir?: string | null): void {
    this.opening = Boolean(dir);
    // Development only: SINCE_START_VIEW=map opens repositories on the Map instead of Review (e2e).
    const view: Record<string, string> = !app.isPackaged && process.env.SINCE_START_VIEW === 'map' ? { view: 'map' } : {};
    const query: Record<string, string> = { ...(dir ? { repo: dir } : {}), ...view };
    this.webContents.loadFile(path.join(import.meta.dirname, '..', 'renderer', 'index.html'), Object.keys(query).length ? { query } : undefined);
  }

  isDestroyed() { return this.webContents.isDestroyed(); }
  focus() { this.host.select(this); this.host.win.show(); this.host.win.focus(); }
  setTitle(title: string): void { this.title = title; this.host.changed(); }
  setRepresentedFilename(root: string): void { this.root = root; this.host.changed(); }
  destroy() { this.host.remove(this); }

  // The last tab's ⌘W: the repository closes and the welcome screen shows (it stays on the recent list).
  reset() {
    sessions.get(this.id)?.dispose();
    sessions.delete(this.id);
    this.title = 'Since';
    this.setRepresentedFilename('');
    this.load();
    notifyWindows();
  }

  gone() {
    sessions.get(this.id)?.dispose();
    sessions.delete(this.id);
    handoffs.delete(this.id);
    notRepoDirs.delete(this.id);
    tabs.delete(this.id);
    this.emit('closed');
    menuChanged();
    notifyWindows();
  }
}

class TabHost {
  win: Electron.BaseWindow;
  maximized: boolean;
  tabs: Tab[];
  active: Tab | null;
  // `restore`: the launch window, which takes the size and place of the window closed last (AK-633).
  constructor(restore = false) {
    const colors = windowColors();
    const last = restore ? windowState.fitState(windowState.readState(windowStateFile()), screen.getAllDisplays().map((d) => d.workArea)) : null;
    const win = this.win = new BaseWindow({
      width: 1360,
      height: 860,
      ...last?.bounds,
      minWidth: 900,
      minHeight: 560,
      show: false,
      backgroundColor: colors.bg,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: LIGHTS,
      titleBarOverlay: isMac ? undefined : { color: colors.bg, symbolColor: colors.symbol, height: 40 },
    });
    this.maximized = Boolean(last?.maximized);
    this.tabs = [];
    this.active = null;
    hosts.add(this);
    win.on('resize', () => this.layout());
    win.on('focus', () => windowFocus());
    win.on('close', () => {
      const roots = this.roots();
      windowState.saveState(windowStateFile(), { bounds: win.getNormalBounds(), maximized: win.isMaximized(), ...roots });
      rememberClosed(roots.tabs, { active: roots.active, window: true });
    });
    // Back and forward from the mouse's side buttons (Windows, Linux) and the trackpad swipe (macOS, when set to swipe between pages).
    const toActive = (cmd: string) => this.active?.webContents.send('command', cmd);
    win.on('app-command', (e, cmd) => { if (cmd === 'browser-backward') toActive('back'); else if (cmd === 'browser-forward') toActive('forward'); });
    win.on('swipe', (e, dir) => { if (dir === 'left' || dir === 'right') toActive(dir === 'left' ? 'back' : 'forward'); });
    // Closing a window doesn't close its tabs' pages: close them, which ends their sessions.
    win.on('closed', () => {
      hosts.delete(this);
      for (const t of this.tabs) if (!t.isDestroyed()) t.webContents.close();
      this.tabs = [];
      menuChanged();
    });
  }

  // What launch reopens: the repositories' roots, in tab order, and the one showing.
  roots(): { tabs: string[]; active: string | null } {
    const root = (t: Tab) => sessions.get(t.id)?.repo.root;
    return { tabs: this.tabs.map(root).filter((r): r is string => !!r), active: (this.active && root(this.active)) || null };
  }

  list(): TabInfo[] { return this.tabs.map((t) => ({ id: t.id, title: t.title, active: t === this.active })); }

  // A new last tab, shown unless `show` is false.
  add(dir?: string | null, { show = true }: { show?: boolean } = {}): Tab {
    const tab = new Tab(this, dir);
    this.tabs.push(tab);
    this.win.contentView.addChildView(tab.view);
    this.layout();
    // A new window shows once its first page has loaded.
    if (!this.win.isVisible()) {
      tab.webContents.once('did-finish-load', () => {
        if (this.win.isDestroyed() || this.win.isVisible()) return;
        if (this.maximized) this.win.maximize();
        this.win.show();
      });
    }
    if (show || !this.active) this.select(tab);
    else { tab.view.setVisible(false); this.changed(); }
    return tab;
  }

  select(tab: Tab | undefined): void {
    if (!tab || !this.tabs.includes(tab)) return;
    this.active = tab;
    for (const t of this.tabs) t.view.setVisible(t === tab);
    tab.webContents.focus();
    this.changed();
  }

  step(by: number): void { const i = tabOrder.step(this.tabs.length, this.active ? this.tabs.indexOf(this.active) : -1, by); if (i >= 0) this.select(this.tabs[i]); }
  pick(n: number): void { const i = tabOrder.byNumber(this.tabs.length, n); if (i >= 0) this.select(this.tabs[i]); }

  // Closes a tab; the window closes with its last one.
  remove(tab: Tab): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (this.tabs.length === 1) { this.win.close(); return; }
    const next = tabOrder.afterClose(this.tabs.length, i);
    this.tabs.splice(i, 1);
    this.win.contentView.removeChildView(tab.view);
    tab.webContents.close();
    if (this.active === tab) this.select(this.tabs[next]); else this.changed();
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [width = 0, height = 0] = this.win.getContentSize();
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: 0, width, height });
  }

  // The window's title, traffic lights, menu and every tab's strip follow the tabs and the one showing.
  changed() {
    if (this.win.isDestroyed()) return;
    const a = this.active;
    this.win.setTitle(a?.title || 'Since');
    if (isMac) {
      this.win.setRepresentedFilename(a?.root || '');
      this.win.setWindowButtonPosition(this.tabs.length > 1 ? TABBED_LIGHTS : LIGHTS);
    }
    const list = this.list();
    for (const t of this.tabs) if (!t.isDestroyed()) t.webContents.send('tabs', list, hasClosedTabs());
    menuChanged();
  }
}

// A new window with a tab for each folder in `dirs` (none: the welcome screen), showing the tab at `active`.
export function createWindow(dirs?: string | readonly (string | undefined)[] | null, { restore = false, active = 0 }: { restore?: boolean; active?: number } = {}): Tab | null {
  const host = new TabHost(restore);
  const list = ([] as (string | undefined)[]).concat(dirs ?? []);
  if (!list.length) list.push(undefined);
  list.forEach((d, i) => host.add(d, { show: i === active }));
  bench?.attach({ setBounds: (b) => host.win.setBounds(b), webContents: host.tabs[0]?.webContents });
  return host.active;
}

export const newTab = () => { const h = focusedHost(); if (h) h.add(); else createWindow(); };
// ⌘W: closes the tab. The last tab closes its repository instead (the welcome screen shows), and on the
// welcome screen the window.
export function closeTab(tab = activeTab()) {
  if (!tab) return BaseWindow.getFocusedWindow()?.close();
  const root = sessions.get(tab.id)?.repo.root;
  if (root) rememberClosed([root]);
  if (tab.host.tabs.length > 1) return tab.destroy();
  if (sessions.has(tab.id)) return tab.reset();
  return tab.host.win.close();
}

// Tabs and windows closed, newest last, for Reopen Closed Tab (⇧⌘T): their repositories' roots.
let closedTabs: ClosedEntry[] = [];
export const hasClosedTabs = (): boolean => closedTabs.length > 0;
function rememberClosed(roots: string[], { active = null, window = false }: { active?: string | null; window?: boolean } = {}): void {
  closedTabs = tabOrder.remember(closedTabs, { roots, active, window });
  for (const h of hosts) h.changed();
}
// ⇧⌘T: the tab closed last comes back in the front window (filling a welcome-screen tab), or the window closed
// last comes back with its tabs. Folders deleted since or already open in a tab are skipped.
export function reopenClosed() {
  const { entry, rest } = tabOrder.takeClosed(closedTabs, (d) => fs.existsSync(d) && !windowFor(d));
  closedTabs = rest;
  const host = entry && !entry.window && (focusedHost() || [...hosts].at(-1));
  if (entry && !host) createWindow(entry.roots, { active: tabOrder.reopenActive(entry.roots, entry.active) });
  else if (entry && host) {
    const blank = host.active && !sessions.has(host.active.id) && !host.active.opening ? host.active : null;
    if (blank) blank.load(entry.roots[0]); else host.add(entry.roots[0]);
    host.win.focus();
  }
  for (const h of hosts) h.changed();
}

// A folder from Finder, the Dock or `open`: the tab already showing it, else a new tab in the front window.
export function openFolder(dir: string) {
  const shown = windowFor(dir);
  if (shown) return shown.focus();
  const host = focusedHost() || [...hosts].at(-1);
  if (!host) return createWindow(dir);
  host.add(dir);
  return host.win.focus();
}

// With no folder to open (launch, or the Dock icon with no windows left), reopen the tabs of the window closed
// last that are still recent repositories, else show the welcome screen (AK-633). Calls made while one is under
// way share it; a folder dropped on the Dock icon may have opened a window meanwhile.
let openingLast: Promise<void> | null = null;
export function openLastWindow(): Promise<void> {
  openingLast ||= (async () => {
    const state = windowState.readState(windowStateFile());
    // Saved before tabs: `repo`, one root or null.
    const wanted = !state ? undefined : Array.isArray(state.tabs) ? state.tabs : state.repo ? [state.repo] : [];
    const roots = await recentStore.lastTabs(recentFile(), git.openRepo, wanted);
    if (!hosts.size) createWindow(roots, { restore: true, active: tabOrder.reopenActive(roots, state?.active ?? state?.repo) });
  })().finally(() => { openingLast = null; });
  return openingLast;
}

