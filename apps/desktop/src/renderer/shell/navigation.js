import { h, $, icon, toast, dialog, contextMenu } from '../lib/ui.ts';
import { setSwatches } from '../commit/diff.ts';
import { opSentence } from '../commit/resolve-text.ts';
import * as keymap from '../palette/keymap.ts';
import { fileHistoryView } from '../history/file-history-view.ts';
import { createNav } from './nav.ts';
import { reviewView } from '../review/review-view.js';
import { sidebarMode, toggleSidebarState, sidebarToggleLabel, isNarrow, NAV_ITEMS, SECTION_PAGES, sectionOf, pageLabel, orderedSections, moveSection, placeSection, showSection } from './sidebar.ts';
import { PANES, clampPane, stepPane, defaultSizes } from './pane-size.ts';
import { authorProfile } from '../lib/profile.ts';
import { approveWhy, draftSwitch } from '../prs/prs.ts';
import { up } from '../lib/upcalls.ts';
import { state, tildePath, api, savePref, tip, MOD } from '../lib/app-helpers.ts';
import { lanesPage, root, sidebarEl, topbarEl, bannerEl, contentEl, setSidebarEl, setTopbarEl, setBannerEl, setContentEl, catchupCount, finishedCount, reviewCount, mapView, branchesPage, commitView, catchupPage, reviewPage, setMapView, setCommitView, setCatchupPage, setBranchesPage, setReviewPage } from './shell.ts';
import { git, undoTitle, undo, redoTitle, redo, act, aborted } from '../lib/bridge.ts';
import { refreshAux, refreshHistory, worktreeOf } from '../graph/load.js';
import { stashSave, stashesView } from '../commit/stashes.ts';
import { snapshotsView } from '../history/snapshots.js';
import { editRemoteUrl, remoteMenu, addRemote, fetchAll, pull, push } from '../branches/remote-ops.ts';
import { reflogView } from '../history/reflog.ts';
import { splitView } from '../commit/split.ts';
import { showCommit, closeFileHistory } from '../history/file-history.js';
import { quickView, openQuick } from '../graph/quick-view.js';
import { prViewer } from '../prs/prs-page.js';
import { selectCommit, sbWorktree, selectWorktreeItem, commitSide, createMapView } from '../graph/map.js';
import { copy, checkout, refMenu } from '../graph/commit-actions.js';
import { renderWelcome, openPrefs } from '../settings/prefs-window.js';
import { createCommitView } from '../commit/commit-view.js';

// The shell: sidebar, top bar, banner and switching views, plus back and forward.

// Back and forward (⌘[ ⌘], the ‹ › buttons): jumps between views, lanes, commits and pull requests. Arrow
// keys inside a list aren't jumps. Per window; a different repository starts afresh, a worktree switch is a step.
const nav = createNav();
let navDepth = 0; // inside a jump: the outermost one records it
let navigating = false; // putting back a step: record nothing
let lanesPlace = null; // the lanes row, filter and scroll for the next lanes page (see openLanes)

const lanesOpen = () => state.view === 'lanes' && !state.review && !state.fileHistory && !state.quick && !state.split;
// Names the place on screen; a jump that ends where it started records nothing.
// In Review the selected row counts too: the split view's pane shows it (AK-272).
const placeKey = (lanes = lanesOpen() ? lanesPage?.location() : null) => [state.repo?.root, state.view, state.review?.lane.key, state.fileHistory?.path, state.quick?.sha,
  state.view === 'map' && !state.quick ? state.selected : '', lanes ? `${lanes.tab}:${lanes.key ?? ''}` : ''].join('|');
function place() {
  return {
    key: placeKey(), root: state.repo?.root, view: state.view, review: state.review,
    fileHistory: state.fileHistory, quick: state.quick, selected: state.selected, search: state.search,
    lanes: lanesOpen() ? lanesPage?.location() : null,
  };
}
// Runs a jump and remembers where it came from. Anything it opens later (a picker, a worktree switch) records itself.
function go(fn) {
  if (navDepth || navigating || !state.repo) return fn();
  const from = place();
  navDepth++;
  try { return fn(); } finally {
    navDepth--;
    if (nav.record(from, placeKey())) renderTopbar();
  }
}
const jumpTo = (sha) => go(() => { setView('map'); selectCommit(sha, 'center'); });

