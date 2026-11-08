import { h, $, icon, toast } from '../lib/ui.ts';
import { parseLog, createHistory, createMerge } from './log.ts';
import { forgetCounts } from '../lanes/lanes-view.ts';
import { up } from '../lib/upcalls.ts';
import { state } from '../lib/app-helpers.ts';
import { mapView, lanesPage, branchesPage, catchupPage, reviewPage, commitView } from '../shell/shell.ts';
import { coalesce, git } from '../lib/bridge.ts';
import type { History } from './log.ts';
import type { PillRef } from '../lib/app-helpers.ts';
import type { Head, LfsInfo, Ref, RepoInfo, Worktree } from '../../shared/git-types.ts';

/** The newest commits, read before the ordered log; `repo` and `opts` say what it was read for. */
type Preview = History & { repo?: RepoInfo | null; opts?: string };

// Data loading

const refreshHistory = coalesce(async () => {
  if (!state.repo) return;
  // On a first load, start reading the newest commits while the refs load.
  if (!state.logKey && !previewAhead) previewAhead = readPreview(logOpts()).catch(() => null);
  const [{ refs, head }, opInfo, history, worktrees] = await Promise.all([
    git('refs'),
    git('opInfo'),
    git('history', state.historyLimit),
    git('worktrees').catch(() => []),
  ]);
  const worktreesChanged = JSON.stringify(worktrees) !== JSON.stringify(state.worktrees);
  state.worktrees = worktrees;
  state.refs = refs;
  state.head = head;
  state.opInfo = opInfo;
  state.opState = opInfo?.op ?? null;
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
  up.renderSidebar();
  up.renderTopbar();
  up.renderBanner();
  if (state.view === 'map') mapView?.refresh();
  if (state.view === 'lanes') lanesPage?.refresh();
  if (state.view === 'branches') branchesPage?.refresh();
  else if (logChanged || worktreesChanged) up.countFinished();
  if (logChanged) forgetCounts(state.repo?.root);
  if (logChanged) { if (state.view === 'catchup' && catchupPage) catchupPage.refresh(); else up.countCatchup(); }
  if (state.review) reviewPage?.refresh();
  // The reflog marks entries unreachable from the loaded history.
  if (state.view === 'snapshots' || (state.view === 'reflog' && logChanged) || (state.view === 'worktrees' && worktreesChanged)) up.renderView();
  // Ref pages rebuild only when their rows changed, so a refresh keeps the selection and focus.
  if (up.REF_LISTS[state.view] && !state.review && !state.quick && !state.split && !state.fileHistory && up.refListKey(state.view) !== up.refListShown) up.renderView();
});

function tipsKey(refs: readonly Ref[], head: Head, worktrees: readonly Worktree[] = []) {
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
let previewAhead: Promise<Preview | null> | null = null;

const logOpts = () => ({ remotes: state.show.remotes, tags: state.show.tags });
type LogOpts = ReturnType<typeof logOpts>;

// The newest commits in plain date order, with details: shown before the ordered log arrives.
async function readPreview(opts: LogOpts): Promise<Preview | null> {
  const preview: Preview = createHistory();
  preview.repo = state.repo;
  const { id } = await git('logOpen', { ...opts, kind: 'full', preview: true, limit: PREVIEW });
  for (let text: string | null | false; (text = await git('logRead', id)) !== null;) {
    if (text === false) return null; // closed: another repository was opened
    preview.add(parseLog(text, 'full'));
  }
  preview.opts = JSON.stringify(opts);
  return preview;
}

function setHistory(hist: History) {
  state.hist = hist;
  state.commits = hist.commits;
  state.index = hist.index;
  state.graph = hist.graph;
  markLoading();
}

function markLoading(details?: string) {
  const ds = document.documentElement.dataset;
  ds.history = state.hist.complete ? 'ready' : 'loading';
  if (details) ds.details = details;
  ds.commits = String(state.commits.length);
  const note = $('#history-note');
  if (note) note.textContent = state.hist.complete ? '' : `Loading history… ${state.commits.length.toLocaleString()}`;
}

// Pull a log stream from the main process, passing each chunk to fn, until it ends or a newer
// load starts. Resolves true if the stream was read to the end. Main answers false for a stream
// it has closed (the repository was replaced or closed): that is not the end of the log, so the
// history is left incomplete and reloads on the next refresh.
async function readLog(opts: LogOpts & { kind: string }, seq: number, fn: (text: string) => void) {
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
  let shown: (value: void) => void = () => {};
  const firstScreen = new Promise<void>((r) => { shown = r; });
  let live = false; // is the history being built already on screen?
  let target: History | null = null;

  const grew = () => {
    markLoading();
    if (state.view === 'map') mapView?.grow();
  };
  const show = (hist: History) => {
    live = hist === target;
    setHistory(hist);
    fixSelection();
    if (state.view === 'map') mapView?.refresh();
    // The reflog marks entries unreachable from this history; a reload lands after refreshHistory's render.
    else if (state.view === 'reflog') up.renderView(true);
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
      const t = createHistory(head);
      target = t;
      for (const c of preview.commits) t.seed(c);
      // Rows without details stay placeholders until fetched on demand, so a failure here only
      // leaves the loading marker up; it must not surface as an unhandled rejection.
      const details = readLog({ ...opts, kind: 'details' }, seq, (text) => {
        if (t.fill(text) && live) mapView?.refreshPending();
      }).catch(() => false);
      markLoading('loading');
      const ok = await readLog({ ...opts, kind: 'topo' }, seq, (text) => {
        t.add(parseLog(text, 'topo'));
        if (live) grew();
        else if (t.length >= needed()) show(t);
      });
      if (!ok || seq !== loadSeq) return;
      t.complete = true;
      show(t);
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
      from = hist.index.get(missing[missing.length - 1]!)! + 1; // missingDetails lists indexed commits
      if (hist.fill(await git('logDetails', missing))) mapView?.refreshPending();
    }
    if (seq === loadSeq) markLoading('ready');
  };
  run().then(() => shown(), (e) => { shown(); if (seq === loadSeq) { state.logKey = ''; toast('Could not load history', { kind: 'error', detail: e.message }); } });
  return firstScreen;
}

