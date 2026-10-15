import { h, $, icon, kbd, loading, toast, dialog, confirm, prompt, contextMenu, closeMenu, palette, VirtualList, timeAgo, fullDate, avatar, avatarStack } from './ui.js';
import { paint, graphWidth, laneColor, readPalette } from './graph.js';
import { parseLog, createHistory, createMerge } from './log.js';
import { renderDiff, hunkKeys, statusBadge, fileName, setSwatches, fileRef } from './diff.js';
import { openLicence, licenceChip, trialLine, buy, LICENCE_KBD } from './licence.js';
import { isRowControl } from './keys.js';
import * as keymap from './keymap.js';
import { otherRecent, PALETTE_RECENT_LIMIT } from './recent.js';
import { conflictEditor, CONFLICT_KEYS } from './conflict-view.js';
import { fileHistoryView } from './file-history-view.js';
import { lanesView } from './lanes-view.js';
import { createNav } from './nav.js';
import { cleanupView } from './cleanup-view.js';
import { STALE_DAYS, cleanupItem } from './cleanup.js';
import { laneTarget, laneKey, laneTitle, laneActions, canRemove, ACTIONS } from './lanes.js';
import { reviewView } from './review-view.js';
import { storeKey, readTicks, progress as reviewProgress } from './review.js';
import { checkIdentity, matchRule, suggestPattern, upsertRule } from './identity.js';
import { sidebarMode, toggleSidebarState, sidebarToggleLabel, isNarrow } from './sidebar.js';
import { authorProfile } from './profile.js';
import { SUBMODULE_STATES } from './submodule.js';
import { tourView } from './tour-view.js';
import { setupView } from './setup-view.js';
import { shortcutsWindow } from './shortcuts-view.js';
import { SETUP_PREF, needsSetup, setupValues } from './setup.js';
import { prsByRef, prRef, prTitle, refKey, REVIEW_LABELS, CHECK_LABELS } from './prs.js';

const api = window.gitlanes;
const ROW_H = 32;
const isMac = navigator.platform.startsWith('Mac');
const MOD = isMac ? '⌘' : 'Ctrl';

const state = {
  repo: null,
  view: 'map',
  // expanded: saved choice for wide windows; pinned/hover: the overlay on narrow ones (see sidebar.js).
  sidebar: { expanded: loadPref('sidebar', { expanded: true }).expanded, pinned: false, hover: false },
  refs: [],
  head: { branch: null, oid: null, detached: false },
  hist: createHistory(), // the history on screen; commits/index/graph below are its parts
  commits: [],
  logKey: '',
  graph: null,
  index: new Map(),
  byRef: new Map(),
  selected: null,
  detail: true,
  quick: null,
  split: null,
  status: { staged: [], unstaged: [], conflicts: [] },
  opState: null,
  lfs: null, // { used, installed, version, patterns, files }; see git.getLfs
  show: loadPref('show', { tags: true, remotes: true, swatches: true, agentLanes: true }),
  search: '',
  stashes: [],
  history: { undo: [], redo: [], undoCount: 0, redoCount: 0 },
  historyLimit: 100, // snapshots loaded per stack; older ones load on request
  snapSel: null, // selected row in the Snapshots view (journal entry id)
  reflog: [],
  config: [],
  configFilter: '',
  remotes: [],
  worktrees: [],
  submodules: [], // see git.getSubmodules
  cv: { list: 'unstaged', path: null, sel: new Set(), anchor: null, lines: new Set(), diff: null, full: false },
  amend: false,
  collapsed: loadPref('collapsed', {}),
  theme: 'system',
  licence: null,
  prs: null, // pull requests from GitHub (see loadPrs); null until known
};

state.graph = state.hist.graph;
setSwatches(state.show.swatches);

function loadPref(k, d) { try { return { ...d, ...JSON.parse(localStorage.getItem('pref:' + k)) }; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem('pref:' + k, JSON.stringify(v)); } catch { /* ignore */ } }

// ---------------------------------------------------------------------------
// Git bridge

async function git(method, ...args) {
  const r = await api.git(method, ...args);
  if (r.error?.code === 'READ_ONLY') { openLicence({ blocked: true }); const e = new Error(r.error.message); e.readOnly = true; throw e; }
  if (r.error) { const e = new Error(r.error.message); e.stderr = r.error.stderr; throw e; }
  return r.ok;
}

async function act(label, method, args = [], { busy, success, undoable = true, quiet = false, then } = {}) {
  closeMenu();
  const t = busy ? toast(busy, { kind: 'busy', timeout: 0 }) : null;
  try {
    const res = await git(method, ...args, { __label: label });
    t?.close();
    if (!quiet) toast(success || label, { kind: 'success', action: undoable ? { label: 'Undo', run: undo } : null });
    await refreshAll();
    await then?.(res);
    return true;
  } catch (e) {
    t?.close();
    if (!e.readOnly) toast(`${label} failed`, { kind: 'error', detail: e.message });
    await refreshAll();
    return false;
  }
}

async function quiet(method, ...args) {
  try { await git(method, ...args); } catch (e) { if (!e.readOnly) toast('Git error', { kind: 'error', detail: e.message }); }
  await refreshStatus();
}

async function undo() {
  try {
    const label = await git('undo');
    toast(label ? `Undid “${label}”` : 'Nothing to undo', { action: label ? { label: 'Redo', run: redo } : null });
  } catch (e) { if (!e.readOnly) toast('Undo failed', { kind: 'error', detail: e.message }); }
  await refreshAll();
}
// "Undo Discard 3 lines in app.js" style labels for the next undo/redo step.
const undoTitle = () => { const e = state.history.undo.at(-1); return e ? `Undo ${e.label}` : 'Undo'; };
const redoTitle = () => { const e = state.history.redo.at(-1); return e ? `Redo ${e.label}` : 'Redo'; };
const baseName = (p) => p.split('/').pop();

async function redo() {
  try {
    const label = await git('redo');
    toast(label ? `Redid “${label}”` : 'Nothing to redo');
  } catch (e) { if (!e.readOnly) toast('Redo failed', { kind: 'error', detail: e.message }); }
  await refreshAll();
}

// Run at most one instance of fn at a time; calls made meanwhile collapse into one rerun.
function coalesce(fn) {
  let running = null, again = false;
  const wrapped = async () => {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await fn(); } while (again);
    })().finally(() => { running = null; });
    return running;
  };
  return wrapped;
}

// ---------------------------------------------------------------------------
// Data loading

const refreshHistory = coalesce(async () => {
  if (!state.repo) return;
  // On a first load, start reading the newest commits while the refs load.
  if (!state.logKey && !previewAhead) previewAhead = readPreview(logOpts()).catch(() => null);
  const [{ refs, head }, opState, history, worktrees] = await Promise.all([
    git('refs'),
    git('opState'),
    git('history', state.historyLimit),
    git('worktrees').catch(() => []),
  ]);
  const worktreesChanged = JSON.stringify(worktrees) !== JSON.stringify(state.worktrees);
  state.worktrees = worktrees;
  state.refs = refs;
  state.head = head;
  state.opState = opState;
  state.history = history;
  // The log is fully determined by the tips it starts from, so only reload when they move.
  const key = tipsKey(refs, head, worktrees);
  const logChanged = key !== state.logKey;
  if (logChanged) {
    state.logKey = key;
    await loadHistory().catch((e) => { state.logKey = ''; toast('Could not load history', { kind: 'error', detail: e.message }); });
  }
  previewAhead = null;
  indexRefs();
  fixSelection();
  renderSidebar();
  renderTopbar();
  renderBanner();
  if (state.view === 'map') mapView?.refresh();
  if (state.view === 'lanes') (state.cleanup ? cleanupPage : lanesPage)?.refresh();
  if (state.review) reviewPage?.refresh();
  // The reflog marks entries unreachable from the loaded history.
  if (state.view === 'snapshots' || (state.view === 'reflog' && logChanged) || (state.view === 'worktrees' && worktreesChanged)) renderView();
});

function tipsKey(refs, head, worktrees = []) {
  const kinds = new Set(['branch', ...(state.show.tags ? ['tag'] : []), ...(state.show.remotes ? ['remote'] : [])]);
  const detached = worktrees.filter((w) => !w.current && w.detached && w.head).map((w) => w.head);
  return [state.show.tags, state.show.remotes, head.oid, ...[...refs.filter((r) => kinds.has(r.kind)).map((r) => r.target), ...detached].sort()].join(' ');
}

function fixSelection() {
  if (state.selected && state.index.has(state.selected)) return;
  if (state.selected && !state.hist.complete) return; // may still be on its way
  const head = state.head.oid;
  state.selected = head && state.index.has(head) ? head : state.commits[0]?.sha || null;
}

// ---------------------------------------------------------------------------
// History loading
//
// The log streams in from git in chunks and is laid out as it arrives, so the first screen
// shows up long before a large history has finished loading.
//  - First load: git's newest commits are shown at once (a short, unordered "preview" that needs
//    no full-history walk), then the ordered topology stream builds the real history, swapped in
//    as soon as it covers the screen. Subjects and authors follow in a second stream.
//  - Reloads replay the topology stream against the current history: the unchanged prefix is
//    kept as is, and only missing details are fetched.
const PREVIEW = 1000;
let loadSeq = 0;
let previewAhead = null;

const logOpts = () => ({ remotes: state.show.remotes, tags: state.show.tags });

// The newest commits in plain date order, with details: shown before the ordered log arrives.
async function readPreview(opts) {
  const preview = createHistory();
  preview.repo = state.repo;
  const { id } = await git('logOpen', { ...opts, kind: 'full', preview: true, limit: PREVIEW });
  for (let text; (text = await git('logRead', id)) !== null;) {
    if (text === false) return null; // closed: another repository was opened
    preview.add(parseLog(text, 'full'));
  }
  preview.opts = JSON.stringify(opts);
  return preview;
}

function setHistory(hist) {
  state.hist = hist;
  state.commits = hist.commits;
  state.index = hist.index;
  state.graph = hist.graph;
  markLoading();
}

function markLoading(details) {
  const ds = document.documentElement.dataset;
  ds.history = state.hist.complete ? 'ready' : 'loading';
  if (details) ds.details = details;
  ds.commits = state.commits.length;
  const note = $('#history-note');
  if (note) note.textContent = state.hist.complete ? '' : `Loading history… ${state.commits.length.toLocaleString()}`;
}

// Pull a log stream from the main process, passing each chunk to fn, until it ends or a newer
// load starts. Resolves true if the stream was read to the end. Main answers false for a stream
// it has closed (the repository was replaced or closed): that is not the end of the log, so the
// history is left incomplete and reloads on the next refresh.
async function readLog(opts, seq, fn) {
  const { id } = await git('logOpen', opts);
  let done = false;
  try {
    while (seq === loadSeq) {
      const text = await git('logRead', id);
      if (text === false) { if (seq === loadSeq) state.logKey = ''; break; }
      if (text === null) { done = true; break; }
      if (seq === loadSeq) fn(text);
    }
  } finally {
    if (!done) git('logClose', id).catch(() => {});
  }
  return done;
}

// Rows the history must cover before it can replace what is on screen.
const needed = () => Math.min(mapView?.lastVisible() ?? 0, state.commits.length) + 1;

// Resolves once the first screen is ready; loading continues in the background.
function loadHistory() {
  const seq = ++loadSeq;
  const opts = logOpts();
  const fresh = !state.hist.complete;
  const head = state.head.oid;
  let shown;
  const firstScreen = new Promise((r) => { shown = r; });
  let live = false; // is the history being built already on screen?
  let target = null;

  const grew = () => {
    markLoading();
    if (state.view === 'map') mapView?.grow();
  };
  const show = (hist) => {
    live = hist === target;
    setHistory(hist);
    fixSelection();
    if (state.view === 'map') mapView?.refresh();
    shown();
  };

  const run = async () => {
    if (fresh) {
      const ahead = previewAhead && (await previewAhead);
      previewAhead = null;
      let preview = ahead && ahead.repo === state.repo && ahead.opts === JSON.stringify(opts) ? ahead : await readPreview(opts);
      if (seq !== loadSeq) return;
      if (!preview) { state.logKey = ''; return; }
      // The preview may have been read before HEAD was known.
      if (preview.graph.head !== head) preview = preview.fork(preview.length, head);
      if (preview.length < PREVIEW) preview.complete = true; // that was all of it, though maybe unordered
      show(preview);
      // The ordered history, with the preview's details carried over.
      target = createHistory(head);
      for (const c of preview.commits) target.seed(c);
      // Rows without details stay placeholders until fetched on demand, so a failure here only
      // leaves the loading marker up; it must not surface as an unhandled rejection.
      const details = readLog({ ...opts, kind: 'details' }, seq, (text) => {
        if (target.fill(text) && live) mapView?.refreshPending();
      }).catch(() => false);
      markLoading('loading');
      const ok = await readLog({ ...opts, kind: 'topo' }, seq, (text) => {
        target.add(parseLog(text, 'topo'));
        if (live) grew();
        else if (target.length >= needed()) show(target);
      });
      if (!ok || seq !== loadSeq) return;
      target.complete = true;
      show(target);
      if (await details && seq === loadSeq) markLoading('ready');
      return;
    }
    // Reload: keep showing the current history while the new one is replayed against it.
    shown();
    const merge = createMerge(state.hist, head);
    const ok = await readLog({ ...opts, kind: 'topo' }, seq, (text) => {
      merge.push(parseLog(text, 'topo'));
      const next = merge.next;
      if (!next) return;
      if (live) grew();
      else if (next.length >= needed()) { target = next; show(next); }
    });
    if (!ok || seq !== loadSeq) return;
    target = merge.finish();
    if (target) show(target); else { markLoading(); shown(); }
    // Fill in details for the commits that are new to us, a batch at a time.
    markLoading('loading');
    const hist = state.hist;
    let from = 0;
    for (;;) {
      const missing = hist.missingDetails(from, 2000);
      if (!missing.length || seq !== loadSeq) break;
      from = hist.index.get(missing[missing.length - 1]) + 1;
      if (hist.fill(await git('logDetails', missing))) mapView?.refreshPending();
    }
    if (seq === loadSeq) markLoading('ready');
  };
  run().then(() => shown(), (e) => { shown(); if (seq === loadSeq) { state.logKey = ''; toast('Could not load history', { kind: 'error', detail: e.message }); } });
  return firstScreen;
}

// Details for rows on screen that the streams have not reached yet (e.g. after jumping to the end).
const wanted = new Set();
let wantTimer = 0;
function wantDetails(sha) {
  if (wanted.has(sha)) return;
  wanted.add(sha);
  if (!wantTimer) wantTimer = setTimeout(fetchWanted, 40);
}
async function fetchWanted() {
  const hist = state.hist;
  // Take the batch before waiting: rows drawn during the fetch go into the next one.
  const shas = [...wanted].filter((sha) => mapView?.isVisible(sha));
  wanted.clear();
  try {
    if (shas.length && hist.fill(await git('logDetails', shas))) mapView?.refreshPending();
  } catch { /* the row stays a placeholder until the stream reaches it */ }
  wantTimer = wanted.size ? setTimeout(fetchWanted, 40) : 0;
}

// Stop the history load in flight (and anything queued for it) before another repository is
// opened or the current one closed, so none of it lands in the next repository's view.
function cancelHistory() {
  loadSeq++;
  previewAhead = null;
  wanted.clear();
  clearTimeout(wantTimer);
  wantTimer = 0;
}

const refreshStatus = coalesce(async () => {
  if (!state.repo) return;
  const [status, opState] = await Promise.all([git('status'), git('opState')]);
  state.status = status;
  const opChanged = opState !== state.opState;
  state.opState = opState;
  renderNavCounts();
  if (opChanged) renderBanner();
  if (state.view === 'commit') commitView?.refresh();
  refreshSubmodules();
});

// A submodule's state changes with its own work tree, so this follows the status refresh.
async function refreshSubmodules() {
  const root = state.repo?.root;
  const subs = await git('submodules').catch(() => []);
  if (state.repo?.root !== root || JSON.stringify(subs) === JSON.stringify(state.submodules)) return;
  state.submodules = subs;
  renderSidebar();
}

async function refreshAux() {
  if (!state.repo) return;
  refreshRemotes();
  // Re-render only when the data changed: a rebuild drops filters, selection and in-flight clicks.
  const shown = () => JSON.stringify([state.stashes, state.view === 'reflog' && state.reflog, state.view === 'config' && state.config]);
  const before = shown();
  state.stashes = await git('stashes').catch(() => []);
  refreshLfs();
  if (state.view === 'reflog') state.reflog = await git('reflog').catch(() => []);
  if (state.view === 'config') state.config = await git('config').catch(() => []);
  renderNavCounts();
  if (['stashes', 'reflog', 'config'].includes(state.view) && shown() !== before) renderView(true);
}

async function refreshLfs() {
  const root = state.repo?.root;
  const lfs = await git('lfs').catch(() => null);
  if (!state.repo || state.repo.root !== root) return;
  const warn = (l) => !!(l?.used && !l.installed);
  const changed = warn(lfs) !== warn(state.lfs);
  state.lfs = lfs;
  if (changed) renderBanner();
}

async function refreshAll() {
  await Promise.all([refreshHistory(), refreshStatus(), refreshAux()]);
}

function indexRefs() {
  const by = new Map();
  const push = (sha, r) => { if (!by.has(sha)) by.set(sha, []); by.get(sha).push(r); };
  const local = new Map(state.refs.filter((r) => r.kind === 'branch').map((r) => [r.short, r]));
  for (const r of state.refs) {
    if (r.kind === 'remote') {
      if (!state.show.remotes) continue;
      // Collapse remote tips that sit on the same commit as their tracking local branch.
      const tracked = [...local.values()].find((l) => l.upstream === r.short && l.target === r.target);
      if (tracked) continue;
    }
    if (r.kind === 'tag' && !state.show.tags) continue;
    push(r.target, r);
  }
  if (state.head.detached && state.head.oid) push(state.head.oid, { kind: 'head', short: 'HEAD' });
  for (const w of state.worktrees) if (!w.current && w.detached && w.head) push(w.head, { kind: 'worktree', short: w.name, worktree: w });
  for (const [, list] of by) list.sort((a, b) => rank(a) - rank(b));
  state.byRef = by;
  indexPrs();
}
const rank = (r) => (r.kind === 'head' ? 0 : r.kind === 'branch' ? (r.short === state.head.branch ? 0 : 1) : r.kind === 'worktree' ? 1 : r.kind === 'remote' ? 2 : 3);

// The other worktree that has `branch` checked out, if any.
const worktreeOf = (branch) => state.worktrees.find((w) => !w.current && w.branch === branch);

function refPill(r) {
  const isHead = r.kind === 'branch' && r.short === state.head.branch;
  const synced = r.kind === 'branch' && r.upstream && state.refs.some((x) => x.kind === 'remote' && x.short === r.upstream && x.target === r.target);
  const wt = r.kind === 'branch' && !isHead ? worktreeOf(r.short) : r.worktree;
  const title = r.kind === 'worktree' ? `Worktree ${r.short} (detached HEAD)` : r.kind === 'branch' && r.upstream ? `${r.short} → ${r.upstream}` : r.short;
  return h('span.pill.' + r.kind + (isHead ? '.head' : '') + (wt ? '.in-worktree' : ''), { title: wt && r.kind === 'branch' ? `${title} · checked out in worktree ${wt.name}` : title },
    icon(r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : r.kind === 'head' ? 'checkout' : r.kind === 'worktree' ? 'worktree' : 'branch', 12),
    r.short,
    wt && r.kind === 'branch' ? icon('worktree', 12) : null,
    synced && state.show.remotes ? icon('cloud', 12) : null,
    r.kind === 'branch' && (r.ahead || r.behind) ? h('span.track', null, r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : '') : null,
    prBadge(prFor(r)),
  );
}

// ---------------------------------------------------------------------------
// Shell

const root = $('#app');
let sidebarEl, topbarEl, bannerEl, contentEl;
let mapView = null, commitView = null, lanesPage = null, cleanupPage = null, reviewPage = null;

// ---------------------------------------------------------------------------
// Back and forward (⌘[ ⌘], the ‹ › buttons): jumps between views, lanes, commits and pull requests. Arrow
// keys inside a list aren't jumps. Per window; a different repository starts afresh, a worktree switch is a step.
const nav = createNav();
let navDepth = 0; // inside a jump: the outermost one records it
let navigating = false; // putting back a step: record nothing
let lanesPlace = null; // the lanes row, filter and scroll for the next lanes page (see openLanes)

const lanesOpen = () => state.view === 'lanes' && !state.cleanup && !state.review && !state.fileHistory && !state.quick && !state.split;
// Names the place on screen; a jump that ends where it started records nothing.
const placeKey = () => [state.repo?.root, state.view, state.cleanup, state.review?.lane.key, state.fileHistory?.path, state.quick?.sha,
  state.view === 'map' && !state.quick ? state.selected : '', lanesOpen() ? lanesPage?.location().tab : ''].join('|');
function place() {
  return {
    key: placeKey(), root: state.repo?.root, view: state.view, cleanup: state.cleanup, review: state.review,
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
      await switchWorktree(w);
      toast(`Switched to worktree “${w.name}”`);
    }
    state.view = to.view;
    state.cleanup = to.cleanup;
    state.review = to.review;
    state.fileHistory = to.fileHistory;
    state.quick = to.quick;
    state.split = null;
    state.search = to.search;
    lanesPlace = to.lanes;
    if (to.lanes) lanesTab = to.lanes.tab;
    renderSidebar();
    renderTopbar();
    renderView();
    if (to.view === 'map' && !to.quick && !to.review && !to.fileHistory && to.selected) selectCommit(to.selected, 'center');
    if (to.view === 'reflog' || to.view === 'config' || to.view === 'stashes') refreshAux();
    if (to.view === 'worktrees') refreshHistory();
  } finally { navigating = false; }
}
const goBack = () => navStep('back');
const goForward = () => navStep('forward');
// The built-in conflict editor on screen in Commit view, if any.
let conflictEd = null;

function renderShell() {
  root.replaceChildren();
  if (!state.repo) return renderWelcome();
  sidebarEl = h('aside.sidebar');
  topbarEl = h('header.topbar');
  bannerEl = h('div.banner-slot');
  contentEl = h('div.content');
  root.append(sidebarEl, h('main.main', null, topbarEl, bannerEl, contentEl));
  sidebarEl.addEventListener('mouseenter', () => sidebarHover(true));
  sidebarEl.addEventListener('mouseleave', () => sidebarHover(false));
  root.querySelector('.main').addEventListener('mousedown', () => { if (sidebarMode(sbState()) === 'overlay') setSidebar({ ...state.sidebar, pinned: false, hover: false }); });
  renderSidebar();
  applySidebar();
  renderTopbar();
  renderBanner();
  renderView();
}

const VIEWS = [
  { id: 'map', label: 'Map', icon: 'map', key: '1' },
  { id: 'commit', label: 'Commit', icon: 'commit', key: '2' },
  { id: 'stashes', label: 'Stashes', icon: 'stash', key: '3' },
  { id: 'snapshots', label: 'Snapshots', icon: 'history', key: '4' },
  { id: 'reflog', label: 'Reflog', icon: 'reflog', key: '5' },
  { id: 'config', label: 'Config', icon: 'config', key: '6' },
  { id: 'worktrees', label: 'Worktrees', icon: 'worktree', key: '7' },
  { id: 'lanes', label: 'Lanes', icon: 'lanes', key: '8' },
];

function setView(v) {
  if (!state.repo) return;
  go(() => showView(v));
}
function showView(v) {
  state.quick = null;
  state.split = null;
  state.fileHistory = null;
  state.cleanup = false;
  state.review = null;
  state.view = v;
  renderSidebar();
  renderTopbar();
  renderView();
  if (v === 'reflog' || v === 'config' || v === 'stashes') refreshAux();
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
}

// A person in the commit details; a link to their GitHub profile when we can place them.
function personLink(name, email) {
  const p = authorProfile(email, originRemote()?.web);
  const body = [avatar(name, email, 18), h('span.person-name', null, name)];
  if (!p) return h('span.prop-person', { title: `${name} <${email}>` }, ...body);
  return h('a.prop-person.person-link', { href: p.url, title: `${p.label}\n${name} <${email}>`, onclick: (e) => { e.preventDefault(); api.app('external', p.url); } }, ...body, icon('external', 12));
}

