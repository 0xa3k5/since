import { h, icon, kbd, toast, dialog, confirm, contextMenu, menuAnchor, palette, timeAgo, resolveSheet } from '../lib/ui.ts';
import { methodFix, mergeViaNote } from '../prs/gh-gates.ts';
import { removalPlan } from './worktree-removal.ts';
import { opSentence } from '../commit/resolve-text.ts';
import * as keymap from '../palette/keymap.ts';
import { lanesView, reviewCounts, cachedPrs } from './lanes-view.js';
import { branchesView } from '../branches/branches-view.js';
import { isFinished } from '../branches/branches.ts';
import { catchupView } from '../catchup/catchup-view.js';
import { landedEntries } from '../catchup/catchup.js';
import { STALE_DAYS, cleanupItem } from '../branches/cleanup.ts';
import { laneTarget, laneKey, laneTitle, canRemove, switchAway } from './lanes.ts';
import { reviewPane } from '../review/review-pane.js';
import { openSendBack } from './send-back-view.js';
import { openMergePlan } from './merge-plan-view.js';
import { openStackLink } from './stack-link-view.js';
import { loadPrReview, leavesPage } from '../prs/pr-review.ts';
import { storeKey, readTicks, progress as reviewProgress } from '../review/review.ts';
import { pageOf } from '../shell/sidebar.ts';
import { SUBMODULE_STATES } from '../lib/submodule.ts';
import { AUTOSTASH_DEFAULT, stashMessage } from '../commit/autostash.ts';
import { mergeHereBlock } from '../lib/git-version.ts';
import { needsCheckConfirm } from './check-confirm.js';
import { up } from '../lib/upcalls.ts';
import { state, sentence, tip, isEditable, tildify, keyText, api, loadPref, savePref, MOD, parentDir } from '../lib/app-helpers.ts';
import { lanesPage, setLanesPage, catchupPage, setCatchupPage, catchupCount, assignCatchupCount, countRun, setCountRun, branchesPage, setBranchesPage, finishedCount, assignFinishedCount, finishedRun, setFinishedRun, reviewCount, assignReviewCount, reviewRun, setReviewRun } from '../shell/shell.ts';
import { git, updateGit, gitWhy, undo, coalesce, abortAnd, act } from '../lib/bridge.ts';
import { refreshAll, refreshHistory, worktreeOf } from '../graph/load.js';
import { editRemoteUrl, remoteMenu, addRemote, fetchAll } from '../branches/remote-ops.ts';
import { showCommit } from '../history/file-history.js';
import { checkoutPr, mergeReadyPrs, setupPrs, toggleDraft, prRemote, prError, approvePr, requestChangesPr, mergePr, closePr, openPrOnGitHub, updatePrBranch, REMOTE_NOTE, prCall, OWN_PR, refreshPrs, fixMergeGate, prCheckLines, checkFailEl } from '../prs/prs-page.js';
import { commitSide } from '../graph/map.js';
import { refMenu, canSwitchFrom, switchTarget, switchChanges, switchAndDelete, changesText, showStashAction, copy, checkout, createBranch } from '../graph/commit-actions.js';
import { openRepo } from '../settings/prefs-window.js';
import { jumpTo, lanesPlace, lanesOpen, navigating, navDepth, nav, place, placeKey, renderTopbar, setLanesPlace, paneHandle, setView, renderNavCounts, go, renderView } from '../shell/navigation.js';

// Worktrees: extra working folders of this repository, each with its own
// branch or detached HEAD. A window shows one worktree and can switch between them.

// The Remotes, Tags and Submodules pages (AK-463): a sidebar section at full width. ↑/↓ move, ↵ opens the row
// (a tag or remote branch shows in the Map, a remote edits its URL, a submodule opens), right-click for its menu.
const REF_LISTS = {
  remoteList: { lede: 'Every remote and its branches.', empty: 'No remotes yet.' },
  tagList: { lede: 'Every tag, newest first.', empty: 'No tags yet.' },
  submoduleList: { lede: 'The repositories nested in this one.', empty: 'No submodules.' },
};
function refListRows(view) {
  const refRow = (r, label, nested) => ({ icon: r.kind === 'tag' ? 'tag' : 'branch', label, nested, when: r.date ? timeAgo(r.date) : '', open: () => jumpTo(r.target), menu: (x, y) => refMenu(x, y, r) });
  if (view === 'tagList') return state.refs.filter((r) => r.kind === 'tag').sort((a, b) => b.date - a.date).map((r) => refRow(r, r.short));
  if (view === 'submoduleList') return state.submodules.map((m) => ({ icon: 'submodule', label: m.path, sub: [sentence(SUBMODULE_STATES[m.state][0]), m.url].filter(Boolean).join(' · '), open: () => openSubmodule(m), menu: (x, y) => submoduleMenu(x, y, m) }));
  const remote = state.refs.filter((r) => r.kind === 'remote');
  const names = [...new Set([...state.remotes.map((r) => r.name), ...remote.map((r) => r.short.split('/')[0])])];
  return names.flatMap((name) => {
    const r = state.remotes.find((x) => x.name === name);
    return [
      r ? { icon: 'cloud', label: name, sub: r.label, open: () => editRemoteUrl(r), menu: (x, y) => remoteMenu(x, y, r) } : null,
      ...remote.filter((b) => b.short.startsWith(name + '/')).map((b) => refRow(b, b.short.slice(name.length + 1), true)),
    ];
  }).filter(Boolean);
}
let refListShown = '';
const refListSel = {};
const refListKey = (view, rows = refListRows(view)) => view + '\n' + rows.map((r) => `${r.label}\t${r.sub || ''}`).join('\n');