async function navStep(dir) {
  if (!state.repo || document.querySelector('.overlay')) return;
  const here = place();
  const to = dir === 'back' ? nav.back(here) : nav.forward(here);
  if (!to) return;
  navigating = true;
  try {
    // Another worktree of this repository: switch to it the usual way first.
    if (to.root !== state.repo.root) {
      const w = state.worktrees.find((x) => x.path === to.root);
      if (!w || w.missing) { renderTopbar(); return toast('That worktree is gone', { detail: tildePath(to.root) }); }
      // A failed switch toasts and leaves us where we were: take the step back so ⌘[ / ⌘] don't skip an entry.
      try { await up.switchWorktree(w); } finally { if (state.repo?.root !== to.root) nav.undo(dir, here, to); }
      if (state.repo?.root !== to.root) return renderTopbar();
      toast(`Switched to worktree “${w.name}”`);
    }
    state.view = to.view;
    state.review = to.review;
    state.fileHistory = to.fileHistory;
    state.quick = to.quick;
    state.split = null;
    state.search = to.search;
    lanesPlace = to.lanes;
    renderSidebar();
    renderTopbar();
    renderView();
    if (to.view === 'map' && !to.quick && !to.review && !to.fileHistory && to.selected) selectCommit(to.selected, 'center');
    if (to.view === 'reflog' || to.view === 'stashes') refreshAux();
    if (to.view === 'worktrees') refreshHistory();
  } finally { navigating = false; }
}
const goBack = () => navStep('back');
const goForward = () => navStep('forward');
// The built-in conflict editor on screen in Commit view, if any.
let conflictEd = null;
// Marks a drag of Commit view file rows, so drops from anywhere else are ignored.
const CV_DRAG_TYPE = 'application/x-since-files';

function renderShell() {
  root.replaceChildren();
  if (!state.repo) return renderWelcome();
  setSidebarEl(h('aside.sidebar'));
  setTopbarEl(h('header.topbar'));
  setBannerEl(h('div.banner-slot'));
  setContentEl(h('div.content'));
  root.append(sidebarEl, paneHandle('sidebar', () => root), h('main.main', null, topbarEl, bannerEl, contentEl));
  applyPanes();
  sidebarEl.addEventListener('mouseenter', () => sidebarHover(true));
  sidebarEl.addEventListener('mouseleave', () => sidebarHover(false));
  root.querySelector('.main').addEventListener('mousedown', () => { if (sidebarMode(sbState()) === 'overlay') setSidebar({ ...state.sidebar, pinned: false, hover: false }); });
  renderSidebar();
  applySidebar();
  renderTopbar();
  renderBanner();
  renderView();
}

// The view a newly opened repository starts on: Review. Development builds can ask for the Map
// (SINCE_START_VIEW=map, main.js), which the end-to-end tests do.
let startView = 'lanes';

// The pages at the top of the sidebar (keys 1–8, sidebar.js). Catch up, Review, Map and Commit always show.
const VIEWS = NAV_ITEMS;

function setView(v) {
  if (!state.repo) return;
  go(() => showView(v));
}
function showView(v) {
  state.quick = null;
  state.split = null;
  state.fileHistory = null;
  state.review = null;
  state.view = v;
  renderSidebar();
  renderTopbar();
  renderView();
  if (v === 'reflog' || v === 'stashes') refreshAux();
  if (v === 'worktrees') refreshHistory();
}

// The origin remote (or the first one), as pushes and "View on Hosting Service" pick it.
const originRemote = () => state.remotes.find((r) => r.name === 'origin') || state.remotes[0];

function originLink() {
  const r = originRemote();
  if (!r) return null;
  // Never show the raw URL: it can hold credentials.
  if (!r.web) return h('span.repo-origin', { title: r.label }, r.label);
  return h('a.repo-origin', { href: r.web, title: r.web, onclick: (e) => { e.preventDefault(); openOrigin(); } }, r.label);
}

// Remotes change through `git remote` or the config view; the watcher brings us here.
async function refreshRemotes() {
  const remotes = await git('remotes').catch(() => []);
  if (JSON.stringify(remotes) === JSON.stringify(state.remotes)) return;
  state.remotes = remotes;
  $('.sb-origin')?.replaceChildren(...[originLink()].filter(Boolean));
  renderSidebar();
}

// A person in an avatar group's popover (AK-535): picking them opens their GitHub profile, like personLink.
function withProfile(p) {
  const prof = authorProfile(p.email, originRemote()?.web);
  return prof ? { ...p, open: () => api.app('external', prof.url) } : p;
}

// View Author on GitHub (⌘K, the context menu): the selected commit's author.
function openAuthor(c) {
  const p = authorProfile(c.email, originRemote()?.web);
  if (p) api.app('external', p.url);
  else toast(`No GitHub profile found for ${c.author}`, { kind: 'error' });
}

// ⌘⇧C: the selected commit's page on the origin's web host.
function copyCommitLink(sha) {
  const r = originRemote();
  if (r?.web) copy(`${r.web}/commit/${sha}`, 'Copied link to commit');
  else toast(r ? `${r.name} is not on a web host` : 'This repository has no remotes', { kind: 'error' });
}

function openOrigin() {
  const r = originRemote();
  if (r?.web) api.app('external', r.web);
  else toast(r ? `${r.name} is not on a web host` : 'This repository has no remotes', { kind: 'error' });
}