// ⇧A: the selected commit's author on GitHub.
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
  const branches = state.refs.filter((r) => r.kind === 'branch').sort((a, b) => (a.short === state.head.branch ? -1 : b.short === state.head.branch ? 1 : a.short.localeCompare(b.short)));
  const remotes = state.refs.filter((r) => r.kind === 'remote');
  const tags = state.refs.filter((r) => r.kind === 'tag').sort((a, b) => b.date - a.date);
  const groups = new Map();
  for (const r of remotes) { const n = r.short.split('/')[0]; if (!groups.has(n)) groups.set(n, []); groups.get(n).push(r); }

  const section = (id, title, items, renderItem) => {
    const collapsed = state.collapsed[id];
    return h('div.sb-section', { 'data-section': id },
      h('button.sb-section-head', { onclick: () => { state.collapsed[id] = !collapsed; savePref('collapsed', state.collapsed); renderSidebar(); } },
        h('span.caret' + (collapsed ? '' : '.open'), null, icon('chevron', 12)), title, h('span.sb-count', null, items.length)),
      collapsed ? null : h('div.sb-items', null, items.slice(0, 300).map(renderItem)),
    );
  };

  const refItem = (r, label = r.short) => h('div.sb-item' + (r.kind === 'branch' && r.short === state.head.branch ? '.current' : '') + (state.selected === r.target && state.view === 'map' ? '.selected-ref' : ''), {
    title: r.short,
    onclick: () => jumpTo(r.target),
    ondblclick: () => r.kind === 'branch' ? checkout(r.short) : null,
    oncontextmenu: (e) => { e.preventDefault(); refMenu(e.clientX, e.clientY, r); },
  },
    icon(r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'branch', 14),
    h('span.sb-label', null, label),
    r.kind === 'branch' && r.short === state.head.branch ? h('span.dot-head', { title: 'HEAD' }) : null,
    r.kind === 'branch' && (r.ahead || r.behind) ? h('span.sb-track', null, r.ahead ? `${r.ahead}↑` : '', r.behind ? ` ${r.behind}↓` : '') : null,
    r.gone ? h('span.sb-gone', { title: 'Upstream is gone' }, 'gone') : null,
    r.kind === 'branch' && worktreeOf(r.short) ? h('span.sb-wt', { title: `Checked out in worktree ${worktreeOf(r.short).name}` }, icon('worktree', 12)) : null,
  );

  const worktreeItem = (w) => h('div.sb-item' + (w.current ? '.current' : '') + (w.missing ? '.missing' : ''), {
    title: w.path,
    onclick: () => switchWorktree(w),
    oncontextmenu: (e) => { e.preventDefault(); worktreeMenu(e.clientX, e.clientY, w); },
  },
    icon('worktree', 14),
    h('span.sb-label', null, w.name),
    w.current ? h('span.dot-head', { title: 'This window' }) : null,
    w.locked ? h('span.sb-track', { title: w.lockReason ? `Locked: ${w.lockReason}` : 'Locked' }, 'locked') : null,
    w.missing ? h('span.sb-gone', { title: 'The folder no longer exists' }, 'missing') : null,
  );

  const prItem = (pr) => h('div.sb-item.pr-item' + (state.prs.stale ? '.stale' : ''), { title: prTitle(pr, state.prs.stale), onclick: () => goToPr(pr), oncontextmenu: (e) => prMenu(e, pr) },
    icon('merge', 14),
    h('span.sb-label', null, h('span.pr-num', null, `#${pr.number}`), ' ', pr.title),
    prMarks(pr),
    h('button.icon-btn.tiny.pr-open', { title: 'Open on GitHub', 'aria-label': `Open #${pr.number} on GitHub`, onclick: (e) => { e.stopPropagation(); openPrOnGitHub(pr); } }, icon('external', 12)),
  );

  const submoduleItem = (m) => h('div.sb-item', {
    title: `${m.path}${m.url ? `\n${m.url}` : ''}\n${SUBMODULE_STATES[m.state][1]}`,
    ondblclick: () => openSubmodule(m),
    oncontextmenu: (e) => { e.preventDefault(); submoduleMenu(e.clientX, e.clientY, m); },
  },
    icon('submodule', 14),
    h('span.sb-label', null, m.path),
    m.state === 'clean' ? null : h(m.state === 'uninitialized' ? 'span.sb-track' : 'span.sb-gone', null, SUBMODULE_STATES[m.state][0]),
  );

  sidebarEl.replaceChildren(
    h('div.sb-top', null,
      h('button.icon-btn.sb-toggle', { onclick: toggleSidebar }, icon('sidebar')),
      h('button.repo-switch', { onclick: (e) => repoMenu(e.currentTarget) },
        h('span.repo-icon', null, state.repo.name.slice(0, 1).toUpperCase()),
        h('span.repo-name', null, state.repo.name),
        icon('chevronDown', 12)),
      h('button.icon-btn', { title: tip('Command menu', 'view.palette'), onclick: openPalette }, icon('search')),
    ),
    h('div.sb-origin', null, originLink()),
    h('nav.sb-nav', null, VIEWS.map((v) => h('button.nav-item' + (state.view === v.id ? '.active' : ''), { onclick: () => setView(v.id), 'data-view': v.id, title: tip(v.label, `view.${v.id}`), 'aria-label': v.label },
      icon(v.icon), h('span', null, v.label), h('span.nav-badge'), h('span.nav-kbd', null, keymap.keys(`view.${v.id}`).join(''))))),
    h('div.sb-scroll', null,
      state.worktrees.length > 1 ? section('worktrees', 'Worktrees', state.worktrees, worktreeItem) : null,
      section('branches', 'Branches', branches, (r) => refItem(r)),
      [...groups].map(([name, list]) => section('remote:' + name, name, list, (r) => refItem(r, r.short.slice(name.length + 1)))),
      section('tags', 'Tags', tags, (r) => refItem(r)),
      state.submodules.length ? section('submodules', 'Submodules', state.submodules, submoduleItem) : null,
      state.prs?.active ? section('prs', 'Pull requests', state.prs.data?.prs || [], prItem) : null,
    ),
    // Icons-only stand-ins for the sections above, shown in the rail.
    h('div.sb-rail-items', null,
      state.worktrees.length > 1 ? railItem('worktrees', 'Worktrees', 'worktree') : null,
      railItem('branches', 'Branches', 'branch'),
      [...groups.keys()].map((name) => railItem('remote:' + name, `Remote ${name}`, 'cloud')),
      railItem('tags', 'Tags', 'tag'),
      state.submodules.length ? railItem('submodules', 'Submodules', 'submodule') : null,
      state.prs?.active ? railItem('prs', 'Pull requests', 'merge') : null,
    ),
    h('div.sb-foot', null,
      h('button.sb-action', { onclick: fetchAll, title: tip('Fetch all', 'repo.fetch'), 'aria-label': 'Fetch' }, icon('fetch'), h('span', null, 'Fetch')),
      h('button.sb-action', { onclick: pull, title: tip('Pull', 'repo.pull'), 'aria-label': 'Pull' }, icon('pull'), h('span', null, 'Pull')),
      h('button.sb-action', { onclick: () => push(false), title: tip('Push', 'repo.push'), 'aria-label': 'Push' }, icon('push'), h('span', null, 'Push')),
    ),
  );
  renderNavCounts();
  applySidebar();
}

function railItem(id, label, ic) {
  return h('button.icon-btn.sb-rail-item', { title: label, 'aria-label': label, onclick: () => openSidebarAt(id) }, icon(ic));
}

function renderNavCounts() {
  if (!sidebarEl) return;
  const n = state.status.staged.length + state.status.unstaged.length + state.status.conflicts.length;
  const set = (id, v, cls) => { const b = sidebarEl.querySelector(`[data-view="${id}"] .nav-badge`); if (b) { b.textContent = v || ''; b.className = 'nav-badge' + (cls ? ' ' + cls : ''); } };
  set('commit', n, state.status.conflicts.length ? 'warn' : '');
  set('stashes', state.stashes.length);
}

function renderTopbar() {
  if (!topbarEl) return;
  const v = VIEWS.find((x) => x.id === state.view);
  const crumbs = h('div.crumbs', null,
    h('div.nav-btns', null,
      h('button.icon-btn', { title: tip('Back', 'view.back'), 'aria-label': 'Back', disabled: !nav.canBack, onclick: goBack }, icon('chevronLeft')),
      h('button.icon-btn', { title: tip('Forward', 'view.forward'), 'aria-label': 'Forward', disabled: !nav.canForward, onclick: goForward }, icon('chevron'))),
    h('span.crumb-muted', null, state.repo.name), icon('chevron', 12), h('span.crumb', null, state.split ? 'Split Commit' : state.quick ? 'Quick View' : state.fileHistory ? 'File History' : state.review ? 'Review' : v.label),
    state.head.branch ? h('span.head-chip', { title: 'Current branch' }, icon('branch', 12), state.head.branch) : state.head.oid ? h('span.head-chip.detached', null, 'Detached ' + state.head.oid.slice(0, 7)) : h('span.head-chip.detached', null, 'No commits'),
    state.worktrees.length > 1 ? h('button.head-chip.wt-chip', { title: tip('Switch worktree', 'repo.worktreeSwitch'), onclick: worktreeSwitcher }, icon('worktree', 12), state.worktrees.find((w) => w.current)?.name || state.repo.name) : null,
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
  const chip = licenceChip(state.licence, () => openLicence());
  if (chip) right.append(chip);
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
  if (key === 'agentLanes') { lanesPage?.rerender(); return; }
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
window.addEventListener('resize', () => {
  if (isNarrow(window.innerWidth) === sbNarrow) return;
  sbNarrow = !sbNarrow;
  state.sidebar = { ...state.sidebar, pinned: false, hover: false };
  applySidebar();
});

function renderBanner() {
  if (!bannerEl) return;
  if (!state.opState) return renderLfsBanner();
  const n = state.status.conflicts.length;
  const name = { rebase: 'Rebase', merge: 'Merge', 'cherry-pick': 'Cherry-pick', revert: 'Revert' }[state.opState];
  bannerEl.replaceChildren(h('div.banner', null,
    icon('warning'),
    h('span', null, h('b', null, `${name} in progress`), n ? ` · ${n} conflicted file${n > 1 ? 's' : ''}` : ' · ready to continue'),
    h('span.spacer'),
    state.view !== 'commit' ? h('button.btn.subtle', { onclick: () => setView('commit') }, 'Resolve') : null,
    h('button.btn.subtle', { onclick: () => act(`Abort ${name.toLowerCase()}`, 'abortOp', [], { undoable: false }) }, 'Abort'),
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
  mapView?.destroy(); mapView = null;
  commitView = null;
  conflictEd = null;
  contentEl.replaceChildren();
  contentEl.dataset.view = state.view;
  if (state.split) return contentEl.append(splitView(state.split));
  if (state.quick) return contentEl.append(quickView(state.quick));
  reviewPage = null;
  if (state.review) { reviewPage = reviewView({ ...state.review, root: state.repo.root, git, store: localStorage, onClose: closeReview, onMerge: state.review.source.branch && !state.review.source.isBase ? () => mergeLane(state.review.source, state.review.base) : null }); return contentEl.append(reviewPage.el); }
  if (state.fileHistory) return contentEl.append(fileHistoryView({ path: state.fileHistory.path, git, onShow: showCommit, onOpen: (sha, path) => openQuick(sha, path, state.fileHistory), onClose: closeFileHistory }));
  switch (state.view) {
    case 'map': mapView = createMapView(contentEl); break;
    case 'commit': commitView = createCommitView(contentEl); break;
    case 'stashes': contentEl.append(stashesView()); break;
    case 'snapshots': contentEl.append(snapshotsView()); break;
    case 'reflog': contentEl.append(reflogView()); break;
    case 'config': contentEl.append(configView()); break;
    case 'worktrees': contentEl.append(worktreesView()); break;
    case 'lanes': contentEl.append(state.cleanup ? openCleanup().el : openLanes().el); break;
  }
}

// ---------------------------------------------------------------------------
// Map view

const commitCache = new Map();
async function loadCommit(sha) {
  if (commitCache.has(sha)) return commitCache.get(sha);
  const p = git('commit', sha);
  commitCache.set(sha, p);
  if (commitCache.size > 300) commitCache.delete(commitCache.keys().next().value);
  p.catch(() => commitCache.delete(sha));
  return p;
}

function selectCommit(sha, align = 'nearest') {
  if (!sha) return;
  state.selected = sha;
  if (mapView) mapView.select(sha, align);
}

function createMapView(container) {
  const wrap = h('div.map-wrap');
  const listWrap = h('div.map-list-wrap');
  const scroller = h('div.map-list', { tabIndex: 0 });
  const canvas = h('canvas.graph-canvas');
  const detail = h('div.detail');
  listWrap.append(scroller, canvas);
  wrap.append(listWrap, detail);
  container.append(wrap);
  const ctx = canvas.getContext('2d');
  let results = null;
  let gw = graphWidth(state.graph.maxLanes);

  const bg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg-content').trim() || 'transparent';
  let bgColor = bg();
  let colors = readPalette();

  function rowFor(i) {
    const c = results ? results[i] : state.commits[i];
    const refs = state.byRef.get(c.sha) || [];
    const isSel = c.sha === state.selected;
    const pending = c.subject === null;
    if (pending) wantDetails(c.sha);
    const el = h('div.row' + (isSel ? '.selected' : '') + (c.sha === state.head.oid ? '.is-head' : '') + (pending ? '.pending' : ''), {
      onmousedown: (e) => { if (e.button === 0) { if (results) { clearSearch(); select(c.sha, 'center'); } else select(c.sha); } },
      ondblclick: (e) => { if (!isRowControl(e.target)) checkoutSelected(c); },
      oncontextmenu: (e) => { e.preventDefault(); select(c.sha); commitMenu(e.clientX, e.clientY, c); },
    },
      results ? null : h('span.graph-space', { style: { width: gw + 'px' } }),
      results ? h('span.result-dot', { style: { background: laneColor(state.graph, state.index.get(c.sha)) } }) : null,
      refs.length ? h('span.pills', null, refs.slice(0, 4).map(refPill), refs.length > 4 ? h('span.pill.more', null, `+${refs.length - 4}`) : null) : null,
      h('span.subject', null, pending ? '' : c.subject),
      pending ? h('span.meta', null, h('span.sha', null, c.sha.slice(0, 7))) : h('span.meta', null,
        c.coAuthors?.length ? avatarStack([{ name: c.author, email: c.email }, ...c.coAuthors]) : avatar(c.author, c.email),
        h('span.author', null, c.author),
        h('span.sha', null, c.sha.slice(0, 7)),
        h('span.when', { title: fullDate(c.time) }, timeAgo(c.time)),
      ),
    );
    return el;
  }

  const vl = new VirtualList(scroller, {
    rowHeight: ROW_H,
    render: rowFor,
    onScroll: ({ first, last, top, height }) => {
      if (results) { canvas.style.display = 'none'; return; }
      canvas.style.display = '';
      const dpr = window.devicePixelRatio || 1;
      const w = gw, hh = height;
      if (canvas.width !== Math.ceil(w * dpr) || canvas.height !== Math.ceil(hh * dpr)) {
        canvas.width = Math.ceil(w * dpr); canvas.height = Math.ceil(hh * dpr);
        canvas.style.width = w + 'px'; canvas.style.height = hh + 'px';
      }
      paint(ctx, state.graph, { first, last, rowH: ROW_H, scrollTop: top, width: w, height: hh, headSha: state.head.oid, commits: state.commits, selected: state.selected, bg: bgColor, colors });
    },
  });

  function computeResults() {
    const q = state.search.trim().toLowerCase();
    if (!q) return null;
    const out = [];
    const refHit = new Set(state.refs.filter((r) => r.short.toLowerCase().includes(q)).map((r) => r.target));
    for (const c of state.commits) {
      if (c.sha.startsWith(q) || refHit.has(c.sha) || (c.subject !== null && (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)))) {
        out.push(c);
        if (out.length >= 2000) break;
      }
    }
    return out;
  }

  function refresh() {
    results = computeResults();
    gw = graphWidth(state.graph.maxLanes);
    bgColor = bg();
    colors = readPalette();
    listWrap.classList.toggle('searching', !!results);
    vl.setCount(results ? results.length : state.commits.length);
    shownGraph = state.graph;
    vl.layer.querySelector('.vl-empty')?.remove();
    if (results && !results.length) {
      vl.layer.append(h('div.vl-empty', null, `No commits match “${state.search}”`));
    }
    if (!state.commits.length && !results) {
      vl.layer.append(h('div.vl-empty', null, 'This repository has no commits yet. Make one in the Commit view.'));
    }
    renderDetail();
  }

  // More of the same history arrived: extend the list without re-rendering what is on screen.
  let shownGraph = null;
  function grow() {
    if (results || shownGraph !== state.graph) return refresh();
    const w = graphWidth(state.graph.maxLanes);
    if (w !== gw) { gw = w; vl.invalidate(); }
    vl.setCount(state.commits.length, { keep: true });
  }

  // Re-render rows that were drawn before their subject and author arrived.
  function refreshPending() {
    for (const [i, el] of vl.rows) {
      const c = results ? results[i] : state.commits[i];
      if (el.classList.contains('pending') && c && c.subject !== null) vl.refreshRow(i);
    }
  }

  function select(sha, align = 'nearest') {
    const prev = state.selected;
    state.selected = sha;
    if (!results) {
      const i = state.index.get(sha);
      const pi = state.index.get(prev);
      if (pi != null) vl.refreshRow(pi);
      if (i != null) { vl.refreshRow(i); vl.scrollToIndex(i, align); }
      vl.schedule();
    }
    renderSidebarSelection();
    renderDetail();
  }

  function clearSearch() {
    state.search = '';
    const s = $('#map-search'); if (s) s.value = '';
    results = null;
    refresh();
  }

  let detailToken = 0;
  async function renderDetail() {
    wrap.classList.toggle('with-detail', state.detail && !!state.selected);
    if (!state.detail || !state.selected) { detail.replaceChildren(); return; }
    const sha = state.selected;
    const token = ++detailToken;
    const cached = commitCache.get(sha);
    if (!cached) {
      detail.classList.add('loading');
      detail.querySelector(':scope > .loading-state')?.remove();
      detail.prepend(loading('Loading commit…'));
    }
    let c;
    try { c = await loadCommit(sha); } catch (e) { detail.replaceChildren(h('div.empty', null, e.message)); return; }
    if (token !== detailToken) return;
    detail.classList.remove('loading');
    detail.replaceChildren(commitDetail(c));
  }

  scroller.addEventListener('keydown', (e) => {
    const list = results || state.commits;
    if (!list.length) return;
    const cur = results ? results.findIndex((c) => c.sha === state.selected) : state.index.get(state.selected) ?? -1;
    const move = (d) => { e.preventDefault(); const n = Math.max(0, Math.min(list.length - 1, cur + d)); select(list[n].sha); };
    const c = list[cur];
    const id = keymap.match('map', e);
    switch (id) {
      case 'commit.checkoutBranch': if (!isEditable(e.target)) { e.preventDefault(); if (c) checkoutSelected(c); } break;
      case 'map.copySha': if (!window.getSelection().toString()) { e.preventDefault(); copy(state.selected, 'Copied SHA'); } break;
      case 'map.copyLink': e.preventDefault(); copyCommitLink(state.selected); break;
      case 'map.next': move(1); break;
      case 'map.prev': move(-1); break;
      case 'map.pageDown': move(Math.floor(scroller.clientHeight / ROW_H)); break;
      case 'map.pageUp': move(-Math.floor(scroller.clientHeight / ROW_H)); break;
      case 'map.first': move(-list.length); break;
      case 'map.last': move(list.length); break;
      case 'map.quick': if (results) { clearSearch(); select(c.sha, 'center'); } else openQuick(state.selected); e.preventDefault(); break;
      case 'map.detail': e.preventDefault(); toggleDetail(); break;
      case 'map.clearSearch': if (results) clearSearch(); break;
      case 'map.head': if (state.head.oid) select(state.head.oid, 'center'); break;
      default: if (c && id) commitShortcut(e, id, c);
    }
  });

  refresh();
  // Read the selection on the frame: a jump right after this view opens (a sidebar PR or branch) has moved it by then.
  requestAnimationFrame(() => { const i = state.index.get(state.selected); if (i != null) vl.scrollToIndex(i, 'center'); });
  scroller.focus({ preventScroll: true });

  return {
    refresh,
    grow,
    refreshPending,
    lastVisible: () => (results ? 0 : vl.range().last),
    isVisible: (sha) => { const i = state.index.get(sha); return !results && i != null && vl.rows.has(i); },
    select,
    pickFirstResult: () => { if (results?.length) { const sha = results[0].sha; clearSearch(); select(sha, 'center'); scroller.focus(); } },
    focus: () => scroller.focus(),
    destroy: () => vl.destroy(),
  };
}

function renderSidebarSelection() {
  if (!sidebarEl) return;
  sidebarEl.querySelectorAll('.sb-item.selected-ref').forEach((el) => el.classList.remove('selected-ref'));
}

function commitDetail(c) {
  const refs = state.byRef.get(c.sha) || [];
  const [subject, ...rest] = c.message.split('\n');
  const body = rest.join('\n').trim();
  const add = c.files.reduce((a, f) => a + f.add, 0), del = c.files.reduce((a, f) => a + f.del, 0);
  return h('div.detail-inner', null,
    h('div.detail-head', null,
      h('div.detail-actions', null,
        h('button.btn.subtle', { onclick: () => checkoutCommit(c) }, icon('checkout', 14), 'Checkout'),
        h('button.btn.subtle', { onclick: () => createBranch(c.sha) }, icon('branch', 14), 'Branch'),
        h('button.icon-btn', { title: 'More actions', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); commitMenu(r.left, r.bottom + 4, c); } }, icon('more')),
      ),
      h('h2.detail-title', null, subject),
      refs.length ? h('div.pills.wrap', null, refs.map(refPill)) : null,
      body ? h('pre.detail-body', null, body) : null,
    ),
    h('div.props', null,
      prop('Author', personLink(c.author, c.email)),
      c.coAuthors?.length ? prop('Co-authors', h('span.prop-people', null, c.coAuthors.map((p) => personLink(p.name, p.email)))) : null,
      c.committer !== c.author ? prop('Committer', personLink(c.committer, c.committerEmail)) : null,
      prop('Date', h('span', { title: fullDate(c.time) }, fullDate(c.time))),
      c.signature ? prop('Signature', signatureBadge(c.signature)) : null,
      prop('Commit', h('button.mono-link', { onclick: () => copy(c.sha, 'Copied SHA') }, c.sha.slice(0, 12), icon('copy', 12))),
      c.parents.length ? prop(c.parents.length > 1 ? 'Parents' : 'Parent', h('span.parents', null, c.parents.map((p) => h('button.mono-link', { onclick: () => go(() => selectCommit(p, 'center')) }, p.slice(0, 7))))) : null,
    ),
    h('div.files-head', null, h('span', null, `${c.files.length} file${c.files.length === 1 ? '' : 's'} changed`), h('span.stat', null, h('span.add', null, `+${add}`), h('span.del', null, `−${del}`)),
      h('button.btn.ghost.small', { onclick: () => openQuick(c.sha) }, 'Open', kbd(...keymap.keys('map.quick')))),
    h('div.file-list', null, c.files.slice(0, 500).map((f) => withHistoryMenu(fileRow(f, () => openQuick(c.sha, f.path)), f))),
  );
}

const SIGNATURE_LABELS = { good: 'Verified', expired: 'Expired', revoked: 'Revoked', bad: 'Bad signature', unverified: 'Signed, not verified' };
const SIGNATURE_TIPS = { unverified: 'Signed, but the key is not in your keyring or allowed signers file' };
const signatureBadge = ({ state, signer }) => h(`span.sig-badge.sig-${state}`, { title: [SIGNATURE_TIPS[state], signer].filter(Boolean).join(' · ') || null },
  SIGNATURE_LABELS[state], signer ? h('span.sig-signer', null, signer) : null);

const prop = (label, value) => h('div.prop', null, h('span.prop-label', null, label), h('span.prop-value', null, value));

function fileRow(f, onclick, extra) {
  const [name, dir] = fileName(f.path);
  return h('div.file-row', { onclick, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path },
    statusBadge(f.status),
    h('span.fname', null, name),
    f.lfs ? lfsBadge() : null,
    h('span.fdir', null, dir),
    f.add != null && (f.add || f.del) ? h('span.stat.small', null, f.add ? h('span.add', null, '+' + f.add) : null, f.del ? h('span.del', null, '−' + f.del) : null) : null,
    extra || null,
  );
}

// ---------------------------------------------------------------------------
// Quick view (full-height commit inspector)

// `back` is the file history the commit was opened from; Esc returns to it.
function openQuick(...args) { return go(() => openQuickNow(...args)); }
function openQuickNow(sha, path, back = null) {
  if (!sha) return;
  state.fileHistory = null;
  state.review = null;
  state.quick = { sha, path, back };
  renderTopbar();
  renderView();
}
function closeQuick(...args) { return go(() => closeQuickNow(...args)); }
function closeQuickNow() {
  const sha = state.quick?.sha;
  if (state.quick?.back) return openFileHistory(state.quick.back.path);
  state.quick = null;
  renderTopbar();
  renderView();
  if (sha) selectCommit(sha, 'center');
}

function quickView({ sha, path }) {
  const el = h('div.quick');
  const side = h('div.quick-side');
  const main = h('div.quick-main', null, loading('Loading commit…'));
  el.append(side, main);
  let files = [];
  let current = path;
  let full = false;

  (async () => {
    const c = await loadCommit(sha).catch((e) => { main.replaceChildren(h('div.empty', null, e.message)); return null; });
    if (!c) return;
    files = c.files;
    if (!current && files[0]) current = files[0].path;
    side.replaceChildren(
      h('div.quick-head', null,
        h('button.btn.ghost.small', { onclick: closeQuick }, icon('chevron', 12), 'Back', kbd(...keymap.keys('quick.close'))),
        h('div.quick-title', null, c.message.split('\n')[0]),
        h('div.quick-meta', null, avatar(c.author, c.email, 16), c.author, ' · ', timeAgo(c.time), ' · ', h('span.mono', null, c.sha.slice(0, 7))),
      ),
      h('div.file-list', null, files.map((f) => {
        const r = withHistoryMenu(fileRow(f, () => { current = f.path; full = false; renderFile(); markActive(); }), f);
        r.dataset.path = f.path;
        return r;
      })),
    );
    markActive();
    renderFile();
  })();

  function markActive() { side.querySelectorAll('.file-row').forEach((r) => r.classList.toggle('active', r.dataset.path === current)); }

  async function renderFile() {
    const f = files.find((x) => x.path === current);
    if (!f) { main.replaceChildren(h('div.empty', null, 'No changes in this commit')); return; }
    main.replaceChildren(loading('Loading diff…'));
    const c = await loadCommit(sha);
    if (state.quick?.sha === sha) Object.assign(state.quick, { file: f, parent: c.parents[0] || null });
    const d = await git('commitFileDiff', sha, fileRef(f), c.parents[0] || null).catch((e) => { toast('Diff failed', { kind: 'error', detail: e.message }); return null; });
    main.replaceChildren(
      h('div.diff-head', null, statusBadge(f.status), h('span.mono', null, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path), h('span.spacer'),
        h('span.stat.small', null, h('span.add', null, '+' + f.add), h('span.del', null, '−' + f.del))),
      h('div.diff-scroll', null, renderDiff(d, { full, onShowAll: () => { full = true; renderFile(); } })),
    );
  }

  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    const id = keymap.match('quick', e);
    if (id === 'quick.close') { e.preventDefault(); closeQuick(); }
    if (id === 'quick.next' || id === 'quick.prev') {
      e.preventDefault();
      const i = files.findIndex((f) => f.path === current);
      const n = Math.max(0, Math.min(files.length - 1, i + (id === 'quick.next' ? 1 : -1)));
      if (files[n]) { current = files[n].path; full = false; markActive(); renderFile(); side.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' }); }
    }
  });
  setTimeout(() => el.focus());
  return el;
}