function refListView(view) {
  const page = pageOf(view);
  const rows = refListRows(view);
  refListShown = refListKey(view, rows);
  const el = h('div.page.flush', { tabIndex: 0 });
  const list = h('div.ref-list');
  let idx = Math.max(0, rows.findIndex((r) => r.label === refListSel[view]));
  const mark = () => {
    refListSel[view] = rows[idx]?.label;
    list.querySelectorAll('.ref-row').forEach((row, i) => row.classList.toggle('selected', i === idx));
  };
  rows.forEach((r, i) => list.append(h('div.ref-row' + (r.nested ? '.nested' : ''), {
    onclick: () => { idx = i; mark(); },
    ondblclick: r.open,
    oncontextmenu: (e) => { e.preventDefault(); idx = i; mark(); r.menu(e.clientX, e.clientY); },
  }, icon(r.icon, 14), h('span.ref-name', null, r.label), h('span.ref-sub', null, r.sub || ''), h('span.when', null, r.when || ''))));
  el.append(
    h('div.page-head', null,
      h('div', null, h('h1', null, page.label), h('p.muted', null, REF_LISTS[view].lede)),
      view === 'remoteList' ? h('div.page-actions', null, h('button.btn.subtle', { title: tip('Add remote', 'repo.remotes'), onclick: () => addRemote() }, icon('plus', 14), 'Add remote…')) : null),
    rows.length ? list : h('div.empty', null, REF_LISTS[view].empty),
  );
  el.addEventListener('keydown', (e) => {
    const id = keymap.match('list', e);
    if (!id || isEditable(e.target) || !rows.length) return;
    e.preventDefault();
    if (id === 'list.open') return rows[idx].open();
    idx = Math.max(0, Math.min(rows.length - 1, idx + { 'list.next': 1, 'list.prev': -1 }[id]));
    mark();
    list.querySelector('.ref-row.selected')?.scrollIntoView({ block: 'nearest' });
  });
  mark();
  setTimeout(() => el.focus({ preventScroll: true }));
  return el;
}

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
      h('div', null, h('h1', null, 'Worktrees'), h('p.muted', null, 'A working folder per branch.')),
      h('div.page-actions', null,
        missing ? h('button.btn.subtle', { onclick: pruneWorktrees }, 'Prune missing') : null,
        h('button.btn.primary', { onclick: () => addWorktree() }, icon('plus', 14), 'New worktree', kbd(...keymap.keys('repo.worktreeAdd'))))),
    list,
    ...(state.worktrees.length < 2 ? [h('div.empty', null, `Only the ${main ? 'main ' : ''}worktree so far. Create one with ${keyText('repo.worktreeAdd')}, or press ${keyText('commit.worktree')} on a commit in the Map.`)] : []),
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
  lanesPage?.destroy();
  setLanesPage(lanesView({
    repo: state.repo.root,
    onCounts: (c) => setReviewCount(c.needs),
    git,
    load: (opts) => api.app('lanes-list', opts),
    forecast: () => api.app('lanes-forecast'),
    mergeStates: (remote, numbers) => api.app('pr-merge-states', remote, numbers),
    prsOn: () => Boolean(state.prs?.active),
    markAgents: () => state.show.agentLanes !== false,
    onOpen: openLane,
    onCheckout: (pr, opts) => checkoutPr(pr, opts),
    onPrReview: (pr, remote) => openPrReview(pr, remote),
    onMergeReady: mergeReadyPrs,
    onPrSetup: () => setupPrs(),
    onSendBack: sendBackRow,
    onMarkReady: (pr, remote) => toggleDraft({ ...pr, remote: prRemote(pr, remote) }),
    onApproveAll: approveStack,
    onMakeStack: (n) => makeChainStack(n),
    chains: (remote, base) => api.app('pr-chains', remote, base),
    onGitTooOld: updateGit,
    gitWhy,
    onMergePlan: (o) => openMergePlan({ ...o, call: (...a) => api.app(...a), onSendBack: sendBackPr, onUndo: undo, onDone: async () => { await fetchAll(); lanesPage?.reload(); } }),
    onBranches: (tab) => showBranches(tab),
    onReview: (lane, base) => openReview(lane, base),
    onMerge: mergeLane,
    onAction: laneAction,
    canSwitch: canSwitchFrom,
    switchTo: switchTarget,
    progress: (lane) => reviewProgress(readTicks(localStorage, storeKey(state.repo.root, laneKey(lane))), lane.head),
    onCleanup: (lane) => startCleanup(lane),
    place: lanesPlace,
    pane: (row, ctx) => reviewPane({ row, ctx, root: state.repo.root, git, store: localStorage, call: (...a) => api.app(...a), run: paneAction, onBack: () => lanesPage?.el.focus({ preventScroll: true }), commitSide }),
    onPaneAction: paneAction,
    paneWidth: () => loadPref('reviewPane', {}).width || null,
    setPaneWidth: (width) => savePref('reviewPane', { width }),
    // Moving to another row is a step for ⌘[ / ⌘] once the pane shows it.
    onSettle: (from) => { if (lanesOpen() && !navigating && !navDepth && nav.record({ ...place(), lanes: from, key: placeKey(from) }, placeKey())) renderTopbar(); },
  }));
  setLanesPlace(null);
  return lanesPage;
}

