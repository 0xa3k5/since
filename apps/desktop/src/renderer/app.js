import { $, toast } from './lib/ui.ts';
import { setSwatches } from './commit/diff.js';
import * as keymap from './palette/keymap.ts';
import { sidebarMode, isNarrow } from './shell/sidebar.js';
import { loadSizes } from './shell/pane-size.js';
import { openPrefsCommand } from './settings/prefs.js';
import { state, loadPref, api, isEditable, isMac } from './lib/app-helpers.js';
import { sidebarEl, mapView } from './shell/shell.js';
import { themeLabel } from './shell/theme.js';
import { showUpdate, showTabs } from './shell/updates.js';
import { undo, redo, act } from './lib/bridge.js';
import { refreshHistory, refreshAux, refreshStatus } from './graph/load.js';
import { openIdentity } from './commit/identity-check.js';
import { stashSave } from './commit/stashes.js';
import { writeMessageWithAi, setupAi, showAiButton } from './commit/ai-message.js';
import { snapshotKey } from './history/snapshots.js';
import { openDifftool } from './commit/external-tools.js';
import { fetchAll, pull, push, remotesSwitcher } from './branches/remote-ops.js';
import { tour, openShortcuts, shortcuts, openSetup } from './welcome/welcome.js';
import { closeSplit } from './commit/split.js';
import { openMergetool, openConflicts, openFileHistory, gPending, setGPending } from './history/file-history.js';
import { closeQuick } from './graph/quick-view.js';
import { submoduleSwitcher, prList, refreshPrs, createPr, pickPr, approvePr, requestChangesPr, togglePrs, pickPrRemote, hidePrs } from './prs/prs-page.js';
import { branchHere } from './graph/commit-actions.js';
import { openRepo, initRepo, cloneRepo, openPrefs, prefs } from './settings/prefs-window.js';
import { sbNarrow, applySidebar, setSbNarrow, setView, goBack, goForward, toggleSidebar, toggleShow, openOrigin, openLfs, sbState, sbHideTimer, setSidebar, isMenuKey, resetPanes, toggleDetail, renderSidebar, renderTopbar, renderView, startView, renderShell, setStartView } from './shell/navigation.js';
import { addWorktree, branchSwitcher, worktreeSwitcher, updateSubmodules, openReview, mergePrCmd, closePrCmd, takeHandoff, startCleanup } from './lanes/worktrees.js';
import { openPalette, resetHard, openHosting, repoSwitcher } from './palette/palette.js';

// The renderer entry: global events, the tab strip and boot. Each area lives in its own folder;
// this file wires them together.

state.graph = state.hist.graph;
setSwatches(state.show.swatches);
state.panes = loadSizes(loadPref('panes', {}));

// Git version gates (AK-586). `state.gitInfo`: { path, version } of the git in use.
api.app('git-info').then((r) => { state.gitInfo = r?.ok || null; }, () => {});
// Another window chose a git: every window's reasons follow it.
api.on('git', (info) => { state.gitInfo = info || null; });
window.addEventListener('resize', () => {
  if (isNarrow(window.innerWidth) === sbNarrow) return;
  setSbNarrow(!sbNarrow);
  state.sidebar = { ...state.sidebar, pinned: false, hover: false };
  applySidebar();
});

// Global events

// `refs` is also set when a window opened, closed or switched worktree (which are open elsewhere).
api.on('repo:changed', ({ refs, workdir }) => {
  if (!state.repo) return;
  if (refs) { refreshHistory(); refreshAux(); }
  if (workdir || refs) refreshStatus();
});

const commands = {
  open: (dir) => openRepo(dir),
  init: initRepo,
  clone: cloneRepo,
  undo: () => { if (isEditable(document.activeElement)) document.execCommand('undo'); else if (state.repo) undo(); else tour?.undo(); },
  redo: () => { if (isEditable(document.activeElement)) document.execCommand('redo'); else if (state.repo) redo(); else tour?.redo(); },
  search: () => { if (!state.repo) return; if (state.view !== 'map' || state.quick || state.split || state.fileHistory) setView('map'); setTimeout(() => $('#map-search')?.focus()); },
  palette: openPalette,
  view: (v) => (v === 'config' ? openPrefs('repository') : setView(v)),
  preferences: (section) => openPrefs(section),
  back: goBack,
  forward: goForward,
  sidebar: toggleSidebar,
  toggle: (k) => state.repo && toggleShow(k),
  fetch: () => state.repo && fetchAll(),
  pull: () => state.repo && pull(),
  push: () => state.repo && push(false),
  pushTags: () => state.repo && act('Push tags', 'pushTags', [], { busy: 'Pushing tags…', undoable: false }),
  stashSave: () => state.repo && stashSave(),
  stashStaged: () => state.repo && stashSave({ staged: true }),
  resetHard: () => state.repo && resetHard(),
  reveal: () => state.repo && api.app('reveal'),
  terminal: () => state.repo && api.app('terminal'),
  origin: () => state.repo && openOrigin(),
  hosting: () => state.repo && openHosting(),
  worktreeAdd: () => state.repo && addWorktree(),
  branchSwitch: () => state.repo && branchSwitcher(),
  worktreeSwitch: () => state.repo && worktreeSwitcher(),
  repoSwitch: () => repoSwitcher(),
  lfs: () => openLfs(),
  submodules: () => submoduleSwitcher(),
  submoduleUpdate: () => updateSubmodules(),
  difftool: () => openDifftool(),
  mergetool: () => openMergetool(),
  conflicts: () => openConflicts(),
  fileHistory: () => openFileHistory(),
  review: () => openReview(),
  identity: () => openIdentity(),
  remotes: () => remotesSwitcher(),
  aiMessage: () => writeMessageWithAi(),
  aiSetup: () => state.repo && setupAi(),
  prs: () => state.repo && prList(),
  prRefresh: () => state.repo && refreshPrs({ manual: true }),
  prCreate: () => state.repo && createPr(),
  prCheckout: () => state.repo && pickPr(false),
  prWorktree: () => state.repo && pickPr(true),
  prApprove: () => state.repo && approvePr(),
  prMerge: () => state.repo && mergePrCmd(),
  prClose: () => state.repo && closePrCmd(),
  prChanges: () => state.repo && requestChangesPr(),
  shortcuts: () => openShortcuts(),
  handoff: () => takeHandoff(),
};
api.on('command', (cmd, ...args) => {
  // With the shortcuts window open, the menu's ⌘/ closes it and ⌘F goes to its search.
  if (shortcuts && cmd === 'shortcuts') return shortcuts.close();
  if (shortcuts && cmd === 'search') return shortcuts.find();
  // With Preferences open, ⌘, closes it, Repository Settings… jumps to Repository and ⌘F goes to its search.
  if (prefs && cmd === 'preferences') return openPrefsCommand(args[0]) === 'show' ? prefs.show(args[0]) : prefs.close();
  if (prefs && cmd === 'search') return prefs.find();
  if (document.querySelector('.overlay') && !['undo', 'redo', 'handoff'].includes(cmd)) return;
  commands[cmd]?.(...args);
});

