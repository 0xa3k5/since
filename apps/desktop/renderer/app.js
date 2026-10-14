import { h, $, icon, kbd, loading, toast, dialog, confirm, prompt, contextMenu, closeMenu, palette, VirtualList, timeAgo, fullDate, avatar, avatarStack } from './ui.js';
import { paint, graphWidth, laneColor, readPalette } from './graph.js';
import { parseLog, createHistory, createMerge } from './log.js';
import { renderDiff, hunkKeys, statusBadge, fileName, setSwatches, fileRef } from './diff.js';
import { openLicence, licenceChip, trialLine, buy, LICENCE_KBD } from './licence.js';
import { isCheckoutKey, isRowControl } from './keys.js';
import { conflictEditor, CONFLICT_KEYS } from './conflict-view.js';
import { fileHistoryView } from './file-history-view.js';
import { checkIdentity, matchRule, suggestPattern, upsertRule } from './identity.js';
import { sidebarMode, toggleSidebarState, sidebarToggleLabel, isNarrow } from './sidebar.js';
import { authorProfile } from './profile.js';
import { SUBMODULE_STATES } from './submodule.js';

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
  show: loadPref('show', { tags: true, remotes: true, swatches: true }),
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
  cv: { list: 'unstaged', path: null, lines: new Set(), diff: null, full: false },
  amend: false,
  collapsed: loadPref('collapsed', {}),
  theme: 'system',
  licence: null,
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
  );
}

// ---------------------------------------------------------------------------
// Shell

const root = $('#app');
let sidebarEl, topbarEl, bannerEl, contentEl;
let mapView = null, commitView = null;
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
];