// Catch up (catchup-view.js): what landed on the base since your checkpoint, read in its own
// reader (AK-372). Git alone until Reload.
function openCatchup() {
  setCatchupPage(catchupView({
    repo: state.repo.root,
    paneHandle: (box) => paneHandle('catchup', box),
    git,
    load: (opts) => api.app('catchup', opts),
    mark: (to) => api.app('catchup-mark', to),
    prsOn: () => Boolean(state.prs?.active),
    markAgents: () => state.show.agentLanes !== false,
    refs: () => state.refs,
    counts: () => reviewCounts({ repo: state.repo.root, load: (opts) => api.app('lanes-list', opts), prsOn: () => Boolean(state.prs?.active) }),
    onReview: () => setView('lanes'),
    onCount: setCatchupCount,
  }));
  return catchupPage;
}
// The sidebar badge on Catch up: what landed since the checkpoint (git alone); none once caught up.
function setCatchupCount(n) { if (n === catchupCount) return; assignCatchupCount(n); renderNavCounts(); }
function countCatchup() {
  (countRun ?? setCountRun(coalesce(async () => {
    if (!state.repo) return;
    const r = await api.app('catchup', { since: 'checkpoint' }).catch(() => null);
    setCatchupCount(r ? landedEntries(r.commits, r.merged).length : 0); // the page's count (catchup-view.js)
  })));
  return countRun();
}
// Branches (branches-view.js, AK-396): every local branch and worktree behind tabs, with the
// branch preview beside the list. Local data; pull requests from Review's last load.
let branchesTab = null; // the tab the next Branches page opens on (null: the last one)
function openBranches() {
  setBranchesPage(branchesView({
    repo: state.repo.root,
    git,
    load: (opts) => api.app('lanes-list', opts),
    forecast: () => api.app('lanes-forecast'),
    prs: () => (state.prs?.active ? cachedPrs(state.repo.root) : []),
    markAgents: () => state.show.agentLanes !== false,
    onOpen: openLane,
    onReview: (lane, base) => openReview(lane, base),
    onMerge: mergeLane,
    onAction: laneAction,
    canSwitch: canSwitchFrom,
    gitWhy,
    switchTo: switchTarget,
    onNewWorktree: () => addWorktree(),
    onCount: setFinishedCount,
    paneWidth: () => loadPref('reviewPane', {}).width || null,
    setPaneWidth: (width) => savePref('reviewPane', { width }),
    tab: branchesTab,
    only: cleanupOnly,
    cleanup: {
      run: (items, label) => git('cleanupLanes', items, { __label: label }),
      stoppedOps: (items) => Promise.all(items.map((i) => (i.worktree ? git('worktreeOpInfo', i.worktree).then((x) => (x ? { op: x.op, conflicts: x.conflicts || 0 } : null), () => null) : null))),
      runRemote: (names) => git('deleteRemoteBranches', names),
      days: cleanupPrefs().days,
      onDays: (days) => savePref('cleanup', { ...cleanupPrefs(), days }),
      onProgress: (fn) => api.on('cleanup:progress', fn),
      onDone: refreshAll,
      onUndo: undo,
    },
  }));
  branchesTab = null;
  cleanupOnly = null;
  return branchesPage;
}
// Branches on a tab (⌘K, the keys that used to open Everything else in Review).
function showBranches(tab = null) {
  if (!state.repo) return;
  if (state.view === 'branches' && branchesPage && !state.review && !state.quick && !state.split && !state.fileHistory) return tab && branchesPage.setTab(tab);
  branchesTab = tab;
  setView('branches');
}
// The sidebar badge on Branches: finished branches waiting for Clean up, quiet (not the accent).
function setFinishedCount(n) { if (n === finishedCount) return; assignFinishedCount(n); renderNavCounts(); }
function countFinished() {
  (finishedRun ?? setFinishedRun(coalesce(async () => {
    if (!state.repo) return;
    const r = await api.app('lanes-list', { prs: false }).catch(() => null);
    if (!r?.lanes) return;
    setFinishedCount(r.lanes.filter(isFinished).length);
  })));
  countReview();
  return finishedRun();
}
// The sidebar badge on Review: what the page calls "needs you" (reviewCounts), never the raw branch count.
function setReviewCount(n) { if (n === reviewCount) return; assignReviewCount(n); renderNavCounts(); }
function countReview() {
  (reviewRun ?? setReviewRun(coalesce(async () => {
    if (!state.repo) return;
    const root = state.repo.root;
    const c = await reviewCounts({ repo: root, load: (opts) => api.app('lanes-list', opts), prsOn: () => Boolean(state.prs?.active) }).catch(() => null);
    if (c && state.repo?.root === root) setReviewCount(c.needs);
  })));
  return reviewRun();
}