function renderSidebar() {
  if (!sidebarEl) return;
  const remotes = state.refs.filter((r) => r.kind === 'remote');
  const tags = state.refs.filter((r) => r.kind === 'tag').sort((a, b) => b.date - a.date);
  const groups = new Map();
  for (const r of remotes) { const n = r.short.split('/')[0]; if (!groups.has(n)) groups.set(n, []); groups.get(n).push(r); }

  // A fold-out list below the divider. A click folds it; a double-click (the second click folds it back) opens its
  // full page, and the header stays highlighted while that page is on screen. Long-press to drag it elsewhere.
  const onPage = (id) => sectionOf(state.view) === id && !state.review && !state.quick && !state.split && !state.fileHistory;
  const section = (id, title, items, renderItem, count = items.length) => {
    const collapsed = state.collapsed[id];
    const page = SECTION_PAGES.find((p) => p.id === id);
    const fold = () => { state.collapsed[id] = !collapsed; savePref('collapsed', state.collapsed); renderSidebar(); };
    return h('div.sb-section', { 'data-section': id, 'data-reorder': id },
      h('div.sb-section-row' + (onPage(id) ? '.active' : ''), null,
        dragToReorder(h('button.sb-section-head', { onclick: (e) => { fold(); if (e.detail === 2) setView(page.view); }, oncontextmenu: (e) => { e.preventDefault(); sectionMenu(e.clientX, e.clientY, id); }, 'aria-expanded': String(!collapsed), title: tip(`${title}: double-click for the full page`, `view.${page.view}`) },
          h('span.caret' + (collapsed ? '' : '.open'), null, icon('chevron', 12)), title, h('span.sb-count', null, count), h('span.nav-badge')))),
      collapsed ? null : h('div.sb-items', null, items.slice(0, 300).map(renderItem)),
    );
  };

  const sections = {
    remotes: () => section('remotes', 'Remotes', [...remoteRows, addRemoteItem], (el) => el, state.remotes.length),
    tags: () => section('tags', 'Tags', tags, (r) => refItem(r)),
    worktrees: () => section('worktrees', 'Worktrees', state.worktrees, worktreeItem),
  };

  const refItem = (r, label = r.short, nested = false) => h('div.sb-item' + (nested ? '.sb-nested' : '') + (r.kind === 'branch' && r.short === state.head.branch ? '.current' : '') + (state.selected === r.target && state.view === 'map' ? '.selected-ref' : ''), {
    title: r.short,
    onclick: () => jumpTo(r.target),
    ondblclick: () => r.kind === 'branch' ? checkout(r.short) : null,
    oncontextmenu: (e) => { e.preventDefault(); refMenu(e.clientX, e.clientY, r); },
  },
    icon(r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'branch', 14),
    h('span.sb-label', null, label),
    r.kind === 'branch' && r.short === state.head.branch ? h('span.dot-head', { title: 'HEAD' }) : null,
    r.kind === 'branch' && (r.ahead || r.behind) ? h('span.sb-track', null, r.ahead ? `${r.ahead}↑` : '', r.behind ? ` ${r.behind}↓` : '') : null,
    r.gone ? h('span.sb-gone', { title: 'Upstream is gone' }, 'Gone') : null,
    r.kind === 'branch' && worktreeOf(r.short) ? h('span.sb-wt', { title: `Checked out in worktree ${worktreeOf(r.short).name}` }, icon('worktree', 12)) : null,
  );

  // A click selects the worktree (and its HEAD, on the Map); a double-click or ↵ switches to it. The second click
  // reads e.detail, so it still counts when the first click rebuilt the sidebar.
  const worktreeItem = (w) => h('div.sb-item.sb-worktree' + (w.current ? '.current' : '') + (w.missing ? '.missing' : '') + (sbWorktree === w.path ? '.selected' : ''), {
    title: w.path,
    tabIndex: 0,
    'data-path': w.path,
    onclick: (e) => e.detail === 2 ? up.switchWorktree(w) : selectWorktreeItem(w),
    onkeydown: (e) => { if (keymap.match('worktrees', e) === 'worktrees.switch') { e.preventDefault(); up.switchWorktree(w); } },
    oncontextmenu: (e) => { e.preventDefault(); up.worktreeMenu(e.clientX, e.clientY, w); },
  },
    icon('worktree', 14),
    h('span.sb-label', null, w.name),
    w.current ? h('span.dot-head', { title: 'This window' }) : null,
    w.locked ? h('span.sb-track', { title: w.lockReason ? `Locked: ${w.lockReason}` : 'Locked' }, 'Locked') : null,
    w.missing ? h('span.sb-gone', { title: 'The folder no longer exists' }, 'Missing') : null,
  );

  const remoteItem = (r) => h('div.sb-item', {
    title: `${r.name}\n${r.label}`,
    ondblclick: () => editRemoteUrl(r),
    oncontextmenu: (e) => { e.preventDefault(); remoteMenu(e.clientX, e.clientY, r); },
  },
    icon('cloud', 14),
    h('span.sb-label', null, r.name),
    h('span.sb-track.sb-url', null, r.label),
  );
  // Remotes: each remote, then its branches under it.
  const names = [...new Set([...state.remotes.map((r) => r.name), ...groups.keys()])];
  const remoteRows = names.flatMap((name) => {
    const r = state.remotes.find((x) => x.name === name);
    return [r ? remoteItem(r) : null, ...(groups.get(name) || []).map((b) => refItem(b, b.short.slice(name.length + 1), true))];
  }).filter(Boolean);
  const addRemoteItem = h('div.sb-item.sb-add', { title: tip('Add remote', 'repo.remotes'), onclick: () => addRemote() }, icon('plus', 14), h('span.sb-label', null, 'Add remote…'));

  sidebarEl.replaceChildren(
    h('div.sb-top', null,
      h('button.icon-btn.sb-toggle', { onclick: toggleSidebar }, icon('sidebar')),
      h('button.repo-switch', { 'aria-haspopup': 'menu', onclick: (e) => up.repoMenu(e.currentTarget) },
        h('span.repo-icon', null, state.repo.name.slice(0, 1).toUpperCase()),
        h('span.repo-name', null, state.repo.name),
        icon('chevronDown', 12)),
      h('button.icon-btn', { title: tip('Command menu', 'view.palette'), onclick: up.openPalette }, icon('search')),
    ),
    h('div.sb-origin', null, originLink()),
    h('nav.sb-nav', null, shownNav().map((v) => dragToReorder(h('button.nav-item' + (sectionOf(state.view) === v.id ? '.active' : ''), { onclick: () => setView(v.view), oncontextmenu: (e) => { e.preventDefault(); sectionMenu(e.clientX, e.clientY, v.id); }, 'data-view': v.id, 'data-section': v.id, 'data-reorder': v.id, title: tip(v.label, `view.${v.view}`), 'aria-label': v.label },
      icon(v.icon), h('span', null, v.label), h('span.nav-badge'), h('span.nav-kbd', null, keymap.keys(`view.${v.view}`).join('')))))),
    h('div.sb-divider', { role: 'separator' }),
    h('div.sb-scroll', null,
      shownSections().map((p) => sections[p.id]())),
    // Icons-only stand-ins for the sections above, shown in the rail.
    h('div.sb-rail-items', null, shownSections().map((p) => railItem(p.id, p.label, p.icon))),
    h('div.sb-foot', null,
      h('button.sb-action', { onclick: fetchAll, title: tip('Fetch all', 'repo.fetch'), 'aria-label': 'Fetch' }, icon('fetch'), h('span', null, 'Fetch')),
      h('button.sb-action', { onclick: pull, title: tip('Pull', 'repo.pull'), 'aria-label': 'Pull' }, icon('pull'), h('span', null, 'Pull')),
      h('button.sb-action', { onclick: () => push(false), title: tip('Push', 'repo.push'), 'aria-label': 'Push' }, icon('push'), h('span', null, 'Push')),
    ),
  );
  renderNavCounts();
  applySidebar();
}