function setView(v) {
  if (!state.repo) return;
  state.quick = null;
  state.split = null;
  state.fileHistory = null;
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
    onclick: () => { setView('map'); selectCommit(r.target, 'center'); },
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
      h('button.icon-btn', { title: `Command menu (${MOD}K)`, onclick: openPalette }, icon('search')),
    ),
    h('div.sb-origin', null, originLink()),
    h('nav.sb-nav', null, VIEWS.map((v) => h('button.nav-item' + (state.view === v.id ? '.active' : ''), { onclick: () => setView(v.id), 'data-view': v.id, title: `${v.label} (${MOD}${v.key})`, 'aria-label': v.label },
      icon(v.icon), h('span', null, v.label), h('span.nav-badge'), h('span.nav-kbd', null, MOD + v.key)))),
    h('div.sb-scroll', null,
      state.worktrees.length > 1 ? section('worktrees', 'Worktrees', state.worktrees, worktreeItem) : null,
      section('branches', 'Branches', branches, (r) => refItem(r)),
      [...groups].map(([name, list]) => section('remote:' + name, name, list, (r) => refItem(r, r.short.slice(name.length + 1)))),
      section('tags', 'Tags', tags, (r) => refItem(r)),
      state.submodules.length ? section('submodules', 'Submodules', state.submodules, submoduleItem) : null,
    ),
    // Icons-only stand-ins for the sections above, shown in the rail.
    h('div.sb-rail-items', null,
      state.worktrees.length > 1 ? railItem('worktrees', 'Worktrees', 'worktree') : null,
      railItem('branches', 'Branches', 'branch'),
      [...groups.keys()].map((name) => railItem('remote:' + name, `Remote ${name}`, 'cloud')),
      railItem('tags', 'Tags', 'tag'),
      state.submodules.length ? railItem('submodules', 'Submodules', 'submodule') : null,
    ),
    h('div.sb-foot', null,
      h('button.sb-action', { onclick: fetchAll, title: `Fetch all (${MOD}⇧F)`, 'aria-label': 'Fetch' }, icon('fetch'), h('span', null, 'Fetch')),
      h('button.sb-action', { onclick: pull, title: `Pull (${MOD}⇧L)`, 'aria-label': 'Pull' }, icon('pull'), h('span', null, 'Pull')),
      h('button.sb-action', { onclick: () => push(false), title: `Push (${MOD}⇧P)`, 'aria-label': 'Push' }, icon('push'), h('span', null, 'Push')),
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
    h('span.crumb-muted', null, state.repo.name), icon('chevron', 12), h('span.crumb', null, state.split ? 'Split Commit' : state.quick ? 'Quick View' : state.fileHistory ? 'File History' : v.label),
    state.head.branch ? h('span.head-chip', { title: 'Current branch' }, icon('branch', 12), state.head.branch) : state.head.oid ? h('span.head-chip.detached', null, 'Detached ' + state.head.oid.slice(0, 7)) : h('span.head-chip.detached', null, 'No commits'),
    state.worktrees.length > 1 ? h('button.head-chip.wt-chip', { title: `Switch worktree (${MOD}⌥W)`, onclick: worktreeSwitcher }, icon('worktree', 12), state.worktrees.find((w) => w.current)?.name || state.repo.name) : null,
    h('span.crumb-muted.history-note', { id: 'history-note' }, state.hist.complete ? '' : `Loading history… ${state.commits.length.toLocaleString()}`),
  );
  const right = h('div.top-right');
  if (state.view === 'map' && !state.quick && !state.split && !state.fileHistory) {
    const search = h('input.search', { placeholder: 'Search commits', value: state.search, spellcheck: false, id: 'map-search',
      oninput: (e) => { state.search = e.target.value; mapView?.refresh(); },
      onkeydown: (e) => {
        if (e.key === 'Escape') { state.search = ''; e.target.value = ''; e.target.blur(); mapView?.refresh(); }
        else if (e.key === 'Enter') { mapView?.pickFirstResult(); e.target.blur(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); e.target.blur(); }
      } });
    right.append(
      h('div.toggle-group', null,
        toggleChip('Tags', 'tags'),
        toggleChip('Remotes', 'remotes'),
      ),
      h('label.search-wrap', null, icon('search', 14), search, h('kbd.inline', null, MOD + 'F')),
      h('button.icon-btn.detail-toggle' + (state.detail ? '.on' : ''), { title: `${detailToggleLabel()} (Space, ${MOD}⌥\\)`, 'aria-pressed': String(state.detail), onclick: toggleDetail }, icon('panelRight')),
    );
  }
  if (state.view === 'commit') {
    right.append(h('button.btn.subtle', { onclick: () => stashSave() }, icon('stash', 14), 'Stash'));
  }
  const chip = licenceChip(state.licence, () => openLicence());
  if (chip) right.append(chip);
  right.append(
    h('button.icon-btn', { title: `${undoTitle()} (${MOD}Z)`, disabled: !state.history.undo.length, onclick: undo }, icon('undo')),
    h('button.icon-btn', { title: `${redoTitle()} (${MOD}⇧Z)`, disabled: !state.history.redo.length, onclick: redo }, icon('redo')),
  );
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
  if (btn) { btn.title = `${label} (${MOD}\\)`; btn.setAttribute('aria-label', label); btn.setAttribute('aria-expanded', String(mode !== 'rail')); }
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
  // Keep it open while one of its context menus or dialogs is up.
  else sbHideTimer = setTimeout(() => { if (!document.querySelector('.menu, .overlay')) setSidebar({ ...state.sidebar, hover: false }); }, 200);
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
  if (state.fileHistory) return contentEl.append(fileHistoryView({ path: state.fileHistory.path, git, onShow: showCommit, onOpen: (sha, path) => openQuick(sha, path, state.fileHistory), onClose: closeFileHistory }));
  switch (state.view) {
    case 'map': mapView = createMapView(contentEl); break;
    case 'commit': commitView = createCommitView(contentEl); break;
    case 'stashes': contentEl.append(stashesView()); break;
    case 'snapshots': contentEl.append(snapshotsView()); break;
    case 'reflog': contentEl.append(reflogView()); break;
    case 'config': contentEl.append(configView()); break;
    case 'worktrees': contentEl.append(worktreesView()); break;
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
    if (isCheckoutKey(e) && !isEditable(e.target)) { e.preventDefault(); const s = list[cur]; if (s) checkoutSelected(s); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !window.getSelection().toString()) { e.preventDefault(); copy(state.selected, 'Copied SHA'); }
      return;
    }
    const c = list[cur];
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'PageDown': move(Math.floor(scroller.clientHeight / ROW_H)); break;
      case 'PageUp': move(-Math.floor(scroller.clientHeight / ROW_H)); break;
      case 'Home': move(-list.length); break;
      case 'End': move(list.length); break;
      case 'Enter': if (results) { clearSearch(); select(c.sha, 'center'); } else openQuick(state.selected); e.preventDefault(); break;
      case ' ': e.preventDefault(); toggleDetail(); break;
      case 'Escape': if (results) clearSearch(); break;
      case 'h': if (state.head.oid) select(state.head.oid, 'center'); break;
      default: if (c) commitShortcut(e, c);
    }
  });

  refresh();
  const i = state.index.get(state.selected);
  if (i != null) requestAnimationFrame(() => vl.scrollToIndex(i, 'center'));
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
      c.parents.length ? prop(c.parents.length > 1 ? 'Parents' : 'Parent', h('span.parents', null, c.parents.map((p) => h('button.mono-link', { onclick: () => selectCommit(p, 'center') }, p.slice(0, 7))))) : null,
    ),
    h('div.files-head', null, h('span', null, `${c.files.length} file${c.files.length === 1 ? '' : 's'} changed`), h('span.stat', null, h('span.add', null, `+${add}`), h('span.del', null, `−${del}`)),
      h('button.btn.ghost.small', { onclick: () => openQuick(c.sha) }, 'Open', kbd('↵'))),
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
function openQuick(sha, path, back = null) {
  if (!sha) return;
  state.fileHistory = null;
  state.quick = { sha, path, back };
  renderTopbar();
  renderView();
}
function closeQuick() {
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
        h('button.btn.ghost.small', { onclick: closeQuick }, icon('chevron', 12), 'Back', kbd('Esc')),
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
    if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeQuick(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = files.findIndex((f) => f.path === current);
      const n = Math.max(0, Math.min(files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
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
  const splitBtn = h('button.btn.primary.wide', { onclick: () => submit() }, 'Split commit', kbd(MOD, '↵'));
  for (const t of [first, second]) {
    t.addEventListener('input', update);
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.focus(); }
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
        h('button.btn.subtle.small', { onclick: () => toggleFile(d) }, fileState(d) === 'all' ? 'Deselect file' : 'Select file', kbd('A'))),
      h('div.diff-scroll', null, renderDiff(d, { selectable: true, selection: sel, onSelect, hunkActions, full, onShowAll: () => { full = true; renderFile(); } })),
      h('div.diff-hint', null, 'Selected lines go into the first commit, everything else into the second · Click lines to select · Shift-click for ranges'),
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
        h('button.btn.ghost.small', { onclick: () => closeSplit() }, icon('chevron', 12), 'Back', kbd('Esc')),
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
    if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = diffs.findIndex((d) => d.path === current);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = diffs[Math.max(0, Math.min(diffs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { current = n.path; full = false; renderFiles(); renderFile(); files.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'a' && diffs[i]) { e.preventDefault(); toggleFile(diffs[i]); }
    else if (e.key === 'c') { e.preventDefault(); (first.value.trim() ? second : first).focus(); }
  });
  return el;
}

// ---------------------------------------------------------------------------
// Commit actions (map actions)

const branchesAt = (sha) => state.refs.filter((r) => r.kind === 'branch' && r.target === sha);

function commitShortcut(e, c) {
  const k = e.key;
  const map = {
    b: () => createBranch(c.sha), t: () => createTag(c.sha), m: () => mergeCommit(c), r: () => rebaseOnto(c),
    p: () => cherryPick(c), v: () => revertCommit(c), e: () => editMessage(c), s: () => rewriteOp('squash', c),
    f: () => rewriteOp('fixup', c), Backspace: () => rewriteOp('drop', c), Delete: () => rewriteOp('drop', c),
    o: () => checkoutCommit(c), d: () => diffWithHead(c), w: () => addWorktree({ base: c.sha }), S: () => openSplit(c), A: () => openAuthor(c),
  };
  if (map[k]) { e.preventDefault(); map[k](); }
}

function commitMenu(x, y, c) {
  const locals = branchesAt(c.sha);
  const isHead = c.sha === state.head.oid;
  const remote = originRemote();
  contextMenu(x, y, [
    { label: 'Quick View', icon: 'eye', kbd: '↵', run: () => openQuick(c.sha) },
    { label: 'Diff with HEAD', icon: 'diff', kbd: 'D', disabled: isHead, run: () => diffWithHead(c) },
    '-',
    ...(locals.length
      ? locals.map((b) => (worktreeOf(b.short)
        ? { label: `Switch to Worktree “${worktreeOf(b.short).name}”`, icon: 'worktree', run: () => switchWorktree(worktreeOf(b.short)) }
        : { label: `Checkout “${b.short}”`, icon: 'checkout', kbd: !isHead && b === locals.find((x) => x.short !== state.head.branch) ? [MOD, '↵'] : null, disabled: b.short === state.head.branch, run: () => checkout(b.short) }))
      : [{ label: 'Checkout (detached)', icon: 'checkout', kbd: 'O', disabled: isHead && state.head.detached, run: () => checkoutCommit(c) }]),
    { label: 'Create Branch…', icon: 'branch', kbd: 'B', run: () => createBranch(c.sha) },
    { label: 'Create Tag…', icon: 'tag', kbd: 'T', run: () => createTag(c.sha) },
    { label: 'New Worktree Here…', icon: 'worktree', kbd: 'W', run: () => addWorktree({ base: c.sha }) },
    state.head.branch && !isHead ? { label: `Move “${state.head.branch}” here`, icon: 'swap', run: () => setTip(state.head.branch, c) } : null,
    '-',
    { section: state.head.branch ? `Into ${state.head.branch}` : 'Into HEAD' },
    { label: 'Merge into Current', icon: 'merge', kbd: 'M', disabled: isHead, run: () => mergeCommit(c) },
    { label: 'Rebase Current onto This', icon: 'rebase', kbd: 'R', disabled: isHead, run: () => rebaseOnto(c) },
    { label: 'Cherry-pick onto Current', icon: 'cherry', kbd: 'P', disabled: isHead, run: () => cherryPick(c) },
    { label: 'Revert', icon: 'revert', kbd: 'V', run: () => revertCommit(c) },
    '-',
    { section: 'Rewrite' },
    { label: 'Edit Message…', icon: 'edit', kbd: 'E', run: () => editMessage(c) },
    { label: 'Squash with Parent', icon: 'squash', kbd: 'S', disabled: c.parents.length !== 1, run: () => rewriteOp('squash', c) },
    { label: 'Fixup with Parent', icon: 'squash', kbd: 'F', disabled: c.parents.length !== 1, run: () => rewriteOp('fixup', c) },
    { label: 'Swap with Parent', icon: 'swap', disabled: c.parents.length !== 1, run: () => rewriteOp('swapParent', c) },
    { label: 'Split Commit…', icon: 'split', kbd: ['⇧', 'S'], disabled: c.parents.length > 1, run: () => openSplit(c) },
    { label: 'Delete Commit', icon: 'trash', kbd: '⌫', danger: true, disabled: c.parents.length > 1, run: () => rewriteOp('drop', c) },
    '-',
    { label: 'Copy SHA', icon: 'copy', kbd: [MOD, 'C'], run: () => copy(c.sha, 'Copied SHA') },
    { label: 'Copy Message', icon: 'copy', run: async () => copy((await loadCommit(c.sha)).message, 'Copied message') },
    authorProfile(c.email, remote?.web) ? { label: 'View Author on GitHub', icon: 'external', kbd: ['⇧', 'A'], run: () => openAuthor(c) } : null,
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
    h('div.diff-head', null, h('button.btn.ghost.small', { onclick: () => renderView() }, icon('chevron', 12), 'Back', kbd('Esc')),
      h('span.mono', null, `${c.sha.slice(0, 7)} → HEAD`), h('span.spacer'), h('span.muted', null, `${diffs.length} files`)),
    h('div.diff-scroll', { tabIndex: 0, onkeydown: (e) => { if (e.key === 'Escape') renderView(); } }, diffs.map((d) => h('div.diff-file', null, h('div.diff-file-head', null, h('span.mono', null, d.newPath === '/dev/null' ? d.oldPath : d.newPath)), renderDiff(d)))),
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
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doCommit(); } });
  const amend = h('input', { type: 'checkbox', checked: state.amend, onchange: async (e) => {
    state.amend = e.target.checked;
    if (state.amend && !textarea.value.trim() && state.head.oid) { textarea.value = (await loadCommit(state.head.oid)).message; }
    updateCommitBtn();
  } });
  const commitBtn = h('button.btn.primary.wide', { onclick: () => doCommit() }, 'Commit', kbd(MOD, '↵'));
  // Only shown once the user has turned AI commit messages on.
  const aiBtn = h('button.icon-btn.ai-btn', { title: `Write message with AI (${MOD}⌥G)`, hidden: !aiOn(), onclick: () => writeMessageWithAi() }, icon('sparkle', 15));
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
      const row = fileRow(f, () => selectFile(list, f.path), h('span.row-actions', null,
        list === 'unstaged' ? [
          h('button.icon-btn.tiny', { title: 'Discard changes', onclick: (e) => { e.stopPropagation(); discard([f]); } }, icon('trash', 13)),
          h('button.icon-btn.tiny', { title: 'Stage', onclick: (e) => { e.stopPropagation(); quiet('stageFiles', [f.path]); } }, icon('plus', 13)),
        ] : list === 'staged' ? [
          h('button.icon-btn.tiny', { title: 'Unstage', onclick: (e) => { e.stopPropagation(); quiet('unstageFiles', [f.path]); } }, icon('minus', 13)),
        ] : [
          h('button.btn.ghost.tiny', { title: 'Use our version', onclick: (e) => { e.stopPropagation(); chooseSide(f.path, 'ours'); } }, 'Ours'),
          h('button.btn.ghost.tiny', { title: 'Use their version', onclick: (e) => { e.stopPropagation(); chooseSide(f.path, 'theirs'); } }, 'Theirs'),
          h('button.icon-btn.tiny', { title: 'Mark as resolved', onclick: (e) => { e.stopPropagation(); quiet('markResolved', f.path); } }, icon('check', 13)),
        ]));
      row.dataset.key = list + ':' + f.path;
      row.addEventListener('dblclick', () => {
        if (list === 'unstaged') quiet('stageFiles', [f.path]); else if (list === 'staged') quiet('unstageFiles', [f.path]);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          list === 'unstaged' ? { label: 'Stage', icon: 'plus', kbd: '↵', run: () => quiet('stageFiles', [f.path]) } : null,
          list === 'staged' ? { label: 'Unstage', icon: 'minus', kbd: '↵', run: () => quiet('unstageFiles', [f.path]) } : null,
          list === 'conflicts'
            ? { label: 'Open in Mergetool', icon: 'merge', kbd: [MOD, '⇧', 'M'], run: () => openMergetool([f.path]) }
            : f.status !== '?' ? { label: 'Open in Difftool', icon: 'diff', kbd: [MOD, '⇧', 'D'], run: () => openDifftool({ file: f, args: [list === 'staged'] }) } : null,
          f.status !== '?' ? { label: 'File History & Blame', icon: 'history', kbd: [MOD, '⇧', 'H'], run: () => openFileHistory(f.path) } : null,
          { label: 'Open', icon: 'file', run: () => api.app('open-file', f.path) },
          { label: 'Reveal in Finder', icon: 'folder', run: () => api.app('reveal', f.path) },
          { label: 'Copy Path', icon: 'copy', run: () => copy(f.path, 'Copied path') },
          list !== 'conflicts' ? { label: 'Stash File…', icon: 'stash', run: () => stashSave({ paths: [f.path] }) } : null,
          list === 'unstaged' ? '-' : null,
          list === 'unstaged' ? { label: 'Discard Changes…', icon: 'trash', danger: true, kbd: '⌫', run: () => discard([f]) } : null,
        ]);
      });
      return row;
    })) : h('div.cv-empty', null, list === 'staged' ? 'No staged changes' : 'Working tree clean'),
  );

  function renderLists() {
    const { staged, unstaged, conflicts } = state.status;
    lists.replaceChildren(...[
      conflicts.length ? section('Conflicts', conflicts, 'conflicts', h('button.btn.ghost.tiny', { title: `Open in your mergetool (${MOD}⇧M)`, onclick: () => openMergetool([]) }, 'Mergetool')) : null,
      section('Unstaged', unstaged, 'unstaged', unstaged.length ? [
        h('button.btn.ghost.tiny', { onclick: () => discard(unstaged) }, 'Discard all'),
        h('button.btn.ghost.tiny', { onclick: () => quiet('stageFiles', unstaged.map((f) => f.path)) }, 'Stage all'),
      ] : null),
      section('Staged', staged, 'staged', staged.length ? [
        h('button.btn.ghost.tiny', { title: `Stash only the staged changes (${MOD}⌥S)`, onclick: () => stashSave({ staged: true }) }, 'Stash'),
        h('button.btn.ghost.tiny', { onclick: () => quiet('unstageFiles', staged.map((f) => f.path)) }, 'Unstage all'),
      ] : null),
    ].filter(Boolean));
    lists.querySelectorAll('.file-row').forEach((r) => r.classList.toggle('active', r.dataset.key === state.cv.list + ':' + state.cv.path));
    updateCommitBtn();
  }

  function selectFile(list, path) {
    if (state.cv.list !== list || state.cv.path !== path) { state.cv.lines = new Set(); state.cv.full = false; }
    state.cv.list = list; state.cv.path = path;
    lists.querySelectorAll('.file-row').forEach((r) => r.classList.toggle('active', r.dataset.key === list + ':' + path));
    renderDiffPane();
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
      list !== 'conflicts' ? h('div.diff-hint', null, 'Click lines to select · Shift-click for ranges') : null,
    ].filter(Boolean));
    updateBar();
  }

  el.addEventListener('keydown', (e) => {
    if (e.target === textarea) return;
    if (state.cv.list === 'conflicts' && conflictEd?.key(e)) return;
    if (e.target.tagName === 'TEXTAREA') return;
    const all = [...state.status.conflicts.map((f) => ['conflicts', f]), ...state.status.unstaged.map((f) => ['unstaged', f]), ...state.status.staged.map((f) => ['staged', f])];
    const i = all.findIndex(([l, f]) => l === state.cv.list && f.path === state.cv.path);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { selectFile(n[0], n[1].path); lists.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter' && i !== -1) {
      e.preventDefault();
      const [l, f] = all[i];
      if (l === 'unstaged') quiet('stageFiles', [f.path]); else if (l === 'staged') quiet('unstageFiles', [f.path]);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && i !== -1 && all[i][0] === 'unstaged') {
      e.preventDefault(); discard([all[i][1]]);
    } else if (e.key === 'c' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); textarea.focus();
    }
  });
  el.tabIndex = 0;

  renderLists();
  renderDiffPane();
  setTimeout(() => el.focus({ preventScroll: true }));
  return {
    refresh: () => { renderLists(); renderDiffPane(); },
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
        h('div.empty.big', null, icon('stash', 28), h('div', null, 'No stashes'), h('div.muted', null, `Stash uncommitted changes with ${MOD}⇧S`)),
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
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target) || !state.stashes.length) return;
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
async function stashSave({ staged = false, paths = null } = {}) {
  const what = staged ? 'staged changes' : paths ? (paths.length === 1 ? baseName(paths[0]) : `${paths.length} files`) : 'changes';
  if (staged && !state.status?.staged?.length) return toast('Nothing staged to stash');
  const fields = [{ name: 'msg', label: 'Message', placeholder: 'WIP' }];
  if (!staged) fields.push({ name: 'u', type: 'checkbox', label: 'Include untracked files', value: true });
  const v = await dialog({ title: `Stash ${what}`, submit: 'Stash', fields });
  if (v) act(`Stash ${what}`, 'stashSave', [v.msg.trim(), !!v.u, { staged, paths }], { undoable: false });
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
        h('button.btn.subtle', { disabled: !u.length, onclick: undo }, icon('undo', 14), 'Undo', kbd(MOD, 'Z')),
        h('button.btn.subtle', { disabled: !r.length, onclick: redo }, icon('redo', 14), 'Redo', kbd(MOD, '⇧', 'Z'))),
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
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (step) { selectSnapshot(list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + step))].id); return true; }
  if (e.key === 'Enter' && at >= 0 && document.activeElement?.tagName !== 'BUTTON') { if (list[at].movesRefs) restoreSnapshot(list[at]); return true; }
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
async function restoreSnapshot(e) {
  let p;
  try { p = await git('previewRestore', e.id); } catch (err) { return toast('Can’t preview this snapshot', { kind: 'error', detail: err.message }); }
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
      ondblclick: () => { if (state.index.has(e.sha)) { setView('map'); selectCommit(e.sha, 'center'); } else openQuick(e.sha); },
      oncontextmenu: (ev) => {
        ev.preventDefault();
        contextMenu(ev.clientX, ev.clientY, [
          { label: 'Quick View', icon: 'eye', run: () => openQuick(e.sha) },
          state.index.has(e.sha) ? { label: 'Show in Map', icon: 'map', run: () => { setView('map'); selectCommit(e.sha, 'center'); } } : null,
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

function fetchAll() { return act('Fetch', 'fetch', [], { busy: 'Fetching all remotes…', success: 'Fetched all remotes', undoable: false }); }
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
        h('button.btn.primary', { onclick: () => addWorktree() }, icon('plus', 14), 'New worktree', kbd(MOD, '⌥', 'N')))),
    list,
    ...(state.worktrees.length < 2 ? [h('div.empty', null, `Only the ${main ? 'main ' : ''}worktree so far. Create one with ${MOD}⌥N, or press W on a commit in the Map.`)] : []),
    h('div.diff-hint.wt-hint', null, '↵ Switch · ', MOD, '↵ New window · L Lock · ⌫ Remove · N New'),
  );
  el.addEventListener('keydown', (e) => {
    const w = state.worktrees[idx];
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(state.worktrees.length - 1, idx + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); mark(); }
    else if (e.key === 'Enter' && w) { e.preventDefault(); if (e.metaKey || e.ctrlKey) openWorktreeWindow(w); else switchWorktree(w); }
    else if (e.metaKey || e.ctrlKey || e.altKey) return;
    else if (e.key === 'l' && w) { e.preventDefault(); toggleLock(w); }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && w) { e.preventDefault(); removeWorktree(w); }
    else if (e.key === 'n') { e.preventDefault(); addWorktree(); }
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

function worktreeMenu(x, y, w) {
  contextMenu(x, y, [
    { label: 'Switch to This Worktree', icon: 'worktree', kbd: '↵', disabled: w.current || w.missing, run: () => switchWorktree(w) },
    { label: 'Open in New Window', icon: 'plus', kbd: [MOD, '↵'], disabled: w.current || w.missing, run: () => openWorktreeWindow(w) },
    '-',
    { label: 'Reveal in Finder', icon: 'folder', disabled: w.missing, run: () => api.app('reveal', w.path) },
    { label: 'Open in Terminal', icon: 'terminal', disabled: w.missing, run: () => api.app('terminal', w.path) },
    { label: 'Copy Path', icon: 'copy', run: () => copy(w.path, 'Copied path') },
    '-',
    { label: w.locked ? 'Unlock' : 'Lock…', icon: 'key', kbd: 'L', disabled: w.main, run: () => toggleLock(w) },
    w.missing
      ? { label: 'Prune Missing Worktrees', icon: 'trash', danger: true, run: pruneWorktrees }
      : { label: 'Remove Worktree…', icon: 'trash', kbd: '⌫', danger: true, disabled: w.main || w.current, run: () => removeWorktree(w) },
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
    { group: 'Worktrees', label: 'New worktree…', icon: 'plus', kbd: [MOD, '⌥', 'N'], run: () => addWorktree() },
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
  if (!m.head) return toast(`${m.path} isn’t checked out yet`, { kind: 'error', detail: `Update it first (${MOD}⌥U).` });
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

function submoduleSwitcher() {
  if (!state.repo) return;
  if (!state.submodules.length) return toast('This repository has no submodules');
  palette(() => [
    ...state.submodules.map((m) => ({ group: 'Submodules', label: m.path, icon: 'submodule', detail: SUBMODULE_STATES[m.state][0], keywords: `${m.name} ${m.url}`, run: () => (m.head ? openSubmodule(m) : updateSubmodules([m])) })),
    { group: 'Submodules', label: 'Update all submodules', icon: 'pull', kbd: [MOD, '⌥', 'U'], run: () => updateSubmodules() },
  ], { placeholder: 'Open submodule…' });
}

// ---------------------------------------------------------------------------
// Command palette

// Recent repositories other than the open one, newest first.
async function recentRepos() {
  return (await api.app('recent')).filter((x) => x.root !== state.repo?.root);
}
function tildePath(p) { return p.replace(/^\/Users\/[^/]+/, '~'); }

async function repoSwitcher() {
  const recent = await recentRepos();
  if (!recent.length) return toast('No other recent repositories');
  palette(() => recent.map((x) => ({ group: 'Recent repositories', label: x.name, icon: 'folder', detail: tildePath(x.root), keywords: x.root, run: () => openRepo(x.root) })), { placeholder: 'Switch repository…' });
}

async function openPalette() {
  if (!state.repo) return;
  const recent = (await recentRepos()).slice(0, 8);
  palette(() => {
    const items = [];
    const add = (group, label, run, opts = {}) => items.push({ group, label, run, ...opts });
    VIEWS.forEach((v) => add('Navigation', `Go to ${v.label}`, () => setView(v.id), { icon: v.icon, kbd: [MOD, v.key] }));
    add('Repository', 'Fetch all remotes', fetchAll, { icon: 'fetch', kbd: [MOD, '⇧', 'F'] });
    add('Repository', 'Pull current branch', pull, { icon: 'pull', kbd: [MOD, '⇧', 'L'] });
    add('Repository', 'Push current branch', () => push(false), { icon: 'push', kbd: [MOD, '⇧', 'P'] });
    add('Repository', 'Force push current branch (with lease)', async () => { if (await confirm('Force push?', 'Overwrites the remote branch if nobody else pushed meanwhile.', { submit: 'Force push' })) push(true); }, { icon: 'push' });
    add('Repository', 'Write commit message with AI', writeMessageWithAi, { icon: 'sparkle', kbd: [MOD, '⌥', 'G'], detail: aiOn() ? null : 'off', keywords: 'ai llm generate claude codex ollama' });
    add('Repository', 'Set up AI commit messages…', setupAi, { icon: 'sparkle', keywords: 'ai llm claude codex ollama provider off' });
    add('Repository', 'Set commit identity…', openIdentity, { icon: 'commit', kbd: [MOD, '⌥', 'I'], keywords: 'user email name author wrong identity' });
    add('Repository', 'Push all tags', () => act('Push tags', 'pushTags', [], { busy: 'Pushing tags…', undoable: false }), { icon: 'tag' });
    add('Repository', 'Stash changes…', () => stashSave(), { icon: 'stash', kbd: [MOD, '⇧', 'S'] });
    add('Repository', 'Stash staged changes…', () => stashSave({ staged: true }), { icon: 'stash', kbd: [MOD, '⌥', 'S'], keywords: 'partial stash index' });
    add('Repository', state.history.undo.length ? undoTitle() : 'Undo last operation', undo, { icon: 'undo', kbd: [MOD, 'Z'] });
    add('Repository', redoTitle(), redo, { icon: 'redo', kbd: [MOD, '⇧', 'Z'] });
    const snap = state.view === 'snapshots' && snapshotEntries().find((x) => x.id === state.snapSel && x.movesRefs);
    if (snap) add('Repository', `Restore before “${snap.label}”…`, () => restoreSnapshot(snap), { icon: 'restore', kbd: ['↵'], keywords: 'snapshot undo history timeline jump back restore' });
    add('Repository', 'Create branch at HEAD…', () => state.head.oid && createBranch(state.head.oid), { icon: 'branch' });
    add('Repository', 'Reset hard to HEAD…', resetHard, { icon: 'trash' });
    add('Repository', 'Git LFS files…', openLfs, { icon: 'cloud', kbd: [MOD, '⌥', 'F'], detail: state.lfs?.used ? (state.lfs.installed ? null : 'git-lfs missing') : 'not used', keywords: 'lfs large file storage pointer download' });
    add('Repository', 'File history & blame…', () => openFileHistory(), { icon: 'history', kbd: [MOD, '⇧', 'H'], detail: fileHistoryTarget() || null, keywords: 'blame annotate log file history who changed line follow renames' });
    add('Repository', 'Open file in difftool', () => openDifftool(), { icon: 'diff', kbd: [MOD, '⇧', 'D'], keywords: 'difftool external diff tool compare kaleidoscope beyond' });
    if (state.status.conflicts.length) add('Conflicts', 'Resolve conflicts…', openConflicts, { icon: 'merge', kbd: [MOD, '⌥', 'M'], detail: `${state.status.conflicts.length} conflicted`, keywords: 'conflict editor merge resolve ours theirs' });
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
    add('Repository', 'Open conflicts in mergetool', () => openMergetool(), { icon: 'merge', kbd: [MOD, '⇧', 'M'], detail: state.status.conflicts.length ? `${state.status.conflicts.length} conflicted` : 'no conflicts', keywords: 'mergetool external merge tool conflict resolve' });
    add('Worktrees', 'New worktree…', () => addWorktree(), { icon: 'worktree', kbd: [MOD, '⌥', 'N'] });
    add('Worktrees', 'Switch worktree…', worktreeSwitcher, { icon: 'worktree', kbd: [MOD, '⌥', 'W'] });
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
      add('Submodules', 'Open submodule…', submoduleSwitcher, { icon: 'submodule', kbd: [MOD, '⌥', 'B'], keywords: 'submodule nested repository' });
      add('Submodules', 'Update all submodules', () => updateSubmodules(), { icon: 'pull', kbd: [MOD, '⌥', 'U'], keywords: 'submodule init update checkout recorded' });
      for (const m of state.submodules) {
        if (m.head) add('Submodules', `Open submodule ${m.path} in new window`, () => openSubmodule(m), { icon: 'submodule', detail: SUBMODULE_STATES[m.state][0] });
        if (['outdated', 'uninitialized'].includes(m.state)) add('Submodules', `Update submodule ${m.path}`, () => updateSubmodules([m]), { icon: 'pull', detail: SUBMODULE_STATES[m.state][0] });
      }
    }
    add('Repository', 'Open in Finder', () => api.app('reveal'), { icon: 'folder' });
    add('Repository', 'Open in Terminal', () => api.app('terminal'), { icon: 'terminal' });
    add('Repository', 'Open in hosting service', openHosting, { icon: 'external' });
    if (originRemote()?.web) add('Repository', 'Open origin in browser', openOrigin, { icon: 'external', kbd: [MOD, '⇧', 'G'], detail: originRemote().label });
    add('View', state.show.tags ? 'Hide tags' : 'Show tags', () => toggleShow('tags'), { icon: 'tag' });
    add('View', state.show.remotes ? 'Hide remote branches' : 'Show remote branches', () => toggleShow('remotes'), { icon: 'cloud' });
    add('View', state.show.swatches ? 'Hide colour swatches in diffs' : 'Show colour swatches in diffs', () => toggleShow('swatches'), { icon: 'theme', kbd: [MOD, '⌥', 'C'], keywords: 'color colour swatch preview css hex rgb settings' });
    add('View', detailToggleLabel(), () => { setView('map'); toggleDetail(); }, { icon: 'panelRight', kbd: [MOD, '⌥', '\\'], keywords: 'toggle commit details inspector right panel sidebar show hide' });
    add('View', sidebarToggleLabel(sbState()), toggleSidebar, { icon: 'sidebar', kbd: [MOD, '\\'], keywords: 'toggle sidebar collapse minimize expand rail' });
    THEMES.forEach((t) => add('View', `Theme: ${t.label}`, () => setTheme(t.id), { icon: t.icon, detail: state.theme === t.id ? 'current' : null, keywords: 'appearance light dark mode system' }));
    add('View', 'Cycle theme', cycleTheme, { icon: 'theme', kbd: THEME_KBD, keywords: 'appearance light dark mode' });
    const sel = state.commits[state.index.get(state.selected)];
    if (sel) add('Commit', 'Checkout selected commit', () => checkoutSelected(sel), { icon: 'checkout', kbd: [MOD, '↵'], detail: sel.sha === state.head.oid ? 'already HEAD' : sel.sha.slice(0, 7), keywords: 'checkout switch detach head' });
    if (sel && authorProfile(sel.email, originRemote()?.web)) add('Commit', 'View author on GitHub', () => openAuthor(sel), { icon: 'external', kbd: ['⇧', 'A'], detail: sel.author, keywords: 'author profile github user person' });
    if (sel) add('Commit', 'Split selected commit…', () => openSplit(sel), { icon: 'split', kbd: ['⇧', 'S'], detail: sel.sha.slice(0, 7), keywords: 'split commit lines hunks rewrite' });
    add('View', 'Jump to HEAD', () => { setView('map'); selectCommit(state.head.oid, 'center'); }, { icon: 'checkout' });
    add('App', 'Open repository…', () => openRepo(), { icon: 'folder', kbd: [MOD, 'O'] });
    add('App', 'Switch repository…', repoSwitcher, { icon: 'folder', kbd: [MOD, '⌥', 'O'], keywords: 'recent open project switch' });
    for (const x of recent) add('Recent repositories', `Switch to ${x.name}`, () => openRepo(x.root), { icon: 'folder', detail: tildePath(x.root), keywords: `recent repository open ${x.root}` });
    add('App', 'Clone repository…', cloneRepo, { icon: 'fetch' });
    add('App', 'New window', () => api.app('new-window'), { icon: 'plus' });
    add('App', 'Close repository', closeRepo, { icon: 'x' });
    add('App', state.licence?.mode === 'licensed' ? 'Licence…' : 'Enter licence key…', () => openLicence(), { icon: 'key', kbd: LICENCE_KBD, detail: trialLine(state.licence), keywords: 'license licence key activate trial register' });
    if (state.licence?.mode !== 'licensed') add('App', 'Buy GitLanes', buy, { icon: 'external', keywords: 'license licence purchase upgrade trial' });
    if (update.status === 'ready') add('App', `Restart to update to ${update.version}`, installUpdate, { icon: 'update', keywords: 'update upgrade version install' });
    else add('App', 'Check for updates', checkUpdates, { icon: 'update', detail: update.current ? `v${update.current}` : null, keywords: 'update upgrade version' });
    add('App', update.auto === false ? 'Turn on automatic update checks' : 'Turn off automatic update checks', toggleAutoUpdate, { icon: 'update', keywords: 'update automatic auto check daily settings' });
    for (const r of state.refs) {
      if (r.kind === 'branch' && r.short !== state.head.branch) add('Branches', `Checkout ${r.short}`, () => checkout(r.short), { icon: 'branch', detail: timeAgo(r.date) });
    }
    for (const r of state.refs) {
      add('Refs', `Go to ${r.short}`, () => { setView('map'); selectCommit(r.target, 'center'); }, { icon: r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'branch' });
    }
    for (const c of state.commits.slice(0, 5000)) {
      add('Commits', c.subject ?? c.sha.slice(0, 7), () => { setView('map'); selectCommit(c.sha, 'center'); }, { icon: 'commit', detail: c.sha.slice(0, 7), keywords: c.sha.slice(0, 10) + ' ' + c.author });
    }
    return items;
  });
}

async function repoMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const recent = (await api.app('recent')).filter((x) => x.root !== state.repo?.root).slice(0, 8);
  contextMenu(r.left, r.bottom + 4, [
    recent.length ? { section: 'Recent repositories' } : null,
    ...recent.map((x) => ({ label: x.name, icon: 'folder', run: () => openRepo(x.root) })),
    recent.length ? '-' : null,
    { label: 'Open Repository…', icon: 'folder', kbd: [MOD, 'O'], run: () => openRepo() },
    { label: 'Clone Repository…', icon: 'fetch', run: cloneRepo },
    { label: 'New Window', icon: 'plus', kbd: [MOD, '⇧', 'N'], run: () => api.app('new-window') },
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

async function renderWelcome() {
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
  const el = h('div.welcome', { tabIndex: 0 },
    h('div.welcome-drag'),
    h('div.welcome-card', null,
      h('div.logo', null, h('div.logo-mark', null, icon('map', 22))),
      h('h1', null, 'GitLanes'),
      h('p.muted', null, 'A fast, keyboard-first Git client.'),
      trialLine(state.licence) ? h('button.licence-line', { onclick: () => openLicence() }, icon('key', 12), trialLine(state.licence), kbd(...LICENCE_KBD)) : null,
      h('div.welcome-actions', null,
        h('button.btn.primary', { onclick: () => openRepo() }, icon('folder', 14), 'Open repository', kbd(MOD, 'O')),
        h('button.btn.subtle', { onclick: cloneRepo }, icon('fetch', 14), 'Clone', kbd(MOD, '⇧', 'O')),
        h('button.btn.subtle', { onclick: initRepo }, icon('plus', 14), 'New', kbd(MOD, 'N')),
      ),
      recent.length ? h('div.recent-head', null, 'Recent') : null,
      list,
    ),
  );
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(recent.length - 1, idx + 1); renderList(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); renderList(); }
    if (e.key === 'Enter' && recent[idx]) openRepo(recent[idx].root);
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
  state.search = '';
  state.configFilter = '';
  commitCache.clear();
  state.remotes = [];
  document.title = repo.name;
  renderShell();
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
  undo: () => { if (isEditable(document.activeElement)) document.execCommand('undo'); else if (state.repo) undo(); },
  redo: () => { if (isEditable(document.activeElement)) document.execCommand('redo'); else if (state.repo) redo(); },
  search: () => { if (!state.repo) return; if (state.view !== 'map' || state.quick || state.split || state.fileHistory) setView('map'); setTimeout(() => $('#map-search')?.focus()); },
  palette: openPalette,
  view: (v) => setView(v),
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
  identity: () => openIdentity(),
  aiMessage: () => writeMessageWithAi(),
  aiSetup: () => state.repo && setupAi(),
  licence: () => openLicence(),
  buy,
};
api.on('command', (cmd, ...args) => {
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
async function openFileHistory(path = fileHistoryTarget()) {
  if (!state.repo) return;
  if (!path) {
    const files = await git('trackedFiles').catch((e) => { toast('Couldn’t list files', { kind: 'error', detail: e.message }); return null; });
    if (!files?.length) return files && toast('No tracked files yet');
    while ($('.palette-overlay')) await new Promise((r) => setTimeout(r, 30)); // ⌘K is still closing
    return palette(() => files.map((p) => ({ label: p, icon: 'file', run: () => openFileHistory(p) })), { placeholder: 'File history & blame: pick a file…' });
  }
  state.quick = null;
  state.split = null;
  state.fileHistory = { path };
  renderTopbar();
  renderView();
}
function closeFileHistory() {
  state.fileHistory = null;
  renderTopbar();
  renderView();
}
// Shows a commit in the Map, or in the commit viewer when the graph doesn't have it (yet).
function showCommit(sha) {
  setView('map');
  if (state.index.has(sha)) selectCommit(sha, 'center'); else openQuick(sha);
}
function withHistoryMenu(row, f) {
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      f.status !== 'D' ? { label: 'File History & Blame', icon: 'history', kbd: [MOD, '⇧', 'H'], run: () => openFileHistory(f.path) } : null,
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

function isEditable(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.overlay')) return;
  if (e.key === 'Escape' && sidebarMode(sbState()) === 'overlay') {
    e.preventDefault();
    clearTimeout(sbHideTimer);
    const inside = sidebarEl.contains(document.activeElement);
    setSidebar({ ...state.sidebar, pinned: false, hover: false });
    if (inside) sidebarEl.querySelector('.sb-toggle')?.focus();
    return;
  }
  // ⌘⌥O: switch to a recent repository (e.code, since ⌥ turns the key into "ø")
  if (e.code === 'KeyO' && (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey) { e.preventDefault(); commands.repoSwitch(); return; }
  if (e.key === 'Escape' && state.quick) { e.preventDefault(); closeQuick(); }
  if (e.key === 'Escape' && state.split && !isEditable(document.activeElement)) { e.preventDefault(); closeSplit(); }
  // "G then X" navigation
  if (!isEditable(document.activeElement) && !e.metaKey && !e.ctrlKey && state.repo) {
    if (gPending) {
      gPending = false;
      const v = { m: 'map', c: 'commit', s: 'stashes', h: 'snapshots', r: 'reflog', w: 'worktrees' }[e.key];
      if (v) { e.preventDefault(); setView(v); return; }
    } else if (e.key === 'g' && state.view !== 'commit') { gPending = true; setTimeout(() => { gPending = false; }, 800); return; }
    if (e.key === '/' ) { e.preventDefault(); commands.search(); }
    if (state.view === 'snapshots' && !e.altKey && !e.shiftKey && snapshotKey(e)) { e.preventDefault(); return; }
  }
  if (state.repo && e.code === 'Backslash' && (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (state.view === 'map' && !state.quick && !state.split && !state.fileHistory) toggleDetail();
  }
});
let gPending = false;

// ---------------------------------------------------------------------------
// Theme (System / Light / Dark). The main process owns the setting and applies it via
// nativeTheme, which flips prefers-color-scheme here; we only repaint the canvas graph.

const THEMES = [
  { id: 'system', label: 'System', icon: 'theme' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];
const THEME_KBD = isMac ? ['⌃', '⌘', 'T'] : ['Ctrl', 'Alt', '⇧', 'T'];
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

// Boot
(async () => {
  document.documentElement.classList.toggle('mac', isMac);
  state.theme = await api.app('theme');
  state.licence = await api.app('licence');
  api.app('ai-settings').then((a) => { state.ai = a; showAiButton(); });
  showUpdate(await api.app('update-state'));
  const params = new URLSearchParams(location.search);
  const dir = params.get('repo');
  if (dir) await openRepo(dir);
  else renderShell();
})();