// Clean up (cleanup-view.js) is the Finished tab of Branches (AK-396): finished branches and
// worktrees, removed in bulk as one undo step. With a lane, just that one is ticked.
function startCleanup(...args) { return go(() => startCleanupNow(...args)); }
let cleanupOnly = null; // a lane's Clean up: the laneKey to tick, alone
function startCleanupNow(lane = null) {
  if (!state.repo) return;
  const key = lane?.name ? laneKey(lane) : null;
  if (state.view === 'branches' && branchesPage && !state.review && !state.quick && !state.split && !state.fileHistory) return branchesPage.cleanup(lane?.name ? lane : null);
  cleanupOnly = key;
  branchesTab = 'finished';
  setView('branches');
}
const cleanupPrefs = () => ({ days: STALE_DAYS, ...loadPref('cleanup', {}) });
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
// Review a pull request from the Inbox (pr-review.js): its head is fetched into FETCH_HEAD and
// diffed locally, with the PR's actions on the page. Esc goes back to the Inbox row.
function openPrReview(...args) { return go(() => openPrReviewNow(...args)); }
async function openPrReviewNow(pr, given = null) {
  if (!state.repo || !pr) return;
  const remote = prRemote(pr, given);
  if (!state.prs?.active) return setupPrs();
  const t = toast(`Fetching #${pr.number}…`, { kind: 'busy', timeout: 0 });
  const res = await loadPrReview(pr, remote, (...a) => api.app(...a));
  t.close();
  if (res.error) return prError(`Couldn’t fetch #${pr.number}`, res.error);
  if (state.view === 'lanes' && lanesPage && lanesOpen()) { setLanesPlace(lanesPage.location()); }
  state.quick = null;
  state.split = null;
  state.fileHistory = null;
  state.review = res.review;
  renderTopbar();
  renderView();
}
function pickPrReview() {
  if (!state.prs?.active) return setupPrs();
  const prs = state.prs.data?.prs || [];
  if (!prs.length) return toast('No open pull requests', { detail: `Refresh pull requests (${keyText('repo.prRefresh')}) to load them.` });
  palette(() => prs.map((p) => ({ group: 'Open pull requests', label: `#${p.number} ${p.title}`, icon: 'diff', detail: p.branch, keywords: `${p.author} ${p.branch} ${p.base}`, run: () => openPrReview(p) })), { placeholder: 'Review pull request…' });
}
// The review page's PR buttons and keys. Merged or closed: back to where the review came from.
function prDeskAction(id) {
  const pr = state.review?.pr;
  if (!pr) return;
  const leave = () => { if (leavesPage(id) && state.review?.pr?.number === pr.number) closeReview(); };
  if (id === 'approve') return approvePr(pr);
  if (id === 'changes') return requestChangesPr(pr);
  if (id === 'merge') return mergePr(pr, leave);
  if (id === 'close') return closePr(pr, leave);
  if (id === 'checkout') return checkoutPr(pr, { worktree: true });
  if (id === 'draft') return toggleDraft(pr);
}
// Menu, ⌘K and shortcut Merge/Close: on the PR review page they act on its PR and leave the page
// after, like its own buttons (AK-269).
const mergePrCmd = () => (state.review?.pr ? prDeskAction('merge') : mergePr());
const closePrCmd = () => (state.review?.pr ? prDeskAction('close') : closePr());
// Review's split-view pane actions (review-pane.js, pr-review.js PANE_ACTIONS) on a row. Merge,
// approve and close happen on GitHub (their dialogs say so); then the row re-stages and the
// selection moves to the next row that needs you. Merge on a local branch is merge and tidy.
function paneAction(id, row, ctx) {
  const { lane } = row;
  // The Inbox row's PR doesn't carry its remote; the page's context does.
  const pr = row.pr && { ...row.pr, remote: prRemote(row.pr, ctx?.remote) };
  const done = () => lanesPage?.afterAction(row.key, id);
  const local = lane?.branch && !lane.isBase ? (pr && !lane.pr ? { ...lane, pr } : lane) : null;
  if (id === 'merge') return local ? mergeLane(local, ctx.base, done) : pr ? mergePr(pr, done) : toast(`Nothing to merge on ${row.title}`);
  if (id === 'approve' && pr) return approvePr(pr, done, ctx?.viewer);
  if (id === 'close' && pr) return closePr(pr, done);
  if (id === 'draft' && pr) return toggleDraft(pr, ctx?.viewer, (draft) => lanesPage?.afterAction(row.key, draft ? 'draft' : 'ready'));
  if (id === 'checkout') return lane ? openLane(lane) : pr ? checkoutPr(pr, { worktree: true }) : null;
  if (id === 'github' && pr) return openPrOnGitHub(pr);
  if (id === 'checks' && pr?.url) return api.app('external', `${pr.url}/checks`);
  if (id === 'rebase' && local && ctx.base) return rebaseLane(local, ctx.base);
  if (id === 'updateBranch' && pr) return updatePrBranch(pr, done);
  if (id === 'sendBack') return sendBackRow(row, ctx);
  const why = id !== 'rebase' ? 'No pull request' : !local ? (lane?.isBase ? 'Base branch' : 'Not checked out here') : 'No base branch';
  toast(`That doesn’t apply to ${row.title}`, { detail: why });
}

// Send back (send-back-view.js): the sheet for a stuck row. sendBackPr(number) opens it for that
// PR from anywhere (Merge plan links to it), going to Review first.
function sendBackRow(row, ctx) {
  return openSendBack({ row, base: ctx?.base || null, prsOn: Boolean(state.prs?.active), remote: prRemote(row.pr, ctx?.remote), call: (...a) => api.app(...a), git });
}
// Make chain a GitHub stack (⌘K, AK-556): the open PR chains on the inbox's bases; one that can be
// linked opens the dialog (a pick list when there are several), else a toast says why not. With
// `number`, only the chain that PR is in (the selected stack, AK-609).
async function makeChainStack(number = null) {
  const prs = lanesPage?.inboxPrs() || [];
  const remote = lanesPage?.inboxRemote();
  const branches = new Set(prs.map((p) => p.branch));
  const bases = [...new Set(prs.filter((p) => p.base && !branches.has(p.base)).map((p) => p.base))];
  if (!remote || !bases.length) return toast('No chain of pull requests here');
  const found = [];
  let extension = false;
  for (const base of bases) {
    const res = await api.app('pr-chains', remote, base).catch((e) => ({ error: { message: e.message } }));
    if (res?.error) return toast('Couldn’t look for chains', { detail: res.error.message });
    extension ||= res.ok.extension;
    for (const c of res.ok.chains) if (!c.native && (number == null || c.prs.includes(number))) found.push({ ...c, base });
  }
  const linkable = found.filter((c) => c.linkable);
  if (!linkable.length) return toast(found.length ? 'Can’t make it a GitHub stack' : 'No chain of pull requests to link', { detail: found[0]?.why || undefined });
  const by = new Map(prs.map((p) => [p.number, { title: p.title, branch: p.branch }]));
  const go = (c) => openStackLink({ chain: c, prs: by, base: c.base, remote, extension, call: (...a) => api.app(...a), onLinked: () => lanesPage?.reload() });
  if (linkable.length === 1) return go(linkable[0]);
  palette(() => linkable.map((c) => ({ group: 'Chains', label: `#${c.prs[0]} → #${c.prs[c.prs.length - 1]}`, detail: `${c.prs.length} pull requests onto ${c.base}`, icon: 'merge', run: () => go(c) })), { placeholder: 'Make which chain a GitHub stack…' });
}

