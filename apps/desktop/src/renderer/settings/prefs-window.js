import { h, icon, brandMark, kbd, toast, dialog, prompt, palette, timeAgo } from '../lib/ui.ts';
import { createHistory } from '../graph/log.ts';
import { setSwatches } from '../commit/diff.ts';
import * as keymap from '../palette/keymap.ts';
import { stageMemory } from '../review/review-rows.ts';
import { orderedSections, moveSection, showSection } from '../shell/sidebar.ts';
import { tourView } from '../welcome/tour-view.ts';
import { AUTOSTASH_DEFAULT } from '../commit/autostash.ts';
import { prefsWindow } from './prefs-view.ts';
import { prefRows, prRemoteChoice } from './prefs.ts';
import { SETUP_PREF, needsSetup } from './setup.ts';
import { up } from '../lib/upcalls.ts';
import { loadPref, state, api, savePref, tildePath, MOD } from '../lib/app-helpers.ts';
import { root, finishedCount, reviewCount, mapView, assignFinishedCount, assignReviewCount, catchupPage, lanesPage, branchesPage, reviewPage, sidebarEl, topbarEl, bannerEl, contentEl, setCatchupPage, setLanesPage, setBranchesPage, setReviewPage, setSidebarEl, setTopbarEl, setBannerEl, setContentEl, setMapView } from '../shell/shell.ts';
import { THEMES, setTheme } from '../shell/theme.ts';
import { update, setUpdate } from '../shell/updates.ts';
import { git, act } from '../lib/bridge.ts';
import { cancelHistory, setHistory, refreshAll } from '../graph/load.ts';
import { openIdentity } from '../commit/identity-check.ts';
import { setupAi } from '../commit/ai-message.ts';
import { addRemote, remoteItems } from '../branches/remote-ops.ts';
import { aiLabel, openSetup, openShortcuts, importShortcuts, exportShortcuts, resetShortcuts, tour, setupPanel, setTour } from '../welcome/welcome.ts';
import { setupPrs, turnOffPrs, setPrRemote, hidePrs, prStage, loadPrs, prefetchOnOpen, setPrStage } from '../prs/prs-page.js';
import { commitCache, selectCommit } from '../graph/map.ts';
import { copy } from '../graph/commit-actions.js';

// Preferences window (⌘,; prefs.js / prefs-view.js). No new store: each row reads and writes the same saved
// value as ⌘K and the menus (settings.json in the main process, or the renderer's prefs), and acts the same way.

let prefs = null;
const prefState = () => ({
  autoUpdate: update.auto,
  autostash: loadPref('autostash', AUTOSTASH_DEFAULT),
  ai: aiLabel(),
  theme: state.theme,
  themes: THEMES,
  show: state.show,
  sidebarExpanded: state.sidebar.expanded,
  sections: orderedSections(state.sections),
  prs: prefPrs,
  repo: Boolean(state.repo),
  config: state.config,
  remotes: state.remotes,
});
let prefPrs = null;
async function loadPrefState() {
  const [ai, pr, config] = await Promise.all([
    api.app('ai-settings').catch(() => null),
    api.app('pr-state').catch(() => null),
    state.repo ? git('config').catch(() => []) : [],
  ]);
  if (ai) state.ai = ai;
  prefPrs = pr;
  state.config = config;
}
async function openPrefs(section) {
  if (prefs) return prefs.show(section || 'general');
  if (document.querySelector('.overlay:not(.closing)')) return;
  await loadPrefState();
  if (prefs || document.querySelector('.overlay:not(.closing)')) return;
  prefs = prefsWindow({ section, rows: () => prefRows(prefState()), act: prefAct, onClose: () => { prefs = null; } });
}
// Rows that open their own window close Preferences first.
const leavePrefs = (then) => { prefs?.close(); setTimeout(then, 120); };
async function prefAct(row, value) {
  const id = row.id;
  if (row.kind === 'config') return configAct(row.value, value);
  if (id === 'autoUpdate') { const s = await api.app('set-auto-update', value); setUpdate({ ...update, auto: s.auto }); }
  else if (id === 'checkUpdates') await api.app('check-updates');
  else if (id === 'setup') leavePrefs(openSetup);
  else if (id === 'autostashAsk' || id === 'autostashUntracked') {
    const a = loadPref('autostash', AUTOSTASH_DEFAULT);
    savePref('autostash', id === 'autostashAsk' ? { ...a, ask: value } : { ...a, untracked: value });
  }
  else if (id === 'identity') leavePrefs(openIdentity);
  else if (id === 'ai') await setupAi();
  else if (id === 'theme') { state.theme = value; await setTheme(value); }
  else if (id in state.show) { if (state.show[id] !== value) { if (state.repo) up.toggleShow(id); else { state.show[id] = value; savePref('show', state.show); if (id === 'swatches') setSwatches(value); } } }
  else if (id === 'sidebarExpanded') up.setSidebar({ ...state.sidebar, expanded: value });
  else if (id === 'resetPanes') up.resetPanes();
  else if (id.startsWith('section:')) { const sec = id.slice(8); up.setSections(value === 'up' || value === 'down' ? moveSection(state.sections, sec, value === 'up' ? -1 : 1) : showSection(state.sections, sec, value)); }
  else if (id === 'prsOn') { await (value ? setupPrs({ ask: false }) : turnOffPrs()); prefPrs = await api.app('pr-state').catch(() => prefPrs); }
  else if (id === 'prRemote') { await setPrRemote(prRemoteChoice(value)); prefPrs = await api.app('pr-state').catch(() => prefPrs); }
  else if (id === 'prsHidden') { await hidePrs(value); prefPrs = await api.app('pr-state').catch(() => prefPrs); }
  else if (id === 'shortcuts') leavePrefs(openShortcuts);
  else if (id === 'importShortcuts') await importShortcuts();
  else if (id === 'exportShortcuts') await exportShortcuts();
  else if (id === 'resetShortcuts') await resetShortcuts();
  else if (id === 'addConfig') return configAct(null);
  else if (id === 'addRemote') await addRemote();
  else if (id.startsWith('remote:')) { const r = state.remotes.find((x) => `remote:${x.name}` === id); if (r) leavePrefs(() => palette(() => remoteItems(r), { placeholder: `Remote ${r.name}…` })); }
}
// One git config entry of the open repository: edit (local only), copy or unset. Moved here from the old
// Config view; act()'s refresh reloads the table while Preferences is open (refreshAux).
async function configAct(c, how) {
  if (how === 'copy') return copy(c.value, 'Copied');
  if (c && c.scope !== 'local') return toast(`${c.key} is set in your ${c.scope} git config`, { detail: 'Only this repository’s local values can be edited here.' });
  if (how === 'unset') await act(`Unset ${c.key}`, 'unsetConfig', [c.key], { undoable: false });
  else {
    const v = await dialog({ title: c ? 'Edit option' : 'Add option', submit: 'Save', fields: [{ name: 'k', label: 'Key', value: c?.key || '', placeholder: 'user.name' }, { name: 'v', label: 'Value', value: c?.value || '' }] });
    if (!v || !v.k.trim()) return;
    await act(`Set ${v.k.trim()}`, 'setConfig', [v.k.trim(), v.v], { undoable: false });
  }
}