// ---------------------------------------------------------------------------
// Split commit: pick the lines that become the first commit; the rest become the second.

async function openSplit(c) {
  if (!c) return;
  try { await git('checkSplit', c.sha); } catch (e) { toast('Can’t split this commit', { kind: 'error', detail: e.message }); return; }
  state.quick = null;
  state.fileHistory = null;
  state.review = null;
  state.split = { sha: c.sha };
  renderTopbar();
  renderView();
}
function closeSplit(select = true) {
  const sha = state.split?.sha;
  state.split = null;
  renderTopbar();
  renderView();
  if (select && sha) selectCommit(sha, 'center');
}

function splitView({ sha }) {
  const el = h('div.quick.split', { tabIndex: 0 });
  const side = h('div.quick-side.split-side');
  const files = h('div.file-list.split-files');
  const main = h('div.quick-main', null, loading('Loading commit…'));
  el.append(side, main);
  let diffs = [], current = null, full = false;
  const picked = new Map(); // path -> Set of line keys in the first commit
  const whole = new Set(); // files without lines (binary, mode-only) going whole into the first commit

  const changeKeys = (d) => d.hunks.flatMap((hk, hi) => hunkKeys(hk, hi));
  const fileState = (d) => {
    const total = changeKeys(d).length;
    const n = total ? picked.get(d.path).size : whole.has(d.path) ? 1 : 0;
    return n === 0 ? 'none' : n >= (total || 1) ? 'all' : 'some';
  };
  const statusOf = (d) => (d.header.some((l) => l.startsWith('new file')) ? 'A' : d.header.some((l) => l.startsWith('deleted file')) ? 'D' : 'M');

  const first = h('textarea.composer-input.split-msg', { placeholder: 'Message for the selected changes', spellcheck: true, rows: 3 });
  const second = h('textarea.composer-input.split-msg', { placeholder: 'Message for the remaining changes', spellcheck: true, rows: 3 });
  const summary = h('div.split-summary');
  const splitBtn = h('button.btn.primary.wide', { onclick: () => submit() }, 'Split commit', kbd(...keymap.keys('split.submit')));
  for (const t of [first, second]) {
    t.addEventListener('input', update);
    t.addEventListener('keydown', (e) => {
      const id = keymap.match('split', e);
      if (id === 'split.submit') { e.preventDefault(); submit(); }
      else if (id === 'split.leave') { e.preventDefault(); e.stopPropagation(); el.focus(); }
    });
  }

  function toggleFile(d) {
    const keys = changeKeys(d);
    const on = fileState(d) !== 'all';
    if (!keys.length) on ? whole.add(d.path) : whole.delete(d.path);
    else picked.set(d.path, new Set(on ? keys : []));
    renderFiles();
    if (d.path === current) renderFile();
    update();
  }

  function renderFiles() {
    files.replaceChildren(...diffs.map((d) => {
      const st = fileState(d);
      const box = h('input', { type: 'checkbox', title: 'Put the whole file in the first commit', checked: st === 'all', onclick: (e) => e.stopPropagation(), onchange: () => toggleFile(d) });
      box.indeterminate = st === 'some';
      const total = changeKeys(d).length;
      const row = fileRow({ path: d.path, status: statusOf(d) }, () => { current = d.path; full = false; renderFiles(); renderFile(); },
        h('span.split-count', null, total ? `${picked.get(d.path).size}/${total}` : ''));
      row.prepend(box);
      row.dataset.path = d.path;
      row.classList.toggle('active', d.path === current);
      return row;
    }));
  }

  function renderFile() {
    const d = diffs.find((x) => x.path === current);
    if (!d) return main.replaceChildren(h('div.empty', null, 'No changes in this commit'));
    const sel = picked.get(d.path);
    const hunkBtns = [];
    const label = (keys) => (keys.every((k) => sel.has(k)) ? 'Deselect hunk' : 'Select hunk');
    const onSelect = () => { hunkBtns.forEach(([b, keys]) => { b.textContent = label(keys); }); renderFiles(); update(); };
    const hunkActions = (hi, hunk) => {
      const keys = hunkKeys(hunk, hi);
      const b = h('button.btn.ghost.tiny', { onclick: () => { const all = keys.every((k) => sel.has(k)); keys.forEach((k) => (all ? sel.delete(k) : sel.add(k))); renderFile(); onSelect(); } }, label(keys));
      hunkBtns.push([b, keys]);
      return b;
    };
    main.replaceChildren(
      h('div.diff-head', null, statusBadge(statusOf(d)), h('span.mono', null, d.path), h('span.spacer'),
        h('button.btn.subtle.small', { onclick: () => toggleFile(d) }, fileState(d) === 'all' ? 'Deselect file' : 'Select file', kbd(...keymap.keys('split.toggleFile')))),
      h('div.diff-scroll', null, renderDiff(d, { selectable: true, selection: sel, onSelect, hunkActions, full, onShowAll: () => { full = true; renderFile(); } })),
      h('div.diff-hint', null, 'Selected lines go into the first commit, everything else into the second · Click lines to select · Shift-click for ranges · Drag to select several'),
    );
  }

  function selection() {
    const out = {};
    for (const d of diffs) {
      const st = fileState(d);
      if (st === 'all') out[d.path] = 'all';
      else if (st === 'some') out[d.path] = [...picked.get(d.path)];
    }
    return out;
  }

  function update() {
    const n = diffs.filter((d) => fileState(d) !== 'none').length;
    const allIn = diffs.length && diffs.every((d) => fileState(d) === 'all');
    summary.textContent = !n ? 'Select the changes for the first commit.' : allIn ? 'Leave at least one change for the second commit.' : `First commit: changes in ${n} of ${diffs.length} file${diffs.length > 1 ? 's' : ''}. The rest go into the second.`;
    summary.classList.toggle('warn', !n || !!allIn);
    splitBtn.disabled = !n || !!allIn || !first.value.trim() || !second.value.trim();
  }

  async function submit() {
    update();
    if (splitBtn.disabled) { (!first.value.trim() ? first : !second.value.trim() ? second : null)?.focus(); return; }
    const ok = await act('Split commit', 'rewrite', ['split', sha, { files: selection(), messages: [first.value, second.value] }], { busy: 'Splitting commit…' });
    if (ok) closeSplit(false);
  }

  (async () => {
    let c;
    try { [c, diffs] = await Promise.all([loadCommit(sha), git('commitDiffs', sha)]); } catch (e) { main.replaceChildren(h('div.empty', null, e.message)); return; }
    for (const d of diffs) picked.set(d.path, new Set());
    current = diffs[0]?.path || null;
    first.value = c.message;
    side.replaceChildren(
      h('div.quick-head', null,
        h('button.btn.ghost.small', { onclick: () => closeSplit() }, icon('chevron', 12), 'Back', kbd(...keymap.keys('global.close'))),
        h('div.quick-title', null, `Split “${c.message.split('\n')[0]}”`),
        h('div.quick-meta', null, avatar(c.author, c.email, 16), c.author, ' · ', timeAgo(c.time), ' · ', h('span.mono', null, c.sha.slice(0, 7))),
      ),
      files,
      h('div.composer.split-composer', null,
        h('label.field', null, h('span.field-label', null, h('span.split-dot.one'), 'First commit · selected changes'), first),
        h('label.field', null, h('span.field-label', null, h('span.split-dot.two'), 'Second commit · remaining changes'), second),
        summary, splitBtn),
    );
    renderFiles();
    renderFile();
    update();
    el.focus();
  })();

  el.addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;
    const id = keymap.match('split', e);
    const i = diffs.findIndex((d) => d.path === current);
    if (id === 'split.next' || id === 'split.prev') {
      e.preventDefault();
      const n = diffs[Math.max(0, Math.min(diffs.length - 1, i + (id === 'split.next' ? 1 : -1)))];
      if (n) { current = n.path; full = false; renderFiles(); renderFile(); files.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' }); }
    } else if (id === 'split.toggleFile' && diffs[i]) { e.preventDefault(); toggleFile(diffs[i]); }
    else if (id === 'split.message') { e.preventDefault(); (first.value.trim() ? second : first).focus(); }
  });
  return el;
}

// ---------------------------------------------------------------------------
// Commit actions (map actions)

const branchesAt = (sha) => state.refs.filter((r) => r.kind === 'branch' && r.target === sha);

function commitShortcut(e, id, c) {
  const run = {
    'commit.branch': () => createBranch(c.sha), 'commit.tag': () => createTag(c.sha), 'commit.merge': () => mergeCommit(c),
    'commit.rebase': () => rebaseOnto(c), 'commit.cherryPick': () => cherryPick(c), 'commit.revert': () => revertCommit(c),
    'commit.edit': () => editMessage(c), 'commit.squash': () => rewriteOp('squash', c), 'commit.fixup': () => rewriteOp('fixup', c),
    'commit.drop': () => rewriteOp('drop', c), 'commit.checkout': () => checkoutCommit(c), 'commit.diffHead': () => diffWithHead(c),
    'commit.worktree': () => addWorktree({ base: c.sha }), 'commit.split': () => openSplit(c), 'commit.author': () => openAuthor(c),
  }[id];
  if (run) { e.preventDefault(); run(); }
}

function commitMenu(x, y, c) {
  const locals = branchesAt(c.sha);
  const isHead = c.sha === state.head.oid;
  const remote = originRemote();
  contextMenu(x, y, [
    { label: 'Quick View', icon: 'eye', kbd: keymap.keys('map.quick'), run: () => openQuick(c.sha) },
    { label: 'Diff with HEAD', icon: 'diff', kbd: keymap.keys('commit.diffHead'), disabled: isHead, run: () => diffWithHead(c) },
    '-',
    ...(locals.length
      ? locals.map((b) => (worktreeOf(b.short)
        ? { label: `Switch to Worktree “${worktreeOf(b.short).name}”`, icon: 'worktree', run: () => switchWorktree(worktreeOf(b.short)) }
        : { label: `Checkout “${b.short}”`, icon: 'checkout', kbd: !isHead && b === locals.find((x) => x.short !== state.head.branch) ? [MOD, '↵'] : null, disabled: b.short === state.head.branch, run: () => checkout(b.short) }))
      : [{ label: 'Checkout (detached)', icon: 'checkout', kbd: keymap.keys('commit.checkout'), disabled: isHead && state.head.detached, run: () => checkoutCommit(c) }]),
    { label: 'Create Branch…', icon: 'branch', kbd: keymap.keys('commit.branch'), run: () => createBranch(c.sha) },
    { label: 'Create Tag…', icon: 'tag', kbd: keymap.keys('commit.tag'), run: () => createTag(c.sha) },
    { label: 'New Worktree Here…', icon: 'worktree', kbd: keymap.keys('commit.worktree'), run: () => addWorktree({ base: c.sha }) },
    state.head.branch && !isHead ? { label: `Move “${state.head.branch}” here`, icon: 'swap', run: () => setTip(state.head.branch, c) } : null,
    '-',
    { section: state.head.branch ? `Into ${state.head.branch}` : 'Into HEAD' },
    { label: 'Merge into Current', icon: 'merge', kbd: keymap.keys('commit.merge'), disabled: isHead, run: () => mergeCommit(c) },
    { label: 'Rebase Current onto This', icon: 'rebase', kbd: keymap.keys('commit.rebase'), disabled: isHead, run: () => rebaseOnto(c) },
    { label: 'Cherry-pick onto Current', icon: 'cherry', kbd: keymap.keys('commit.cherryPick'), disabled: isHead, run: () => cherryPick(c) },
    { label: 'Revert', icon: 'revert', kbd: keymap.keys('commit.revert'), run: () => revertCommit(c) },
    '-',
    { section: 'Rewrite' },
    { label: 'Edit Message…', icon: 'edit', kbd: keymap.keys('commit.edit'), run: () => editMessage(c) },
    { label: 'Squash with Parent', icon: 'squash', kbd: keymap.keys('commit.squash'), disabled: c.parents.length !== 1, run: () => rewriteOp('squash', c) },
    { label: 'Fixup with Parent', icon: 'squash', kbd: keymap.keys('commit.fixup'), disabled: c.parents.length !== 1, run: () => rewriteOp('fixup', c) },
    { label: 'Swap with Parent', icon: 'swap', disabled: c.parents.length !== 1, run: () => rewriteOp('swapParent', c) },
    { label: 'Split Commit…', icon: 'split', kbd: keymap.keys('commit.split'), disabled: c.parents.length > 1, run: () => openSplit(c) },
    { label: 'Delete Commit', icon: 'trash', kbd: keymap.keys('commit.drop'), danger: true, disabled: c.parents.length > 1, run: () => rewriteOp('drop', c) },
    '-',
    { label: 'Copy SHA', icon: 'copy', kbd: keymap.keys('map.copySha'), run: () => copy(c.sha, 'Copied SHA') },
    remote?.web ? { label: 'Copy Link to Commit', icon: 'copy', kbd: keymap.keys('map.copyLink'), run: () => copyCommitLink(c.sha) } : null,
    { label: 'Copy Message', icon: 'copy', run: async () => copy((await loadCommit(c.sha)).message, 'Copied message') },
    authorProfile(c.email, remote?.web) ? { label: 'View Author on GitHub', icon: 'external', kbd: keymap.keys('commit.author'), run: () => openAuthor(c) } : null,
    remote?.web ? { label: 'View on Hosting Service', icon: 'external', run: () => api.app('external', `${remote.web}/commit/${c.sha}`) } : null,
  ]);
}

function refMenu(x, y, r) {
  const items = [];
  if (r.kind === 'branch') {
    const cur = r.short === state.head.branch;
    const wt = worktreeOf(r.short);
    items.push(
      wt ? { label: `Switch to Worktree “${wt.name}”`, icon: 'worktree', run: () => switchWorktree(wt) } : { label: 'Checkout', icon: 'checkout', disabled: cur, run: () => checkout(r.short) },
      !wt && !cur ? { label: 'Open in New Worktree…', icon: 'worktree', run: () => addWorktree({ branch: r.short }) } : null,
      { label: `Merge into ${state.head.branch || 'HEAD'}`, icon: 'merge', disabled: cur, run: () => act(`Merge ${r.short}`, 'merge', [r.short]) },
      { label: `Rebase ${state.head.branch || 'HEAD'} onto ${r.short}`, icon: 'rebase', disabled: cur, run: () => act(`Rebase onto ${r.short}`, 'rebaseOnto', [r.short]) },
      '-',
      state.prs?.active && !prFor(r) ? { label: 'New Pull Request…', icon: 'plus', kbd: cur ? [MOD, '⌥', '⇧', 'N'] : null, run: () => createPr(r.short) } : null,
      state.prs?.active && !prFor(r) ? '-' : null,
      { label: 'Rename…', icon: 'edit', run: () => renameBranch(r) },
      { label: 'Copy Name', icon: 'copy', run: () => copy(r.short, 'Copied branch name') },
      '-',
      { label: 'Delete Branch', icon: 'trash', danger: true, disabled: cur, run: () => deleteBranch(r) },
    );
  } else if (r.kind === 'remote') {
    items.push(
      { label: 'Checkout as Local Branch', icon: 'checkout', run: () => act(`Checkout ${r.short}`, 'checkoutTracking', [r.short]) },
      { label: 'Open in New Worktree…', icon: 'worktree', run: () => addWorktree({ base: r.short, branch: r.short.slice(r.short.indexOf('/') + 1) }) },
      { label: `Merge into ${state.head.branch || 'HEAD'}`, icon: 'merge', run: () => act(`Merge ${r.short}`, 'merge', [r.short]) },
      { label: 'Copy Name', icon: 'copy', run: () => copy(r.short, 'Copied') },
      '-',
      { label: 'Delete Remote Branch…', icon: 'trash', danger: true, run: async () => { if (await confirm(`Delete ${r.short} on the remote?`, 'This pushes a deletion to the remote and cannot be undone from here.', { submit: 'Delete' })) act(`Delete ${r.short}`, 'deleteRemoteBranch', [r.short], { busy: 'Deleting remote branch…', undoable: false }); } },
    );
  } else if (r.kind === 'tag') {
    items.push(
      { label: 'Copy Name', icon: 'copy', run: () => copy(r.short, 'Copied') },
      { label: 'Push All Tags', icon: 'push', run: () => act('Push tags', 'pushTags', [], { busy: 'Pushing tags…', undoable: false }) },
      '-',
      { label: 'Delete Tag', icon: 'trash', danger: true, run: () => act(`Delete tag ${r.short}`, 'deleteTag', [r.short]) },
    );
  }
  contextMenu(x, y, items);
}

async function copy(text, msg) { await api.app('copy', text); toast(msg); }

function checkout(branch) {
  const wt = worktreeOf(branch);
  if (wt) return toast(`${branch} is checked out in worktree “${wt.name}”`, { kind: 'error', detail: 'A branch can only be checked out in one worktree at a time.', action: { label: 'Switch', run: () => switchWorktree(wt) } });
  return act(`Checkout ${branch}`, 'checkout', [branch], { success: `Switched to ${branch}` });
}
function checkoutCommit(c) {
  const b = branchesAt(c.sha).find((x) => x.short !== state.head.branch);
  if (b) return checkout(b.short);
  return act(`Checkout ${c.sha.slice(0, 7)}`, 'checkout', [c.sha], { success: `HEAD detached at ${c.sha.slice(0, 7)}` });
}
// ⌘↵ / double-click on a map row. Already at HEAD: nothing to do.
function checkoutSelected(c) {
  if (c.sha !== state.head.oid) return checkoutCommit(c);
}
async function createBranch(sha) {
  const v = await dialog({ title: 'Create branch', description: `At ${sha.slice(0, 7)}`, submit: 'Create branch', fields: [{ name: 'name', label: 'Name', placeholder: 'feature/my-branch' }, { name: 'co', type: 'checkbox', label: 'Check out after creating', value: true }] });
  if (!v || !v.name.trim()) return;
  act(`Create branch ${v.name.trim()}`, 'createBranch', [v.name.trim(), sha, v.co]);
}
async function createTag(sha) {
  const v = await dialog({ title: 'Create tag', description: `At ${sha.slice(0, 7)}`, submit: 'Create tag', fields: [{ name: 'name', label: 'Name', placeholder: 'v1.0.0' }, { name: 'msg', label: 'Message (optional, makes it annotated)', multiline: true, rows: 3 }] });
  if (!v || !v.name.trim()) return;
  act(`Create tag ${v.name.trim()}`, 'createTag', [v.name.trim(), sha, v.msg.trim() || null]);
}
async function renameBranch(r) {
  const name = await prompt('Rename branch', { label: 'New name', value: r.short, submit: 'Rename' });
  if (name && name !== r.short) act(`Rename ${r.short}`, 'renameBranch', [r.short, name]);
}
async function deleteBranch(r) {
  act(`Delete branch ${r.short}`, 'deleteBranch', [r.short]);
}
async function setTip(branch, c) {
  act(`Move ${branch} to ${c.sha.slice(0, 7)}`, 'setBranchTip', [branch, c.sha]);
}
function mergeCommit(c) {
  if (c.sha === state.head.oid) return;
  const b = branchesAt(c.sha)[0] || state.refs.find((r) => r.kind === 'remote' && r.target === c.sha);
  act(`Merge ${b ? b.short : c.sha.slice(0, 7)}`, 'merge', [b ? b.short : c.sha]);
}
function rebaseOnto(c) {
  if (c.sha === state.head.oid) return;
  act(`Rebase onto ${c.sha.slice(0, 7)}`, 'rebaseOnto', [c.sha], { busy: 'Rebasing…' });
}
function cherryPick(c) { act(`Cherry-pick ${c.sha.slice(0, 7)}`, 'cherryPick', [c.sha]); }
function revertCommit(c) { act(`Revert ${c.sha.slice(0, 7)}`, 'revert', [c.sha]); }
async function editMessage(c) {
  const full = await loadCommit(c.sha);
  const msg = await prompt('Edit commit message', { value: full.message, multiline: true, submit: 'Save', description: `${c.sha.slice(0, 7)} · descendants will be rewritten` });
  if (msg && msg !== full.message) act('Edit message', 'rewrite', ['reword', c.sha, { message: msg + '\n' }], { busy: 'Rewriting history…' });
}
function rewriteOp(op, c) {
  const label = { squash: 'Squash with parent', fixup: 'Fixup with parent', swapParent: 'Swap with parent', drop: 'Delete commit' }[op];
  act(label, 'rewrite', [op, c.sha], { busy: 'Rewriting history…' });
}
async function diffWithHead(c) {
  if (!state.head.oid || c.sha === state.head.oid) return;
  const diffs = await git('compare', c.sha, 'HEAD').catch((e) => { toast('Diff failed', { kind: 'error', detail: e.message }); return null; });
  if (!diffs) return;
  state.quick = null;
  contentEl.replaceChildren(h('div.compare', null,
    h('div.diff-head', null, h('button.btn.ghost.small', { onclick: () => renderView() }, icon('chevron', 12), 'Back', kbd(...keymap.keys('diff.close'))),
      h('span.mono', null, `${c.sha.slice(0, 7)} → HEAD`), h('span.spacer'), h('span.muted', null, `${diffs.length} files`)),
    h('div.diff-scroll', { tabIndex: 0, onkeydown: (e) => { if (keymap.match('diff', e) === 'diff.close') renderView(); } }, diffs.map((d) => h('div.diff-file', null, h('div.diff-file-head', null, h('span.mono', null, d.newPath === '/dev/null' ? d.oldPath : d.newPath)), renderDiff(d)))),
  ));
  contentEl.querySelector('.diff-scroll').focus();
}

// ---------------------------------------------------------------------------
// Commit view (stage / unstage / partial lines / commit)

function draftKey() { return 'draft:' + state.repo.root; }