// Approve all on someone else's stack (AK-611): one dialog listing the parts, an optional comment,
// then each part is approved in turn; a failure stops there and says which.
async function approveStack(prs, remote, onDone) {
  const v = await dialog({
    title: `Approve ${prs.length} pull requests?`,
    description: REMOTE_NOTE,
    content: [h('ul.dialog-list', null, ...prs.map((p) => h('li', null, h('b', null, `#${p.number}`), ` ${p.title}`)))],
    submit: `Approve ${prs.length}`,
    fields: [{ name: 'body', label: 'Comment (optional)', multiline: true, rows: 3 }],
  });
  if (!v) return;
  let done = 0;
  for (const pr of prs) {
    const res = await prCall('pr-approve', pr, { body: v.body }, `Approving #${pr.number}…`);
    if (res.error) { prError(`Couldn’t approve #${pr.number}${done ? ` (approved ${done})` : ''}`, OWN_PR.test(res.error.message) ? { message: 'Your own pull request' } : res.error); break; }
    done++;
  }
  if (done === prs.length) toast(`Approved ${done} pull requests`, { kind: 'success' });
  if (done) { onDone?.(); refreshPrs(); }
}

function sendBackPr(number) {
  if (!state.repo) return;
  if (state.view !== 'lanes' || !lanesOpen()) setView('lanes');
  return lanesPage?.sendBack(number);
}