// The sidebar rows on screen, in the saved order, not hidden in Preferences → Sidebar. Submodules only show when
// the repository has them.
const shownNav = () => orderedSections(state.sections, 'nav')
  .filter((p) => !p.hidden && (p.id !== 'submodules' || state.submodules.length));
const shownSections = () => orderedSections(state.sections, 'list').filter((p) => !p.hidden);
function setSections(next) {
  state.sections = next;
  savePref('sidebarSections', next);
  renderSidebar();
}
// Right-click on a sidebar row: move or hide it, or open Preferences → Sidebar.
function sectionMenu(x, y, id) {
  const row = orderedSections(state.sections).find((p) => p.id === id);
  const shown = (row.group === 'nav' ? shownNav() : shownSections()).map((p) => p.id), i = shown.indexOf(id);
  // Moves step over rows that aren't on screen, so one move always changes what you see.
  const move = (dir) => {
    const at = (s, x) => orderedSections(s).findIndex((p) => p.id === x);
    let s = state.sections;
    const target = shown[i + dir];
    while (dir < 0 ? at(s, id) > at(s, target) : at(s, id) < at(s, target)) s = moveSection(s, id, dir);
    setSections(s);
  };
  contextMenu(x, y, [
    { label: 'Move Up', icon: 'chevronUp', disabled: i <= 0, run: () => move(-1) },
    { label: 'Move Down', icon: 'chevronDown', disabled: i < 0 || i >= shown.length - 1, run: () => move(1) },
    { label: 'Hide from Sidebar', icon: 'eye', disabled: Boolean(row.fixed), run: () => { setSections(showSection(state.sections, id, false)); toast(`${row.label} hidden. Bring it back in Preferences → Sidebar.`); } },
    { label: 'Sidebar Preferences…', icon: 'config', run: () => openPrefs('sidebar') },
  ]);
}