// Mouse buttons 4 and 5 go back and forward, as in a browser.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); } else if (e.button === 4) { e.preventDefault(); goForward(); }
});

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.overlay')) return;
  const id = keymap.match('global', e);
  if (id === 'global.close' && sidebarMode(sbState()) === 'overlay') {
    e.preventDefault();
    clearTimeout(sbHideTimer);
    const inside = sidebarEl.contains(document.activeElement);
    setSidebar({ ...state.sidebar, pinned: false, hover: false });
    if (inside) sidebarEl.querySelector('.sb-toggle')?.focus();
    return;
  }
  // Switch Repository… when the user gives it keys (also a File menu item, which handles it on macOS)
  if (keymap.match('menu', e) === 'file.repoSwitch') { e.preventDefault(); commands.repoSwitch(); return; }
  // ⌘S toggles the sidebar from the View menu; any other keys the user adds have no menu accelerator, so handle them here
  if (keymap.match('menu', e) === 'view.sidebar' && !isMenuKey('view.sidebar', e)) { e.preventDefault(); toggleSidebar(); return; }
  // Choose defaults, when the user gives it keys. Plain ⌘, stays the menu's Settings… (Config)
  if (id === 'global.setup' && !isEditable(e.target)) { e.preventDefault(); openSetup(); return; }
  if (id === 'global.close' && state.quick) { e.preventDefault(); closeQuick(); }
  if (id === 'global.close' && state.split && !isEditable(document.activeElement)) { e.preventDefault(); closeSplit(); }
  // "G then X" navigation: the view chords in the keymap ("g r" → view.reflog)
  if (!isEditable(document.activeElement) && !e.metaKey && !e.ctrlKey && state.repo) {
    if (gPending) {
      const v = keymap.match('menu', e, gPending)?.replace('view.', '');
      setGPending(null);
      if (v) { e.preventDefault(); setView(v); return; }
    } else if (state.view !== 'commit' && (setGPending(keymap.chordStart('menu', e)))) { setTimeout(() => { setGPending(null); }, 800); return; }
    if (id === 'global.search') { e.preventDefault(); commands.search(); }
    // Not while File History, Quick View or Split covers the Snapshots view: their keys would reach the hidden list.
    if (state.view === 'snapshots' && !state.fileHistory && !state.quick && !state.split && !e.altKey && !e.shiftKey && snapshotKey(e)) { e.preventDefault(); return; }
  }
  if (state.repo && id === 'global.branch') { e.preventDefault(); branchHere(); return; }
  if (state.repo && id === 'global.cleanup' && !isEditable(e.target)) { e.preventDefault(); startCleanup(); return; }
  if (state.repo && id === 'global.resetPanes') { e.preventDefault(); resetPanes(); return; }
  if (state.repo && id === 'global.prs') { e.preventDefault(); togglePrs(); return; }
  if (state.repo && id === 'global.prRemote') { e.preventDefault(); pickPrRemote(); return; }
  if (state.repo && id === 'global.prHide' && state.prs?.enabled && state.prs.remote) { e.preventDefault(); hidePrs(!state.prs.hidden); return; }
  if (state.repo && id === 'global.detail') {
    e.preventDefault();
    if (state.view === 'map' && !state.quick && !state.split && !state.fileHistory && !state.review) toggleDetail();
  }
});

api.on('theme', (mode, { announce } = {}) => {
  state.theme = mode;
  if (announce) toast(`Theme: ${themeLabel(mode)}`);
  setTimeout(() => mapView?.refresh(), 50);
  prefs?.refresh();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => mapView?.refresh());
api.on('update', showUpdate);

// Custom key bindings changed (here or in another window): redraw everything that shows keys.
api.on('keymap', (o) => {
  keymap.setOverrides(o);
  if (state.repo) { renderSidebar(); renderTopbar(); renderView(true); }
  shortcuts?.refresh();
});
api.on('tabs', showTabs);

// Boot
(async () => {
  document.documentElement.classList.toggle('mac', isMac);
  state.theme = await api.app('theme');
  keymap.setOverrides(await api.app('keymap'));
  api.app('ai-settings').then((a) => { state.ai = a; showAiButton(); });
  showUpdate(await api.app('update-state'));
  showTabs(...(await api.app('tabs')));
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'map') setStartView('map');
  const dir = params.get('repo');
  if (!dir || !(await openRepo(dir))) renderShell();
})();