// Details for rows on screen that the streams have not reached yet (e.g. after jumping to the end).
const wanted = new Set<string>();
let wantTimer = 0;
function wantDetails(sha: string) {
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
  const [status, opInfo] = await Promise.all([git('status'), git('opInfo')]);
  const opChanged = JSON.stringify(opInfo) !== JSON.stringify(state.opInfo) || status.conflicts.length !== state.status?.conflicts?.length;
  state.status = status;
  state.opInfo = opInfo;
  state.opState = opInfo?.op ?? null;
  up.renderNavCounts();
  if (opChanged) up.renderBanner();
  if (state.view === 'commit') commitView?.refresh();
  refreshSubmodules();
});

// A submodule's state changes with its own work tree, so this follows the status refresh.
async function refreshSubmodules() {
  const root = state.repo?.root;
  const subs = await git('submodules').catch(() => []);
  if (state.repo?.root !== root || JSON.stringify(subs) === JSON.stringify(state.submodules)) return;
  state.submodules = subs;
  up.renderSidebar();
}

async function refreshAux() {
  if (!state.repo) return;
  up.refreshRemotes();
  // Re-render only when the data changed: a rebuild drops filters, selection and in-flight clicks.
  const shown = () => JSON.stringify([state.stashes, state.view === 'reflog' && state.reflog]);
  const before = shown();
  state.stashes = await git('stashes').catch(() => []);
  refreshLfs();
  if (state.view === 'reflog') state.reflog = await git('reflog').catch(() => []);
  if (up.prefs && state.repo) { state.config = await git('config').catch(() => []); up.prefs.refresh(); }
  if (shown() !== before) up.renderSidebar(); else up.renderNavCounts();
  if (['stashes', 'reflog'].includes(state.view) && shown() !== before) up.renderView(true);
}

async function refreshLfs() {
  const root = state.repo?.root;
  const lfs = await git('lfs').catch(() => null);
  if (!state.repo || state.repo.root !== root) return;
  const warn = (l: LfsInfo | null) => !!(l?.used && !l.installed);
  const changed = warn(lfs) !== warn(state.lfs);
  state.lfs = lfs;
  if (changed) up.renderBanner();
}

async function refreshAll() {
  await Promise.all([refreshHistory(), refreshStatus(), refreshAux()]);
}

function indexRefs() {
  const by = new Map<string, PillRef[]>();
  const push = (sha: string, r: PillRef) => { let list = by.get(sha); if (!list) { list = []; by.set(sha, list); } list.push(r); };
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
  up.indexPrs();
}
const rank = (r: PillRef) => (r.kind === 'head' ? 0 : r.kind === 'branch' ? (r.short === state.head.branch ? 0 : 1) : r.kind === 'worktree' ? 1 : r.kind === 'remote' ? 2 : 3);

// The other worktree that has `branch` checked out, if any.
const worktreeOf = (branch: string | null) => state.worktrees.find((w) => !w.current && w.branch === branch);

function refPill(r: PillRef) {
  const isHead = r.kind === 'branch' && r.short === state.head.branch;
  const synced = r.kind === 'branch' && r.upstream && state.refs.some((x) => x.kind === 'remote' && x.short === r.upstream && x.target === r.target);
  const wt = r.kind === 'branch' && !isHead ? worktreeOf(r.short) : r.kind === 'worktree' ? r.worktree : undefined;
  const title = r.kind === 'worktree' ? `Worktree ${r.short} (detached HEAD)` : r.kind === 'branch' && r.upstream ? `${r.short} → ${r.upstream}` : r.short;
  return h('span.pill.' + r.kind + (isHead ? '.head' : '') + (wt ? '.in-worktree' : ''), { title: wt && r.kind === 'branch' ? `${title} · checked out in worktree ${wt.name}` : title },
    icon(r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : r.kind === 'head' ? 'checkout' : r.kind === 'worktree' ? 'worktree' : 'branch', 12),
    r.short,
    wt && r.kind === 'branch' ? icon('worktree', 12) : null,
    synced && state.show.remotes ? icon('cloud', 12) : null,
    r.kind === 'branch' && (r.ahead || r.behind) ? h('span.track', null, r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : '') : null,
    up.prBadge(up.prFor(r)),
  );
}

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { refreshAll, refreshStatus });

export { refreshAux, refreshHistory, worktreeOf, wantDetails, refPill, refreshAll, refreshStatus, cancelHistory, setHistory };