// Long-press a sidebar row, then drag it to a new place in its group (AK-491). Moving before the press holds
// is a normal click or scroll; Esc cancels the drag. Returns the handle.
const HOLD_MS = 350;
function dragToReorder(handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const row = handle.closest('[data-reorder]') || handle, id = row.dataset.reorder;
    const x0 = e.clientX, y0 = e.clientY;
    let on = false, before = null;
    const rows = () => (row.parentElement ? [...row.parentElement.querySelectorAll(':scope > [data-reorder]')] : []);
    const mark = (y) => {
      const others = rows().filter((r) => r !== row);
      const next = others.find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
      before = next?.dataset.reorder ?? null;
      others.forEach((r) => { r.classList.toggle('drop-before', r === next); r.classList.toggle('drop-after', !next && r === others.at(-1)); });
    };
    const move = (ev) => {
      if (on) { ev.preventDefault(); mark(ev.clientY); } else if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) end(false);
    };
    const key = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    const up = () => end(true);
    const cancel = () => end(false);
    const end = (commit) => {
      clearTimeout(timer);
      removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', cancel, true); removeEventListener('keydown', key, true);
      if (!on) return;
      // The click that ends the drag doesn't fold, open or select anything.
      const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      addEventListener('click', eat, true);
      setTimeout(() => removeEventListener('click', eat, true));
      sidebarEl.classList.remove('sb-reordering');
      [row, ...rows()].forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
      if (commit) setSections(placeSection(state.sections, id, before));
    };
    const timer = setTimeout(() => { on = true; sidebarEl.classList.add('sb-reordering'); row.classList.add('dragging'); mark(y0); }, HOLD_MS);
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true);
    addEventListener('pointercancel', cancel, true); addEventListener('keydown', key, true);
  });
  return handle;
}

function railItem(id, label, ic) {
  return h('button.icon-btn.sb-rail-item', { title: label, 'aria-label': label, onclick: () => openSidebarAt(id) }, icon(ic));
}

function renderNavCounts() {
  if (!sidebarEl) return;
  const n = state.status.staged.length + state.status.unstaged.length + state.status.conflicts.length;
  const set = (id, v, cls) => { const b = sidebarEl.querySelector(`.sb-nav [data-view="${id}"] .nav-badge, [data-section="${id}"] .sb-section-head .nav-badge`); if (b) { b.textContent = v || ''; b.className = 'nav-badge' + (cls ? ' ' + cls : ''); } };
  set('commit', n, state.status.conflicts.length ? 'warn' : '');
  set('catchup', catchupCount, 'accent');
  set('branches', finishedCount ? `${finishedCount} to clean` : '', 'quiet');
  set('lanes', reviewCount);
  set('stashes', state.stashes.length);
}

function renderTopbar() {
  if (!topbarEl) return;
  const crumbs = h('div.crumbs', null,
    h('div.nav-btns', null,
      h('button.icon-btn', { title: tip('Back', 'view.back'), 'aria-label': 'Back', disabled: !nav.canBack, onclick: goBack }, icon('chevronLeft')),
      h('button.icon-btn', { title: tip('Forward', 'view.forward'), 'aria-label': 'Forward', disabled: !nav.canForward, onclick: goForward }, icon('chevron'))),
    h('span.crumb-muted', null, state.repo.name), icon('chevron', 12), h('span.crumb', null, state.split ? 'Split Commit' : state.quick ? 'Quick View' : state.fileHistory ? 'File History' : state.review ? 'Review' : pageLabel(state.view)),
    state.head.branch ? h('button.head-chip.branch-chip', { title: tip('Switch branch', 'repo.branchSwitch'), onclick: up.branchSwitcher }, icon('branch', 12), state.head.branch) : state.head.oid ? h('button.head-chip.branch-chip.detached', { title: tip('Switch branch', 'repo.branchSwitch'), onclick: up.branchSwitcher }, 'Detached ' + state.head.oid.slice(0, 7)) : h('span.head-chip.detached', null, 'No commits'),
    state.worktrees.length > 1 ? h('button.head-chip.wt-chip', { title: tip('Switch worktree', 'repo.worktreeSwitch'), onclick: up.worktreeSwitcher }, icon('worktree', 12), state.worktrees.find((w) => w.current)?.name || state.repo.name) : null,
    h('span.crumb-muted.history-note', { id: 'history-note' }, state.hist.complete ? '' : `Loading history… ${state.commits.length.toLocaleString()}`),
  );
  const right = h('div.top-right');
  const onMap = state.view === 'map' && !state.quick && !state.split && !state.fileHistory && !state.review;
  if (onMap) {
    const search = h('input.search', { placeholder: 'Search commits', value: state.search, spellcheck: false, id: 'map-search',
      oninput: (e) => { state.search = e.target.value; mapView?.refresh(); },
      onkeydown: (e) => {
        if (e.key === 'Escape') { state.search = ''; e.target.value = ''; e.target.blur(); mapView?.refresh(); }
        else if (e.key === 'Enter') { go(() => mapView?.pickFirstResult()); e.target.blur(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); e.target.blur(); }
      } });
    right.append(
      h('div.toggle-group', null,
        toggleChip('Tags', 'tags'),
        toggleChip('Remotes', 'remotes'),
      ),
      h('label.search-wrap', null, icon('search', 14), search, h('kbd.inline', null, MOD + 'F')),
    );
  }
  if (state.view === 'commit') {
    right.append(h('button.btn.subtle', { onclick: () => stashSave() }, icon('stash', 14), 'Stash'));
  }
  right.append(
    h('button.icon-btn', { title: tip(undoTitle(), 'edit.undo'), disabled: !state.history.undo.length, onclick: undo }, icon('undo')),
    h('button.icon-btn', { title: tip(redoTitle(), 'edit.redo'), disabled: !state.history.redo.length, onclick: redo }, icon('redo')),
  );
  // The panel toggle sits last, at the edge next to the panel it opens.
  if (onMap) {
    right.append(h('button.icon-btn.detail-toggle' + (state.detail ? '.on' : ''), { title: tip(detailToggleLabel(), 'map.detail', 'global.detail'), 'aria-pressed': String(state.detail), onclick: toggleDetail }, icon('panelRight')));
  }
  // Background refreshes rebuild the bar; keep the caret in the search field.
  const typing = document.activeElement?.id === 'map-search' ? document.activeElement : null;
  topbarEl.replaceChildren(crumbs, right);
  const search = typing && $('#map-search');
  if (search) { search.focus(); search.setSelectionRange(typing.selectionStart, typing.selectionEnd); }
}