function createCommitView(container) {
  const el = h('div.commit-view');
  const side = h('div.cv-side');
  const lists = h('div.cv-lists');
  const diffPane = h('div.cv-diff');
  const textarea = h('textarea.composer-input', { placeholder: 'Commit message', spellcheck: true, rows: 4 });
  textarea.value = localStorage.getItem(draftKey()) || '';
  textarea.addEventListener('input', () => { try { localStorage.setItem(draftKey(), textarea.value); } catch { /* ignore */ } updateCommitBtn(); });
  textarea.addEventListener('keydown', (e) => { if (keymap.match('message', e) === 'message.commit') { e.preventDefault(); doCommit(); } });
  const amend = h('input', { type: 'checkbox', checked: state.amend, onchange: async (e) => {
    state.amend = e.target.checked;
    if (state.amend && !textarea.value.trim() && state.head.oid) { textarea.value = (await loadCommit(state.head.oid)).message; }
    updateCommitBtn();
  } });
  const commitBtn = h('button.btn.primary.wide', { onclick: () => doCommit() }, 'Commit', kbd(...keymap.keys('message.commit')));
  // Only shown once the user has turned AI commit messages on.
  const aiBtn = h('button.icon-btn.ai-btn', { title: tip('Write message with AI', 'repo.aiMessage'), hidden: !aiOn(), onclick: () => writeMessageWithAi() }, icon('sparkle', 15));
  const composer = h('div.composer', null, textarea, h('div.composer-row', null, h('label.check.small', null, amend, h('span', null, 'Amend last commit')), h('span.spacer'), aiBtn, commitBtn));
  side.append(lists, composer);
  el.append(side, diffPane);
  container.append(el);

  function updateCommitBtn() {
    const can = textarea.value.trim() && (state.status.staged.length || state.amend) && !state.status.conflicts.length;
    commitBtn.disabled = !can;
    commitBtn.firstChild.textContent = state.amend ? 'Amend' : `Commit${state.status.staged.length ? ` ${state.status.staged.length} file${state.status.staged.length > 1 ? 's' : ''}` : ''}`;
  }

  async function doCommit() {
    updateCommitBtn();
    if (commitBtn.disabled) { if (!textarea.value.trim()) textarea.focus(); return; }
    if (!(await identityOk())) return;
    const ok = await act(state.amend ? 'Amend commit' : 'Commit', 'createCommit', [textarea.value.trim() + '\n', state.amend], { success: state.amend ? 'Amended commit' : 'Committed' });
    if (ok) {
      textarea.value = '';
      try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
      state.amend = false; amend.checked = false;
      updateCommitBtn();
    }
  }

  const section = (title, files, list, actions) => h('div.cv-section', null,
    h('div.cv-section-head', null, h('span', null, title), h('span.sb-count', null, files.length), h('span.spacer'), actions),
    files.length ? h('div.file-list', null, files.map((f) => {
      const row = fileRow(f, (e) => clickFile(e, list, f.path), h('span.row-actions', null,
        list === 'unstaged' ? [
          h('button.icon-btn.tiny', { title: 'Discard changes', onclick: (e) => { e.stopPropagation(); discard(targets(list, f)); } }, icon('trash', 13)),
          h('button.icon-btn.tiny', { title: 'Stage', onclick: (e) => { e.stopPropagation(); quiet('stageFiles', paths(targets(list, f))); } }, icon('plus', 13)),
        ] : list === 'staged' ? [
          h('button.icon-btn.tiny', { title: 'Unstage', onclick: (e) => { e.stopPropagation(); quiet('unstageFiles', paths(targets(list, f))); } }, icon('minus', 13)),
        ] : [
          h('button.btn.ghost.tiny', { title: 'Use our version', onclick: (e) => { e.stopPropagation(); chooseSide(f.path, 'ours'); } }, 'Ours'),
          h('button.btn.ghost.tiny', { title: 'Use their version', onclick: (e) => { e.stopPropagation(); chooseSide(f.path, 'theirs'); } }, 'Theirs'),
          h('button.icon-btn.tiny', { title: 'Mark as resolved', onclick: (e) => { e.stopPropagation(); quiet('markResolved', f.path); } }, icon('check', 13)),
        ]));
      row.dataset.list = list; row.dataset.path = f.path;
      row.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
      row.addEventListener('dblclick', (e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) return;
        if (list === 'unstaged') quiet('stageFiles', [f.path]); else if (list === 'staged') quiet('unstageFiles', [f.path]);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (list !== state.cv.list || !state.cv.sel.has(f.path)) selectFile(list, f.path);
        const t = targets(list, f);
        if (t.length > 1) {
          const n = `${t.length} Files`;
          return contextMenu(e.clientX, e.clientY, [
            list === 'unstaged' ? { label: `Stage ${n}`, icon: 'plus', kbd: keymap.keys('cv.stage'), run: () => quiet('stageFiles', paths(t)) } : null,
            list === 'staged' ? { label: `Unstage ${n}`, icon: 'minus', kbd: keymap.keys('cv.stage'), run: () => quiet('unstageFiles', paths(t)) } : null,
            list === 'conflicts' ? { label: 'Open in Mergetool', icon: 'merge', kbd: keymap.keys('repo.mergetool'), run: () => openMergetool(paths(t)) } : null,
            { label: 'Copy Paths', icon: 'copy', run: () => copy(paths(t).join('\n'), 'Copied paths') },
            list !== 'conflicts' ? { label: `Stash ${n}…`, icon: 'stash', run: () => stashSave({ paths: t.flatMap((x) => (x.oldPath ? [x.path, x.oldPath] : [x.path])), untracked: t.some((x) => x.status === '?') }) } : null,
            list === 'unstaged' ? '-' : null,
            list === 'unstaged' ? { label: `Discard Changes to ${n}…`, icon: 'trash', danger: true, kbd: keymap.keys('cv.discard'), run: () => discard(t) } : null,
          ]);
        }
        contextMenu(e.clientX, e.clientY, [
          list === 'unstaged' ? { label: 'Stage', icon: 'plus', kbd: keymap.keys('cv.stage'), run: () => quiet('stageFiles', [f.path]) } : null,
          list === 'staged' ? { label: 'Unstage', icon: 'minus', kbd: keymap.keys('cv.stage'), run: () => quiet('unstageFiles', [f.path]) } : null,
          list === 'conflicts'
            ? { label: 'Open in Mergetool', icon: 'merge', kbd: keymap.keys('repo.mergetool'), run: () => openMergetool([f.path]) }
            : f.status !== '?' ? { label: 'Open in Difftool', icon: 'diff', kbd: keymap.keys('repo.difftool'), run: () => openDifftool({ file: f, args: [list === 'staged'] }) } : null,
          f.status !== '?' ? { label: 'File History & Blame', icon: 'history', kbd: keymap.keys('repo.fileHistory'), run: () => openFileHistory(f.path) } : null,
          { label: 'Open', icon: 'file', run: () => api.app('open-file', f.path) },
          { label: 'Reveal in Finder', icon: 'folder', run: () => api.app('reveal', f.path) },
          { label: 'Copy Path', icon: 'copy', run: () => copy(f.path, 'Copied path') },
          list !== 'conflicts' ? { label: 'Stash File…', icon: 'stash', run: () => stashSave({ paths: f.oldPath ? [f.path, f.oldPath] : [f.path], untracked: f.status === '?' }) } : null,
          list === 'unstaged' ? '-' : null,
          list === 'unstaged' ? { label: 'Discard Changes…', icon: 'trash', danger: true, kbd: keymap.keys('cv.discard'), run: () => discard([f]) } : null,
        ]);
      });
      return row;
    })) : h('div.cv-empty', null, list === 'staged' ? 'No staged changes' : 'Working tree clean'),
  );

  function renderLists() {
    const { staged, unstaged, conflicts } = state.status;
    lists.replaceChildren(...[
      conflicts.length ? section('Conflicts', conflicts, 'conflicts', h('button.btn.ghost.tiny', { title: tip('Open in your mergetool', 'repo.mergetool'), onclick: () => openMergetool([]) }, 'Mergetool')) : null,
      section('Unstaged', unstaged, 'unstaged', unstaged.length ? [
        h('button.btn.ghost.tiny', { onclick: () => discard(unstaged) }, 'Discard all'),
        h('button.btn.ghost.tiny', { onclick: () => quiet('stageFiles', unstaged.map((f) => f.path)) }, 'Stage all'),
      ] : null),
      section('Staged', staged, 'staged', staged.length ? [
        h('button.btn.ghost.tiny', { title: tip('Stash only the staged changes', 'repo.stashStaged'), onclick: () => stashSave({ staged: true }) }, 'Stash'),
        h('button.btn.ghost.tiny', { onclick: () => quiet('unstageFiles', staged.map((f) => f.path)) }, 'Unstage all'),
      ] : null),
    ].filter(Boolean));
    // Files that were staged, unstaged or discarded drop out of the selection.
    const left = new Set(paths(listFiles(state.cv.list)));
    state.cv.sel = new Set([...state.cv.sel].filter((p) => left.has(p)));
    markSelection();
    updateCommitBtn();
  }

  // Multi-select: `sel` holds the selected paths of `state.cv.list`; the diff pane shows `state.cv.path`.
  const listFiles = (list) => state.status[list] || [];
  const paths = (files) => files.map((f) => f.path);
  const selected = () => listFiles(state.cv.list).filter((f) => state.cv.sel.has(f.path));
  // A row action applies to the whole selection when the row is part of it, otherwise to that row only.
  const targets = (list, f) => (list === state.cv.list && state.cv.sel.size > 1 && state.cv.sel.has(f.path) ? selected() : [f]);

  function markSelection() {
    const many = state.cv.sel.size > 1;
    lists.classList.toggle('multi', many);
    lists.querySelectorAll('.file-row').forEach((r) => {
      const mine = r.dataset.list === state.cv.list;
      r.classList.toggle('active', mine && r.dataset.path === state.cv.path);
      r.classList.toggle('selected', many && mine && state.cv.sel.has(r.dataset.path));
    });
  }

  function selectFile(list, path, keep = false) {
    if (state.cv.list !== list || state.cv.path !== path) { state.cv.lines = new Set(); state.cv.full = false; }
    if (!keep) { state.cv.sel = new Set([path]); state.cv.anchor = path; }
    state.cv.list = list; state.cv.path = path;
    markSelection();
    renderDiffPane();
  }

  // Shift selects a range from the anchor, Cmd toggles one file. Both stay inside one list.
  function selectRange(list, path) {
    const all = paths(listFiles(list));
    const a = all.indexOf(state.cv.anchor), b = all.indexOf(path);
    if (list !== state.cv.list || a === -1 || b === -1) return selectFile(list, path);
    state.cv.sel = new Set(all.slice(Math.min(a, b), Math.max(a, b) + 1));
    selectFile(list, path, true);
  }
  function clickFile(e, list, path) {
    if (e.shiftKey) return selectRange(list, path);
    if (!(e.metaKey || e.ctrlKey) || list !== state.cv.list) return selectFile(list, path);
    const sel = new Set(state.cv.sel);
    if (sel.has(path) && sel.size > 1) sel.delete(path); else sel.add(path);
    state.cv.sel = sel; state.cv.anchor = path;
    selectFile(list, sel.has(path) ? path : paths(listFiles(list)).find((p) => sel.has(p)), true);
  }
  function selectAll() {
    const all = paths(listFiles(state.cv.list));
    if (!all.length) return;
    state.cv.sel = new Set(all);
    selectFile(state.cv.list, all.includes(state.cv.path) ? state.cv.path : all[0], true);
  }

  async function discard(files) {
    const what = files.length === 1 ? baseName(files[0].path) : `${files.length} files`;
    if (!(await confirm(`Discard changes to ${what}?`, `The changes are removed from your working tree. You can undo this with ${MOD}Z.`, { submit: 'Discard' }))) return;
    act(`Discard changes to ${what}`, 'discardFiles', [files.map(fileRef)]);
  }

  function chooseSide(p, side) {
    act(`Use ${side === 'ours' ? 'our' : 'their'} version of ${baseName(p)}`, 'chooseSide', [p, side]);
  }

  async function renderConflict(file, token) {
    const info = await git('conflict', file.path).catch((e) => { toast('Couldn’t read the conflict', { kind: 'error', detail: e.message }); return null; });
    if (token !== diffToken) return;
    if (!info) { conflictEd = null; diffPane.replaceChildren(); return; }
    // A status refresh with the file unchanged keeps the editor (and its scroll) as it is.
    const cur = conflictEd?.info;
    if (cur && cur.path === info.path && cur.kind === info.kind && cur.text === info.text && diffPane.contains(conflictEd.el)) return;
    conflictEd = conflictEditor(info, {
      mod: MOD,
      badge: h('span', null, statusBadge(file.status), file.lfs ? lfsBadge() : null),
      onResolve: (text) => act(`Resolve conflicts in ${baseName(file.path)}`, 'resolveConflict', [file.path, text]),
      onSide: (side) => chooseSide(file.path, side),
      onMergetool: () => openMergetool([file.path]),
    });
    diffPane.replaceChildren(conflictEd.el);
  }

  let diffToken = 0;
  async function renderDiffPane() {
    const { list, path } = state.cv;
    const file = (state.status[list] || []).find((f) => f.path === path);
    if (!file) {
      conflictEd = null;
      // After resolving a file, move on to the next conflicted one.
      if (list === 'conflicts' && state.status.conflicts[0]) return selectFile('conflicts', state.status.conflicts[0].path);
      const any = state.status.unstaged[0] ? ['unstaged', state.status.unstaged[0]] : state.status.staged[0] ? ['staged', state.status.staged[0]] : state.status.conflicts[0] ? ['conflicts', state.status.conflicts[0]] : null;
      if (any) return selectFile(any[0], any[1].path);
      diffPane.replaceChildren(h('div.empty.big', null, icon('check', 28), h('div', null, 'Nothing to commit'), h('div.muted', null, 'Your working tree matches HEAD.')));
      return;
    }
    const token = ++diffToken;
    if (list === 'conflicts') return renderConflict(file, token);
    conflictEd = null;
    const d = await git('workingDiff', fileRef(file), list === 'staged').catch((e) => { toast('Diff failed', { kind: 'error', detail: e.message }); return null; });
    if (token !== diffToken) return;
    state.cv.diff = d;
    // Drop selections that no longer exist.
    if (d) {
      const valid = new Set();
      d.hunks.forEach((hk, hi) => hk.lines.forEach((l, li) => { if (l.t !== ' ') valid.add(`${hi}:${li}`); }));
      for (const k of state.cv.lines) if (!valid.has(k)) state.cv.lines.delete(k);
    }
    const sel = state.cv.lines;
    const bar = h('div.sel-bar');
    const updateBar = () => {
      bar.replaceChildren();
      if (!sel.size || list === 'conflicts') return;
      bar.append(h('span.muted', null, `${sel.size} line${sel.size > 1 ? 's' : ''} selected`),
        list === 'unstaged' ? h('button.btn.ghost.small', { onclick: () => lineOp('discardLines') }, 'Discard') : null,
        list === 'unstaged' ? h('button.btn.ghost.small', { onclick: () => lineOp('stashLines') }, 'Stash') : null,
        h('button.btn.primary.small', { onclick: () => lineOp(list === 'unstaged' ? 'stageLines' : 'unstageLines') }, list === 'unstaged' ? 'Stage lines' : 'Unstage lines'),
        h('button.icon-btn.tiny', { title: 'Clear selection', onclick: () => { sel.clear(); renderDiffPane(); } }, icon('x', 13)),
      );
    };
    async function lineOp(method, keys = [...sel], hunk = false) {
      if (method === 'discardLines') {
        const what = hunk ? 'hunk' : `${keys.length} line${keys.length > 1 ? 's' : ''}`;
        if (!(await confirm(`Discard selected ${what}?`, `The changes are removed from your working tree. You can undo this with ${MOD}Z.`, { submit: 'Discard' }))) return;
        sel.clear();
        await act(`Discard ${what} in ${baseName(file.path)}`, 'discardLines', [fileRef(file), keys]);
        return;
      }
      if (method === 'stashLines') {
        const what = hunk ? 'hunk' : `${keys.length} line${keys.length > 1 ? 's' : ''}`;
        const v = await dialog({ title: `Stash selected ${what}`, submit: 'Stash', fields: [{ name: 'msg', label: 'Message', placeholder: 'WIP' }] });
        if (!v) return;
        sel.clear();
        await act(`Stash ${what} in ${baseName(file.path)}`, 'stashLines', [fileRef(file), keys, v.msg.trim()], { undoable: false });
        return;
      }
      try { await git(method, fileRef(file), keys); } catch (e) { toast('Could not apply partial change', { kind: 'error', detail: e.message }); }
      sel.clear();
      await refreshStatus();
    }
    const hunkActions = list === 'conflicts' ? null : (hi, hunk) => [
      list === 'unstaged' ? h('button.btn.ghost.tiny', { onclick: () => lineOp('discardLines', hunkKeys(hunk, hi), true) }, 'Discard hunk') : null,
      list === 'unstaged' ? h('button.btn.ghost.tiny', { onclick: () => lineOp('stashLines', hunkKeys(hunk, hi), true) }, 'Stash hunk') : null,
      h('button.btn.ghost.tiny', { onclick: () => lineOp(list === 'unstaged' ? 'stageLines' : 'unstageLines', hunkKeys(hunk, hi)) }, list === 'unstaged' ? 'Stage hunk' : 'Unstage hunk'),
    ];
    diffPane.replaceChildren(...[
      h('div.diff-head', null, statusBadge(file.status), h('span.mono', null, file.oldPath ? `${file.oldPath} → ${file.path}` : file.path), file.lfs ? lfsBadge() : null, h('span.spacer'), bar,
        list === 'conflicts' ? null : h('button.btn.subtle.small', { onclick: () => quiet(list === 'unstaged' ? 'stageFiles' : 'unstageFiles', [file.path]) }, list === 'unstaged' ? 'Stage file' : 'Unstage file'),
        h('button.icon-btn', { title: 'Open file', onclick: () => api.app('open-file', file.path) }, icon('external', 14)),
      ),
      h('div.diff-scroll', null, renderDiff(d, { selectable: list !== 'conflicts', selection: sel, onSelect: updateBar, hunkActions, full: state.cv.full, onShowAll: () => { state.cv.full = true; renderDiffPane(); } })),
      list !== 'conflicts' ? h('div.diff-hint', null, 'Click lines to select · Shift-click for ranges · Drag to select several') : null,
    ].filter(Boolean));
    updateBar();
  }

  el.addEventListener('keydown', (e) => {
    if (e.target === textarea) return;
    if (state.cv.list === 'conflicts' && conflictEd?.key(e)) return;
    if (e.target.tagName === 'TEXTAREA') return;
    const all = [...state.status.conflicts.map((f) => ['conflicts', f]), ...state.status.unstaged.map((f) => ['unstaged', f]), ...state.status.staged.map((f) => ['staged', f])];
    const i = all.findIndex(([l, f]) => l === state.cv.list && f.path === state.cv.path);
    const id = keymap.match('commit', e);
    const step = { 'cv.next': 1, 'cv.prev': -1, 'cv.extendNext': 1, 'cv.extendPrev': -1 }[id];
    if (id === 'cv.selectAll') {
      if (isEditable(e.target)) return;
      e.preventDefault(); selectAll();
    } else if (step) {
      e.preventDefault();
      const n = all[Math.max(0, Math.min(all.length - 1, i + step))];
      // Shift+arrows extend the selection, but never across into another list.
      if (n && (id === 'cv.extendNext' || id === 'cv.extendPrev')) { if (n[0] === state.cv.list) selectRange(n[0], n[1].path); } else if (n) selectFile(n[0], n[1].path);
      lists.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' });
    } else if (id === 'cv.single' && state.cv.sel.size > 1) {
      e.preventDefault(); selectFile(state.cv.list, state.cv.path);
    } else if (id === 'cv.stage' && i !== -1) {
      e.preventDefault();
      const [l, f] = all[i];
      if (l === 'unstaged') quiet('stageFiles', paths(targets(l, f))); else if (l === 'staged') quiet('unstageFiles', paths(targets(l, f)));
    } else if (id === 'cv.discard' && i !== -1 && all[i][0] === 'unstaged') {
      e.preventDefault(); discard(targets('unstaged', all[i][1]));
    } else if (id === 'cv.message') {
      e.preventDefault(); textarea.focus();
    }
  });
  el.tabIndex = 0;

  renderLists();
  renderDiffPane();
  setTimeout(() => el.focus({ preventScroll: true }));
  return {
    refresh: () => { renderLists(); renderDiffPane(); },
    selectAll,
  };
}

// ---------------------------------------------------------------------------
// Stashes

function stashesView() {
  const el = h('div.split-view');
  const list = h('div.list-pane');
  const detail = h('div.detail-pane');
  el.append(list, detail);
  let current = state.stashes[0]?.ref;
  function renderList() {
    list.replaceChildren(
      h('div.pane-head', null, h('span', null, 'Stashes'), h('span.sb-count', null, state.stashes.length), h('span.spacer'), h('button.btn.subtle.small', { onclick: () => stashSave() }, icon('plus', 13), 'Stash changes')),
      state.stashes.length ? h('div', null, state.stashes.map((s) => h('div.list-row' + (s.ref === current ? '.active' : ''), {
        onclick: () => { current = s.ref; renderList(); renderDetail(); },
        oncontextmenu: (e) => { e.preventDefault(); stashMenu(e.clientX, e.clientY, s); },
      }, icon('stash', 14), h('div.list-main', null, h('div.list-title', null, s.message), h('div.list-sub', null, s.ref)), h('span.when', null, timeAgo(s.time))))) :
        h('div.empty.big', null, icon('stash', 28), h('div', null, 'No stashes'), h('div.muted', null, `Stash uncommitted changes with ${keyText('repo.stash')}`)),
    );
  }
  async function renderDetail() {
    const s = state.stashes.find((x) => x.ref === current);
    if (!s) return detail.replaceChildren();
    detail.replaceChildren(loading('Loading diff…'));
    const diffs = await git('compare', `${s.sha}^1`, s.sha).catch(() => []);
    if (s.ref !== current) return;
    detail.replaceChildren(
      h('div.diff-head', null, h('span.title', null, s.message), h('span.spacer'),
        h('button.btn.ghost.small', { onclick: () => dropStash(s) }, 'Drop'),
        h('button.btn.subtle.small', { onclick: () => act(`Apply ${s.ref}`, 'stashApply', [s.ref, false]) }, 'Apply'),
        h('button.btn.primary.small', { onclick: () => act(`Pop ${s.ref}`, 'stashApply', [s.ref, true]) }, 'Pop')),
      h('div.diff-scroll', null, diffs.length ? diffs.map((d) => h('div.diff-file', null, h('div.diff-file-head', null, h('span.mono', null, d.newPath === '/dev/null' ? d.oldPath : d.newPath)), renderDiff(d))) : h('div.empty', null, 'Untracked files only')),
    );
  }
  function stashMenu(x, y, s) {
    contextMenu(x, y, [
      { label: 'Apply', icon: 'check', run: () => act(`Apply ${s.ref}`, 'stashApply', [s.ref, false]) },
      { label: 'Pop', icon: 'pull', run: () => act(`Pop ${s.ref}`, 'stashApply', [s.ref, true]) },
      '-',
      { label: 'Drop…', icon: 'trash', danger: true, run: () => dropStash(s) },
    ]);
  }
  // ↑/↓ move the selection through the list.
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    const step = { 'stashes.next': 1, 'stashes.prev': -1 }[keymap.match('stashes', e)];
    if (!step || isEditable(e.target) || !state.stashes.length) return;
    e.preventDefault();
    const i = state.stashes.findIndex((x) => x.ref === current);
    const n = state.stashes[Math.max(0, Math.min(state.stashes.length - 1, i < 0 ? 0 : i + step))];
    if (n.ref === current) return;
    current = n.ref;
    renderList();
    renderDetail();
    list.querySelector('.list-row.active')?.scrollIntoView({ block: 'nearest' });
  });
  renderList();
  renderDetail();
  setTimeout(() => el.focus({ preventScroll: true }));
  return el;
}

async function dropStash(s) {
  if (await confirm(`Drop ${s.ref}?`, `${s.message}\n\nYou can undo this with ${MOD}Z.`, { submit: 'Drop' })) act(`Drop ${s.ref} (${s.message})`, 'stashDrop', [s.ref]);
}

// Stash everything, only the staged changes, or only `paths`. Lines and hunks stash from the diff pane.
// `untracked` forces -u (an untracked path is unknown to git without it), so the checkbox is hidden.
async function stashSave({ staged = false, paths = null, untracked = false } = {}) {
  const what = staged ? 'staged changes' : paths ? (paths.length === 1 ? baseName(paths[0]) : `${paths.length} files`) : 'changes';
  if (staged && !state.status?.staged?.length) return toast('Nothing staged to stash');
  const fields = [{ name: 'msg', label: 'Message', placeholder: 'WIP' }];
  if (!staged && !untracked) fields.push({ name: 'u', type: 'checkbox', label: 'Include untracked files', value: true });
  const v = await dialog({ title: `Stash ${what}`, submit: 'Stash', fields });
  if (v) act(`Stash ${what}`, 'stashSave', [v.msg.trim(), untracked || !!v.u, { staged, paths }], { undoable: false });
}

// ---------------------------------------------------------------------------
// Snapshots (undo history)

function snapshotsView() {
  const { undo: u, redo: r, undoCount, redoCount } = state.history;
  const entries = [...[...r].map((e) => ({ ...e, redo: true })), ...[...u].reverse()];
  const hidden = undoCount - u.length + redoCount - r.length;
  const more = () => { state.historyLimit += 500; refreshHistory(); };
  return h('div.page', null,
    h('div.page-head', null,
      h('div', null, h('h1', null, 'Snapshots'), h('p.muted', null, 'Every operation that moves a branch, tag or HEAD, discards changes or drops a stash is recorded. Undo, redo, or restore any earlier state.')),
      h('div.page-actions', null,
        h('button.btn.subtle', { disabled: !u.length, onclick: undo }, icon('undo', 14), 'Undo', kbd(...keymap.keys('edit.undo'))),
        h('button.btn.subtle', { disabled: !r.length, onclick: redo }, icon('redo', 14), 'Redo', kbd(...keymap.keys('edit.redo')))),
    ),
    entries.length ? h('div.timeline', null, entries.map((e, i) => h('div.tl-row' + (e.redo ? '.undone' : '') + (!e.redo && i === r.length ? '.current' : '') + (e.id === state.snapSel ? '.selected' : ''), { 'data-id': e.id, onclick: (ev) => { if (!ev.target.closest('button')) selectSnapshot(e.id); } },
      h('span.tl-dot'),
      h('div.list-main', null, h('div.list-title', null, e.label), h('div.list-sub', null, e.redo ? 'Undone — can be redone' : i === r.length ? 'Latest' : fullDate(e.time / 1000))),
      h('span.when', null, timeAgo(e.time / 1000)),
      !e.movesRefs ? null : h('button.btn.ghost.small', { title: 'Preview and restore refs to the state before this operation (↵)', onclick: () => restoreSnapshot(e) }, icon('restore', 13), 'Restore before'),
    )), hidden > 0 ? h('div.tl-more', null, h('button.btn.subtle.small', { onclick: more }, `Show ${hidden.toLocaleString()} more`)) : null) : h('div.empty.big', null, icon('history', 28), h('div', null, 'No snapshots yet'), h('div.muted', null, 'Operations like commit, checkout, merge, rebase or discard will appear here.')),
  );
}

const snapshotEntries = () => [...state.history.redo, ...[...state.history.undo].reverse()];

function selectSnapshot(id) {
  state.snapSel = id;
  for (const row of document.querySelectorAll('.timeline .tl-row')) row.classList.toggle('selected', Number(row.dataset.id) === id);
  document.querySelector('.timeline .tl-row.selected')?.scrollIntoView({ block: 'nearest' });
}

// ↑/↓ select a snapshot, ↵ previews restoring the state before it.
function snapshotKey(e) {
  const list = snapshotEntries();
  if (!list.length) return false;
  const at = list.findIndex((x) => x.id === state.snapSel);
  const id = keymap.match('snapshots', e);
  const step = { 'snapshots.next': 1, 'snapshots.prev': -1 }[id];
  if (step) { selectSnapshot(list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + step))].id); return true; }
  if (id === 'snapshots.restore' && at >= 0 && document.activeElement?.tagName !== 'BUTTON') { if (list[at].movesRefs) restoreSnapshot(list[at]); return true; }
  return false;
}