// Merge and tidy (lanes overview, branch review, ⌘K): land a lane on its base as one squashed
// commit, then remove its worktree and delete its branch, as one undo step. A lane with an open
// PR (pull requests on) can be merged on GitHub instead (`gh pr merge --squash`, not undoable);
// the local tidy after it is. Deleting the remote branch is opt-in and never undoable.
// `handed`: another window handed this over (the base is checked out here); the window showing the
// lane's worktree, if any, is closed when it's tidied.
async function mergeLane(lane, base = null, onDone = null, { handed = false } = {}) {
  if (!state.repo || !lane) return;
  if (!lane.branch) return toast(`${lane.name} is not on a branch`, { detail: 'Merge and tidy works on branches.' });
  let plan;
  try { plan = await git('mergeLanePlan', lane.branch, ...(base ? [base] : [])); } catch (e) { return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: e.message }); }
  // Its worktree has an operation stopped in it: abort that as part of the tidy (one undo step).
  const abort = Boolean(plan.blockerOp && plan.worktree);
  if (abort) {
    const info = await git('worktreeOpInfo', plan.worktree.path).catch(() => null);
    const go = await resolveSheet({ title: `Merge and tidy ${lane.name}`, reason: info ? opSentence(info) : `“${plan.worktree.name}” has a ${plan.blockerOp} in progress.`, actions: [{ id: 'abort', label: abortAnd(plan.blockerOp, 'merge') }] });
    if (!go) return;
    try { plan = await git('mergeLanePlan', lane.branch, base, { abort: true }); } catch (e) { return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: e.message }); }
  }
  if (plan.blocker) return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: plan.blocker });
  const ab = abort ? [{ abort: true }] : [];
  const away = plan.worktree && state.worktrees.find((w) => w.path === plan.worktree.path);
  // Open in another window: that window is closed as part of the tidy, stated in the merge dialog.
  let draft = false;
  try { draft = Boolean(away?.elsewhere && localStorage.getItem('draft:' + away.path)?.trim()); } catch { /* ignore */ }
  const closing = away?.elsewhere ? `Closes the window showing ${away.name} first.${draft ? ' Its commit message in progress is lost.' : ''}` : null;
  const close = away?.elsewhere ? [{ close: true }] : [];
  const lopt = ab.length || close.length ? [{ ...ab[0], ...close[0] }] : [];
  const pr = state.prs?.active && lane.pr && prRemote(lane.pr) ? lane.pr : null;
  const n = plan.commits.length;
  // An open PR GitHub would refuse (a draft, conflicts): fix that first, from every entry point.
  if (pr) {
    const info = await prCall('pr-merge-info', pr, undefined, `Checking #${pr.number}…`);
    if (info.ok?.gate.hard && !(await fixMergeGate(pr, info.ok))) return;
  }
  const block = !pr && n ? mergeHereBlock(plan, state.gitInfo?.version) : null;
  // Too old a git: offer another one first, then carry on from here.
  if (block?.kind === 'git-version') return updateGit('mergeHere', () => mergeLane(lane, base, onDone, { handed }));
  // The base is checked out in another worktree: that worktree's window opens and merges there.
  if (plan.mergeBlocker && !pr && n && plan.baseWorktree && !handed) {
    try { await api.app('handoff', { kind: 'mergeLane', dir: plan.baseWorktree.path, branch: lane.branch, base: plan.base }); } catch (e) { return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: e.message }); }
    return toast(`Continue in ${plan.baseWorktree.name}`);
  }
  if (block) return toast(`Can’t merge ${lane.name}`, { kind: 'error', detail: block.detail });
  // Checked out here: switch away first (stashing if asked), then merge and tidy, as one undo step;
  // or merge and keep it. In the main worktree: merge and keep it (nothing to tidy).
  // The switch and stash are facts in the merge dialog, not a sheet before it (AK-598); Keep
  // branch merges and stays.
  let move = null, dirty = 0;
  const to = plan.keep === 'current' && n ? switchTarget(lane.branch, plan.base) : null;
  if (to) {
    const { untracked } = loadPref('autostash', AUTOSTASH_DEFAULT);
    dirty = switchChanges();
    move = { to, stash: dirty ? { message: stashMessage(lane.branch, to), untracked } : undefined };
  }
  let kept = move ? null : plan.keep === 'current' ? `${lane.branch} stays checked out here` : plan.keep === 'main' ? `${lane.branch} stays checked out in the main worktree` : null;
  if (kept && !n) {
    if (plan.keep === 'current') return switchAndDelete({ short: lane.branch }, plan.base);
    return toast(`Nothing left to merge from ${lane.branch}`, { detail: `${kept}.` });
  }
  const keptToast = () => toast(`Merged ${lane.branch} into ${plan.base}`, { kind: 'success', detail: `${kept}.`, action: { label: 'Undo', run: undo } });
  const remote = lane.upstream && !lane.upstreamGone ? lane.upstream : null;
  const laneChecks = pr && lane.pr.checks === 'failure' ? prCheckLines(lane.pr) : null;
  const tidy = plan.worktree ? `remove the worktree ${plan.worktree.name} and delete ${lane.branch}` : `delete ${lane.branch}`;
  const here = kept ? `${n} commit${n > 1 ? 's' : ''} → one commit on ${plan.base}. ${kept}.`
    : n ? `${n} commit${n > 1 ? 's' : ''} → one commit on ${plan.base}, then ${tidy}.` : `Nothing left to merge into ${plan.base || 'the base'}: this will ${tidy}.`;
  const moving = move ? `Switches to ${move.to}${move.stash ? ` · stashes ${changesText(dirty)}` : ''}` : null;
  const v = await dialog({
    title: kept ? `Merge ${lane.name}?` : `Merge and tidy ${lane.name}?`,
    description: h('div.pr-merge', null,
      h('div', null, here),
      moving ? h('div', null, moving) : null,
      closing && !kept ? h('div', null, closing) : null,
      checkFailEl(laneChecks),
      plan.mergeBlocker && n ? h('div.pr-blocked', null, `Can’t merge here: ${plan.mergeBlocker}`) : null),
    submit: kept ? 'Merge' : 'Merge and tidy',
    alt: move ? 'Keep branch' : undefined,
    wide: n > 0,
    fields: [
      pr ? { name: 'via', type: 'select', label: 'Merge', value: 'github', options: [{ value: 'here', label: 'Here, as one commit' }, { value: 'github', label: `On GitHub (#${pr.number}, squash)` }], note: (via) => mergeViaNote(via, pr.number) } : null,
      n ? { name: 'message', label: 'Commit message (merging here)', multiline: true, rows: 6, value: plan.message } : null,
      remote && !kept ? { name: 'remote', type: 'checkbox', label: `Also delete ${remote || 'the branch'} on the remote (can’t be undone)`, value: false } : null,
    ].filter(Boolean),
  });
  if (!v) return;
  if (v.alt) { move = null; kept = `${lane.branch} stays checked out here`; v.remote = false; }
  const label = `Merge and tidy ${lane.branch}`;
  if (v.via === 'github') {
    let info = await prCall('pr-merge-info', pr, undefined, `Checking #${pr.number}…`);
    if (info.error) return prError(`Couldn’t check #${pr.number}`, info.error);
    if (info.ok.gate.hard) {
      const fixed = await fixMergeGate(pr, info.ok);
      if (!fixed) return;
      info = { ok: fixed };
    }
    const { gate } = info.ok;
    if (gate.soft.length) return toast(`Can’t merge #${pr.number}`, { kind: 'error', detail: `${gate.soft.join(' ')} Use Merge pull request… to merge anyway.` });
    // Checks that failed since the list was loaded get their own confirm: a confirm, never a block.
    if (needsCheckConfirm(Boolean(laneChecks), info.ok.failing)) {
      const ok = await dialog({ title: `Merge #${pr.number} with a failing check?`, description: h('div.pr-merge', null, checkFailEl(prCheckLines(pr, info.ok.failing, info.ok.checkCounts))), submit: 'Merge' });
      if (!ok) return;
    }
    // Squash merging off in the repo's settings: name what's on and offer it (AK-588).
    const off = methodFix(info.ok.methods, 'squash');
    const how = off ? await resolveSheet({ title: `Merge #${pr.number}`, reason: off.reason, actions: off.actions }) : { id: 'squash' };
    if (!how) return;
    const res = await prCall('pr-merge', pr, { method: how.id, deleteBranch: Boolean(v.remote), admin: false }, `Merging #${pr.number}…`);
    if (res.error) return prError(`Couldn’t merge #${pr.number}`, res.error);
    toast(`Merged #${pr.number} on GitHub`, { kind: 'success', detail: 'The merge on GitHub can’t be undone.' });
    onDone?.();
    await fetchAll();
    // Local commits GitHub never saw would go with the branch: keep it and say so.
    if (info.ok.headOid && plan.head && info.ok.headOid !== plan.head) return toast(`Kept ${lane.branch}`, { detail: `It has commits that aren’t in #${pr.number}. Push or move them, then delete the branch.` });
    if (move) return act(`Delete branch ${lane.branch}`, 'switchDelete', [move.to, ...(move.stash ? [move.stash] : [])], { success: `Switched to ${move.to} and deleted ${lane.branch}${move.stash ? '. Changes stashed.' : ''}`, actions: move.stash ? [showStashAction(move.stash.message)] : null });
    // Keep branch: it stays (AK-598).
    if (plan.keep === 'current' && !v.alt) return switchAndDelete({ short: lane.branch }, plan.base);
    if (kept) return;
    return act(`Tidy ${lane.branch}`, 'tidyLane', [lane.branch, ...lopt], { busy: 'Tidying up…', success: `Tidied ${lane.branch}` });
  }
  if (n && !String(v.message || '').trim()) return toast('The commit message is empty', { kind: 'error' });
  const ok = move
    ? await act(label, 'switchMerge', [move.to, lane.branch, plan.base, v.message, ...(move.stash ? [move.stash] : [])], { busy: 'Merging…', success: `Switched to ${move.to} and merged ${lane.branch} into ${plan.base}${move.stash ? '. Changes stashed.' : ''}`, actions: move.stash ? [showStashAction(move.stash.message)] : null })
    : n
    ? await act(kept ? `Merge ${lane.branch}` : label, 'mergeLane', [lane.branch, plan.base, v.message, ...lopt], { busy: 'Merging…', success: `Merged ${lane.branch} into ${plan.base}`, quiet: Boolean(kept), then: kept ? keptToast : null })
    : await act(`Tidy ${lane.branch}`, 'tidyLane', [lane.branch, ...lopt], { busy: 'Tidying up…', success: `Tidied ${lane.branch}` });
  if (ok && v.remote && remote) act(`Delete ${remote}`, 'deleteRemoteBranch', [remote], { busy: 'Deleting remote branch…', undoable: false });
  if (ok) onDone?.();
  if (ok && state.review && !kept) closeReview();
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
  if (!base) return toast('No base branch', { detail: 'Since couldn’t tell which branch this one is based on.' });
  const w = lane.worktree;
  if (w?.prunable) return toast(`${laneTitle(lane)}’s worktree folder is missing`, { kind: 'error', detail: 'Clean it up or prune it first.' });
  const label = `Rebase ${lane.branch} onto ${base}`;
  if (w && !w.current) {
    const wt = state.worktrees.find((x) => x.path === w.path);
    if (!wt) return;
    // Open in another window: that window rebases it (handoff, as Merge and tidy does).
    if (wt.elsewhere) {
      try { await api.app('handoff', { kind: 'rebaseLane', dir: wt.path, branch: lane.branch, base }); } catch (e) { return toast(`Can’t rebase ${lane.branch}`, { kind: 'error', detail: e.message }); }
      return toast(`Rebasing in ${wt.name}`);
    }
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
  if (!state.repo || !lane || !canRemove(lane, canSwitchFrom)) return;
  if (switchAway(lane)) return switchAndDelete({ short: lane.branch });
  const n = lane.changes || 0;
  const verb = n ? 'Discard' : 'Delete';
  const what = [lane.worktree && `its worktree ${tildify(lane.worktree.path)}`, lane.branch && `branch ${lane.branch}`].filter(Boolean).join(' and ');
  const lost = n ? ` with ${n} uncommitted file${n > 1 ? 's' : ''}` : '';
  const op = lane.worktree && await git('worktreeOpInfo', lane.worktree.path).catch(() => null);
  if (!(await confirm(`${verb} ${laneTitle(lane)}?`, `${op ? `${opSentence(op)} Aborting it can’t be undone. ` : ''}Removes ${what}${lost}. ${lane.worktree ? 'Ignored files in it, such as build output, are deleted for good; ' : ''}${MOD}Z brings everything else back. A remote branch is kept.`, { submit: op ? `Abort and ${verb.toLowerCase()}` : verb }))) return;
  act(`${verb} ${lane.branch || lane.name}`, 'cleanupLanes', [[{ ...cleanupItem(lane), ...(op ? { abort: true } : {}) }]], {
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
    { label: w.locked ? 'Unlock' : 'Lock…', icon: 'key', kbd: keymap.keys('worktrees.lock'), disabled: w.main, why: w.main ? 'Main worktree' : null, run: () => toggleLock(w) },
    w.missing
      ? { label: 'Prune Missing Worktrees', icon: 'trash', danger: true, run: pruneWorktrees }
      : { label: 'Remove Worktree…', icon: 'trash', kbd: keymap.keys('worktrees.remove'), danger: true, disabled: w.main, why: w.main ? 'Main worktree' : null, run: () => removeWorktree(w) },
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

// Remove a worktree (AK-581). Its changes are stashed and the window showing it is closed first:
// ⌘Z brings it all back. Asks first, on the menu item, only when that window holds work undo
// can't bring back. When this window shows it, the main worktree's window (or this one, switched
// there) removes it. `handed`: another window asked already and handed it over.
async function removeWorktree(w, opts) {
  // Any failure says so (AK-577): never a silent no-op.
  try { await removeWorktreeNow(w, opts); } catch (e) { toast(`Can’t remove “${w.name}”`, { kind: 'error', detail: e.message }); }
}
async function removeWorktreeNow(w, { handed = false } = {}) {
  const at = menuAnchor();
  if (w.locked && !w.main && !w.missing) {
    if (!(await askAt(at, `“${w.name}” is locked.`, 'Unlock and remove'))) return;
    if (!(await act(`Unlock ${w.name}`, 'unlockWorktree', [w.path], { undoable: false, quiet: true }))) return;
    return removeWorktreeNow({ ...w, locked: false }, { handed });
  }
  // Plan on a fresh read: the row can be older than the windows (one opened or closed since it was drawn).
  const list = await git('worktrees').catch(() => state.worktrees);
  w = list.find((x) => x.path === w.path) || w;
  const main = list.find((x) => x.main);
  const facts = w.missing || w.main || w.locked ? {} : await git('removalFacts', w.path).catch(() => ({}));
  let draft = false;
  try { draft = !!localStorage.getItem('draft:' + w.path)?.trim(); } catch { /* ignore */ }
  let plan = removalPlan(w, { main, facts, draft });
  if (plan.kind === 'prune') return pruneWorktrees();
  if (plan.kind === 'blocked') return toast(plan.why, { kind: 'error' });
  const asked = plan.kind === 'ask';
  if (asked) {
    if (!handed && !(await askAt(at, plan.why, plan.then.close || plan.then.kind === 'handoff' ? 'Close and remove' : 'Remove'))) return;
    plan = plan.then;
  }
  if (plan.kind === 'handoff') {
    try { await api.app('handoff', { kind: 'removeWorktree', dir: plan.dir, path: w.path }); } catch (e) { toast(`Can’t remove “${w.name}”`, { kind: 'error', detail: e.message }); }
    return;
  }
  if (plan.kind === 'switch') {
    await switchWorktree(main);
    if (state.repo?.root !== main.path) return toast(`Can’t remove “${w.name}”`, { kind: 'error', detail: `${main.name} didn’t open in this window.` });
    plan = plan.then;
  }
  const stash = plan.stash ? `Since: ${w.name} before removing it` : null;
  act(`Remove worktree ${w.name}`, 'removeWorktree', [w.path, { close: plan.close, stash: plan.stash, abort: plan.abort }], {
    busy: 'Removing worktree…',
    success: `Removed ${w.name}`,
    detail: plan.close ? 'Closed its window first.' : undefined,
    actions: stash ? [showStashAction(stash)] : null,
  });
}

// A question about the menu item just chosen, on the same spot: `ok` or Cancel. Dismissing it is Cancel.
function askAt(at, why, ok) {
  return new Promise((resolve) => {
    const a = at || { x: innerWidth / 3, y: innerHeight / 3 };
    let answered = false;
    const pick = (v) => () => { answered = true; resolve(v); };
    contextMenu(a.x, a.y, [{ section: why }, { label: ok, icon: 'trash', danger: true, run: pick(true) }, { label: 'Cancel', icon: 'x', run: pick(false) }], { focus: 1 });
    const menu = document.querySelector('.menu');
    new MutationObserver((_, obs) => { if (!menu.isConnected) { obs.disconnect(); setTimeout(() => { if (!answered) resolve(false); }); } }).observe(document.body, { childList: true });
  });
}

// A step another window handed to this one (main process app:handoff, AK-581).
async function takeHandoff() {
  const h = await api.app('take-handoff').catch(() => null);
  if (!h || !state.repo) return;
  await refreshHistory();
  if (h.kind === 'removeWorktree') {
    const w = state.worktrees.find((x) => x.path === h.path);
    return w ? removeWorktree(w, { handed: true }) : toast('That worktree is already gone');
  }
  if (h.kind === 'mergeLane') return mergeLane({ name: h.branch, branch: h.branch }, h.base, null, { handed: true });
  if (h.kind === 'rebaseLane') {
    if (state.head.branch !== h.branch) return toast(`${h.branch} is no longer checked out here`);
    return act(`Rebase ${h.branch} onto ${h.base}`, 'rebaseOnto', [h.base], { busy: 'Rebasing…' });
  }
}

async function toggleLock(w) {
  if (w.main) return toast('The main worktree can’t be locked');
  if (w.locked) return act(`Unlock ${w.name}`, 'unlockWorktree', [w.path], { undoable: false });
  const v = await dialog({ title: `Lock worktree “${w.name}”?`, description: 'A locked worktree can’t be removed or pruned, by Since or by git, until it is unlocked.', submit: 'Lock', fields: [{ name: 'reason', label: 'Reason (optional)', placeholder: 'On an external drive' }] });
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

// The header branch pill and ⌘⇧B: local branches first (current on top), then
// remote branches that have no local branch yet, which check out as tracking branches.
function branchSwitcher() {
  if (!state.repo || !state.head.oid) return;
  const locals = state.refs.filter((r) => r.kind === 'branch').sort((a, b) => (a.short === state.head.branch ? -1 : b.short === state.head.branch ? 1 : a.short.localeCompare(b.short)));
  const tracked = new Set(locals.map((r) => r.upstream).filter(Boolean));
  const names = new Set(locals.map((r) => r.short));
  const remotes = state.refs.filter((r) => r.kind === 'remote' && !r.short.endsWith('/HEAD') && !tracked.has(r.short) && !names.has(r.short.slice(r.short.indexOf('/') + 1)));
  palette(() => [
    ...locals.map((r) => {
      const cur = r.short === state.head.branch, wt = worktreeOf(r.short);
      return { group: 'Branches', label: r.short, icon: 'branch', detail: cur ? 'current' : wt ? `in worktree ${wt.name}` : r.upstream || '', keywords: r.upstream || '', run: () => cur ? null : checkout(r.short) };
    }),
    ...remotes.map((r) => ({ group: 'Remote branches', label: r.short, icon: 'cloud', detail: 'check out as local branch', run: () => act(`Checkout ${r.short}`, 'checkoutTracking', [r.short]) })),
    { group: 'Branches', label: 'New branch…', icon: 'plus', kbd: keymap.keys('global.branch'), run: () => createBranch(state.head.oid) },
  ], { placeholder: 'Switch to branch…' });
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
async function updateSubmodules(list) {
  if (!state.repo) return;
  let todo = (list || state.submodules).filter((m) => ['outdated', 'uninitialized'].includes(m.state));
  if (!state.submodules.length) return toast('This repository has no submodules');
  // Out of date but with local changes: stash them in the submodule and update it too.
  const dirty = (list || state.submodules).filter((m) => m.state === 'modified' && m.head !== m.recorded);
  let stash = false;
  if (dirty.length) {
    const v = await resolveSheet({
      title: todo.length + dirty.length === 1 ? `Update submodule ${dirty[0].path}` : 'Update submodules',
      reason: `${dirty.map((m) => m.path).join(', ')} ${dirty.length > 1 ? 'have' : 'has'} local changes.`,
      actions: [{ id: 'stash', label: 'Stash in submodule and continue' }, todo.length ? { id: 'skip', label: `Update the other ${todo.length}` } : null],
    });
    if (!v) return;
    stash = v.id === 'stash';
    if (stash) todo = [...todo, ...dirty];
  }
  if (!todo.length) return toast(list ? 'Already up to date' : 'All submodules are up to date', { detail: state.submodules.some((m) => m.state === 'modified') ? 'Submodules with local changes are left alone.' : null });
  const label = todo.length === 1 ? `Update submodule ${todo[0].path}` : `Update ${todo.length} submodules`;
  return act(label, 'updateSubmodules', [todo.map((m) => m.path), ...(stash ? [{ stash: true }] : [])], { busy: 'Updating submodules…' });
}

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { countFinished, countCatchup, REF_LISTS, refListKey, switchWorktree, worktreeMenu, branchSwitcher, worktreeSwitcher, closeReview, mergeLane, prDeskAction, worktreesView, refListView, openLanes, openCatchup, openBranches, addWorktree, countReview, setCatchupCount, mergePrCmd, closePrCmd, rebaseLane, openSubmodule, updateSubmodules, takeHandoff });
Object.defineProperties(up, {
  refListShown: { get: () => refListShown, set: (value) => { refListShown = value; }, enumerable: true },
});

export { pickPrReview, prDeskAction, mergePrCmd, closePrCmd, openReview, branchSwitcher, addWorktree, worktreeSwitcher, pruneWorktrees, removeWorktree, switchWorktree, openWorktreeWindow, toggleLock, updateSubmodules, openSubmodule, mergeLane, rebaseLane, laneAction, deleteLane, startCleanup, makeChainStack, paneAction, openLane, showBranches, takeHandoff };