// The commit details panel on the right of the map; shown and hidden from the top bar, Space or ⌘⌥\.
const detailToggleLabel = () => (state.detail ? 'Hide commit details' : 'Show commit details');
function toggleDetail() {
  state.detail = !state.detail;
  mapView?.refresh();
  renderTopbar();
}
function toggleChip(label, key) {
  return h('button.chip' + (state.show[key] ? '.on' : ''), { onclick: () => toggleShow(key) }, label);
}
function toggleShow(key) {
  state.show[key] = !state.show[key];
  savePref('show', state.show);
  if (key === 'swatches') { setSwatches(state.show.swatches); renderView(); return; }
  if (key === 'unified') { if (state.view === 'commit') renderView(); return; }
  if (key === 'agentLanes') { lanesPage?.rerender(); branchesPage?.rerender(); return; }
  refreshHistory();
  renderTopbar();
}
// Sidebar modes (expanded / rail / overlay); the rules live in sidebar.js.
let sbHideTimer = 0;
const sbState = () => ({ ...state.sidebar, width: window.innerWidth });
function applySidebar() {
  if (!sidebarEl) return;
  const mode = sidebarMode(sbState());
  root.classList.toggle('sb-rail', mode === 'rail');
  root.classList.toggle('sb-overlay', mode === 'overlay');
  const label = sidebarToggleLabel(sbState());
  const btn = sidebarEl.querySelector('.sb-toggle');
  if (btn) { btn.title = tip(label, 'view.sidebar'); btn.setAttribute('aria-label', label); btn.setAttribute('aria-expanded', String(mode !== 'rail')); }
  // Don't leave focus inside parts of the sidebar the rail hides.
  if (mode === 'rail' && sidebarEl.contains(document.activeElement) && !document.activeElement.checkVisibility()) btn?.focus();
}
function setSidebar(next) {
  if (next.expanded !== state.sidebar.expanded) savePref('sidebar', { expanded: next.expanded });
  state.sidebar = next;
  applySidebar();
}
// True when `e` is the key the app menu owns for `id` (its first single-step binding): the menu handles that one.
function isMenuKey(id, e) {
  const b = keymap.bindings(id).find((x) => !x.includes(' '));
  const k = keymap.fromEvent(e);
  return !!b && !!k && keymap.normalize(b) === keymap.normalize(k);
}