const refName = (r) => r.replace(/^refs\/(heads|tags)\//, '');
const shortOid = (o) => o.slice(0, 7);
const changeRow = (c) => {
  const [kind, text] = c.kind === 'head'
    ? ['HEAD', `${c.from ? (c.from.startsWith('refs/') ? refName(c.from) : shortOid(c.from)) : 'none'} → ${c.to.startsWith('refs/') ? refName(c.to) : `${shortOid(c.to)} (detached)`}`]
    : c.kind === 'create' ? ['Create', `${refName(c.ref)} at ${shortOid(c.to)}`]
      : c.kind === 'delete' ? ['Delete', `${refName(c.ref)} (was ${shortOid(c.from)})`]
        : ['Move', `${refName(c.ref)} ${shortOid(c.from)} → ${shortOid(c.to)}`];
  return h('li.restore-change.' + c.kind, null, h('span.restore-kind', null, kind), h('span.mono', null, text), c.ref.startsWith('refs/tags/') ? h('span.muted', null, ' tag') : null);
};

// Preview what "Restore before" would change, then apply it as one undoable step.
// One preview at a time: a second ↵ (or key repeat) during the preview's git call would stack a second dialog.
let restorePending = false;
async function restoreSnapshot(e) {
  if (restorePending) return;
  restorePending = true;
  let p;
  try { p = await git('previewRestore', e.id); } catch (err) { return toast('Can’t preview this snapshot', { kind: 'error', detail: err.message }); } finally { restorePending = false; }
  if (!p.changes.length && !p.movesHead) return toast(`Already at the state before “${e.label}”`);
  const desc = h('div.restore-preview', null,
    h('div', null, `${p.changes.length} change${p.changes.length === 1 ? '' : 's'}. You can undo this with ${MOD}Z.`),
    h('ul.restore-changes', null, p.changes.map(changeRow)),
    p.movesHead ? h('div.muted', null, 'The working copy moves with HEAD. Uncommitted changes are kept when possible; if they’d be overwritten, nothing changes.') : null);
  if (await dialog({ title: `Restore the state before “${e.label}”?`, description: desc, submit: 'Restore', wide: true })) act(`Restore before “${e.label}”`, 'restoreHistory', [e.id]);
}

// ---------------------------------------------------------------------------
// Reflog

function reflogView() {
  const el = h('div.page.flush');
  el.append(h('div.page-head', null, h('div', null, h('h1', null, 'Unified Reflog'), h('p.muted', null, 'Recover lost commits from every ref’s history.'))));
  const rows = h('div.table');
  for (const e of state.reflog) {
    rows.append(h('div.table-row', {
      ondblclick: () => { if (state.index.has(e.sha)) jumpTo(e.sha); else openQuick(e.sha); },
      oncontextmenu: (ev) => {
        ev.preventDefault();
        contextMenu(ev.clientX, ev.clientY, [
          { label: 'Quick View', icon: 'eye', run: () => openQuick(e.sha) },
          state.index.has(e.sha) ? { label: 'Show in Map', icon: 'map', run: () => jumpTo(e.sha) } : null,
          { label: 'Create Branch Here…', icon: 'branch', run: () => createBranch(e.sha) },
          { label: 'Checkout (detached)', icon: 'checkout', run: () => act(`Checkout ${e.sha.slice(0, 7)}`, 'checkout', [e.sha]) },
          { label: 'Copy SHA', icon: 'copy', run: () => copy(e.sha, 'Copied SHA') },
        ]);
      },
    },
      h('span.mono.dim', null, e.sha.slice(0, 7)),
      h('span.reflog-sel', null, e.selector.replace(/@\{\d+\}$/, '')),
      h('span.reflog-action', null, e.action),
      h('span.when', null, timeAgo(e.time)),
      !state.index.has(e.sha) ? h('span.badge.warn', { title: 'Not reachable from any branch or tag' }, 'unreachable') : h('span'),
    ));
  }
  if (!state.reflog.length) rows.append(h('div.empty', null, 'Reflog is empty'));
  el.append(rows);
  return el;
}

// ---------------------------------------------------------------------------
// Config

function configView() {
  const el = h('div.page.flush');
  const table = h('div.table');
  const render = () => {
    table.replaceChildren();
    const filter = state.configFilter.toLowerCase();
    for (const c of state.config) {
      if (filter && !(c.key + ' ' + c.value).toLowerCase().includes(filter)) continue;
      table.append(h('div.table-row.config-row', {
        ondblclick: () => c.scope === 'local' && editConfig(c),
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Edit…', icon: 'edit', disabled: c.scope !== 'local', run: () => editConfig(c) },
            { label: 'Copy Value', icon: 'copy', run: () => copy(c.value, 'Copied') },
            { label: 'Delete', icon: 'trash', danger: true, disabled: c.scope !== 'local', run: () => act(`Unset ${c.key}`, 'unsetConfig', [c.key], { undoable: false }) },
          ]);
        },
      }, h('span.badge.' + c.scope, null, c.scope), h('span.mono', null, c.key), h('span.config-val', null, c.value)));
    }
  };
  el.append(
    h('div.page-head', null,
      h('div', null, h('h1', null, 'Configuration'), h('p.muted', null, 'Effective git config. Local values can be edited.')),
      h('div.page-actions', null,
        h('input.input.small', { placeholder: 'Filter…', value: state.configFilter, oninput: (e) => { state.configFilter = e.target.value; render(); } }),
        h('button.btn.subtle', { onclick: () => editConfig(null) }, icon('plus', 14), 'Add option'))),
    table,
  );
  render();
  return el;
}

async function editConfig(c) {
  const v = await dialog({ title: c ? 'Edit option' : 'Add option', submit: 'Save', fields: [{ name: 'k', label: 'Key', value: c?.key || '', placeholder: 'user.name' }, { name: 'v', label: 'Value', value: c?.value || '' }] });
  if (v && v.k.trim()) act(`Set ${v.k.trim()}`, 'setConfig', [v.k.trim(), v.v], { undoable: false });
}

// ---------------------------------------------------------------------------
// Commit identity: warn before committing as someone this repo doesn't usually commit as, or
// as anyone but the email a user rule assigns to its remotes. Rules and per-repo dismissals are
// app preferences; the fix writes user.name / user.email to the repo's own .git/config.

const identityPrefs = () => loadPref('identity', { rules: [], ignored: {} });

async function setIdentity(name, email, current) {
  try {
    if (name && name !== current.name) await git('setConfig', 'user.name', name, { __label: 'Set user.name' });
    if (email !== current.email) await git('setConfig', 'user.email', email, { __label: 'Set user.email' });
    toast(`This repository now commits as ${email}`, { kind: 'success' });
    return true;
  } catch (e) {
    if (!e.readOnly) toast('Couldn’t set the commit identity', { kind: 'error', detail: e.message });
    return false;
  } finally {
    refreshAux();
  }
}

// True when the commit may go ahead: the identity looks right, the user fixed it, or chose to
// commit anyway.
async function identityOk() {
  let id;
  try { id = await git('identity'); } catch { return true; }
  const prefs = identityPrefs();
  const w = checkIdentity(id, prefs.rules, prefs.ignored[state.repo.root] || []);
  if (!w) return true;
  const who = (x) => x.name ? `${x.name} <${x.email}>` : x.email;
  const now = id.email || 'not set';
  const v = await dialog({
    title: 'Commit with this identity?',
    description: w.reason === 'rule'
      ? `Repositories on “${w.pattern}” commit as ${w.expected.email}, but user.email here is ${now}.`
      : `This clone made ${w.count} commits as ${w.expected.email}, but user.email is now ${now}.`,
    fields: [
      { name: 'fix', type: 'checkbox', label: `Use ${who(w.expected)} for this repository`, value: true },
      ...(id.email ? [{ name: 'ignore', type: 'checkbox', label: `Don’t warn about ${id.email} in this repository`, value: false }] : []),
    ],
    submit: 'Commit',
  });
  if (!v) return false;
  if (v.fix) return setIdentity(w.expected.name, w.expected.email, id);
  if (v.ignore) {
    const ignored = { ...prefs.ignored, [state.repo.root]: [...(prefs.ignored[state.repo.root] || []), id.email] };
    savePref('identity', { ...prefs, ignored });
  }
  return true;
}

// ⌘⌥I: set this repo's identity, optionally as a rule for every repo on matching remotes.
async function openIdentity() {
  if (!state.repo) return;
  let id;
  try { id = await git('identity'); } catch (e) { toast('Couldn’t read the commit identity', { kind: 'error', detail: e.message }); return; }
  const prefs = identityPrefs();
  const rule = matchRule(prefs.rules, id.remotes);
  const v = await dialog({
    title: 'Commit identity',
    description: 'Saved to this repository’s .git/config. Add a remote pattern to be warned whenever a repository on it commits as anyone else.',
    fields: [
      { name: 'name', label: 'Name', value: id.name },
      { name: 'email', label: 'Email', value: id.email, placeholder: 'you@example.com' },
      { name: 'pattern', label: 'Rule for remotes containing (optional)', value: rule?.pattern || '', placeholder: suggestPattern(id.remotes[0]) || 'github.com/acme' },
    ],
    submit: 'Save',
  });
  if (!v) return;
  const name = v.name.trim(), email = v.email.trim(), pattern = v.pattern.trim();
  if (!email) { toast('Enter an email', { kind: 'error' }); return; }
  if (!(await setIdentity(name, email, id))) return;
  if (pattern) savePref('identity', { ...prefs, rules: upsertRule(prefs.rules, { pattern, email, name }) });
}

// ---------------------------------------------------------------------------
// Remote operations

function fetchAll() { return act('Fetch', 'fetch', [], { busy: 'Fetching all remotes…', success: 'Fetched all remotes', undoable: false, then: () => refreshPrs() }); }
function pull() { return act('Pull', 'pull', [], { busy: `Pulling ${state.head.branch || ''}…`, success: 'Pulled' }); }
async function push(force) { return act('Push', 'push', [{ force: force === true }], { busy: `Pushing ${state.head.branch || ''}…`, success: `Pushed ${state.head.branch || ''}`, undoable: false }); }

// ---------------------------------------------------------------------------
// Worktrees: extra working folders of this repository, each with its own
// branch or detached HEAD. A window shows one worktree and can switch between them.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
const parentDir = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

function worktreesView() {
  const el = h('div.page.flush', { tabIndex: 0 });
  const list = h('div.wt-list');
  const changes = new Map();
  let idx = Math.max(0, state.worktrees.findIndex((w) => w.current));
  const main = state.worktrees.find((w) => w.main);
  const missing = state.worktrees.some((w) => w.missing);

  function row(w, i) {
    const n = changes.get(w.path);
    return h('div.list-row.wt-row' + (i === idx ? '.active' : ''), {
      onclick: () => { idx = i; mark(); },
      ondblclick: () => switchWorktree(w),
      oncontextmenu: (e) => { e.preventDefault(); idx = i; mark(); worktreeMenu(e.clientX, e.clientY, w); },
    },
      icon('worktree'),
      h('div.list-main', null,
        h('div.list-title', null, w.name,
          w.current ? h('span.badge.local', null, 'This window') : null,
          w.main ? h('span.badge', null, 'Main') : null,
          w.locked ? h('span.badge', { title: w.lockReason || 'Locked' }, 'Locked') : null,
          w.missing ? h('span.badge.warn', { title: 'The folder no longer exists' }, 'Missing') : null),
        h('div.list-sub', null, tildify(w.path), w.lockReason ? ` · ${w.lockReason}` : '')),
      w.branch ? h('span.pill.branch', { title: w.branch }, icon('branch', 12), w.branch)
        : w.head ? h('span.pill.worktree', { title: 'Detached HEAD' }, icon('worktree', 12), w.head.slice(0, 7))
          : h('span.muted', null, 'No commits'),
      h('span.wt-changes' + (n ? '.dirty' : ''), null, n == null ? '' : n ? `${n} changed` : 'Clean'),
      h('span.wt-actions', null,
        w.current || w.missing ? null : h('button.btn.subtle.small', { onclick: (e) => { e.stopPropagation(); switchWorktree(w); } }, 'Switch'),
        h('button.icon-btn', { title: 'More actions', onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); worktreeMenu(r.left, r.bottom + 4, w); } }, icon('more'))),
    );
  }
  function render() { list.replaceChildren(...state.worktrees.map(row)); }
  function mark() { list.querySelectorAll('.wt-row').forEach((r, i) => r.classList.toggle('active', i === idx)); list.querySelectorAll('.wt-row')[idx]?.scrollIntoView({ block: 'nearest' }); }

  el.append(
    h('div.page-head', null,
      h('div', null, h('h1', null, 'Worktrees'), h('p.muted', null, 'Extra working folders for this repository, each on its own branch. Work on several branches at once, or give each coding agent its own lane.')),
      h('div.page-actions', null,
        missing ? h('button.btn.subtle', { onclick: pruneWorktrees }, 'Prune missing') : null,
        h('button.btn.primary', { onclick: () => addWorktree() }, icon('plus', 14), 'New worktree', kbd(...keymap.keys('repo.worktreeAdd'))))),
    list,
    ...(state.worktrees.length < 2 ? [h('div.empty', null, `Only the ${main ? 'main ' : ''}worktree so far. Create one with ${keyText('repo.worktreeAdd')}, or press ${keyText('commit.worktree')} on a commit in the Map.`)] : []),
    h('div.diff-hint.wt-hint', null, '↵ Switch · ', MOD, '↵ New window · L Lock · ⌫ Remove · N New'),
  );
  el.addEventListener('keydown', (e) => {
    const w = state.worktrees[idx];
    const id = keymap.match('worktrees', e);
    if (id === 'worktrees.next') { e.preventDefault(); idx = Math.min(state.worktrees.length - 1, idx + 1); mark(); }
    else if (id === 'worktrees.prev') { e.preventDefault(); idx = Math.max(0, idx - 1); mark(); }
    else if (id === 'worktrees.switch' && w) { e.preventDefault(); switchWorktree(w); }
    else if (id === 'worktrees.window' && w) { e.preventDefault(); openWorktreeWindow(w); }
    else if (id === 'worktrees.lock' && w) { e.preventDefault(); toggleLock(w); }
    else if (id === 'worktrees.remove' && w) { e.preventDefault(); removeWorktree(w); }
    else if (id === 'worktrees.add') { e.preventDefault(); addWorktree(); }
  });
  // Change counts cost a `git status` per worktree, so they load after the list. Other
  // worktrees' folders aren't watched: recount when the window comes back into focus.
  const count = () => Promise.all(state.worktrees.filter((w) => !w.missing).map(async (w) => changes.set(w.path, await git('worktreeChanges', w.path).catch(() => null))))
    .then(() => { if (el.isConnected) render(); });
  const onFocus = () => { if (el.isConnected) count(); else window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);
  render();
  count();
  setTimeout(() => el.focus({ preventScroll: true }));
  return el;
}

// Lanes overview (lanes-view.js): local git data, plus PRs while pull requests are on here.
function openLanes() {
  lanesPage = lanesView({
    load: (opts) => api.app('lanes-list', opts),
    forecast: () => api.app('lanes-forecast'),
    prsOn: () => Boolean(state.prs?.active),
    markAgents: () => state.show.agentLanes !== false,
    onOpen: openLane,
    onCheckout: (pr) => checkoutPr(pr, { worktree: true }),
    onMergeReady: mergeReadyPrs,
    tab: lanesTab,
    onReview: (lane, base) => openReview(lane, base),
    onMerge: mergeLane,
    onAction: laneAction,
    progress: (lane) => reviewProgress(readTicks(localStorage, storeKey(state.repo.root, laneKey(lane))), lane.head),
    onCleanup: (lane) => startCleanup(lane),
    place: lanesPlace,
  });
  lanesTab = 'lanes';
  lanesPlace = null;
  return lanesPage;
}
// ⌘⇧I: the lanes overview on its Inbox tab. Only while pull requests are on.
let lanesTab = 'lanes';
function openInbox(...args) { return go(() => openInboxNow(...args)); }
function openInboxNow() {
  if (!state.repo) return;
  if (!state.prs?.active) return toast('Pull requests are off', { detail: `Turn them on (${keyText('global.prs')}) to see the inbox.` });
  if (state.view === 'lanes' && lanesPage) return lanesPage.show('inbox');
  lanesTab = 'inbox';
  setView('lanes');
}

// Lanes → Clean up (cleanup-view.js): stale branches and worktrees, removed in bulk as one undo step.
function startCleanup(...args) { return go(() => startCleanupNow(...args)); }
let cleanupOnly = null; // a lane's Clean up button: the laneKey to tick, alone
function startCleanupNow(lane = null) {
  if (!state.repo) return;
  cleanupOnly = lane?.name ? laneKey(lane) : null;
  setView('lanes');
  state.cleanup = true;
  renderView();
}
const cleanupPrefs = () => loadPref('cleanup', { days: STALE_DAYS });
function openCleanup() {
  cleanupPage = cleanupView({
    load: () => api.app('lanes-list'),
    run: (items, label) => git('cleanupLanes', items, { __label: label }),
    runRemote: (names) => git('deleteRemoteBranches', names),
    days: () => cleanupPrefs().days,
    setDays: (days) => savePref('cleanup', { ...cleanupPrefs(), days }),
    onProgress: (fn) => api.on('cleanup:progress', fn),
    onDone: refreshAll,
    onUndo: undo,
    onBack: () => setView('lanes'),
    only: cleanupOnly,
    mod: MOD,
  });
  cleanupOnly = null;
  return cleanupPage;
}
// Review a lane's branch (review-view.js): from Lanes, or the current branch from ⌘K / the menu.
function openReview(...args) { return go(() => openReviewNow(...args)); }
function openReviewNow(lane, base = null) {
  if (!state.repo) return;
  if (!lane) {
    if (!state.head.oid) return toast('Nothing to review yet', { detail: 'This branch has no commits.' });
    lane = state.head.branch ? { name: state.head.branch, branch: state.head.branch, head: state.head.oid } : { name: state.head.oid.slice(0, 7), branch: null, head: state.head.oid, worktree: state.worktrees.find((w) => w.current) };
  }
  if (lane.isBase) return toast(`${lane.name} is the base branch`, { detail: 'Review a branch made from it instead.' });
  const rev = lane.branch || lane.head;
  if (!rev) return toast(`${lane.name} has no commits yet`);
  state.quick = null;
  state.split = null;
  state.fileHistory = null;
  state.review = { lane: { key: laneKey(lane), name: lane.name, rev }, base, source: lane };
  renderTopbar();
  renderView();
}
// Merge and tidy (lanes overview, branch review, ⌘K): land a lane on its base as one squashed
// commit, then remove its worktree and delete its branch, as one undo step. A lane with an open
// PR (pull requests on) can be merged on GitHub instead (`gh pr merge --squash`, not undoable);
// the local tidy after it is. Deleting the remote branch is opt-in and never undoable.
async function mergeLane(lane, base = null) {
  if (!state.repo || !lane) return;
  if (!lane.branch) return toast(`${lane.name} is not on a branch`, { detail: 'Merge and tidy works on branches.' });
  let plan;
  try { plan = await git('mergeLanePlan', lane.branch, ...(base ? [base] : [])); } catch (e) { return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: e.message }); }
  if (plan.blocker) return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: plan.blocker });
  const pr = state.prs?.active && prRemote() ? lane.pr : null;
  if (plan.mergeBlocker && !pr && plan.commits.length) return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: plan.mergeBlocker });
  const n = plan.commits.length;
  const remote = lane.upstream && !lane.upstreamGone ? lane.upstream : null;
  const tidy = plan.worktree ? `remove the worktree ${plan.worktree.name} and delete ${lane.branch}` : `delete ${lane.branch}`;
  const here = n ? `${n} commit${n > 1 ? 's' : ''} → one commit on ${plan.base}, then ${tidy}.` : `Nothing left to merge into ${plan.base || 'the base'}: this will ${tidy}.`;
  const v = await dialog({
    title: `Merge and tidy ${lane.name}?`,
    description: h('div.pr-merge', null,
      h('div', null, here),
      pr ? h('div.pr-remote-note', null, `On GitHub: #${pr.number} is squash-merged there, which ⌘Z can’t undo. The local tidy after it can be undone.`) : null,
      plan.mergeBlocker && n ? h('div.pr-blocked', null, `Can’t merge here: ${plan.mergeBlocker}`) : null,
      h('div.muted', null, '⌘Z undoes the local merge and tidy in one step.')),
    submit: 'Merge and tidy',
    wide: n > 0,
    fields: [
      pr ? { name: 'via', type: 'select', label: 'Merge', value: plan.mergeBlocker && n ? 'github' : 'here', options: [{ value: 'here', label: 'Here, as one commit' }, { value: 'github', label: `On GitHub (#${pr.number}, squash)` }] } : null,
      n ? { name: 'message', label: 'Commit message (merging here)', multiline: true, rows: 6, value: plan.message } : null,
      remote || pr ? { name: 'remote', type: 'checkbox', label: `Also delete ${remote || 'the branch'} on the remote (can’t be undone)`, value: false } : null,
    ].filter(Boolean),
  });
  if (!v) return;
  const label = `Merge and tidy ${lane.branch}`;
  if (v.via === 'github') {
    const info = await prCall('pr-merge-info', pr, undefined, `Checking #${pr.number}…`);
    if (info.error) return prError(`Couldn’t check #${pr.number}`, info.error);
    const { gate } = info.ok;
    if (gate.hard || gate.soft.length) return toast(`Can’t merge #${pr.number}`, { kind: 'error', detail: gate.hard || `${gate.soft.join(' ')} Use Merge pull request… to merge anyway.` });
    if (!info.ok.methods.includes('squash')) return toast(`#${pr.number} can’t be squash-merged`, { kind: 'error', detail: 'Use Merge pull request… to pick another method.' });
    const res = await prCall('pr-merge', pr, { method: 'squash', deleteBranch: Boolean(v.remote), admin: false }, `Merging #${pr.number}…`);
    if (res.error) return prError(`Couldn’t merge #${pr.number}`, res.error);
    toast(`Merged #${pr.number} on GitHub`, { kind: 'success', detail: 'The merge on GitHub can’t be undone.' });
    await fetchAll();
    return act(`Tidy ${lane.branch}`, 'tidyLane', [lane.branch], { busy: 'Tidying up…', success: `Tidied ${lane.branch}` });
  }
  if (n && !String(v.message || '').trim()) return toast('The commit message is empty', { kind: 'error' });
  const ok = n
    ? await act(label, 'mergeLane', [lane.branch, plan.base, v.message], { busy: 'Merging…', success: `Merged ${lane.branch} into ${plan.base}` })
    : await act(`Tidy ${lane.branch}`, 'tidyLane', [lane.branch], { busy: 'Tidying up…', success: `Tidied ${lane.branch}` });
  if (ok && v.remote && remote) act(`Delete ${remote}`, 'deleteRemoteBranch', [remote], { busy: 'Deleting remote branch…', undoable: false });
  if (ok && state.review) closeReview();
}
function closeReview(...args) { return go(() => closeReviewNow(...args)); }
function closeReviewNow() {
  state.review = null;
  renderTopbar();
  renderView();
}
// Row actions from Lanes (lanes.js ACTIONS) that aren't open, review, merge or clean up.
function laneAction(id, lane, base) {
  if (id === 'rebase') return rebaseLane(lane, base);
  if (id === 'delete' || id === 'discard') return deleteLane(lane);
  if (id === 'checks' && lane.pr?.url) return api.app('external', `${lane.pr.url}/checks`);
}

// Rebase a lane's branch onto the base, where its conflicts can be fixed: in its own worktree (this
// window switches there first), else in this window, which checks the branch out. A stop on conflicts
// opens the conflict editor as usual; ⌘Z undoes the rebase.
async function rebaseLane(lane, base) {
  if (!state.repo || !lane?.branch || lane.isBase) return;
  if (!base) return toast('No base branch', { detail: 'Lanes couldn’t tell which branch this one is based on.' });
  const w = lane.worktree;
  if (w?.prunable) return toast(`${laneTitle(lane)}’s worktree folder is missing`, { kind: 'error', detail: 'Clean it up or prune it first.' });
  const label = `Rebase ${lane.branch} onto ${base}`;
  if (w && !w.current) {
    const wt = state.worktrees.find((x) => x.path === w.path);
    if (!wt) return;
    await switchWorktree(wt);
    if (state.repo?.root !== w.path) return; // open in another window, or it failed to open
    return act(label, 'rebaseOnto', [base], { busy: 'Rebasing…' });
  }
  if (w?.current) return act(label, 'rebaseOnto', [base], { busy: 'Rebasing…' });
  if (!(await confirm(`${label}?`, `This window checks out ${lane.branch} to rebase it${state.head.branch ? `, leaving ${state.head.branch}` : ''}. ${MOD}Z undoes both.`, { submit: 'Rebase' }))) return;
  act(label, 'rebaseBranch', [base, lane.branch], { busy: 'Rebasing…' });
}

// Delete a lane (Lanes: conflicts → Delete, stalled → Discard): its worktree and branch, one undo
// step. Its remote branch stays.
async function deleteLane(lane) {
  if (!state.repo || !lane || !canRemove(lane)) return;
  const n = lane.changes || 0;
  const verb = n ? 'Discard' : 'Delete';
  const what = [lane.worktree && `its worktree ${tildify(lane.worktree.path)}`, lane.branch && `branch ${lane.branch}`].filter(Boolean).join(' and ');
  const lost = n ? ` with ${n} uncommitted file${n > 1 ? 's' : ''}` : '';
  if (!(await confirm(`${verb} ${laneTitle(lane)}?`, `Removes ${what}${lost}. ${lane.worktree ? 'Ignored files in it, such as build output, are deleted for good; ' : ''}${MOD}Z brings everything else back. A remote branch is kept.`, { submit: verb }))) return;
  act(`${verb} ${lane.branch || lane.name}`, 'cleanupLanes', [[cleanupItem(lane)]], {
    busy: `${verb === 'Delete' ? 'Deleting' : 'Discarding'} ${lane.name}…`,
    then: (res) => { if (res?.failed?.length) toast(`Couldn’t remove all of ${lane.name}`, { kind: 'error', detail: res.failed.map((f) => `${f.name}: ${f.message}`).join('\n') }); },
  });
}