async function renderWelcome({ setup = needsSetup(loadPref(SETUP_PREF, {})) } = {}) {
  const recent = await api.app('recent');
  let idx = 0;
  const list = h('div.recent-list');
  const renderList = () => {
    list.replaceChildren(...(recent.length ? recent.map((r, i) => h('button.recent' + (i === idx ? '.active' : ''), { onclick: () => openRepo(r.root), onmousemove: () => { if (idx !== i) { idx = i; renderList(); } } },
      h('span.repo-icon', null, r.name.slice(0, 1).toUpperCase()),
      h('span.recent-main', null, h('span.recent-name', null, r.name), h('span.recent-path', null, tildePath(r.root))),
      h('span.when', null, timeAgo(r.opened / 1000)))) : [h('div.muted.center', null, 'No recent repositories')]));
  };
  renderList();
  setTour(tourView({ mod: MOD }));
  const learn = h('div.welcome-learn', null, setup ? setupPanel(() => { learn.replaceChildren(tour.el); tour.el.querySelector('[aria-selected="true"]')?.focus(); }) : tour.el);
  const el = h('div.welcome', { tabIndex: 0 },
    h('div.welcome-drag'),
    h('div.welcome-layout', null, h('div.welcome-main', null, h('div.welcome-card', null,
      h('div.logo', null, h('div.logo-mark', null, brandMark(52))),
      h('h1', null, 'Since'),
      h('p.muted', null, 'A fast, keyboard-first Git client.'),
      h('div.welcome-actions', null,
        h('button.btn.primary', { onclick: () => openRepo() }, icon('folder', 14), 'Open repository', kbd(...keymap.keys('file.open'))),
        h('button.btn.subtle', { onclick: cloneRepo }, icon('fetch', 14), 'Clone', kbd(...keymap.keys('file.clone'))),
        h('button.btn.subtle', { onclick: initRepo }, icon('plus', 14), 'New', kbd(...keymap.keys('file.init'))),
      ),
      recent.length ? h('div.recent-head', null, 'Recent') : null,
      list,
    )), learn),
  );
  el.addEventListener('keydown', (e) => {
    if (learn.contains(e.target)) return;
    const id = keymap.match('recent', e);
    if (id === 'recent.next') { e.preventDefault(); idx = Math.min(recent.length - 1, idx + 1); renderList(); }
    if (id === 'recent.prev') { e.preventDefault(); idx = Math.max(0, idx - 1); renderList(); }
    if (id === 'recent.open' && recent[idx]) openRepo(recent[idx].root);
  });
  el.addEventListener('dragover', (e) => e.preventDefault());
  root.replaceChildren(el);
  el.focus();
}

// Resolves true once a repository is showing (loaded here or focused in another window).
async function bound(promise) {
  const r = await promise;
  if (r.notRepo) return offerNotRepo(r.notRepo);
  if (r.error) { toast('Could not open repository', { kind: 'error', detail: r.error.message }); return false; }
  if (!r.ok) return false;
  if (!r.ok.focused) {
    await loadRepo(r.ok);
    up.takeHandoff();
  }
  return true;
}