// Resizable panes (AK-454): a focusable separator on the pane's edge. Drag it, or focus it and use the arrow keys
// (⇧ for bigger steps, Home/End for the limits); double-click or Enter resets it. The limits live in pane-size.js.
function applyPanes() {
  root.style.setProperty('--sb-w', `${state.panes.sidebar}px`);
  root.style.setProperty('--cv-w', `${state.panes.commit}px`);
  root.style.setProperty('--st-w', `${state.panes.stash}px`);
  root.style.setProperty('--cu-w', `${state.panes.catchup}px`);
  root.querySelectorAll('.pane-handle').forEach((el) => el.setAttribute('aria-valuenow', state.panes[el.dataset.pane]));
}
function setPane(id, px, save = true) {
  state.panes = { ...state.panes, [id]: px };
  applyPanes();
  if (save) savePref('panes', state.panes);
}
function resetPanes() {
  state.panes = defaultSizes();
  applyPanes();
  savePref('panes', state.panes);
}
// `box()` is the element the pane starts at the left edge of and shares its width with.
function paneHandle(id, box) {
  const p = PANES[id];
  const el = h('div.pane-handle', { role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': p.label, 'aria-valuemin': p.min, 'aria-valuemax': p.max, 'aria-valuenow': state.panes[id], 'data-pane': id, title: tip('Drag to resize, double-click to reset', 'global.resetPanes') });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const b = box().getBoundingClientRect();
    document.body.classList.add('pane-resizing');
    const onMove = (m) => setPane(id, clampPane(id, m.clientX - b.left, b.width), false);
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('pane-resizing');
      savePref('panes', state.panes);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
  el.addEventListener('dblclick', () => setPane(id, p.def));
  el.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const px = stepPane(id, state.panes[id], e.key, e.shiftKey, box().getBoundingClientRect().width);
    // Keys that act on the list the handle sits beside (discard, stage) never reach it from here.
    if (px == null) { if (['Backspace', 'Delete', ' '].includes(e.key)) e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
    setPane(id, px);
  });
  return el;
}

function toggleSidebar() {
  clearTimeout(sbHideTimer);
  setSidebar(toggleSidebarState(state.sidebar, window.innerWidth));
}
// Narrow windows: hovering the rail opens the overlay; leaving it closes it after a beat.
function sidebarHover(on) {
  clearTimeout(sbHideTimer);
  if (!isNarrow(window.innerWidth)) return;
  if (on) setSidebar({ ...state.sidebar, hover: true });
  else sbHideTimer = setTimeout(sidebarHoverClose, 200);
}
// Keep it open while one of its context menus or dialogs is up, and check again once it closes.
function sidebarHoverClose() {
  if (document.querySelector('.menu, .overlay')) { sbHideTimer = setTimeout(sidebarHoverClose, 200); return; }
  if (sidebarEl && !sidebarEl.matches(':hover')) setSidebar({ ...state.sidebar, hover: false });
}
// A rail icon: open the full sidebar scrolled to that section.
function openSidebarAt(id) {
  if (state.collapsed[id]) { state.collapsed[id] = false; savePref('collapsed', state.collapsed); renderSidebar(); }
  setSidebar(isNarrow(window.innerWidth) ? { ...state.sidebar, pinned: true } : { ...state.sidebar, expanded: true });
  sidebarEl.querySelector(`[data-section="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
}
let sbNarrow = isNarrow(window.innerWidth);

function renderBanner() {
  if (!bannerEl) return;
  if (!state.opState) return renderLfsBanner();
  const n = state.status.conflicts.length;
  const name = { rebase: 'Rebase', merge: 'Merge', 'cherry-pick': 'Cherry-pick', revert: 'Revert' }[state.opState];
  bannerEl.replaceChildren(h('div.banner', null,
    icon('warning'),
    h('span', null, state.opInfo ? opSentence(state.opInfo, n) : h('b', null, `${name} in progress`)),
    h('span.spacer'),
    state.view !== 'commit' ? h('button.btn.subtle', { onclick: () => setView('commit') }, 'Resolve') : null,
    h('button.btn.subtle', { onclick: () => { const label = `Abort ${name.toLowerCase()}`; act(label, 'abortOp', [], { quiet: true, then: (res) => aborted(label, res, { success: label, undoable: false }) }); } }, 'Abort'),
    h('button.btn.primary', { disabled: n > 0, onclick: () => act(`Continue ${name.toLowerCase()}`, 'continueOp') }, 'Continue'),
  ));
}

// Without git-lfs, LFS files check out as pointer text and new ones get committed whole.
function renderLfsBanner() {
  if (!state.lfs?.used || state.lfs.installed || lfsDismissed.has(state.repo?.root)) return bannerEl.replaceChildren();
  bannerEl.replaceChildren(h('div.banner', null,
    icon('warning'),
    h('span', null, h('b', null, 'Git LFS isn’t installed'), ' · this repository stores large files in LFS. They show as pointer text, and staging them may fail or commit them in full.'),
    h('span.spacer'),
    h('button.btn.subtle', { onclick: () => openLfs() }, 'Details'),
    h('button.btn.subtle', { onclick: () => { lfsDismissed.add(state.repo.root); renderBanner(); } }, 'Dismiss'),
  ));
}
const lfsDismissed = new Set();

const LFS_STATES = {
  downloaded: ['Downloaded', 'The working tree holds the real file.'],
  pointer: ['Pointer only', 'Not downloaded: the working tree holds the small LFS pointer text.'],
  missing: ['Deleted', 'Missing from the working tree.'],
};
const lfsBadge = () => h('span.badge.lfs', { title: 'Stored with Git LFS' }, 'LFS');

function formatSize(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`;
}

async function openLfs() {
  if (!state.repo) return;
  const root = state.repo.root;
  const lfs = await git('lfs').catch((e) => { toast('Couldn’t read Git LFS status', { kind: 'error', detail: e.message }); return null; });
  if (!lfs || state.repo?.root !== root) return;
  state.lfs = lfs;
  renderBanner();
  if (!lfs.used) return toast('This repository doesn’t use Git LFS', { detail: lfs.installed ? lfs.version : 'git-lfs isn’t installed either.' });
  const count = (k) => lfs.files.filter((f) => f.state === k).length;
  const whole = lfs.files.filter((f) => !f.stored).length;
  const summary = [
    lfs.installed ? lfs.version : 'git-lfs isn’t installed. Install it (brew install git-lfs, then git lfs install) to download and commit LFS files correctly.',
    `${lfs.files.length}${lfs.truncated ? '+' : ''} files · ${count('downloaded')} downloaded · ${count('pointer')} pointer only${count('missing') ? ` · ${count('missing')} deleted` : ''}`,
    whole ? `${whole} file${whole > 1 ? 's are' : ' is'} committed or staged in full instead of as an LFS pointer.` : null,
    lfs.patterns.length ? `Tracked patterns: ${lfs.patterns.join('  ')}` : null,
  ];
  const list = h('div.lfs-list', null, lfs.files.map((f) => h('div.lfs-row', { title: LFS_STATES[f.state][1] },
    h(`span.lfs-state.lfs-${f.state}`, null, LFS_STATES[f.state][0]),
    h('span.mono.lfs-path', null, f.path),
    !f.stored ? h('span.badge.warn', { title: 'Git stores the whole file here, not an LFS pointer' }, 'Not in LFS') : null,
    h('span.lfs-size', null, formatSize(f.size)),
  )));
  await dialog({ title: 'Git LFS files', description: h('div', null, summary.filter(Boolean).map((t) => h('div', null, t)), list), submit: 'Done', wide: true });
}

function renderView(soft = false) {
  if (!contentEl) return;
  if (soft && state.view === 'map') return;
  mapView?.destroy(); setMapView(null);
  setCommitView(null);
  conflictEd = null;
  contentEl.replaceChildren();
  contentEl.dataset.view = state.view;
  // The old page's focus listener and "ago" timer go with it, not on its next tick (AK-366).
  catchupPage?.destroy(); setCatchupPage(null);
  lanesPage?.destroy();
  setBranchesPage(null);
  if (state.split) return contentEl.append(splitView(state.split));
  if (state.quick) return contentEl.append(quickView(state.quick));
  setReviewPage(null);
  if (state.review) { setReviewPage(reviewView({ ...state.review, root: state.repo.root, git, store: localStorage, onClose: up.closeReview, onMerge: state.review.source.branch && !state.review.source.isBase ? () => up.mergeLane(state.review.source, state.review.base) : null, pr: state.review.pr || null, onCommit: (sha, mark) => commitSide(reviewPage.el, sha, mark), onPrAction: up.prDeskAction, prWhy: (id) => (id === 'approve' ? approveWhy(state.review.pr, prViewer()) : id === 'draft' ? draftSwitch(state.review.pr, prViewer())?.why || null : null) })); return contentEl.append(reviewPage.el); }
  if (state.fileHistory) return contentEl.append(fileHistoryView({ path: state.fileHistory.path, git, onShow: showCommit, onOpen: (sha, path) => openQuick(sha, path, state.fileHistory), onClose: closeFileHistory }));
  switch (state.view) {
    case 'map': setMapView(createMapView(contentEl)); break;
    case 'commit': setCommitView(createCommitView(contentEl)); break;
    case 'stashes': contentEl.append(stashesView()); break;
    case 'snapshots': contentEl.append(snapshotsView()); break;
    case 'reflog': contentEl.append(reflogView()); break;
    case 'worktrees': contentEl.append(up.worktreesView()); break;
    case 'remoteList': case 'tagList': case 'submoduleList': contentEl.append(up.refListView(state.view)); break;
    case 'lanes': contentEl.append(up.openLanes().el); break;
    case 'catchup': contentEl.append(up.openCatchup().el); break;
    case 'branches': contentEl.append(up.openBranches().el); break;
  }
}

// Other modules assign these through setters: an imported binding can't be assigned.
function setSbNarrow(value) { return (sbNarrow = value); }
function setLanesPlace(value) { return (lanesPlace = value); }
function setStartView(value) { return (startView = value); }

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { renderSidebar, renderTopbar, renderBanner, renderView, renderNavCounts, refreshRemotes, originRemote, withProfile, copyCommitLink, toggleDetail, jumpTo, go, lanesOpen, lfsBadge, openAuthor, showView, toggleShow, paneHandle, CV_DRAG_TYPE, setView, openSidebarAt, setSidebar, resetPanes, setSections, place, nav, placeKey, renderShell });
Object.defineProperties(up, {
  lanesPlace: { get: () => lanesPlace, set: (value) => { lanesPlace = value; }, enumerable: true },
  conflictEd: { get: () => conflictEd, set: (value) => { conflictEd = value; }, enumerable: true },
  navigating: { get: () => navigating, set: (value) => { navigating = value; }, enumerable: true },
  startView: { get: () => startView, set: (value) => { startView = value; }, enumerable: true },
  sbHideTimer: { get: () => sbHideTimer, set: (value) => { sbHideTimer = value; }, enumerable: true },
});

export { sbNarrow, applySidebar, setSbNarrow, jumpTo, lanesPlace, lanesOpen, navigating, navDepth, nav, place, placeKey, renderTopbar, setLanesPlace, paneHandle, setView, renderNavCounts, go, renderView, VIEWS, setSections, goBack, goForward, openLfs, conflictEd, originRemote, openOrigin, toggleShow, detailToggleLabel, toggleDetail, resetPanes, sbState, toggleSidebar, openAuthor, copyCommitLink, sbHideTimer, setSidebar, isMenuKey, renderSidebar, startView, renderShell, setStartView };