function openLane(lane) {
  const t = laneTarget(lane);
  const w = t?.kind === 'worktree' && state.worktrees.find((x) => x.path === t.path);
  if (w) return switchWorktree(w);
  if (lane.head) return showCommit(lane.head);
  toast(`${lane.name} has no commits yet`);
}

function worktreeMenu(x, y, w) {
  contextMenu(x, y, [
    { label: 'Switch to This Worktree', icon: 'worktree', kbd: keymap.keys('worktrees.switch'), disabled: w.current || w.missing, run: () => switchWorktree(w) },
    { label: 'Open in New Window', icon: 'plus', kbd: keymap.keys('worktrees.window'), disabled: w.current || w.missing, run: () => openWorktreeWindow(w) },
    '-',
    { label: 'Reveal in Finder', icon: 'folder', disabled: w.missing, run: () => api.app('reveal', w.path) },
    { label: 'Open in Terminal', icon: 'terminal', disabled: w.missing, run: () => api.app('terminal', w.path) },
    { label: 'Copy Path', icon: 'copy', run: () => copy(w.path, 'Copied path') },
    '-',
    { label: w.locked ? 'Unlock' : 'Lock…', icon: 'key', kbd: keymap.keys('worktrees.lock'), disabled: w.main, run: () => toggleLock(w) },
    w.missing
      ? { label: 'Prune Missing Worktrees', icon: 'trash', danger: true, run: pruneWorktrees }
      : { label: 'Remove Worktree…', icon: 'trash', kbd: keymap.keys('worktrees.remove'), danger: true, disabled: w.main || w.current, run: () => removeWorktree(w) },
  ]);
}

// `branch`: an existing local branch is checked out, a new name is created at `base` (default HEAD).
async function addWorktree({ base = null, branch = '' } = {}) {
  if (!state.repo) return;
  const main = state.worktrees.find((w) => w.main);
  const from = base ? (state.refs.find((r) => r.short === base)?.short || base.slice(0, 7)) : state.head.branch || state.head.oid?.slice(0, 7) || 'HEAD';
  const v = await dialog({
    title: 'New worktree',
    description: `Starts at ${from}. Type an existing branch to check it out there, a new name to create it, or leave Branch empty for a detached HEAD.`,
    submit: 'Create worktree',
    fields: [
      { name: 'branch', label: 'Branch', value: branch, placeholder: 'feature/my-branch' },
      { name: 'dir', label: 'Location (optional)', placeholder: main ? `${tildify(parentDir(main.path))}/${main.name}-<branch>` : '' },
      { name: 'open', type: 'checkbox', label: 'Switch this window to it', value: false },
    ],
  });
  if (!v) return;
  const b = v.branch.trim();
  await act(b ? `New worktree for ${b}` : 'New worktree', 'addWorktree', [{ dir: v.dir.trim() || null, branch: b || null, base }], {
    busy: 'Creating worktree…',
    then: (wt) => { if (v.open && wt) openRepo(wt.path); },
  });
}

async function removeWorktree(w) {
  if (w.missing) return pruneWorktrees();
  if (w.main || w.current) return toast(w.main ? 'The main worktree can’t be removed' : 'This window is showing that worktree', { kind: 'error', detail: w.main ? null : 'Switch to another worktree first.' });
  if (w.locked) return toast(`“${w.name}” is locked`, { kind: 'error', detail: 'Unlock it first.' });
  // Blocked while dirty: the check is repeated in the main process, this one just saves a dialog.
  const n = await git('worktreeChanges', w.path).catch(() => 0);
  if (n) return toast(`Can’t remove “${w.name}”`, { kind: 'error', detail: `It has ${n} uncommitted change${n > 1 ? 's' : ''}. Commit, stash or discard ${n > 1 ? 'them' : 'it'} first.` });
  const what = w.branch ? `Branch ${w.branch} is kept.` : `Its detached HEAD (${w.head?.slice(0, 7)}) is kept for undo.`;
  if (!(await confirm(`Remove worktree “${w.name}”?`, `Deletes the folder ${tildify(w.path)}. ${what} Ignored files in it, such as build output, are deleted for good; ${MOD}Z brings everything else back.`, { submit: 'Remove' }))) return;
  act(`Remove worktree ${w.name}`, 'removeWorktree', [w.path], { busy: 'Removing worktree…' });
}

async function toggleLock(w) {
  if (w.main) return;
  if (w.locked) return act(`Unlock ${w.name}`, 'unlockWorktree', [w.path], { undoable: false });
  const v = await dialog({ title: `Lock worktree “${w.name}”?`, description: 'A locked worktree can’t be removed or pruned, by GitLanes or by git, until it is unlocked.', submit: 'Lock', fields: [{ name: 'reason', label: 'Reason (optional)', placeholder: 'On an external drive' }] });
  if (v) act(`Lock ${w.name}`, 'lockWorktree', [w.path, v.reason.trim() || null], { undoable: false });
}

function pruneWorktrees() {
  return act('Prune missing worktrees', 'pruneWorktrees', [], { undoable: false });
}

function switchWorktree(w) {
  if (w.current) return;
  if (w.missing) return toast(`“${w.name}” no longer exists`, { kind: 'error', detail: 'Its folder was moved or deleted. Prune it from the Worktrees view.' });
  return openRepo(w.path);
}

function openWorktreeWindow(w) {
  if (w.current || w.missing) return;
  api.app('open-window', w.path);
}

function worktreeSwitcher() {
  if (!state.repo) return;
  palette(() => [
    ...state.worktrees.filter((w) => !w.missing).map((w) => ({ group: 'Worktrees', label: w.name, icon: 'worktree', detail: (w.current ? 'this window · ' : '') + (w.branch || (w.head ? 'detached ' + w.head.slice(0, 7) : '')), keywords: w.path, run: () => switchWorktree(w) })),
    { group: 'Worktrees', label: 'New worktree…', icon: 'plus', kbd: keymap.keys('repo.worktreeAdd'), run: () => addWorktree() },
  ], { placeholder: 'Switch to worktree…' });
}

function submoduleMenu(x, y, m) {
  contextMenu(x, y, [
    { label: 'Open in New Window', icon: 'plus', disabled: !m.head, run: () => openSubmodule(m) },
    { label: m.head ? 'Update to Recorded Commit' : 'Initialise and Check Out', icon: 'pull', disabled: !['outdated', 'uninitialized'].includes(m.state), run: () => updateSubmodules([m]) },
    '-',
    { label: 'Reveal in Finder', icon: 'folder', run: () => api.app('reveal', m.path) },
    { label: 'Copy Path', icon: 'copy', run: () => copy(m.path, 'Copied path') },
    m.url ? { label: 'Copy URL', icon: 'copy', run: () => copy(m.url, 'Copied URL') } : null,
  ].filter(Boolean));
}

function openSubmodule(m) {
  if (!m.head) return toast(`${m.path} isn’t checked out yet`, { kind: 'error', detail: `Update it first (${keyText('repo.submoduleUpdate')}).` });
  api.app('open-submodule', m.path).catch((e) => toast('Couldn’t open submodule', { kind: 'error', detail: e.message }));
}

// No list: every submodule that is out of date or not checked out. Undoable (git.updateSubmodules).
function updateSubmodules(list) {
  if (!state.repo) return;
  const todo = (list || state.submodules).filter((m) => ['outdated', 'uninitialized'].includes(m.state));
  if (!state.submodules.length) return toast('This repository has no submodules');
  if (!todo.length) return toast(list ? 'Already up to date' : 'All submodules are up to date', { detail: state.submodules.some((m) => m.state === 'modified') ? 'Submodules with local changes are left alone.' : null });
  const label = todo.length === 1 ? `Update submodule ${todo[0].path}` : `Update ${todo.length} submodules`;
  return act(label, 'updateSubmodules', [todo.map((m) => m.path)], { busy: 'Updating submodules…' });
}

// ---------------------------------------------------------------------------
// Opt-in AI commit messages: the user's own Claude Code / Codex CLI, or Ollama on this Mac.
// Before the first use with a provider, the user sees the exact text that will be sent.

const aiOn = () => Boolean(state.ai && state.ai.provider !== 'off');
const showAiButton = () => { const b = $('.ai-btn'); if (b) b.hidden = !aiOn(); };

async function setupAi() {
  state.ai = await api.app('ai-settings');
  const current = state.ai.provider;
  const choice = await new Promise((resolve) => {
    palette(() => [
      ...state.ai.providers.map((p) => ({ group: 'AI commit messages', label: p.label, icon: 'sparkle', detail: p.id === current ? 'current' : p.id === 'ollama' ? 'local model' : 'your own CLI', keywords: `ai llm ${p.id}`, run: () => resolve(p) })),
      { group: 'AI commit messages', label: 'Off', icon: 'x', detail: current === 'off' ? 'current' : null, run: () => resolve({ id: 'off' }) },
    // Closing the palette without a pick leaves the setting alone.
    ], { placeholder: 'Write commit messages with…', onDismiss: () => resolve(null) });
  });
  if (!choice) return false;
  let model = '';
  if (choice.id === 'ollama') {
    model = await prompt('Ollama model', { label: 'Model name', value: state.ai.model || choice.defaultModel, submit: 'Use model', description: 'Any model you’ve pulled with `ollama pull`. Requests go to Ollama on this Mac only.' });
    if (model === null) return false;
  }
  state.ai = await api.app('ai-configure', choice.id, model);
  showAiButton();
  toast(aiOn() ? `AI commit messages use ${choice.label}` : 'AI commit messages are off');
  return aiOn();
}

async function writeMessageWithAi() {
  if (!state.repo) return;
  state.ai = await api.app('ai-settings');
  if (!aiOn() && !(await setupAi())) return;
  if (!state.status.staged.length) return toast('Stage some changes first');
  let res;
  for (;;) {
    let consent = false, hash = null;
    if (!state.ai.consented) {
      const preview = await api.app('ai-preview');
      if (preview.error) return toast('Couldn’t prepare the message', { kind: 'error', detail: preview.error.message });
      const label = state.ai.providers.find((p) => p.id === state.ai.provider).label;
      const ok = await dialog({
        title: `Send your staged changes to ${label}?`,
        description: state.ai.provider === 'ollama'
          ? 'GitLanes sends exactly this text to Ollama on this Mac. It doesn’t leave your Mac unless your Ollama does.'
          : `GitLanes passes exactly this text to your ${label} command, which sends it to that tool’s AI service under your own account. GitLanes has no server of its own. You’re asked once per provider.`,
        fields: [{ name: 'text', multiline: true, rows: 14, value: preview.ok.prompt, readonly: true }],
        submit: 'Send', wide: true,
      });
      if (!ok) return;
      consent = true;
      hash = preview.ok.hash;
    }
    if (state.view !== 'commit') setView('commit');
    const busy = toast('Writing commit message…', { kind: 'busy', timeout: 0 });
    res = await api.app('ai-generate', consent, hash);
    busy.close();
    state.ai = await api.app('ai-settings');
    // Staging changed while the preview was open: nothing was sent, show the new text.
    if (res.error?.code === 'ai-prompt-changed') { toast(res.error.message); continue; }
    break;
  }
  if (res.error) return toast('Couldn’t write a commit message', { kind: 'error', detail: res.error.message });
  const ta = $('.composer-input');
  if (!ta) return;
  if (ta.value.trim() && ta.value.trim() !== res.ok && !(await confirm('Replace your message?', 'The message you’ve written so far will be replaced.', { submit: 'Replace' }))) return;
  ta.value = res.ok;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

// ---------------------------------------------------------------------------
// Pull requests (read-only), through the user’s GitHub CLI. One user-wide switch (plus a per-repo hide);
// `gh` only runs on Fetch or Refresh, never in the background. The last result is kept per
// repository and shown as stale until the next successful refresh.

const prCacheKey = (root) => 'prs:' + root;
async function loadPrs() {
  const repo = state.repo;
  const st = await api.app('pr-state').catch(() => null);
  if (!st || state.repo !== repo) return;
  let data = null;
  if (st.active) { try { data = JSON.parse(localStorage.getItem(prCacheKey(repo.root))); } catch { /* none */ } }
  state.prs = { ...st, data, stale: Boolean(data), error: null, busy: false, byRef: new Map() };
  showPrs();
}
function indexPrs() { if (state.prs) state.prs.byRef = prsByRef(state.prs.data, state.refs); }
function showPrs() { indexPrs(); renderSidebar(); mapView?.refresh(); }
const prFor = (r) => (state.prs?.active ? state.prs.byRef.get(refKey(r)) : null);
const openPrOnGitHub = (pr) => pr.url && api.app('external', pr.url);

// Draft, review and CI marks, shared by graph badges and the sidebar list.
const prMarks = (pr) => [
  pr.draft ? h('span.pr-draft', null, 'draft') : null,
  pr.review === 'approved' ? h('span.pr-review.approved', null, '✓') : pr.review === 'changes' ? h('span.pr-review.changes', null, '✗') : null,
  pr.checks ? h('span.pr-ci.' + pr.checks, null, '●') : null,
];
function prBadge(pr) {
  if (!pr) return null;
  const stop = (e) => e.stopPropagation();
  return h('span.pr-badge' + (state.prs.stale ? '.stale' : ''), { title: prTitle(pr, state.prs.stale), onmousedown: stop, onclick: (e) => { stop(e); openPr(pr); }, oncontextmenu: (e) => { stop(e); prMenu(e, pr); } }, `#${pr.number}`, prMarks(pr));
}

// Quick view: the PR's summary, with Open on GitHub.
async function openPr(pr) {
  const updated = Date.parse(pr.updatedAt);
  const ok = await dialog({
    title: `#${pr.number} ${pr.title}`,
    description: h('div.pr-quick', null,
      prop('Author', pr.author || '—'),
      prop('Branch', `${pr.branch} → ${pr.base}`),
      prop('Review', pr.draft ? 'Draft' : REVIEW_LABELS[pr.review] || 'No review yet'),
      prop('Checks', CHECK_LABELS[pr.checks] || 'No checks'),
      Number.isFinite(updated) ? prop('Updated', `${timeAgo(updated / 1000)} ago`) : null,
      state.prs.stale ? h('div.pr-stale-note', null, 'Not refreshed: this is the last result GitLanes got.') : null,
    ),
    submit: 'Open on GitHub',
  });
  if (ok) openPrOnGitHub(pr);
}

function goToPr(pr) {
  const r = prRef(pr, state.refs, state.prs.byRef);
  if (!r) return toast(`${pr.branch} isn’t in this clone`, { detail: 'Check it out to get it, or open the pull request on GitHub.', action: { label: 'Check out', run: () => checkoutPr(pr) } });
  if (!state.index.has(r.target)) return openQuick(r.target);
  jumpTo(r.target);
}

// Check out a PR as a branch (gh's branch name), here or in a new worktree. Undoable with ⌘Z.
// An existing branch that points somewhere else is only moved after asking.
async function checkoutPr(pr, { worktree = false } = {}) {
  let opts = { worktree };
  if (worktree) {
    const main = state.worktrees.find((w) => w.main);
    const v = await dialog({
      title: `Check out #${pr.number} in a new worktree`,
      description: `Fetches ${pr.branch} from GitHub and checks it out in its own folder, as a new lane.`,
      submit: 'Create worktree',
      fields: [
        { name: 'dir', label: 'Location (optional)', placeholder: main ? `${tildify(parentDir(main.path))}/${main.name}-${pr.branch.replace(/\//g, '-')}` : '' },
        { name: 'open', type: 'checkbox', label: 'Switch this window to it', value: false },
      ],
    });
    if (!v) return;
    opts = { worktree, dir: v.dir.trim() || null, open: v.open };
  }
  const run = async (update) => {
    const t = toast(`Checking out #${pr.number}…`, { kind: 'busy', timeout: 0 });
    const res = await api.app('pr-checkout', pr.number, { worktree, dir: opts.dir || null, update }).catch((e) => ({ error: { message: e.message } }));
    t.close();
    return res;
  };
  let res = await run(false);
  if (res.ok?.confirm) {
    const c = res.ok.confirm;
    const ok = await confirm(`Update ${c.branch}?`, `${c.branch} is at ${c.from.slice(0, 7)}. Pull request #${pr.number} is at ${c.to.slice(0, 7)}. Moving the branch there is undoable with ${MOD}Z.`, { submit: 'Update branch' });
    if (!ok) return;
    res = await run(true);
  }
  if (res.error) return toast(`Couldn’t check out #${pr.number}`, { kind: 'error', detail: res.error.code === 'gh-auth' ? 'Run `gh auth login` in a terminal, then try again.' : res.error.stderr || res.error.message });
  const { branch, worktree: wt } = res.ok;
  toast(wt ? `New worktree for #${pr.number} on ${branch}` : `Switched to ${branch} (#${pr.number})`, { kind: 'success', action: { label: 'Undo', run: undo } });
  if (wt && opts.open) openRepo(wt.path);
}

// ⌘⌥⇧O / ⌘⌥⇧L: pick an open PR to check out here or in a new worktree.
function pickPr(worktree) {
  if (!state.prs?.active) return setupPrs();
  const prs = state.prs.data?.prs || [];
  if (!prs.length) return toast('No pull requests yet', { detail: `Refresh pull requests with ${keyText('repo.prRefresh')}.` });
  palette(() => prs.map((pr) => ({ group: 'Open pull requests', label: `#${pr.number} ${pr.title}`, icon: worktree ? 'worktree' : 'merge', detail: pr.branch, keywords: `${pr.author} ${pr.branch} ${pr.base}`, run: () => checkoutPr(pr, { worktree }) })),
    { placeholder: worktree ? 'Check out pull request in a new worktree…' : 'Check out pull request…' });
}

// ⌘⌥⇧N: open a PR from the current (or a picked) branch. Title and body come from its commits.
// A branch that isn't on GitHub yet is only pushed after the user ticks the confirm.
async function createPr(branch = state.head.branch) {
  if (!state.prs?.active) return setupPrs();
  if (!branch) return toast('Check out a branch first', { detail: 'A pull request needs a branch to merge from.' });
  const open = prFor({ kind: 'branch', short: branch });
  if (open) return toast(`${branch} already has #${open.number}`, { action: { label: 'Open', run: () => openPr(open) } });
  const t = toast(`Preparing a pull request for ${branch}…`, { kind: 'busy', timeout: 0 });
  const info = await api.app('pr-create-info', branch).catch((e) => ({ error: { message: e.message } }));
  t.close();
  if (info.error) return prError(`Couldn’t prepare a pull request for ${branch}`, info.error);
  const { base, remote, push } = info.ok;
  const bases = [...new Set([base, ...state.refs.filter((r) => r.kind === 'remote' && r.short.startsWith(`${remote}/`)).map((r) => r.short.slice(remote.length + 1)).filter((b) => b !== 'HEAD' && b !== branch)])];
  const aiReady = state.ai?.provider !== 'off' && state.ai?.consented;
  const v = await dialog({
    title: `New pull request from ${branch}`,
    description: h('div.pr-merge', null,
      h('div', null, `${info.ok.head} → ${base} on ${remote}`),
      push ? h('div.pr-blocked', null, push.isNew ? `${branch} isn’t on ${remote} yet.` : `${branch} has ${push.ahead} commit${push.ahead === 1 ? '' : 's'} that ${push.ahead === 1 ? 'isn’t' : 'aren’t'} on ${push.remote} yet.`) : null,
      h('div.pr-remote-note', null, REMOTE_NOTE),
    ),
    submit: push ? 'Push and create' : 'Create pull request',
    wide: true,
    gate: push ? 'push' : undefined,
    fields: [
      bases.length > 1 ? { name: 'base', type: 'select', label: 'Base branch', value: base, options: bases.map((b) => ({ value: b, label: b })) } : null,
      { name: 'title', label: 'Title', value: info.ok.title },
      { name: 'body', label: 'Description', multiline: true, rows: 10, value: info.ok.body },
      aiReady ? { name: 'ai', type: 'button', icon: 'sparkle', label: 'Draft with AI', run: async (inputs) => {
        const busy = toast('Drafting the pull request…', { kind: 'busy', timeout: 0 });
        const res = await api.app('pr-ai-draft', branch, inputs.base?.value || base).catch((e) => ({ error: { message: e.message } }));
        busy.close();
        if (res.error) return toast('Couldn’t draft the pull request', { kind: 'error', detail: res.error.message });
        if (res.ok.title) inputs.title.value = res.ok.title;
        inputs.body.value = res.ok.body;
      } } : null,
      { name: 'draft', type: 'checkbox', label: 'Create as draft', value: false },
      push ? { name: 'push', type: 'checkbox', label: `Push ${branch} to ${push.remote} first`, value: false } : null,
    ].filter(Boolean),
  });
  if (!v) return;
  if (!v.title.trim()) return toast('A pull request needs a title', { kind: 'error' });
  const busy = toast(push ? `Pushing ${branch} and creating the pull request…` : 'Creating the pull request…', { kind: 'busy', timeout: 0 });
  const res = await api.app('pr-create', branch, { base: v.base || base, title: v.title, body: v.body, draft: v.draft, push: Boolean(v.push) }).catch((e) => ({ error: { message: e.message } }));
  busy.close();
  if (res.error) return prError(`Couldn’t create the pull request`, res.error);
  const { number, url } = res.ok;
  toast(`Opened #${number}${v.draft ? ' as a draft' : ''}`, { kind: 'success', detail: url, action: { label: 'Open on GitHub', run: () => openPrOnGitHub({ url }) } });
  refreshPrs();
}

// Pick a local branch for a new PR when the current one can't be used (⌘K entry).
function pickPrBranch() {
  const branches = state.refs.filter((r) => r.kind === 'branch' && !prFor(r));
  palette(() => branches.map((r) => ({ group: 'Branches', label: r.short, icon: 'branch', detail: r.upstream || 'not pushed', run: () => createPr(r.short) })), { placeholder: 'New pull request from branch…' });
}

async function refreshPrs({ manual = false } = {}) {
  const p = state.prs;
  if (!p?.active) return manual ? setupPrs() : undefined;
  if (p.busy) return;
  p.busy = true;
  const busy = manual ? toast('Refreshing pull requests…', { kind: 'busy', timeout: 0 }) : null;
  const res = await api.app('pr-list').catch((e) => ({ error: { message: e.message } }));
  busy?.close();
  p.busy = false;
  if (state.prs !== p) return; // another repository by now
  if (res.ok) {
    p.data = res.ok;
    p.stale = false;
    p.error = null;
    try { localStorage.setItem(prCacheKey(state.repo.root), JSON.stringify(res.ok)); } catch { /* full */ }
    if (manual) toast(`${res.ok.prs.length} open pull request${res.ok.prs.length === 1 ? '' : 's'}`, { kind: 'success' });
  } else if (res.ok === null) {
    p.active = false; // turned off or hidden in another window
  } else {
    // Offline or a `gh` error: keep what we had, marked stale. After a fetch this stays quiet.
    p.stale = Boolean(p.data);
    p.error = res.error.message;
    if (manual) toast('Couldn’t refresh pull requests', { kind: 'error', detail: res.error.code === 'gh-auth' ? 'Run `gh auth login` in a terminal, then refresh.' : res.error.message });
  }
  showPrs();
}

const setPrState = (next) => { state.prs = { ...next, data: null, stale: false, error: null, busy: false, byRef: new Map() }; showPrs(); };
let prLoggedOut = false; // the last turn-on found `gh` logged out, so setup shows Set up… until it works

// One switch for every repository. `ask` explains first (⌘K, ⌘⌥P); the setup switch skips that.
async function setupPrs({ ask = true } = {}) {
  const st = await api.app('pr-state').catch(() => null);
  if (!st) return toast('Open a repository to turn on pull requests', { detail: 'After that they’re on in every repository.' });
  if (st.enabled && st.hidden) return hidePrs(false);
  if (st.enabled && !st.remote) return toast('This repository has no GitHub remote', { detail: 'Pull requests are on and show in repositories that have one.' });
  if (ask) {
    const ok = await dialog({
      title: 'Show pull requests from GitHub?',
      description: 'Shows open pull requests in the graph and the sidebar of every repository with a GitHub remote. Uses your GitHub CLI login and talks to GitHub only when you fetch or refresh.',
      submit: 'Turn on',
    });
    if (!ok) return;
  }
  if (st.gh === 'missing') {
    const install = await dialog({ title: 'Install GitHub CLI', description: 'GitLanes reads pull requests through GitHub’s own `gh` command, so it never handles your token. Install it, run `gh auth login` once, then turn pull requests on again.', submit: 'Open cli.github.com' });
    if (install) api.app('external', st.installUrl);
    return;
  }
  // Login is per host, so it's checked against this repository's remote when there is one.
  if (st.remote) {
    const det = await api.app('pr-detect');
    if (det.error) return toast('Couldn’t check GitHub CLI', { kind: 'error', detail: det.error.message });
    prLoggedOut = det.ok.gh === 'logged-out';
    if (prLoggedOut) {
      const host = st.remote.host;
      const cmd = host === 'github.com' ? 'gh auth login' : `gh auth login --hostname ${host}`;
      const login = await dialog({ title: `Log in to ${host} with GitHub CLI`, description: `Run \`${cmd}\` in a terminal, then turn pull requests on again.`, submit: 'Copy command' });
      if (login) copy(cmd, 'Copied the login command');
      return;
    }
  }
  const next = await api.app('pr-enable', true);
  setPrState(next);
  toast('Pull requests on', { kind: 'success', action: { label: 'Undo', run: () => turnOffPrs() } });
  if (next.active) refreshPrs();
}

async function turnOffPrs() {
  const next = await api.app('pr-enable', false);
  try { localStorage.removeItem(prCacheKey(state.repo.root)); } catch { /* ignore */ }
  setPrState(next);
  toast('Pull requests off', { action: { label: 'Undo', run: () => setupPrs({ ask: false }) } });
}
const togglePrs = () => (state.prs?.enabled ? turnOffPrs() : setupPrs());

// The per-repository escape hatch. The cache stays, so showing them again is instant.
async function hidePrs(hide) {
  const next = await api.app('pr-hide', hide);
  if (hide) setPrState(next); else await loadPrs();
  toast(hide ? 'Hidden in this repository' : 'Shown in this repository', { action: { label: 'Undo', run: () => hidePrs(!hide) } });
}

// ⌘⌥P: open PRs, newest update first; pick one to jump to its branch.
function prList() {
  if (!state.prs?.active) return setupPrs();
  const prs = state.prs.data?.prs || [];
  palette(() => [
    ...prs.map((pr) => ({ group: state.prs.stale ? 'Open pull requests (not refreshed)' : 'Open pull requests', label: `#${pr.number} ${pr.title}`, icon: 'merge', detail: pr.branch, keywords: `${pr.author} ${pr.branch} ${pr.base}`, run: () => goToPr(pr) })),
    { group: 'Pull requests', label: 'Refresh pull requests', icon: 'fetch', kbd: keymap.keys('repo.prRefresh'), run: () => refreshPrs({ manual: true }) },
    { group: 'Pull requests', label: 'New pull request…', icon: 'plus', kbd: keymap.keys('repo.prCreate'), run: () => createPr() },
    { group: 'Pull requests', label: 'Check out pull request…', icon: 'checkout', kbd: keymap.keys('repo.prCheckout'), run: () => pickPr(false) },
    { group: 'Pull requests', label: 'Check out pull request in new worktree…', icon: 'worktree', kbd: keymap.keys('repo.prWorktree'), run: () => pickPr(true) },
    { group: 'Pull requests', label: 'Approve pull request…', icon: 'check', kbd: keymap.keys('repo.prApprove'), run: () => approvePr() },
    { group: 'Pull requests', label: 'Merge pull request…', icon: 'merge', kbd: keymap.keys('repo.prMerge'), run: () => mergePr() },
    { group: 'Pull requests', label: 'Close pull request…', icon: 'x', kbd: keymap.keys('repo.prClose'), run: () => closePr() },
    { group: 'Pull requests', label: 'Show in sidebar', icon: 'sidebar', run: () => openSidebarAt('prs') },
  ], { placeholder: 'Go to pull request…' });
}

// Approve, merge and close. These happen on GitHub, so ⌘Z can't undo them, and each sheet says
// so. What follows locally (fetch, deleting the merged branch) goes through the journal as usual.
const REMOTE_NOTE = 'This happens on GitHub. ⌘Z can’t undo it.';
const prRemote = () => state.prs?.data?.remote?.name;

// The PR to act on: the one given, else the checked-out branch's, else pick one.
function withPr(pr, verb, fn) {
  if (!state.prs?.active) return setupPrs();
  if (pr) return fn(pr);
  const mine = state.head.branch ? prFor({ kind: 'branch', short: state.head.branch }) : null;
  if (mine) return fn(mine);
  const prs = state.prs.data?.prs || [];
  if (!prs.length) return toast('No open pull requests', { detail: `Refresh pull requests (${keyText('repo.prRefresh')}) to load them.` });
  palette(() => prs.map((p) => ({ group: 'Open pull requests', label: `#${p.number} ${p.title}`, icon: 'merge', detail: p.branch, keywords: `${p.author} ${p.branch} ${p.base}`, run: () => fn(p) })), { placeholder: `${verb} pull request…` });
}

async function prCall(channel, pr, opts, busy) {
  const t = toast(busy, { kind: 'busy', timeout: 0 });
  const res = await api.app(channel, prRemote(), pr.number, opts).catch((e) => ({ error: { message: e.message } }));
  t.close();
  return res;
}
const prError = (title, err) => toast(title, { kind: 'error', detail: err.code === 'gh-auth' ? 'Run `gh auth login` in a terminal, then try again.' : err.message });

const approvePr = (given) => withPr(given, 'Approve', async (pr) => {
  const v = await dialog({
    title: `Approve #${pr.number}?`,
    description: `${pr.title}\n${REMOTE_NOTE}`,
    submit: 'Approve',
    fields: [{ name: 'body', label: 'Comment (optional)', multiline: true, rows: 3 }],
  });
  if (!v) return;
  const res = await prCall('pr-approve', pr, { body: v.body }, `Approving #${pr.number}…`);
  if (res.error) return prError(`Couldn’t approve #${pr.number}`, res.error);
  toast(`Approved #${pr.number}`, { kind: 'success' });
  refreshPrs();
});

const MERGE_LABELS = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const mergePr = (given) => withPr(given, 'Merge', async (pr) => {
  const info = await prCall('pr-merge-info', pr, undefined, `Checking #${pr.number}…`);
  if (info.error) return prError(`Couldn’t check #${pr.number}`, info.error);
  const { gate, methods, headOid, checking } = info.ok;
  if (gate.hard) return toast(`Can’t merge #${pr.number}`, { kind: 'error', detail: gate.hard });
  if (gate.soft.length && !gate.canOverride) return toast(`GitHub blocks merging #${pr.number}`, { kind: 'error', detail: `${gate.soft.join(' ')} Only a repository admin can bypass it.` });
  // The local branch to delete afterwards, found now: the refresh after merging drops the PR.
  const local = prRef(pr, state.refs, state.prs.byRef);
  const v = await dialog({
    title: `Merge #${pr.number}?`,
    description: h('div.pr-merge', null,
      h('div', null, pr.title),
      h('div', null, `${pr.branch} → ${pr.base}`),
      gate.soft.length ? h('div.pr-blocked', null, `Merge is blocked: ${gate.soft.join(' ')}`) : null,
      checking ? h('div.pr-remote-note', null, 'GitHub is still checking this pull request. If the merge fails, try again in a moment.') : null,
      h('div.pr-remote-note', null, `${REMOTE_NOTE} Fetching and deleting the local branch afterwards can be undone.`),
    ),
    submit: gate.soft.length ? 'Merge anyway' : 'Merge',
    destructive: gate.soft.length > 0,
    gate: gate.soft.length ? 'anyway' : undefined,
    fields: [
      methods.length > 1 ? { name: 'method', type: 'select', label: 'Merge method', value: methods[0], options: methods.map((m) => ({ value: m, label: MERGE_LABELS[m] })) } : null,
      { name: 'del', type: 'checkbox', label: `Delete ${pr.branch} on GitHub${local?.kind === 'branch' ? ' and here' : ''}`, value: true },
      gate.soft.length ? { name: 'anyway', type: 'checkbox', label: gate.needsAdmin ? 'Merge anyway, using my admin rights to bypass branch protection' : 'Merge anyway', value: false } : null,
    ].filter(Boolean),
  });
  if (!v) return;
  const method = v.method || methods[0];
  const res = await prCall('pr-merge', pr, { method, deleteBranch: v.del, admin: Boolean(v.anyway && gate.needsAdmin) }, `Merging #${pr.number}…`);
  if (res.error) return prError(`Couldn’t merge #${pr.number}`, res.error);
  toast(`Merged #${pr.number}`, { kind: 'success' });
  await fetchAll();
  if (!v.del || local?.kind !== 'branch') return;
  if (local.short === state.head.branch) return toast(`${local.short} is still checked out`, { detail: 'Switch to another branch to delete it.' });
  const now = state.refs.find((r) => r.kind === 'branch' && r.short === local.short);
  if (!now) return;
  // Only delete what was merged: local commits that never reached the PR stay.
  if (!headOid || now.target !== headOid) return toast(`Kept ${local.short}`, { detail: 'It has commits that weren’t in the pull request.' });
  deleteBranch(now);
});

const closePr = (given) => withPr(given, 'Close', async (pr) => {
  const v = await dialog({
    title: `Close #${pr.number} without merging?`,
    description: `${pr.title}\n${REMOTE_NOTE} You can reopen it on GitHub.`,
    submit: 'Close pull request',
    destructive: true,
    fields: [{ name: 'body', label: 'Comment (optional)', multiline: true, rows: 3 }],
  });
  if (!v) return;
  const res = await prCall('pr-close', pr, { body: v.body }, `Closing #${pr.number}…`);
  if (res.error) return prError(`Couldn’t close #${pr.number}`, res.error);
  toast(`Closed #${pr.number}`, { kind: 'success' });
  refreshPrs();
});

// The inbox's Ready bucket, squash-merged on GitHub one at a time after one confirmation. Stops
// at the first failure and says what merged. The branches stay; deleting them is up to you.
async function mergeReadyPrs(prs, remote) {
  const ok = await dialog({
    title: `Squash-merge ${prs.length} pull request${prs.length === 1 ? '' : 's'}?`,
    description: h('div.pr-merge', null,
      ...prs.map((p) => h('div', null, `#${p.number} ${p.title} · ${p.author}`)),
      h('div.pr-remote-note', null, `${REMOTE_NOTE} They merge one at a time and stop at the first one that fails.`)),
    submit: `Merge ${prs.length}`,
  });
  if (!ok) return;
  const merged = [];
  for (const pr of prs) {
    const t = toast(`Merging #${pr.number} (${merged.length + 1} of ${prs.length})…`, { kind: 'busy', timeout: 0 });
    const res = await api.app('pr-merge', remote, pr.number, { method: 'squash', deleteBranch: false, admin: false }).catch((e) => ({ error: { message: e.message } }));
    t.close();
    if (res.error) {
      prError(`Couldn’t merge #${pr.number}${merged.length ? ` · merged ${merged.map((n) => `#${n}`).join(', ')}` : ''}`, res.error);
      break;
    }
    merged.push(pr.number);
  }
  if (merged.length === prs.length) toast(`Merged ${merged.length} pull request${merged.length === 1 ? '' : 's'}`, { kind: 'success' });
  if (merged.length) { await fetchAll(); lanesPage?.reload(); }
}

function prMenu(e, pr) {
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: 'Go to Branch', icon: 'branch', kbd: keymap.keys('menu.choose'), run: () => goToPr(pr) },
    { label: 'Check Out', icon: 'checkout', kbd: keymap.keys('repo.prCheckout'), run: () => checkoutPr(pr) },
    { label: 'Check Out in New Worktree…', icon: 'worktree', kbd: keymap.keys('repo.prWorktree'), run: () => checkoutPr(pr, { worktree: true }) },
    '-',
    { label: 'Approve…', icon: 'check', run: () => approvePr(pr) },
    { label: 'Merge…', icon: 'merge', run: () => mergePr(pr) },
    { label: 'Close…', icon: 'x', danger: true, run: () => closePr(pr) },
    '-',
    { label: 'Open on GitHub', icon: 'external', disabled: !pr.url, run: () => openPrOnGitHub(pr) },
  ]);
}