// A folder that isn't a repository: open one of the repositories inside it, or make it one. No
// sheet (AK-598): in a window with nothing open the list is the window; with a repository open it
// opens in the palette and the repository stays until you pick one. Creating a repository here
// (irreversible) is never the default.
async function offerNotRepo({ dir, name, repos }) {
  const init = () => bound(api.app('init-here', dir));
  if (state.repo) {
    palette(() => [
      ...repos.map((r) => ({ group: `Repositories in ${name}`, label: r.name, detail: tildePath(r.root), icon: 'folder', run: () => openRepo(r.root) })),
      { group: name, label: 'Create repository here', icon: 'plus', run: init },
    ], { placeholder: `Open a repository in ${name}…` });
    return false;
  }
  const rows = repos.map((r, i) => h('button.recent' + (i === 0 ? '.active' : ''), { onclick: () => openRepo(r.root) },
    h('span.repo-icon', null, r.name.slice(0, 1).toUpperCase()),
    h('span.recent-main', null, h('span.recent-name', null, r.name), h('span.recent-path', null, tildePath(r.root)))));
  const el = h('div.welcome', { tabIndex: -1 },
    h('div.welcome-drag'),
    h('div.welcome-layout', null, h('div.welcome-main', null, h('div.welcome-card.not-repo', null,
      h('h2', null, `${name} isn’t a git repository`),
      repos.length ? h('div.recent-head', null, 'Repositories inside') : null,
      h('div.recent-list', null, rows),
      h('div.welcome-actions', null,
        h('button.btn.ghost', { onclick: () => renderWelcome() }, 'Back'),
        h('button.btn.subtle', { onclick: init }, 'Create repository here')),
    ))),
  );
  el.addEventListener('keydown', (e) => {
    const id = keymap.match('recent', e);
    const at = rows.indexOf(document.activeElement);
    if (id === 'recent.next' || id === 'recent.prev') { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, at + (id === 'recent.next' ? 1 : -1)))]?.focus(); }
    if (keymap.match('dialog', e) === 'dialog.cancel') renderWelcome();
  });
  root.replaceChildren(el);
  (rows[0] || el).focus();
  return false;
}

async function loadRepo(repo) {
  // Switching between worktrees of one repository keeps the current view.
  const sameRepo = state.repo && state.repo.commonDir === repo.commonDir;
  // Another worktree is a step Back can undo; another repository starts a fresh history.
  const from = sameRepo && !up.navigating ? up.place() : null;
  if (!sameRepo) up.nav.clear();
  state.repo = repo;
  state.lfs = null;
  // A repository opens on Review (home); the Map is a key (view.map) or a row's Show in Map away.
  if (!sameRepo) { state.view = up.startView; state.worktrees = []; }
  state.selected = null;
  state.logKey = '';
  cancelHistory();
  setHistory(createHistory());
  state.quick = null;
  state.split = null;
  state.fileHistory = null;
  state.review = null;
  state.search = '';
  commitCache.clear();
  state.remotes = [];
  state.prs = null;
  setPrStage(stageMemory());
  document.title = repo.name;
  if (from) up.nav.record(from, up.placeKey());
  up.renderShell();
  loadPrs().then(prefetchOnOpen);
  if (!sameRepo) { assignFinishedCount(0); assignReviewCount(0); up.countFinished(); }
  await refreshAll();
  if (state.head.oid) selectCommit(state.head.oid, 'center');
  if (state.view === 'map') mapView?.focus();
}

const openRepo = (dir) => bound(api.app('open', dir));
const initRepo = () => bound(api.app('init'));
async function cloneRepo() {
  const url = await prompt('Clone repository', { label: 'Repository URL', placeholder: 'https://github.com/owner/repo.git', submit: 'Choose location…' });
  if (!url) return;
  const t = toast('Cloning…', { kind: 'busy', timeout: 0 });
  const off = api.on('clone:progress', (line) => t.update(line));
  await bound(api.app('clone', url));
  off();
  t.close();
}
async function closeRepo() {
  const name = state.repo?.name;
  cancelHistory();
  clearTimeout(up.sbHideTimer); // the sidebar's hover-close poll would hit the removed sidebar
  // Review and Catch up stop their timers and focus reloads now; loads still running come back null.
  catchupPage?.destroy(); setCatchupPage(null);
  lanesPage?.destroy(); setLanesPage(setBranchesPage(setReviewPage(null)));
  await api.app('close-repo');
  state.repo = null;
  setSidebarEl(setTopbarEl(setBannerEl(setContentEl(null))));
  mapView?.destroy(); setMapView(null);
  up.renderShell();
  if (name) toast(`Closed ${name}`);
}

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { openRepo, renderWelcome });
Object.defineProperties(up, {
  prefs: { get: () => prefs, set: (value) => { prefs = value; }, enumerable: true },
});

export { renderWelcome, openPrefs, openRepo, cloneRepo, closeRepo, initRepo, prefs };