function submoduleSwitcher() {
  if (!state.repo) return;
  if (!state.submodules.length) return toast('This repository has no submodules');
  palette(() => [
    ...state.submodules.map((m) => ({ group: 'Submodules', label: m.path, icon: 'submodule', detail: SUBMODULE_STATES[m.state][0], keywords: `${m.name} ${m.url}`, run: () => (m.head ? openSubmodule(m) : updateSubmodules([m])) })),
    { group: 'Submodules', label: 'Update all submodules', icon: 'pull', kbd: keymap.keys('repo.submoduleUpdate'), run: () => updateSubmodules() },
  ], { placeholder: 'Open submodule…' });
}

// ---------------------------------------------------------------------------
// Command palette

// Recent repositories other than the open one, newest first.
async function recentRepos(limit) {
  return otherRecent(await api.app('recent'), state.repo?.root, limit);
}
function tildePath(p) { return p.replace(/^\/Users\/[^/]+/, '~'); }

async function repoSwitcher() {
  const recent = await recentRepos();
  if (!recent.length) return toast('No other recent repositories');
  palette(() => recent.map((x) => ({ group: 'Recent repositories', label: x.name, icon: 'folder', detail: tildePath(x.root), keywords: x.root, run: () => openRepo(x.root) })), { placeholder: 'Switch repository…' });
}

// Opens at once; the recent repositories are added when the app:recent IPC answers.
function openPalette() {
  if (!state.repo) return;
  let recent = [];
  const pal = palette(() => {
    const items = [];
    const add = (group, label, run, opts = {}) => items.push({ group, label, run, ...opts });
    VIEWS.forEach((v) => add('Navigation', `Go to ${v.label}`, () => setView(v.id), { icon: v.icon, kbd: keymap.keys(`view.${v.id}`) }));
    add('Repository', 'Fetch all remotes', fetchAll, { icon: 'fetch', kbd: keymap.keys('repo.fetch') });
    add('Repository', 'Pull current branch', pull, { icon: 'pull', kbd: keymap.keys('repo.pull') });
    add('Repository', 'Push current branch', () => push(false), { icon: 'push', kbd: keymap.keys('repo.push') });
    add('Repository', 'Force push current branch (with lease)', async () => { if (await confirm('Force push?', 'Overwrites the remote branch if nobody else pushed meanwhile.', { submit: 'Force push' })) push(true); }, { icon: 'push' });
    add('Repository', 'Write commit message with AI', writeMessageWithAi, { icon: 'sparkle', kbd: keymap.keys('repo.aiMessage'), detail: aiOn() ? null : 'off', keywords: 'ai llm generate claude codex ollama' });
    add('Repository', 'Pull requests…', prList, { icon: 'merge', kbd: keymap.keys('repo.prs'), detail: state.prs?.active ? null : 'off', keywords: 'pr github gh review checks ci' });
    add('Repository', 'Refresh pull requests', () => refreshPrs({ manual: true }), { icon: 'fetch', kbd: keymap.keys('repo.prRefresh'), keywords: 'pr github gh' });
    add('Repository', 'New pull request…', () => createPr(), { icon: 'plus', kbd: keymap.keys('repo.prCreate'), keywords: 'pr github gh create open push' });
    add('Repository', 'New pull request from branch…', pickPrBranch, { icon: 'plus', keywords: 'pr github gh create open branch' });
    add('Repository', 'Check out pull request…', () => pickPr(false), { icon: 'checkout', kbd: keymap.keys('repo.prCheckout'), keywords: 'pr github gh branch review' });
    add('Repository', 'Check out pull request in new worktree…', () => pickPr(true), { icon: 'worktree', kbd: keymap.keys('repo.prWorktree'), keywords: 'pr github gh lane review' });
    if (state.prs?.active) {
      add('Repository', 'Approve pull request…', () => approvePr(), { icon: 'check', kbd: keymap.keys('repo.prApprove'), keywords: 'pr github gh review approve' });
      add('Repository', 'Merge pull request…', () => mergePr(), { icon: 'merge', kbd: keymap.keys('repo.prMerge'), keywords: 'pr github gh squash rebase merge' });
      add('Repository', 'Close pull request…', () => closePr(), { icon: 'x', kbd: keymap.keys('repo.prClose'), keywords: 'pr github gh close' });
      add('Navigation', 'Go to Pull Request Inbox', openInbox, { icon: 'merge', kbd: keymap.keys('view.inbox'), keywords: 'pr github gh inbox review ready merge failing lanes agents' });
    }
    add('App', state.prs?.enabled ? 'Turn pull requests off' : 'Turn pull requests on', togglePrs, { icon: 'merge', kbd: keymap.keys('global.prs'), keywords: 'pr github gh enable disable everywhere' });
    if (state.prs?.enabled && state.prs.remote) add('Repository', state.prs.hidden ? 'Show pull requests in this repository' : 'Hide pull requests in this repository', () => hidePrs(!state.prs.hidden), { icon: 'eye', kbd: keymap.keys('global.prHide'), keywords: 'pr github gh hide show' });
    add('App', 'Set up AI commit messages…', setupAi, { icon: 'sparkle', keywords: 'ai llm claude codex ollama provider off' });
    add('Repository', 'Set commit identity…', openIdentity, { icon: 'commit', kbd: keymap.keys('repo.identity'), keywords: 'user email name author wrong identity' });
    add('Repository', 'Push all tags', () => act('Push tags', 'pushTags', [], { busy: 'Pushing tags…', undoable: false }), { icon: 'tag' });
    add('Repository', 'Stash changes…', () => stashSave(), { icon: 'stash', kbd: keymap.keys('repo.stash') });
    add('Repository', 'Stash staged changes…', () => stashSave({ staged: true }), { icon: 'stash', kbd: keymap.keys('repo.stashStaged'), keywords: 'partial stash index' });
    add('Repository', state.history.undo.length ? undoTitle() : 'Undo last operation', undo, { icon: 'undo', kbd: keymap.keys('edit.undo') });
    add('Repository', redoTitle(), redo, { icon: 'redo', kbd: keymap.keys('edit.redo') });
    if (nav.canBack) add('View', 'Back', goBack, { icon: 'chevronLeft', kbd: keymap.keys('view.back'), keywords: 'previous history return navigate' });
    if (nav.canForward) add('View', 'Forward', goForward, { icon: 'chevron', kbd: keymap.keys('view.forward'), keywords: 'next history navigate' });
    const snap = state.view === 'snapshots' && snapshotEntries().find((x) => x.id === state.snapSel && x.movesRefs);
    if (snap) add('Repository', `Restore before “${snap.label}”…`, () => restoreSnapshot(snap), { icon: 'restore', kbd: keymap.keys('snapshots.restore'), keywords: 'snapshot undo history timeline jump back restore' });
    add('Repository', 'Create branch at HEAD…', () => state.head.oid && createBranch(state.head.oid), { icon: 'branch' });
    add('Repository', 'Reset hard to HEAD…', resetHard, { icon: 'trash' });
    add('Repository', 'Git LFS files…', openLfs, { icon: 'cloud', kbd: keymap.keys('repo.lfs'), detail: state.lfs?.used ? (state.lfs.installed ? null : 'git-lfs missing') : 'not used', keywords: 'lfs large file storage pointer download' });
    add('Repository', state.head.branch ? `Review branch ${state.head.branch}…` : 'Review branch…', () => openReview(), { icon: 'check', kbd: keymap.keys('repo.review'), keywords: 'review reviewed tick pull request diff base merge-base lane files progress' });
    add('Repository', 'File history & blame…', () => openFileHistory(), { icon: 'history', kbd: keymap.keys('repo.fileHistory'), detail: fileHistoryTarget() || null, keywords: 'blame annotate log file history who changed line follow renames' });
    add('Repository', 'Open file in difftool', () => openDifftool(), { icon: 'diff', kbd: keymap.keys('repo.difftool'), keywords: 'difftool external diff tool compare kaleidoscope beyond' });
    if (state.view === 'commit' && (state.status[state.cv.list] || []).length) add('Repository', 'Select all files in list', () => commitView?.selectAll(), { icon: 'check', kbd: keymap.keys('cv.selectAll'), keywords: 'select all multi stage unstage discard files changes' });
    if (state.status.conflicts.length) add('Conflicts', 'Resolve conflicts…', openConflicts, { icon: 'merge', kbd: keymap.keys('repo.conflicts'), detail: `${state.status.conflicts.length} conflicted`, keywords: 'conflict editor merge resolve ours theirs' });
    if (state.view === 'commit' && state.cv.list === 'conflicts' && conflictEd?.info.kind === 'text') {
      const a = conflictEd.actions, k = CONFLICT_KEYS;
      const c = (label, run, kbd) => add('Conflicts', label, run, { icon: 'merge', kbd, keywords: 'conflict resolve' });
      if (conflictEd.blocks()) {
        c('Next conflict', a.next, k.next);
        c('Previous conflict', a.prev, k.prev);
        c('Take ours for this conflict', a.ours, k.ours);
        c('Take theirs for this conflict', a.theirs, k.theirs);
        c('Take both for this conflict', a.both, k.both);
        c('Reset this conflict', a.reset, k.reset);
        c('Take ours for every conflict', a.allOurs, k.allOurs);
        c('Take theirs for every conflict', a.allTheirs, k.allTheirs);
      }
      c(conflictEd.editing() ? 'Stop editing the result' : 'Edit the result', a.edit, k.edit);
      c('Mark file resolved', a.resolve, [MOD, 'S']);
    }
    add('Repository', 'Open conflicts in mergetool', () => openMergetool(), { icon: 'merge', kbd: keymap.keys('repo.mergetool'), detail: state.status.conflicts.length ? `${state.status.conflicts.length} conflicted` : 'no conflicts', keywords: 'mergetool external merge tool conflict resolve' });
    add('Worktrees', 'New worktree…', () => addWorktree(), { icon: 'worktree', kbd: keymap.keys('repo.worktreeAdd') });
    add('Worktrees', 'Switch worktree…', worktreeSwitcher, { icon: 'worktree', kbd: keymap.keys('repo.worktreeSwitch') });
    if (state.worktrees.some((w) => w.missing)) add('Worktrees', 'Prune missing worktrees', pruneWorktrees, { icon: 'trash' });
    for (const w of state.worktrees) {
      if (w.current || w.missing) continue;
      const detail = w.branch || (w.head ? w.head.slice(0, 7) : null);
      add('Worktrees', `Switch to worktree ${w.name}`, () => switchWorktree(w), { icon: 'worktree', detail });
      add('Worktrees', `Open worktree ${w.name} in new window`, () => openWorktreeWindow(w), { icon: 'plus', detail });
      if (!w.main) add('Worktrees', `${w.locked ? 'Unlock' : 'Lock'} worktree ${w.name}${w.locked ? '' : '…'}`, () => toggleLock(w), { icon: 'key', detail });
      if (!w.main) add('Worktrees', `Remove worktree ${w.name}…`, () => removeWorktree(w), { icon: 'trash', detail });
    }
    if (state.submodules.length) {
      add('Submodules', 'Open submodule…', submoduleSwitcher, { icon: 'submodule', kbd: keymap.keys('repo.submodules'), keywords: 'submodule nested repository' });
      add('Submodules', 'Update all submodules', () => updateSubmodules(), { icon: 'pull', kbd: keymap.keys('repo.submoduleUpdate'), keywords: 'submodule init update checkout recorded' });
      for (const m of state.submodules) {
        if (m.head) add('Submodules', `Open submodule ${m.path} in new window`, () => openSubmodule(m), { icon: 'submodule', detail: SUBMODULE_STATES[m.state][0] });
        if (['outdated', 'uninitialized'].includes(m.state)) add('Submodules', `Update submodule ${m.path}`, () => updateSubmodules([m]), { icon: 'pull', detail: SUBMODULE_STATES[m.state][0] });
      }
    }
    add('Repository', 'Open in Finder', () => api.app('reveal'), { icon: 'folder' });
    add('Repository', 'Open in Terminal', () => api.app('terminal'), { icon: 'terminal' });
    add('Repository', 'Open in hosting service', openHosting, { icon: 'external' });
    if (originRemote()?.web) add('Repository', 'Open origin in browser', openOrigin, { icon: 'external', kbd: keymap.keys('repo.origin'), detail: originRemote().label });
    add('View', state.show.tags ? 'Hide tags' : 'Show tags', () => toggleShow('tags'), { icon: 'tag' });
    add('View', state.show.remotes ? 'Hide remote branches' : 'Show remote branches', () => toggleShow('remotes'), { icon: 'cloud' });
    const laneSel = state.review?.source?.branch ? { lane: state.review.source, base: state.review.base } : state.view === 'lanes' ? lanesPage?.selected() : null;
    if (laneSel?.lane.branch && !laneSel.lane.isBase) add('Repository', `Merge and tidy ${laneSel.lane.name}…`, () => mergeLane(laneSel.lane, laneSel.base), { icon: 'merge', kbd: keymap.keys(state.review ? 'review.merge' : 'lanes.merge'), keywords: 'lane squash merge tidy cleanup remove worktree delete branch land' });
    if (laneSel && !state.review) {
      const l = laneSel.lane;
      const t = laneTitle(l);
      const next = laneActions(l)[0];
      if (next) add('Repository', `Next step on ${t}: ${ACTIONS[next].label.toLowerCase()}`, () => lanesPage.step(), { icon: 'lanes', kbd: keymap.keys('lanes.step'), keywords: 'lane next step button' });
      if (l.branch && !l.isBase && laneSel.base) add('Repository', `Rebase ${t} onto ${laneSel.base}`, () => rebaseLane(l, laneSel.base), { icon: 'rebase', kbd: keymap.keys('lanes.rebase'), keywords: 'lane conflicts update base' });
      if (l.pr?.url) add('Repository', `Open checks of ${t}`, () => laneAction('checks', l), { icon: 'external', kbd: keymap.keys('lanes.checks'), keywords: 'lane ci failing pull request github' });
      if (canRemove(l)) add('Repository', `${l.changes ? 'Discard' : 'Delete'} lane ${t}…`, () => deleteLane(l), { icon: 'trash', kbd: keymap.keys('lanes.delete'), keywords: 'lane remove worktree branch discard stalled abandon' });
      if (l.done) add('Repository', `Clean up ${t}…`, () => startCleanup(l), { icon: 'trash', kbd: keymap.keys('lanes.cleanup'), keywords: 'lane merged shipped tidy remove' });
    }
    add('Repository', 'Clean up stale branches and worktrees…', startCleanup, { icon: 'trash', kbd: keymap.keys('global.cleanup'), keywords: 'lanes prune delete merged squash gone old stale worktrees branches tidy remove bulk' });
    add('View', 'Show lanes with predicted conflicts', () => { setView('lanes'); lanesPage?.showConflicts(); }, { icon: 'lanes', keywords: 'conflict forecast merge-tree overlap lanes branches worktrees' });
    add('View', state.show.agentLanes !== false ? 'Stop marking agent-made lanes' : 'Mark lanes that look agent-made', () => toggleShow('agentLanes'), { icon: 'lanes', keywords: 'agent ai coding badge lanes worktree settings' });
    add('View', state.show.swatches ? 'Hide colour swatches in diffs' : 'Show colour swatches in diffs', () => toggleShow('swatches'), { icon: 'theme', kbd: keymap.keys('view.swatches'), keywords: 'color colour swatch preview css hex rgb settings' });
    add('View', detailToggleLabel(), () => { setView('map'); toggleDetail(); }, { icon: 'panelRight', kbd: keymap.keys('global.detail'), keywords: 'toggle commit details inspector right panel sidebar show hide' });
    add('View', sidebarToggleLabel(sbState()), toggleSidebar, { icon: 'sidebar', kbd: keymap.keys('view.sidebar'), keywords: 'toggle sidebar collapse minimize expand rail' });
    THEMES.forEach((t) => add('View', `Theme: ${t.label}`, () => setTheme(t.id), { icon: t.icon, detail: state.theme === t.id ? 'current' : null, keywords: 'appearance light dark mode system' }));
    add('View', 'Cycle theme', cycleTheme, { icon: 'theme', kbd: THEME_KBD, keywords: 'appearance light dark mode' });
    const sel = state.commits[state.index.get(state.selected)];
    if (sel) add('Commit', 'Checkout selected commit', () => checkoutSelected(sel), { icon: 'checkout', kbd: keymap.keys('commit.checkoutBranch'), detail: sel.sha === state.head.oid ? 'already HEAD' : sel.sha.slice(0, 7), keywords: 'checkout switch detach head' });
    if (sel && authorProfile(sel.email, originRemote()?.web)) add('Commit', 'View author on GitHub', () => openAuthor(sel), { icon: 'external', kbd: keymap.keys('commit.author'), detail: sel.author, keywords: 'author profile github user person' });
    if (sel && originRemote()?.web) add('Commit', 'Copy link to selected commit', () => copyCommitLink(sel.sha), { icon: 'copy', kbd: keymap.keys('map.copyLink'), detail: sel.sha.slice(0, 7), keywords: 'copy link url share permalink github web' });
    if (sel) add('Commit', 'Split selected commit…', () => openSplit(sel), { icon: 'split', kbd: keymap.keys('commit.split'), detail: sel.sha.slice(0, 7), keywords: 'split commit lines hunks rewrite' });
    add('View', 'Jump to HEAD', () => jumpTo(state.head.oid), { icon: 'checkout' });
    add('App', 'Open repository…', () => openRepo(), { icon: 'folder', kbd: keymap.keys('file.open') });
    add('App', 'Switch repository…', repoSwitcher, { icon: 'folder', kbd: keymap.keys('file.repoSwitch'), keywords: 'recent open project switch' });
    for (const x of recent) add('Recent repositories', `Switch to ${x.name}`, () => openRepo(x.root), { icon: 'folder', detail: tildePath(x.root), keywords: `recent repository open ${x.root}` });
    add('App', 'Clone repository…', cloneRepo, { icon: 'fetch' });
    add('App', 'New window', () => api.app('new-window'), { icon: 'plus' });
    add('App', 'Close repository', closeRepo, { icon: 'x' });
    add('App', state.licence?.mode === 'licensed' ? 'Licence…' : 'Enter licence key…', () => openLicence(), { icon: 'key', kbd: LICENCE_KBD, detail: trialLine(state.licence), keywords: 'license licence key activate trial register' });
    if (state.licence?.mode !== 'licensed') add('App', 'Buy GitLanes', buy, { icon: 'external', keywords: 'license licence purchase upgrade trial' });
    if (update.status === 'ready') add('App', `Restart to update to ${update.version}`, installUpdate, { icon: 'update', keywords: 'update upgrade version install' });
    else add('App', 'Check for updates', checkUpdates, { icon: 'update', detail: update.current ? `v${update.current}` : null, keywords: 'update upgrade version' });
    add('App', 'Export shortcuts…', exportShortcuts, { icon: 'command', keywords: 'keys keymap bindings custom save file json' });
    add('App', 'Import shortcuts…', importShortcuts, { icon: 'command', keywords: 'keys keymap bindings custom load file json' });
    add('App', 'Reset all shortcuts to defaults', resetShortcuts, { icon: 'command', keywords: 'keys keymap bindings custom restore default' });
    add('App', 'Keyboard shortcuts', openShortcuts, { icon: 'command', kbd: keymap.keys('help.shortcuts'), keywords: 'keys keymap bindings hotkeys cheat sheet help' });
    add('App', 'Choose defaults…', openSetup, { icon: 'check', kbd: keymap.keys('global.setup'), keywords: 'settings preferences setup onboarding defaults features welcome' });
    add('App', update.auto === false ? 'Turn on automatic update checks' : 'Turn off automatic update checks', toggleAutoUpdate, { icon: 'update', keywords: 'update automatic auto check daily settings' });
    for (const r of state.refs) {
      if (r.kind === 'branch' && r.short !== state.head.branch) add('Branches', `Checkout ${r.short}`, () => checkout(r.short), { icon: 'branch', detail: timeAgo(r.date) });
    }
    for (const r of state.refs) {
      add('Refs', `Go to ${r.short}`, () => jumpTo(r.target), { icon: r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'branch' });
    }
    for (const c of state.commits.slice(0, 5000)) {
      add('Commits', c.subject ?? c.sha.slice(0, 7), () => jumpTo(c.sha), { icon: 'commit', detail: c.sha.slice(0, 7), keywords: c.sha.slice(0, 10) + ' ' + c.author });
    }
    return items;
  });
  recentRepos(PALETTE_RECENT_LIMIT).then((list) => { recent = list; if (list.length) pal?.refresh(); });
}

async function repoMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const recent = await recentRepos(PALETTE_RECENT_LIMIT);
  contextMenu(r.left, r.bottom + 4, [
    recent.length ? { section: 'Recent repositories' } : null,
    ...recent.map((x) => ({ label: x.name, icon: 'folder', run: () => openRepo(x.root) })),
    recent.length ? '-' : null,
    { label: 'Open Repository…', icon: 'folder', kbd: keymap.keys('file.open'), run: () => openRepo() },
    { label: 'Clone Repository…', icon: 'fetch', run: cloneRepo },
    { label: 'New Window', icon: 'plus', kbd: keymap.keys('file.newWindow'), run: () => api.app('new-window') },
    '-',
    { label: 'Open in Finder', icon: 'folder', run: () => api.app('reveal') },
    { label: 'Open in Terminal', icon: 'terminal', run: () => api.app('terminal') },
    { label: 'Open in Hosting Service', icon: 'external', run: openHosting },
    '-',
    { label: 'Close Repository', icon: 'x', run: closeRepo },
  ]);
}

async function resetHard() {
  if (await confirm('Reset hard to HEAD?', `All uncommitted changes to tracked files are removed. You can undo this with ${MOD}Z.`, { submit: 'Reset' })) act('Reset hard to HEAD', 'resetHard', []);
}

async function openHosting() {
  const remotes = state.remotes.length ? state.remotes : await git('remotes').catch(() => []);
  const r = remotes.find((x) => x.name === 'origin' && x.web) || remotes.find((x) => x.web);
  if (r) api.app('external', r.web); else toast('No web URL for remotes', { kind: 'error' });
}

// ---------------------------------------------------------------------------
// Welcome screen / repository lifecycle

// The welcome tour; ⌘Z / ⇧⌘Z drive it while no repository is open.
let tour = null;

// "Choose your defaults" (setup.js): first launch shows it in the tour's place; ⌘⇧, or ⌘K reopens
// it. Switches write the same saved choices as ⌘K and the View menu, and apply at once.
const setupState = () => setupValues({ show: state.show, autoUpdate: update.auto });
async function setupFeature(id, on) {
  if (id === 'autoUpdate') { const s = await api.app('set-auto-update', on); update = { ...update, auto: s.auto }; return; }
  if (state.show[id] === on) return;
  if (state.repo) return toggleShow(id);
  state.show[id] = on;
  savePref('show', state.show);
  if (id === 'swatches') setSwatches(on);
}
// The PR row: a switch once GitHub CLI is installed and logged in, else Set up…. Without a
// repository the main process can't answer yet, so the row offers Set up….
async function prSetup() {
  const st = state.repo ? await api.app('pr-state').catch(() => null) : null;
  if (!st) return { on: false, setup: true };
  return { on: st.enabled, setup: !st.enabled && (st.gh === 'missing' || prLoggedOut) };
}
const aiLabel = () => (aiOn() && state.ai.providers.find((p) => p.id === state.ai.provider)?.label) || 'Off';
function setupPanel(onDone, done) {
  let pr = { on: false, setup: true };
  const view = setupView({
    mod: MOD, values: setupState(), theme: state.theme, themes: THEMES, ai: aiLabel(), onToggle: setupFeature, onTheme: setTheme, done,
    onAi: async () => { await setupAi(); return aiLabel(); },
    pr: { setup: true },
    onPr: async (on) => { await (on ? setupPrs({ ask: false }) : turnOffPrs()); return prSetup(); },
    onDone: () => { savePref(SETUP_PREF, { done: true }); onDone(); },
  });
  // The AI choice is saved by the main process; show it once it's read.
  Promise.all([api.app('ai-settings').then((a) => { state.ai = a; }).catch(() => {}), prSetup().then((p) => { pr = p; })])
    .then(() => view.refresh({ ...setupState(), prs: pr.on }, state.theme, aiLabel(), pr));
  return view.el;
}
function openSetup() {
  if (!state.repo) return renderWelcome({ setup: true });
  if (document.querySelector('.overlay')) return;
  const prev = document.activeElement;
  const close = () => { overlay.classList.remove('in'); setTimeout(() => overlay.remove(), 120); prev?.focus?.(); };
  const view = setupPanel(close, 'Done');
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, view);
  overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); close(); } });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  view.querySelector('.switch')?.focus();
}

// The Keyboard Shortcuts window, with the keys of the view on screen listed first.
let shortcuts = null;
function shortcutsScope() {
  if (!state.repo) return tour ? 'tour' : 'recent';
  if (state.fileHistory) return 'fileHistory';
  if (state.review) return 'review';
  if (state.split) return 'split';
  if (state.quick) return 'quick';
  return ['commit', 'stashes', 'snapshots', 'worktrees'].includes(state.view) ? state.view : 'map';
}
function openShortcuts() {
  if (shortcuts) return shortcuts.close();
  // A palette that just ran this command is still fading out; only a live dialog blocks the window.
  if (document.querySelector('.overlay:not(.closing)')) return;
  shortcuts = shortcutsWindow({
    first: shortcutsScope(),
    save: (o) => api.app('set-keymap', o),
    actions: { exportShortcuts, importShortcuts, resetShortcuts },
    onClose: () => { shortcuts = null; },
  });
}
// Export / import / reset the custom shortcuts (Keyboard Shortcuts window and ⌘K).
async function exportShortcuts() {
  try { const file = await api.app('keymap-export'); if (file) toast('Exported your shortcuts', { kind: 'success', detail: file }); }
  catch (e) { toast('Couldn’t export shortcuts', { kind: 'error', detail: e.message }); }
}
async function importShortcuts() {
  try { if (await api.app('keymap-import')) toast('Imported shortcuts', { kind: 'success' }); }
  catch (e) { toast('Couldn’t import shortcuts', { kind: 'error', detail: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
}
async function resetShortcuts() {
  if (!Object.keys(keymap.getOverrides()).length) return toast('Your shortcuts are already the defaults');
  if (!await confirm('Reset every shortcut to its default?', 'Your custom shortcuts are removed.', { submit: 'Reset All' })) return;
  await api.app('set-keymap', {});
  toast('Shortcuts reset to the defaults', { kind: 'success' });
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
  tour = tourView({ mod: MOD });
  const learn = h('div.welcome-learn', null, setup ? setupPanel(() => { learn.replaceChildren(tour.el); tour.el.querySelector('[aria-selected="true"]')?.focus(); }) : tour.el);
  const el = h('div.welcome', { tabIndex: 0 },
    h('div.welcome-drag'),
    h('div.welcome-layout', null, h('div.welcome-main', null, h('div.welcome-card', null,
      h('div.logo', null, h('div.logo-mark', null, icon('map', 22))),
      h('h1', null, 'GitLanes'),
      h('p.muted', null, 'A fast, keyboard-first Git client.'),
      trialLine(state.licence) ? h('button.licence-line', { onclick: () => openLicence() }, icon('key', 12), trialLine(state.licence), kbd(...LICENCE_KBD)) : null,
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

async function bound(promise) {
  const r = await promise;
  if (r.error) { toast('Could not open repository', { kind: 'error', detail: r.error.message }); return; }
  if (!r.ok || r.ok.focused) return;
  await loadRepo(r.ok);
}

async function loadRepo(repo) {
  // Switching between worktrees of one repository keeps the current view.
  const sameRepo = state.repo && state.repo.commonDir === repo.commonDir;
  // Another worktree is a step Back can undo; another repository starts a fresh history.
  const from = sameRepo && !navigating ? place() : null;
  if (!sameRepo) nav.clear();
  state.repo = repo;
  state.lfs = null;
  if (!sameRepo) { state.view = 'map'; state.worktrees = []; }
  state.selected = null;
  state.logKey = '';
  cancelHistory();
  setHistory(createHistory());
  state.quick = null;
  state.split = null;
  state.fileHistory = null;
  state.review = null;
  state.search = '';
  state.configFilter = '';
  commitCache.clear();
  state.remotes = [];
  state.prs = null;
  document.title = repo.name;
  if (from) nav.record(from, placeKey());
  renderShell();
  loadPrs();
  await refreshAll();
  if (state.head.oid) selectCommit(state.head.oid, 'center');
  mapView?.focus();
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
  cancelHistory();
  clearTimeout(sbHideTimer); // the sidebar's hover-close poll would hit the removed sidebar
  await api.app('close-repo');
  state.repo = null;
  sidebarEl = topbarEl = bannerEl = contentEl = null;
  mapView?.destroy(); mapView = null;
  renderShell();
}

// ---------------------------------------------------------------------------
// Global events

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
  view: (v) => setView(v),
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
  aiMessage: () => writeMessageWithAi(),
  aiSetup: () => state.repo && setupAi(),
  prs: () => state.repo && prList(),
  inbox: openInbox,
  prRefresh: () => state.repo && refreshPrs({ manual: true }),
  prCreate: () => state.repo && createPr(),
  prCheckout: () => state.repo && pickPr(false),
  prWorktree: () => state.repo && pickPr(true),
  prApprove: () => state.repo && approvePr(),
  prMerge: () => state.repo && mergePr(),
  prClose: () => state.repo && closePr(),
  licence: () => openLicence(),
  buy,
  shortcuts: () => openShortcuts(),
};
api.on('command', (cmd, ...args) => {
  // With the shortcuts window open, the menu's ⌘/ closes it and ⌘F goes to its search.
  if (shortcuts && cmd === 'shortcuts') return shortcuts.close();
  if (shortcuts && cmd === 'search') return shortcuts.find();
  if (document.querySelector('.overlay') && cmd !== 'undo' && cmd !== 'redo') return;
  commands[cmd]?.(...args);
});

// ---------------------------------------------------------------------------
// External diff & merge tools: git difftool / mergetool with the user's diff.tool / merge.tool.

// The file on screen: the open file of the commit viewer, else the file selected in Commit view.
function difftoolTarget() {
  if (state.quick) return state.quick.file ? { file: state.quick.file, args: [false, state.quick.sha, state.quick.parent] } : null;
  if (state.view !== 'commit') return null;
  const { list, path } = state.cv;
  const file = (state.status[list] || []).find((f) => f.path === path);
  return file && { file, args: [list === 'staged'], conflict: list === 'conflicts' };
}

async function openDifftool(target = difftoolTarget()) {
  if (!state.repo) return;
  if (!target) return toast('Select a file first', { detail: 'Open in Difftool works on the file shown in Commit view or in a commit.' });
  if (target.conflict) return openMergetool([target.file.path]);
  if (target.file.status === '?') return toast('Untracked files have nothing to compare', { detail: target.file.path });
  try { await git('difftool', fileRef(target.file), ...target.args); } catch (e) { toast('Couldn’t open the difftool', { kind: 'error', detail: e.message }); }
}

// ---------------------------------------------------------------------------
// File history & blame

// The file on screen (commit viewer, Commit view or the open file history), if any.
function fileHistoryTarget() {
  if (state.fileHistory) return state.fileHistory.path;
  if (state.quick) return state.quick.file?.path || null;
  if (state.view === 'commit' && state.cv.list !== 'conflicts') return (state.status[state.cv.list] || []).find((f) => f.path === state.cv.path && f.status !== '?')?.path || null;
  return null;
}

// Opens the history of `path`, of the file on screen, or of a file picked from the tracked files.
function openFileHistory(...args) { return go(() => openFileHistoryNow(...args)); }
async function openFileHistoryNow(path = fileHistoryTarget()) {
  if (!state.repo) return;
  if (!path) {
    const files = await git('trackedFiles').catch((e) => { toast('Couldn’t list files', { kind: 'error', detail: e.message }); return null; });
    if (!files?.length) return files && toast('No tracked files yet');
    while ($('.palette-overlay')) await new Promise((r) => setTimeout(r, 30)); // ⌘K is still closing
    return palette(() => files.map((p) => ({ label: p, icon: 'file', run: () => openFileHistory(p) })), { placeholder: 'File history & blame: pick a file…' });
  }
  state.quick = null;
  state.split = null;
  state.review = null;
  state.fileHistory = { path };
  renderTopbar();
  renderView();
}
function closeFileHistory(...args) { return go(() => closeFileHistoryNow(...args)); }
function closeFileHistoryNow() {
  state.fileHistory = null;
  state.review = null;
  renderTopbar();
  renderView();
}
// Shows a commit in the Map, or in the commit viewer when the graph doesn't have it (yet).
function showCommit(sha) {
  go(() => {
    setView('map');
    if (state.index.has(sha)) selectCommit(sha, 'center'); else openQuick(sha);
  });
}
function withHistoryMenu(row, f) {
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      f.status !== 'D' ? { label: 'File History & Blame', icon: 'history', kbd: keymap.keys('repo.fileHistory'), run: () => openFileHistory(f.path) } : null,
      { label: 'Copy Path', icon: 'copy', run: () => copy(f.path, 'Copied path') },
    ]);
  });
  return row;
}

// Opens the first conflicted file (or the selected one) in the built-in conflict editor.
function openConflicts() {
  if (!state.repo) return;
  const files = state.status.conflicts;
  if (!files.length) return toast('No conflicted files');
  const path = state.cv.list === 'conflicts' && files.some((f) => f.path === state.cv.path) ? state.cv.path : files[0].path;
  state.cv = { ...state.cv, list: 'conflicts', path, lines: new Set(), full: false };
  if (state.view === 'commit') commitView?.refresh(); else setView('commit');
}

// Waits for the tool to exit, then refreshes the conflict list.
let mergetoolOpen = false;
async function openMergetool(paths) {
  if (!state.repo) return;
  if (!state.status.conflicts.length) return toast('No conflicted files');
  if (mergetoolOpen) return toast('Your mergetool is already open');
  // No paths given: the selected conflict, or every conflict.
  paths ??= state.view === 'commit' && state.cv.list === 'conflicts' && state.cv.path ? [state.cv.path] : [];
  mergetoolOpen = true;
  try {
    const { remaining } = await git('mergetool', paths);
    toast(remaining.length ? `${remaining.length} conflicted file${remaining.length === 1 ? '' : 's'} left` : 'Conflicts resolved', { detail: remaining.slice(0, 3).join('\n') || null });
  } catch (e) {
    if (!e.readOnly) toast('Mergetool failed', { kind: 'error', detail: e.message });
  } finally {
    mergetoolOpen = false;
    await refreshStatus();
  }
}

// A tooltip with the command's current keys: "Pull (⌘⇧L)", or just the label when it has none.
const keyText = (id) => keymap.keys(id).join('') || 'the Command Menu';
function tip(label, ...ids) {
  const k = ids.map((id) => keymap.keys(id).join('')).filter(Boolean);
  return k.length ? `${label} (${k.join(', ')})` : label;
}

function isEditable(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }

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
  // ⌘⌥O: switch to a recent repository (also a File menu item, which handles it on macOS)
  if (keymap.match('menu', e) === 'file.repoSwitch') { e.preventDefault(); commands.repoSwitch(); return; }
  // ⌘⇧, (Ctrl+Shift+, off macOS): choose defaults. Plain ⌘, stays the menu's Settings… (Config)
  if (id === 'global.setup' && !isEditable(e.target)) { e.preventDefault(); openSetup(); return; }
  if (id === 'global.close' && state.quick) { e.preventDefault(); closeQuick(); }
  if (id === 'global.close' && state.split && !isEditable(document.activeElement)) { e.preventDefault(); closeSplit(); }
  // "G then X" navigation: the view chords in the keymap ("g c" → view.commit)
  if (!isEditable(document.activeElement) && !e.metaKey && !e.ctrlKey && state.repo) {
    if (gPending) {
      const v = keymap.match('menu', e, gPending)?.replace('view.', '');
      gPending = null;
      if (v) { e.preventDefault(); setView(v); return; }
    } else if (state.view !== 'commit' && (gPending = keymap.chordStart('menu', e))) { setTimeout(() => { gPending = null; }, 800); return; }
    if (id === 'global.search') { e.preventDefault(); commands.search(); }
    // Not while File History, Quick View or Split covers the Snapshots view: their keys would reach the hidden list.
    if (state.view === 'snapshots' && !state.fileHistory && !state.quick && !state.split && !e.altKey && !e.shiftKey && snapshotKey(e)) { e.preventDefault(); return; }
  }
  if (state.repo && id === 'global.cleanup' && !isEditable(e.target)) { e.preventDefault(); startCleanup(); return; }
  if (state.repo && id === 'global.prs') { e.preventDefault(); togglePrs(); return; }
  if (state.repo && id === 'global.prHide' && state.prs?.enabled && state.prs.remote) { e.preventDefault(); hidePrs(!state.prs.hidden); return; }
  if (state.repo && id === 'global.detail') {
    e.preventDefault();
    if (state.view === 'map' && !state.quick && !state.split && !state.fileHistory && !state.review) toggleDetail();
  }
});
let gPending = null;

// ---------------------------------------------------------------------------
// Theme (System / Light / Dark). The main process owns the setting and applies it via
// nativeTheme, which flips prefers-color-scheme here; we only repaint the canvas graph.

const THEMES = [
  { id: 'system', label: 'System', icon: 'theme' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];
const THEME_KBD = keymap.keys('view.cycleTheme');
const themeLabel = (id) => THEMES.find((t) => t.id === id)?.label || id;
const setTheme = (mode) => api.app('set-theme', mode);
const cycleTheme = () => api.app('cycle-theme');

api.on('theme', (mode, { announce } = {}) => {
  state.theme = mode;
  if (announce) toast(`Theme: ${themeLabel(mode)}`);
  setTimeout(() => mapView?.refresh(), 50);
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => mapView?.refresh());

// ---------------------------------------------------------------------------
// Trial & licence. The main process owns the state and refuses changes once the app is read-only.

api.on('licence', (s) => {
  state.licence = s;
  if (state.repo) renderTopbar(); else if (!document.querySelector('.overlay')) renderShell();
});

// here we tell the user and offer the restart. Results of a manual check show in the window that asked.

let update = { status: 'idle' };
let checkingToast = null, availableToast = null;
const announced = new Set();
const checkUpdates = () => api.app('check-updates');
const installUpdate = () => api.app('install-update');
async function toggleAutoUpdate() {
  const s = await api.app('set-auto-update', update.auto === false);
  toast(s.auto ? 'Automatic update checks are on' : 'Automatic update checks are off', { kind: 'success', detail: s.auto ? 'GitLanes checks at launch and once a day.' : 'Check any time with ⌘K → Check for updates.' });
}

function showUpdate(s) {
  update = s;
  const manual = s.manual && document.hasFocus();
  const once = (key) => { if (announced.has(key) && !manual) return false; announced.add(key); return true; };
  if (s.status !== 'checking') { checkingToast?.close(); checkingToast = null; }
  if (s.status === 'checking' && manual && !checkingToast) checkingToast = toast('Checking for updates…', { kind: 'busy', timeout: 0 });
  else if (s.status === 'idle' && manual) toast('GitLanes is up to date', { kind: 'success', detail: `Version ${s.current}` });
  else if (s.status === 'downloading' && manual) toast(`Downloading GitLanes ${s.version}…`, { detail: 'It installs when you restart.' });
  else if (s.status === 'ready' && once(`ready ${s.version}`)) {
    availableToast?.close(); availableToast = null;
    toast(`GitLanes ${s.version} is ready`, { kind: 'success', detail: 'Restart to finish updating.', timeout: 0, action: { label: 'Restart to update', run: installUpdate } });
  } else if (s.status === 'available' && once(`available ${s.version}`)) {
    availableToast?.close();
    availableToast = toast(`GitLanes ${s.version} is available`, {
      detail: s.error ? `It couldn't be installed automatically: ${s.error}` : 'Download it to update.',
      timeout: 12_000,
      action: s.page ? { label: 'Download', run: () => api.app('external', s.page) } : null,
    });
  } else if (s.status === 'error' && manual) toast('Couldn’t check for updates', { kind: 'error', detail: s.error });
  else if (s.status === 'disabled' && manual) toast('Updates come with the packaged app', { detail: 'Development builds don’t update themselves.' });
}
api.on('update', showUpdate);

// Custom key bindings changed (here or in another window): redraw everything that shows keys.
api.on('keymap', (o) => {
  keymap.setOverrides(o);
  if (state.repo) { renderSidebar(); renderTopbar(); renderView(true); }
  shortcuts?.refresh();
});

// Boot
(async () => {
  document.documentElement.classList.toggle('mac', isMac);
  state.theme = await api.app('theme');
  state.licence = await api.app('licence');
  keymap.setOverrides(await api.app('keymap'));
  api.app('ai-settings').then((a) => { state.ai = a; showAiButton(); });
  showUpdate(await api.app('update-state'));
  const params = new URLSearchParams(location.search);
  const dir = params.get('repo');
  if (dir) await openRepo(dir);
  else renderShell();
})();
