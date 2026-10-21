import { h, icon, kbd, timeAgo, ago, fullDate, contextMenu, toast, tipFor } from './ui.js';
import { ACTIONS, sortLanes, laneKey, aheadBehind, keepPrs, takePrs, sendBackWaits, loadGuard, withTimeout, sharedLoad, conflictsByLane, withConflicts, conflictText, laneTitle, canRemove, removeWhy, actionWhy, checkoutHereMode, checkoutChoices, removeLabel } from './lanes.js';
import { STAGES, TABS, reviewRows, primaryAction, STEPS, rowBadges, rowSignals, rowChips, rowAuthors, authorsOf, filterRows, applyAction, rowPrNumber, nextSelection, stuckReason, mergeBlock, baseConflict, conflictNote, overlapNote, needsYou, stackNote, stackRail, stackTitle, stackStatus, stackApproval, partWhy, stackFit, checksBlock } from './review-rows.js';
import * as keymap from './keymap.js';
import { GIT_NEEDS } from './git-version.js';
import { updateBranchBlock } from './pr-review.js';
import { draftSwitch } from './prs.js';
import { navPos, authorsStack } from './reader.js';
import { factsFor, peekFacts, peekEvidence } from './evidence-store.js';


// Review, the home view: one row per piece of work (per pull request while PRs are on), one list at
// a time behind tabs (AK-361, review-rows.js TABS; 1–5). The head (title, counts, Reload and the tabs
// with Plan merge ▸) spans the view above the list and the pane (AK-373). Tabs: Needs you (Stuck · N,
// each row says why, review-rows.js stuckReason, then Ready to merge · N), Stuck, Ready, In progress
// and All open. A group shows only when it has rows; on Needs you a short list ends in one calm line
// that says what's left (AK-396). Review is about pull requests only: every branch and worktree, and
// Clean up, live in Branches (branches-view.js); S, A and C open it on Active, Agent-made and Would conflict.
// Rows carry no buttons (AK-379); the line under the title starts with who made it
// (AK-390): a small initials avatar and name, "+" the agent when the lane looks agent-made, or the bot alone.
// Keyboard-first (AK-381): ↑/↓ and ←/→ move, ⌘K "Next step" runs the row's primary step (the pane's status strip
// shows it as its last button), ↵ (or R) moves focus into the pane, the reader shared with Catch up
// (reader.js: there ↑/↓ scroll, ←/→ still step the list, Esc comes back), M merges, D shows its details (branch, commits, worktree,
// uncommitted changes, Show in Map), E shows In progress, typing filters every row.
// Refreshes in place, keeping the selection. The conflict forecast runs after the list shows (git
// merge-tree, main process) and re-sorts the list when it lands. With pull requests off the rows
// come from local data alone, plus one line to turn them on: no `gh` calls.
// Pull requests load once when a repo opens (prefetchReview, AK-382), then only when you press Reload (⌘R, the header button, ⌘K)
// or right after your own approve, close or merge. Opening Review, repo changes and window focus read local data only: no network.
// The last PR load is kept in memory for the open repo (prCache), so coming back to Review shows it at once, with "Updated 4m ago" beside Reload.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
// Row-action keys → their action (lanes.js ACTIONS); review, merge and open have their own branches.
const LANE_KEYS = { 'lanes.rebase': 'rebase', 'lanes.checks': 'checks', 'lanes.delete': 'delete', 'lanes.cleanup': 'cleanup' };
// The split view's pane actions from the list (pr-review.js PANE_ACTIONS; M merges through lanes.merge).
const PANE_KEYS = { 'lanes.approve': 'approve', 'lanes.closePr': 'close', 'lanes.checkout': 'checkout', 'lanes.github': 'github' };
const TAB = new Map(TABS.map((t) => [t.id, t]));
const NONE = { stuck: 'Nothing is stuck.', ready: 'Nothing is ready to merge yet.', inProgress: 'Nothing is in progress.' };
const SHORT = 6; // a Needs you list this short ends in the calm line
// Live refreshes after commits are debounced; the watcher can fire several times per commit.
const DEBOUNCE = 400;
const PR_TIMEOUT = 30e3; // `gh` hung or offline: say so instead of loading forever
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The last pull request load, kept across visits to Review (this window, this session) so coming back
// costs no `gh` call: { repo, inbox, prs: the lanes that had a PR (for keepPrs), loadedAt (ms) }. Another repo, or pull requests turned off, drops it.
let prCache = null;
// The PR load in flight (`gh`), shared by Reload and the load when a repo opens: one per repo.
const prLoads = sharedLoad();
// The repo Review last opened or prefetched for: a load for another repo lands nowhere.
let openRepo = null;
const loadPrs = (repo, load) => prLoads.run(repo, () => withTimeout(load({ prs: true, inbox: true }), PR_TIMEOUT, 'GitHub didn’t answer in time.'));
// Review's last stuck and ready-to-merge counts, for Catch up's line to Review and the sidebar badge: { repo, stuck, ready, needs }.
let lastCounts = null;
// The last tab, kept across visits to Review (this window, this session).
let lastTab = 'needs';
const AGO_TICK = 30e3; // how often "Updated 4m ago" catches up
// After a PR load, when GitHub was still working out some PRs' merge state (unknown), Review asks
// again for those only: this long after the load, then this long after that answer (AK-625).
const RECHECK = [3e3, 12e3];
const unknownState = (pr) => pr.mergeState === 'unknown';

// load({ prs, inbox }) → app:lanes-list result; forecast() → app:lanes-forecast result; prsOn() and markAgents() read current settings;
// onOpen(lane) opens it in the graph, onReview(lane, base) opens its branch review, onMerge(lane, base) merges and tidies it and
// progress(lane) → its review progress (review.js) or null. actions(lane) → extra context-menu items.
// onAction(id, lane, base) runs the other row actions (rebase, delete, discard, checks; ACTIONS in lanes.js).
// onCleanup(lane?) opens Branches → Finished, with only that lane ticked when one is given; onBranches(tab) opens Branches
// on a tab (S, A, C). onCheckout(pr), onPrReview(pr, remote) and
// onMergeReady(prs, remote) act on pull requests; onPrSetup() turns pull requests on. `place` is a
// `location()` to return to (Back, ⌘[): its mode, row, filter, open stages and scroll, put back once the rows load.
// Split view: pane(row, ctx) builds the right-hand pane for the selected row (review-pane.js:
// { el, key, refresh, update, focus, destroy }), onPaneAction(id, row, ctx) runs its actions (PANE_ACTIONS) from the
// list's keys, paneWidth()/setPaneWidth(px) keep its width, and onSettle(from) records a move to another row once the
// pane shows it (`from` is the location before it), for Back and Forward. After an action app.js calls afterAction.
export function lanesView({ repo = null, git = null, pane = null, onPaneAction = null, paneWidth = () => null, setPaneWidth = () => {}, onSettle = () => {}, load, forecast = async () => null, prsOn, markAgents, onOpen, onCleanup, onReview = () => {}, onMerge = () => {}, onAction = () => {}, canSwitch = null, switchTo = null, progress = () => null, onCheckout = () => {}, onPrReview = () => {}, onMergeReady = () => {}, onPrSetup = () => {}, onSendBack = () => {}, onMarkReady = null, onApproveAll = null, onMakeStack = null, chains = null, onMergePlan = null, onGitTooOld = null, gitWhy = () => null, onBranches = () => {}, onCounts = () => {}, mergeStates = null, place = null }) {
  if (prCache && prCache.repo !== repo) prCache = null; // another repo: its PRs don't apply
  openRepo = repo;
  const seed = prsOn() && prCache ? prCache : null;
  let lanes = [];
  let seedLanes = seed?.prs || []; // the cached PRs, put on the first local lanes
  let inbox = seed?.inbox || null; // { prs, remote, me, requested } from the last PR load
  let inboxFailed = false;
  let loadedAt = seed?.loadedAt || null; // when the PRs last loaded (ms); null: not this session
  let reloading = false; // a PR load is running
  let staged = null; // the last reviewRows result
  let shown = [];
  let selKey = null;
  let conflicts = new Map(); // laneKey → forecast entries (conflictsByLane)
  let forecastOk = true; // false on git before 2.38: no forecast, no Plan merge
  let loaded = false;
  let pendingSendBack = null; // sendBack(number) before Review listed it: opens once a refresh does
  let pendingPr = null; // showPr(number) before Review listed it: selected once a refresh does
  let base = null;
  let timer = 0;
  const loads = loadGuard();
  let tab = TAB.has(place?.tab) ? place.tab : lastTab; // TABS id
  const details = new Set(); // rows with Details ▾ open
  let wanted = place?.key ?? null; // the row to select once it's loaded
  let wantedScroll = place?.scroll ?? null;

  const filter = h('input.lanes-filter', { type: 'search', placeholder: 'Filter, or #123 for a PR…', spellcheck: false, 'aria-label': 'Filter', value: place?.filter || '' });
  const count = h('span.muted.lanes-count');
  const list = h('div.lanes-list', { role: 'listbox', 'aria-label': 'Review' });
  const empty = h('div.empty');
  const title = h('h1', null, 'Review');
  const lede = h('p.muted');
  const tabBar = h('div.review-tabs', { role: 'tablist', 'aria-label': 'Review lists' });
  const reloadKeys = () => keymap.keys('lanes.reload');
  const updated = h('span.muted.review-updated', { 'aria-live': 'polite' });
  const reloadBtn = h('button.btn.ghost.small.review-reload', { onclick: () => reload(), 'data-tip': `${tipFor('Reload pull requests', 'lanes.reload')}\nAsk GitHub for the latest pull requests and review requests`, 'aria-label': 'Reload pull requests' });
  // The head spans the whole view, above the list and the pane (AK-373): the title, the counts,
  // Updated and Reload on one line, the description under it, then the tabs on one line
  // (they scroll sideways when the window is narrow) with Plan merge ▸ at the right.
  const head = h('div.review-top', null,
    h('div.page-head.review-head', null,
      h('div.review-head-row', null, title, count, h('span.spacer'), updated, reloadBtn),
      lede),
    tabBar);
  // The list column scrolls on its own; its filter row stays at the top of it.
  const left = h('div.page.flush.lanes', null,
    h('div.review-filter', null, h('div.lanes-bar', null, icon('search', 14), filter)),
    list,
    empty,
  );
  const paneHost = h('div.review-pane-host');
  const handle = h('div.review-split-handle', { role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  // The head is the grid's first row, across the window; the list and the pane share the row below.
  const el = h('div.review-split', { tabIndex: 0 }, head, left, handle, paneHost);
  let paneObj = null;
  let paneTimer = 0;
  let settled = null; // the row the pane last showed, for Back and Forward
  const paneConflicts = new Map(); // row key → files the pane found conflicting with the base (AK-305)
  let jumpTo = null; // the row whose "Conflicts in N files" was clicked before its pane opened
  let moved = false; // the selection changed by the user since the pane last showed
  let after = null; // { before, key }: an action ran on `key`; pick the next row on the next render
  const w = paneWidth();
  if (w) el.style.setProperty('--pane-w', `${w}px`);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const box = el.getBoundingClientRect();
    let px = null;
    const onMove = (m) => { px = Math.round(Math.max(360, Math.min(box.width - 320, box.right - m.clientX))); el.style.setProperty('--pane-w', `${px}px`); };
    const onUp = () => { handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); if (px) setPaneWidth(px); };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });

  function run(id, l) {
    if (id === 'review') onReview(l, base);
    else if (id === 'merge') onMerge(l, base);
    else if (id === 'open') onOpen(l);
    else if (id === 'cleanup') onCleanup(l);
    else onAction(id, l, base);
  }
  // A key for a row action: runs it when the selected row's lane allows it.
  function runKey(id, l) {
    if (!l) return;
    const no = actionWhy(id, l, { base, finished: Boolean(l.done), canSwitch });
    if (!no) run(id, l); else toast(`${ACTIONS[id].label} doesn’t apply to ${laneTitle(l)}`, { detail: no });
  }

  // Staged rows: the PR's actions, or the lane's when it has no PR.
  const requested = () => new Set(prsOn() ? inbox?.requested || [] : []);
  // A row as a lane for the lane actions: its PR joined on, or just the PR when it isn't checked out here.
  const asLane = (r) => (r.lane ? (r.pr && !r.lane.pr ? { ...r.lane, pr: r.pr } : r.lane) : { name: r.title, title: r.title, pr: r.pr });
  const paneCtx = (r) => ({
    base, remote: inbox?.remote || null, viewer: inbox?.viewer || null, requested: requested(), step: step(r), prsOn: prsOn(), agents: markAgents(),
    conflicts: r.stage === 'stuck' && Boolean(baseConflict(r, base)), onConflicts: (files) => noteConflicts(r.key, files),
    onFacts: () => refreshChips(r.key),
    onSelectPr: (n) => selectPr(n),
    // The stack path (AK-537): each PR's stage for its dot, and [ / ] along the stack.
    stageOf: (n) => staged?.all.find((y) => y.pr?.number === n)?.stage || null,
    onStack: (d) => stackStep(d),
    // ‹ N of M › and ←/→ in the reader: the current tab's list (AK-381).
    nav: { ...navPos(shown.map((x) => x.key), r.key), onStep: (d) => move(d) },
  });
  // The pane read which files conflict: the row's note counts them.
  function noteConflicts(key, files) {
    const paths = files.map((f) => f.path);
    if (paneConflicts.get(key)?.join('\0') === paths.join('\0')) return;
    paneConflicts.set(key, paths);
    render();
  }
  // "Conflicts in N files": select the row and jump its pane to the Conflicting group.
  function jumpToConflicts(r) {
    select(r.key);
    if (paneObj?.key === r.key) paneObj.showConflicts?.();
    else jumpTo = r.key;
  }
  const split = () => Boolean(pane);
  function act(id, r) {
    const { pr, lane } = r;
    // A PR with no lane here squash-merges on GitHub: M and Merge… wait until it's ready, like the button (AK-275).
    const why = id === 'merge' && pr && !(lane?.branch && !lane.isBase) ? mergeBlock(r, { base }) : null;
    if (why) return toast(why);
    if (id === 'draft') return pr && onPaneAction?.(id, r, paneCtx(r));
    if (split() && ['merge', 'approve', 'close', 'checkout', 'github'].includes(id) && onPaneAction) return onPaneAction(id, r, paneCtx(r));
    if (id === 'review' && split() && paneObj?.key === r.key) paneObj.focus();
    else if (id === 'review') { if (pr) onPrReview(pr, inbox?.remote); else if (lane) onReview(lane, base); }
    else if (id === 'merge') {
      if (lane?.branch && !lane.isBase) onMerge(asLane(r), base);
      else if (pr) onMergeReady([pr], inbox?.remote);
      else toast(`Nothing to merge on ${r.title}`);
    } else if (id === 'open') { if (lane) onOpen(lane); else if (pr) onPrReview(pr, inbox?.remote); }
    else if (id === 'checkout') { if (pr) onCheckout(pr, { worktree: true }); }
    else if (id === 'checkoutHere') {
      const mode = checkoutHereMode(r);
      if (mode === 'pr') onCheckout(pr, { worktree: false }); else if (mode) onOpen(lane);
    }
    else if (id === 'updateBranch') { const why = updateBranchBlock(r, paneCtx(r)); if (why) toast(why); else if (onPaneAction) onPaneAction(id, r, paneCtx(r)); }
    else if (id === 'sendBack') { if (r.stage === 'stuck') onSendBack(r, paneCtx(r)); else toast(`${r.title} isn’t stuck`); }
    else if (id === 'details') toggleDetails(r.key);
    else runKey(id, asLane(r));
  }
  const step = (r) => primaryAction(r, { base, requested: requested() });

  // A draft that's only held back by being a draft shows the outlined draft dot, not its checks' colour (AK-611).
  const drafty = (r) => Boolean(r.pr?.draft) && r.stage !== 'stuck';
  // A row (AK-379): status dot · the title, led by a muted #number (AK-516), over one quiet line (why it's stuck, in red; else
  // its tags, who and where) · age. No buttons: ⌘K "Next step" runs the primary step, the pane's status strip
  // has the rest, and the context menu has them all. Details (D) open under the title.
  function stagedRow(r, rail = { up: false, down: false }) {
    const active = r.key === selKey;
    const open = details.has(r.key);
    const at = r.pr?.updatedAt ? Date.parse(r.pr.updatedAt) : r.lane?.activity || 0;
    const overlap = overlapNote(r);
    const stack = stackNote(r);
    const stage = STAGES.find((x) => x.id === r.stage);
    const stuck = r.stage === 'stuck' && reason(r);
    const tags = rowBadges(r, { requested: requested() });
    // Who made it leads the line (AK-390): "(AK) AK + (CO) Claude Opus 5.5 · CI failing · ak/branch".
    const authors = rowAuthors(r, { agents: markAgents() });
    const sub = [r.branch, !r.pr && r.worktree ? r.lane?.worktree?.short || tildify(r.worktree.path) : null].filter(Boolean).join(' · ');
    // "Draft" leads the line (AK-611), as in the pane.
    const line = [...tags.filter((b) => b.kind === 'draft').map((b) => b.text), stack?.text, ...tags.filter((b) => !b.signal && !b.chip && b.kind !== 'draft').map((b) => b.text), sub, overlap?.text].filter(Boolean).join(' · ');
    // A stack's rows next to each other share a rail through their dots (AK-537).
    return h('div.list-row.lanes-row.review-row.staged' + (active ? '.active' : '') + (rail.up ? '.stack-up' : '') + (rail.down ? '.stack-down' : ''), {
      role: 'option', 'aria-selected': String(active), 'aria-expanded': String(open), 'data-key': r.key, 'data-stage': r.stage || undefined,
      title: [r.pr ? `#${r.pr.number} ${r.title}` : r.title, authors.length ? `By ${authors.map((a) => a.name).join(' and ')}` : null, stage?.label, stack?.title, ...tags.map((b) => b.title), overlap?.title, r.ahead ? `↑${r.ahead} against ${base || 'the base'}` : null].filter(Boolean).join('\n'),
      onclick: () => select(r.key),
      ondblclick: () => act('open', r),
      oncontextmenu: (e) => { e.preventDefault(); select(r.key); stagedMenu(e.clientX, e.clientY, r); },
    },
      h('span.review-dot' + (r.stage ? `.${r.stage}` : '') + (drafty(r) ? '.draft' : ''), { role: 'img', 'aria-label': drafty(r) ? `${stage?.label || 'Open'}, draft` : stage?.label || 'Open' }),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name', { title: r.title }, r.pr ? h('span.review-row-num', null, `#${r.pr.number}`) : h('span.review-row-num', null, icon(r.worktree ? 'worktree' : 'branch', 13)), r.title), chipsEl(r)),
        stuck ? reasonEl(r, authors) : subLine('div.list-sub.review-row-sub', null, r, authors, line ? h('span.review-row-text', null, line) : null),
        open ? detailsEl(r) : null),
      at ? h('span.review-row-age', { title: fullDate(at / 1000) }, timeAgo(at / 1000)) : h('span'),
    );
  }

  // Compact signals after the title (AK-520, review-rows.js rowChips): check result, review state, open
  // threads, media, then change facts, from what's already here: change facts (git only, read in the
  // background for the rows shown) and the evidence a PR's reader loaded. The title keeps at least
  // 8em; chips that don't fit fold into "+N", whose tooltip lists them (fitChips).
  const rowRev = (r) => (r.lane && !r.lane.isBase ? r.lane.branch || r.lane.head : r.lane ? null : r.pr?.head || null);
  function chipsEl(r) {
    const rev = rowRev(r);
    const facts = rev && base ? peekFacts(base, rev) : null;
    const chips = rowChips(r, { facts, evidence: prsOn() ? peekEvidence(inbox?.remote || null, r.pr) : null, requested: requested() });
    if (!chips.length) return null;
    return h('span.row-signals', null,
      ...chips.map((c) => h('span.sig' + (c.kind ? `.${c.kind}` : ''), { title: c.title, 'data-chip': c.id }, c.icon ? icon(c.icon, 11) : null, c.text)),
      h('span.sig.more', { hidden: true }));
  }
  function fitChips(rowEl) {
    const box = rowEl?.querySelector('.row-signals');
    if (!box) return;
    const chips = [...box.querySelectorAll('.sig:not(.more)')];
    const more = box.querySelector('.sig.more');
    for (const c of chips) c.hidden = false;
    more.hidden = true;
    if (box.scrollWidth <= box.clientWidth + 1) return;
    more.hidden = false;
    const hidden = [];
    for (let i = chips.length - 1; i >= 0 && box.scrollWidth > box.clientWidth + 1; i--) {
      chips[i].hidden = true;
      hidden.unshift(chips[i]);
      more.textContent = `+${hidden.length}`;
    }
    more.title = hidden.map((c) => c.title || c.textContent).join('\n');
  }
  let fitFrame = 0;
  const fitAll = () => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(() => { for (const row of list.querySelectorAll('.review-row')) fitChips(row); for (const head of list.querySelectorAll('.review-stack-head')) fitHead(head); }); };
  new ResizeObserver(fitAll).observe(list);
  function refreshChips(key) {
    const rowEl = [...list.querySelectorAll('.review-row')].find((x) => x.dataset.key === key);
    const r = staged?.all.find((x) => x.key === key);
    if (!rowEl || !r) return;
    const title = rowEl.querySelector('.list-title');
    title.querySelector('.row-signals')?.remove();
    const next = chipsEl(r);
    if (next) { title.append(next); fitChips(rowEl); }
  }
  // Change facts for the rows shown, one at a time in the background (git only, cached per pair).
  let factsQueue = [];
  let factsBusy = false;
  function queueFacts(rows) {
    factsQueue = rows.filter((r) => { const rev = rowRev(r); return rev && base && peekFacts(base, rev) === undefined; });
    pumpFacts();
  }
  async function pumpFacts() {
    if (factsBusy || !git) return;
    factsBusy = true;
    while (factsQueue.length && el.isConnected) {
      const r = factsQueue.shift();
      const rev = rowRev(r);
      if (!rev || peekFacts(base, rev) !== undefined) continue;
      const f = await factsFor(git, base, rev);
      if (f) refreshChips(r.key);
    }
    factsBusy = false;
  }

  // The line under the title (AK-400, AK-411): avatar group · a conflict marker · the text, "·"
  // between the parts there are (failing checks are a chip after the title now, AK-520). null when
  // there's nothing to show.
  function subLine(sel, props, r, authors, text, conflictShown = false) {
    const s = rowSignals(r, { conflictShown });
    const signals = s.conflict ? h('span.review-signals', null,
      s.conflict ? h('span.review-signal', { role: 'img', 'aria-label': s.conflict.title, title: s.conflict.title }, icon('warning', 12)) : null) : null;
    const parts = [authors.length ? authorsStack(authors, 14, '.review-row-authors') : null, signals, text].filter(Boolean);
    if (!parts.length) return null;
    return h(sel, props, parts.flatMap((p, i) => (i ? [h('span.review-row-sep', { 'aria-hidden': 'true' }, '·'), p] : [p])));
  }

  const reason = (r, max = 2) => stuckReason(r, { base, max });
  // Why it's stuck; a conflict with the base is its own note that jumps to the conflicting files
  // (and stands in for the ⚠ marker, so the conflict shows once).
  function reasonEl(r, authors = []) {
    const note = conflictNote(r, { base, files: paneConflicts.get(r.key) });
    const rest = stuckReason(r, { base, max: 2, noBase: Boolean(note), bareChecks: true });
    return subLine('div.review-reason', { title: reason(r, 20) }, r, authors,
      note || rest ? h('span.review-row-text', null,
        note ? h('button.review-reason-link', { title: 'Show the conflicting files', onclick: (e) => { e.stopPropagation(); jumpToConflicts(r); }, ondblclick: (e) => e.stopPropagation() }, note) : null,
        note && rest ? ' · ' : null, rest) : null, Boolean(note));
  }

  // Details ▾: the branch, its commits, worktree and uncommitted changes, and the way into the map.
  function detailsEl(r) {
    const l = r.lane;
    const line = (label, value, t) => h('div.review-detail', null, h('span.muted', null, label), h('span', { title: t || value }, value));
    const ab = l ? aheadBehind(l) : '';
    return h('div.review-details', { onclick: (e) => e.stopPropagation(), ondblclick: (e) => e.stopPropagation() },
      line('Branch', r.branch || (l?.detached ? 'Detached HEAD' : '—')),
      line('Commits', l ? (r.ahead != null ? `${plural(r.ahead, 'commit')} not on ${base || 'the base'}` : ab || '—') : 'Not on this Mac yet'),
      line('Worktree', r.worktree ? tildify(r.worktree.path) : l ? 'None (branch only)' : '—', r.worktree?.path),
      line('Uncommitted', r.worktree ? (r.worktree.changes ? plural(r.worktree.changes, 'changed file') : 'None') : '—'),
      ...(r.conflicts || []).map((c) => h('div.review-detail.warn', { title: c.files.join('\n') }, conflictText(c))),
      h('div.lanes-fix', null,
        l ? h('button.btn.subtle.lanes-fix-btn', { onclick: () => onOpen(l), title: `Show in Map (${keymap.keys('lanes.open').join(' or ')})` }, icon('map', 12), l.worktree && !l.worktree.current && !l.worktree.prunable ? 'Switch to worktree' : 'Show in Map')
          : r.pr ? h('button.btn.subtle.lanes-fix-btn', { 'aria-haspopup': 'menu', onclick: (e) => { const b = e.currentTarget.getBoundingClientRect(); contextMenu(b.left, b.bottom + 4, checkoutItems(r)); }, title: 'Check out here or in a new worktree' }, icon('checkout', 12), 'Check out', icon('chevronDown', 10)) : null,
        l && !l.isBase ? h('button.btn.subtle.lanes-fix-btn', { onclick: () => onReview(l, base), title: 'Review the branch’s changes' }, icon('check', 12), 'Review branch') : null));
  }

  function toggleDetails(key) {
    if (!key) return;
    if (details.has(key)) details.delete(key); else details.add(key);
    render();
  }

  // A pull request: switch this window to its branch, or give it its own worktree. One already open
  // in another worktree switches to it on Check Out, like ⇧W.
  const checkoutItems = (r) => checkoutChoices(r).map((c) => (c === 'here'
    ? { label: 'Check Out', icon: 'checkout', kbd: keymap.keys('lanes.checkoutHere'), run: () => act('checkoutHere', r) }
    : { label: 'Check Out in New Worktree…', icon: 'worktree', kbd: keymap.keys('lanes.checkout'), run: () => act('checkout', r) }));

  // Draft ↔ ready (AK-610): only the switch that applies, greyed with why.
  const draftItems = (r) => {
    const d = r.pr ? draftSwitch(r.pr, inbox?.viewer) : null;
    return d ? [{ label: d.menu, icon: d.icon, disabled: Boolean(d.why), why: d.why, run: () => act('draft', r) }] : [];
  };

  function stagedMenu(x, y, r) {
    const l = asLane(r);
    contextMenu(x, y, [
      ...(r.lane ? [{ label: r.lane.worktree && !r.lane.worktree.current && !r.lane.worktree.prunable ? 'Switch to Worktree' : 'Show in Map', icon: r.lane.worktree ? 'worktree' : 'map', kbd: keymap.keys('lanes.open'), run: () => onOpen(r.lane) }] : []),
      ...(r.pr ? [{ label: 'Review…', icon: 'diff', kbd: keymap.keys('lanes.review'), run: () => act('review', r) }] : [{ label: 'Review Branch', icon: 'check', kbd: keymap.keys('lanes.review'), run: () => act('review', r) }]),
      ...checkoutItems(r),
      { label: 'Merge…', icon: 'merge', kbd: keymap.keys('lanes.merge'), disabled: !r.pr && (!l.branch || l.isBase), why: r.pr ? null : actionWhy('merge', l) || gitWhy('mergeHere'), gated: !r.pr && !actionWhy('merge', l) && Boolean(gitWhy('mergeHere')), run: () => act('merge', r) },
      ...draftItems(r),
      ...(r.lane?.branch && !r.lane.isBase && base ? [{ label: 'Rebase onto Base', icon: 'rebase', kbd: keymap.keys('lanes.rebase'), run: () => act('rebase', r) }] : []),
      ...(r.pr?.url ? [{ label: 'Open Checks', icon: 'external', kbd: keymap.keys('lanes.checks'), run: () => act('checks', r) }] : []),
      ...(r.stage === 'stuck' ? [{ label: 'Send Back…', icon: 'copy', kbd: keymap.keys('lanes.sendBack'), run: () => act('sendBack', r) }] : []),
      { label: details.has(r.key) ? 'Hide Details' : 'Details', icon: 'lanes', kbd: keymap.keys('lanes.details'), run: () => toggleDetails(r.key) },
      ...(r.lane ? ['-', { label: removeLabel(r.lane, switchTo), icon: 'trash', kbd: keymap.keys('lanes.delete'), disabled: !canRemove(r.lane, canSwitch), why: removeWhy(r.lane, canSwitch), run: () => act('delete', r) }] : []),
    ]);
  }

  function render() {
    renderStaged();
    renderReload();
    syncPane();
  }

  // Reload and "Updated 4m ago" in the header; hidden while pull requests are off.
  function renderReload() {
    const on = prsOn();
    reloadBtn.hidden = !on;
    updated.hidden = !on;
    reloadBtn.disabled = reloading;
    reloadBtn.replaceChildren(icon('restore', 14), reloading ? 'Reloading…' : 'Reload');
    updated.textContent = reloading ? '' : loadedAt ? `Updated ${ago(loadedAt / 1000)}` : 'Not loaded yet';
    updated.title = loadedAt ? fullDate(loadedAt / 1000) : '';
  }

  // The pane follows the selection, a moment after it stops moving (a PR not here is fetched).
  function syncPane() {
    el.classList.toggle('split', split());
    const r = split() ? current() : null;
    if (!r) {
      clearTimeout(paneTimer); paneObj?.destroy(); paneObj = null;
      if (paneHost.contains(document.activeElement)) el.focus({ preventScroll: true });
      paneHost.replaceChildren('');
      return;
    }
    if (paneObj?.key === r.key) { paneObj.update(r, paneCtx(r)); return; }
    clearTimeout(paneTimer);
    paneTimer = setTimeout(showPane, paneObj ? 120 : 0);
  }
  function showPane() {
    const r = split() ? current() : null;
    if (!r || paneObj?.key === r.key || !el.isConnected) return;
    const had = paneHost.contains(document.activeElement);
    paneObj?.destroy();
    paneObj = pane(r, paneCtx(r));
    paneHost.replaceChildren(paneObj.el);
    if (jumpTo === r.key) paneObj.showConflicts?.();
    jumpTo = null;
    // Stepping from the reader (←/→) keeps you reading: focus goes into the new pane.
    if (had) paneObj.focus();
    if (moved && settled && settled !== r.key) onSettle({ ...location(), key: settled });
    moved = false;
    settled = r.key;
  }

  // After a pane action on row `key` (approve, merge, close…): re-stage it at once and move the
  // selection to the next row that needs you; the PR list reloads behind it.
  function afterAction(key, id) {
    const before = shown.map((r) => r.key);
    // Draft or ready (AK-610) re-stages a lane's row too, and keeps it selected.
    const flip = id === 'draft' || id === 'ready';
    const n = rowPrNumber(key) ?? (flip ? shown.find((r) => r.key === key)?.pr?.number ?? null : null);
    if (inbox && n != null) inbox = { ...inbox, ...applyAction(inbox, n, id) };
    if (!flip) after = { before, key };
    render();
    list.querySelector('.lanes-row.active')?.scrollIntoView({ block: 'nearest' });
    if (prsOn() && ['approve', 'close', 'merge', 'draft', 'ready'].includes(id)) fetchLanes({ prs: true }).catch(fail);
  }

  // Below a short Needs you list: one calm line that says what's left (AK-396), from the tab counts;
  // nothing when there's nothing more to say (AK-627).
  function calmLine() {
    const ready = staged.stages.ready.length;
    const going = staged.stages.inProgress.length;
    const some = staged.stages.stuck.length + ready > 0;
    const parts = [
      some && prsOn() && !ready ? 'Nothing is ready to merge yet.' : null,
      going ? `${plural(going, prsOn() ? 'PR is' : 'branch is', prsOn() ? 'PRs are' : 'branches are')} still in progress.` : null,
    ].filter(Boolean);
    if (some && !parts.length) return null;
    return h('div.review-calm', { role: 'note' }, some ? null : h('b', null, 'Nothing needs you right now.'), parts.join(' '));
  }

  // Rows in list order, a stack's head over its rows wherever two or more of them sit together. The
  // stack's rows share one rail colour, from its status (AK-611).
  function pushRows(out, rs) {
    let tone = null;
    rs.forEach((r, i) => {
      const rail = stackRail(rs, i);
      if (rail.down && !rail.up) {
        const mates = [];
        for (let j = i; j < rs.length && rs[j].stack?.root === r.stack.root; j++) mates.push(rs[j]);
        tone = stackStatus(mates, { base }).tone;
        out.push(stackHead(mates));
      }
      const el = stagedRow(r, rail);
      if ((rail.up || rail.down) && tone) el.dataset.rail = tone;
      if (!rail.down) tone = null;
      out.push(el);
    });
  }

  // GitHub's word on each stack (AK-611): native or a plain chain, and whether it can be linked.
  // One app:pr-chains per base after a load; root PR number → { native, linkable, why }.
  let chainInfo = new Map();
  let chainsFor = null;
  async function loadChains() {
    const prs = inbox?.prs || [];
    if (!chains || !inbox?.remote || chainsFor === prs) return;
    chainsFor = prs;
    const bases = new Set((staged?.all || []).filter((r) => r.stack).map((r) => r.stack.base));
    if (!bases.size) return;
    const next = new Map();
    for (const b of bases) {
      const res = await chains(inbox.remote, b).catch(() => null);
      for (const c of res?.ok?.chains || []) next.set(c.prs[0], c);
    }
    if (chainsFor !== prs) return;
    chainInfo = next;
    render();
  }

  // A stack's head (AK-609, AK-611): one quiet line over its rows, not a row of its own (it's never
  // selected): #4 → #6 · "3 PRs into main" · tag · segments · status · text buttons · ⋯. It sheds
  // as the list narrows (stackShed): container queries first, then fitHead.
  function stackHead(rows) {
    const { st, acts, link } = stackOffer(rows);
    const s = rows[0].stack;
    const c = chainInfo.get(s.root);
    const prs = rows.map((r) => r.pr);
    const name = stackTitle(prs);
    const range = `#${prs[0].number} → #${prs[prs.length - 1].number}`;
    const segs = h('span.review-stack-segs', { role: 'group', 'aria-label': 'Parts' }, ...rows.map((r) => h('button.review-stack-seg', {
      type: 'button', 'data-stage': r.stage || 'inProgress', 'data-draft': drafty(r) ? '' : undefined, 'data-soft-fail': softFail(r) ? '' : undefined,
      title: segTitle(r), 'aria-label': `#${r.pr.number}`, onclick: () => select(r.key),
    })));
    const tag = c ? (c.native ? 'GitHub stack' : 'Chain') : null;
    const more = h('button.review-stack-menu', { type: 'button', hidden: true, 'aria-haspopup': 'menu', 'aria-label': 'More stack actions', title: 'More stack actions', onclick: (e) => {
      const b = e.currentTarget.getBoundingClientRect();
      const all = e.currentTarget.closest('.review-stack-head').dataset.shed === 'tight';
      contextMenu(b.left, b.bottom + 4, [...acts.filter((x) => all || x.id !== 'merge').map((x) => ({ label: menuLabel(x), run: x.run, disabled: Boolean(x.why), why: x.why || undefined })),
        link ? { label: 'Make it a GitHub stack', disabled: true, why: c.why } : null], { focus: e.detail === 0 ? 0 : -1 });
    } }, icon('more', 14));
    return h('div.review-stack-head' + `.${st.stage}` + (st.tone ? `.${st.tone}` : ''), { role: 'presentation', 'data-stack': String(s.root), title: `${name === `Stack ${range}` ? '' : `${name}\n`}Stacked: ${[s.base || 'base', ...s.path.map((n) => `#${n}`)].join(' ‹ ')}` },
      h('span.review-stack-name', null, range),
      h('span.review-stack-meta', null, `${rows.length} PRs into ${s.base || 'the base'}`),
      tag ? h('span.review-stack-tag' + (c.native ? '.native' : ''), { role: 'img', 'aria-label': tag, title: tag }, icon(c.native ? 'github' : 'catchup', 12), h('span.review-stack-tag-text', null, tag)) : null,
      segs,
      h('span.review-stack-status', { title: st.text }, h('span.full', null, st.text), h('span.short', null, st.short)),
      h('span.review-stack-end', null,
        acts.length || link ? h('span.review-stack-acts', null,
          ...acts.map((x) => h('button.review-stack-act' + (x.id === 'merge' ? '.primary' : ''), { type: 'button', disabled: x.why ? true : undefined, title: x.why || undefined, onclick: x.run }, x.label)),
          link) : null,
        more));
  }
  // A ready part whose failing checks GitHub doesn't require (AK-611): its own segment, not plain green.
  const softFail = (r) => r.stage === 'ready' && r.pr.checks === 'failure' && !r.pr.draft && !checksBlock(r.pr);
  function segTitle(r) {
    const n = r.pr.number;
    if (softFail(r)) return `#${n} · ${(r.pr.failing || []).join(', ') || 'checks'} failing · Not required to merge`;
    return `#${n} ${r.title}\n${partWhy(r, { base }).why.replace(/^is /, '').replace(/^./, (x) => x.toUpperCase())}`;
  }
  // A head action in ⋯ says what it does on its own.
  const menuLabel = (x) => (x.id === 'checks' ? `View #${x.n}’s failure` : x.id === 'rebase' ? `Rebase #${x.n}` : x.label);
  // One head on one line (AK-611): with the container queries applied, hide the sentence, then move
  // the secondary actions, then the main one, into ⋯ until it fits.
  function fitHead(head) {
    head.dataset.shed = '';
    const w = (el) => (el ? el.getBoundingClientRect().width : 0);
    const cs = getComputedStyle(head);
    const gap = parseFloat(cs.columnGap) || 8;
    const kept = [...head.querySelectorAll(':scope > .review-stack-name, :scope > .review-stack-meta, :scope > .review-stack-tag, :scope > .review-stack-segs')].map(w).filter((x) => x > 0);
    const base = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + kept.reduce((a, b) => a + b, 0) + gap * (kept.length - 1);
    const main = head.querySelector('.review-stack-act.primary');
    const secondary = [...head.querySelectorAll('.review-stack-acts > :not(.primary)')];
    const status = head.querySelector('.review-stack-status');
    const lv = stackFit(head.clientWidth, { base, gap, sentence: parseFloat(getComputedStyle(status).minWidth) || 0, main: w(main), secondary: secondary.map(w), more: 22 });
    head.dataset.shed = lv;
    head.querySelector('.review-stack-menu').hidden = !((lv === 'menu' && secondary.length) || (lv === 'tight' && (main || secondary.length)));
  }

  // What a stack's head offers, for the head and ⌘K: Merge for the parts that merge now, the held
  // part's fix, Make it a GitHub stack (a chain; else why it can't be), Approve all (someone else's).
  function stackOffer(rows) {
    const st = stackStatus(rows, { base });
    const n = st.through;
    const prs = rows.map((r) => r.pr);
    const c = chainInfo.get(rows[0].stack.root);
    const ok = stackApproval(prs, inbox?.viewer);
    // One fix per blocker of the held part (AK-611): Mark #6 ready · View failure.
    const fixes = st.fixes?.filter((f) => f.id !== 'ready' || onMarkReady).map((f) => ({
      id: f.id, label: f.label, n: f.row.pr.number,
      run: () => (f.id === 'ready' ? onMarkReady(f.row.pr, inbox?.remote) : act(f.id, f.row)),
    })) || [];
    const acts = [
      n.length && canPlan() ? { id: 'merge', label: n.length === rows.length ? 'Merge stack' : n.length > 1 ? `Merge #${n[0]} → #${n[n.length - 1]}` : `Merge #${n[0]}`, run: () => mergePlan(null, { only: n, held: stackHeld(rows, st) }) } : null,
      ...fixes,
      c && !c.native && c.linkable && onMakeStack ? { id: 'link', label: 'Make it a GitHub stack', run: () => onMakeStack(rows[0].pr.number) } : null,
      ok && onApproveAll ? { id: 'approve', label: `Approve all ${ok.prs.length}…`, why: ok.why, run: () => onApproveAll(ok.prs, inbox?.remote, () => reload()) } : null,
    ].filter(Boolean);
    const link = c && !c.native && !c.linkable && c.why ? h('span.review-stack-why', { title: c.why }, c.why) : null;
    return { st, acts, link };
  }
  // The parts a stack merge leaves open, with why: the held part's status, "stacked on #N" above it.
  const stackHeld = (rows, st) => rows.slice(st.through.length).map((r, i) => ({ number: r.pr.number, why: i ? `Stacked on #${rows[st.through.length + i - 1].pr.number}` : st.why.replace(/^is /, '').replace(/^./, (c) => c.toUpperCase()) }));
  // ⌘K's stack head entries for the selected row's stack (two or more of its rows listed), else [].
  function stackActions() {
    const x = current();
    const rows = x?.stack ? shown.filter((r) => r.stack?.root === x.stack.root) : [];
    if (rows.length < 2) return [];
    const name = stackTitle(rows.map((r) => r.pr));
    return stackOffer(rows).acts.filter((a) => !a.why && a.id !== 'link').map((a) => ({ ...a, label: a.id === 'merge' && a.label === 'Merge stack' ? `Merge stack: ${name}` : a.id === 'checks' ? `View #${a.n}’s failure` : a.id === 'rebase' ? `Rebase #${a.n}` : a.label }));
  }

  function renderStaged() {
    const prsLoading = prsOn() && !inbox && !inboxFailed && reloading;
    const prsUnloaded = prsOn() && !inbox && !inboxFailed && !reloading; // nothing cached, Reload not pressed yet
    // A PR GitHub is still checking keeps the stage it had (AK-321).
    const previous = staged ? new Map(staged.all.map((x) => [x.key, x.stage])) : null;
    staged = reviewRows({ lanes, prs: inbox?.prs || [], reviewRequested: inbox?.requested || [], forecast: forecastOk && conflicts.size ? conflicts : null, prsOn: prsOn(), now: Date.now(), previous });
    loadChains();
    if (pendingSendBack != null && staged.all.some((x) => x.pr?.number === pendingSendBack)) { const n = pendingSendBack; pendingSendBack = null; setTimeout(() => sendBack(n)); }
    if (pendingPr != null && staged.all.some((x) => x.pr?.number === pendingPr)) { const n = pendingPr; pendingPr = null; setTimeout(() => showPr(n)); }
    const rows = [];
    const q = filter.value.trim();
    if (loaded) { lastCounts = { repo, stuck: staged.stages.stuck.length, ready: staged.stages.ready.length, needs: needsYou(staged.stages) }; onCounts(lastCounts); }
    if (q) {
      shown = filterRows(staged.all, q);
      pushRows(rows, shown);
    } else {
      shown = [];
      const t = TAB.get(tab);
      const many = t.stages.length > 1;
      const settled = loaded && !prsLoading && !prsUnloaded;
      for (const id of t.stages) {
        const rs = staged.stages[id];
        const label = STAGES.find((x) => x.id === id).label;
        // A group shows only when it has rows (AK-396); a one-stage tab says when it's empty.
        if (many && !rs.length) continue;
        if (many) rows.push(h('div.lanes-group.needs', { role: 'presentation', 'data-stage': id }, h('span', null, label, ' ', h('span.lanes-count', null, String(rs.length)))));
        if (!rs.length && loaded && !prsLoading && !(prsUnloaded && id !== 'stuck')) rows.push(h('div.review-none', null, NONE[id]));
        shown.push(...rs);
        pushRows(rows, rs);
      }
      if (tab === 'open' && !shown.length && settled) rows.push(h('div.review-none', null, 'Nothing is open.'));
      if (tab === 'needs' && settled && shown.length <= SHORT) { const calm = calmLine(); if (calm) rows.push(calm); }
      if (!prsOn()) rows.push(h('button.review-prs-off', { onclick: () => onPrSetup() }, icon('merge', 12), 'Local work only. Turn on PR features to see stuck and ready pull requests here'));
    }
    adopt(shown.map((r) => r.key));
    if (after) { selKey = nextSelection(after.before, staged, after.key) ?? selKey; after = null; }
    if (!shown.some((r) => r.key === selKey)) selKey = shown[0]?.key ?? null;
    list.replaceChildren(...rows);
    fitAll();
    queueFacts(shown);
    const n = staged.stages.stuck.length;
    const ready = staged.stages.ready.length;
    const needs = needsYou(staged.stages);
    // The counts live on the tabs; the title row only says it's loading.
    count.replaceChildren(...(!loaded ? ['Loading…'] : prsLoading ? [h('span.spinner.review-count-spin', { role: 'status', 'aria-label': 'Loading pull requests' })] : []));
    lede.textContent = !prsOn() ? 'Your branches and worktrees. What’s stuck comes first.'
      : !loaded || prsUnloaded || prsLoading ? 'Pull requests that need you, one list at a time.'
        : needs ? `${plural(needs, 'pull request needs', 'pull requests need')} you` : 'Nothing needs you right now.';
    renderTabs();
    const failed = loaded && !prsLoading && inboxFailed && prsOn();
    empty.replaceChildren(...(failed ? ['Couldn’t load pull requests. ', h('button.btn.ghost.small', { onclick: () => fetchLanes({ prs: true }).catch(fail) }, 'Retry')]
      : loaded && prsUnloaded && !(q && !shown.length) ? ['Pull requests aren’t loaded. ', h('button.btn.ghost.small', { onclick: () => reload() }, 'Reload', kbd(...reloadKeys()))]
        : [!loaded ? '' : prsLoading ? 'Loading pull requests…' : q && !shown.length ? 'Nothing matches.' : '']));
    empty.hidden = !empty.textContent;
  }

  // Ready-to-merge PRs whose primary button is Merge: Merge all ready (⌘K) merges them all after one confirmation.
  const readyPrs = () => (staged ? staged.stages.ready.filter((r) => r.pr && step(r) === 'merge').map((r) => r.pr) : []);
  // Reloads the inbox first so the confirmation doesn't list PRs whose checks or approval changed.
  async function mergeReady() {
    if (prsOn()) {
      try { await fetchLanes({ prs: true }); } catch (e) { return fail(e); }
      if (!el.isConnected || inboxFailed) return;
    }
    const prs = readyPrs();
    if (!prs.length) return toast('Nothing is ready to merge', { detail: 'Ready means GitHub would merge it now.' });
    onMergeReady(prs, inbox?.remote);
  }

  // Merge plan (merge-plan-view.js): on git 2.38+ with pull requests on. With them off nothing is
  // ever ready, so there's no plan for local branches.
  const canPlan = () => Boolean(onMergePlan && prsOn() && forecastOk && inbox?.remote);
  // Plan merge on a git too old for it: shown greyed, and opens Update git (AK-586).
  const planGated = () => Boolean(onMergePlan && onGitTooOld && prsOn() && !forecastOk && inbox?.remote);
  // Merge plan's target (AK-541, option A): a landing branch, one no open PR comes from (main,
  // master, dev, release/…). A PR lands on the branch its chain of bases reaches through other open
  // PRs' branches; a PR's own branch is never a target. The choice is remembered per repo.
  function landings() {
    const prs = inbox?.prs || [];
    const byBranch = new Map(prs.filter((p) => p.branch).map((p) => [p.branch, p]));
    const land = (p) => { let b = p.base; const seen = new Set(); while (byBranch.has(b) && !seen.has(b)) { seen.add(b); b = byBranch.get(b).base; } return b; };
    return new Map(prs.map((p) => [p.number, land(p)]));
  }
  function mergeTargets() {
    const open = inbox?.prs || [];
    const land = landings();
    const all = readyPrs();
    return [...new Set(open.map((p) => land.get(p.number)))].filter(Boolean).map((name) => ({
      name, open: open.filter((p) => land.get(p.number) === name).length, ready: all.filter((p) => land.get(p.number) === name).length,
    })).sort((a, b) => b.ready - a.ready || b.open - a.open || a.name.localeCompare(b.name));
  }
  const targetKey = () => `pref:mergeTarget:${repo || ''}`;
  // `only`: PR numbers to plan (a stack's head, AK-609); the target is where they land. `held`: the
  // stack's parts that stay open ({ number, why }, AK-611), listed under the plan.
  function mergePlan(method = null, { anyway = false, target = null, only = null, held = [] } = {}) {
    if (planGated()) return onGitTooOld('mergePlan', () => { forecastOk = true; render(); mergePlan(method, { anyway, target, only, held }); });
    if (!canPlan()) return toast(forecastOk ? 'Merge plan needs pull requests on' : `Merge plan needs git ${GIT_NEEDS.mergePlan} or later`);
    const open = inbox?.prs || [];
    if (!open.length) return toast('No open pull requests');
    const land = landings();
    const all = readyPrs();
    const targets = mergeTargets();
    let saved = null;
    try { saved = localStorage.getItem(targetKey()); } catch { /* ignore */ }
    const has = (n) => targets.some((t) => t.name === n);
    if (only) target = land.get(only[0]) || target;
    const to = target && has(target) ? target : saved && has(saved) ? saved : targets[0].name;
    const ready = all.filter((p) => land.get(p.number) === to && (!only || only.includes(p.number)));
    const others = open.filter((p) => land.get(p.number) === to && !ready.some((x) => x.number === p.number));
    const onTarget = (name, { save = true } = {}) => {
      if (save) { try { localStorage.setItem(targetKey(), name); } catch { /* ignore */ } }
      mergePlan(method, { anyway, target: name });
    };
    onMergePlan({ ready, others, held, known: open, base: to, remote: inbox.remote, method, anyway, targets, chosen: Boolean(target || (saved && has(saved))), onTarget });
  }

  function renderTabs() {
    const total = (t) => t.stages.reduce((sum, id) => sum + (staged?.stages[id]?.length || 0), 0);
    tabBar.replaceChildren(...TABS.map((t) => {
      const on = t.id === tab;
      const n = total(t);
      return h('button.review-tab' + (t.id === 'stuck' && n ? '.stuck' : ''), {
        role: 'tab', 'aria-selected': String(on), tabIndex: on ? 0 : -1, 'data-tab': t.id,
        'data-tip': tipFor(t.label, t.keyId), onclick: () => setTab(t.id),
      }, t.label, loaded ? h('span.review-tab-n', null, String(n)) : null);
    }),
    h('span.spacer'),
    ...[(tab === 'needs' || tab === 'ready') && (canPlan() || planGated()) && readyPrs().length ? h('button.btn.subtle.small.lanes-group-act' + (planGated() ? '.gated' : ''), { onclick: () => mergePlan(), 'data-tip': planGated() ? `Needs git ${GIT_NEEDS.mergePlan}` : tipFor('Plan merge', 'lanes.mergePlan') + '\nWork out an order with no conflicts, then merge in that order' }, 'Plan merge ▸') : null].filter(Boolean)); // nothing (not "null") when Plan merge isn't offered
  }
  // 1–5 and the tabs: one list at a time; the selection moves to the tab's first row unless it's on the tab.
  function setTab(id) {
    if (!TAB.has(id)) return;
    tab = lastTab = id;
    if (filter.value) filter.value = '';
    render();
    if (!shown.some((x) => x.key === selKey) && shown[0]) select(shown[0].key);
    el.focus({ preventScroll: true });
  }

  // Back to a saved place: select its row once the list has it, and scroll to where it was.
  function adopt(keys) {
    if (wanted && keys.includes(wanted)) selKey = wanted;
    if (loaded && (!prsOn() || inbox || inboxFailed || !reloading)) wanted = null; // gone since: keep the usual first row
    if (loaded && wantedScroll != null) { const y = wantedScroll; wantedScroll = null; setTimeout(() => { left.scrollTop = y; }); }
  }

  function select(key, scroll = true) {
    if (key !== selKey) moved = true;
    selKey = key;
    list.querySelectorAll('.lanes-row').forEach((r) => { const on = r.dataset.key === key; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    if (scroll) list.querySelector('.lanes-row.active')?.scrollIntoView({ block: 'nearest' });
    syncPane();
  }
  function move(d) {
    if (!shown.length) return;
    const i = shown.findIndex((x) => keyOf(x) === selKey);
    select(keyOf(shown[Math.max(0, Math.min(shown.length - 1, i + d))]));
  }
  const keyOf = (x) => x.key;
  const current = () => shown.find((x) => keyOf(x) === selKey);

  // Commands shared by the list and the filter box. In the box, letters type instead.
  function command(e, typing) {
    const rs = typing ? null : keymap.match('reader', e); // ←/→ step the list too (AK-381); in the filter they move the caret
    if (rs === 'reader.next' || rs === 'reader.prev') { move(rs === 'reader.next' ? 1 : -1); e.preventDefault(); e.stopPropagation(); return true; }
    const id = keymap.match('lanes', e);
    if (!id || (typing && e.key.length === 1 && id !== 'lanes.reload')) return false;
    const x = current();
    if (id === 'lanes.next') move(1);
    else if (id === 'lanes.prev') move(-1);
    else if (id === 'lanes.filter') filter.focus();
    else if (id === 'lanes.reload') reload();
    else if (id === 'lanes.open') { if (x && split() && paneObj?.key === x.key) paneObj.focus(); else if (x) act('open', x); }
    else if (id === 'lanes.clear') {
      if (!filter.value && !typing) return false; // let Escape through
      filter.value = '';
      render();
      el.focus({ preventScroll: true });
    } else if (typing) return false; // the rest are letters, Space or ⌘⌫: they edit the filter
    else if (id === 'lanes.all') onBranches('active');
    else if (id === 'lanes.agents') onBranches('agents');
    else if (id === 'lanes.conflicts') onBranches('conflict');
    else if (id === 'lanes.stages') setTab('inProgress');
    else if (TABS.some((t) => t.keyId === id)) setTab(TABS.find((t) => t.keyId === id).id);
    else if (id === 'lanes.mergeReady') mergeReady();
    else if (id === 'lanes.mergePlan') mergePlan();
    else if (id === 'lanes.stackDown' || id === 'lanes.stackUp') stackStep(id === 'lanes.stackUp' ? 1 : -1);
    else if (!x) return false;
    else if (id === 'lanes.review') act('review', x);
    else if (id === 'lanes.merge') act('merge', x);
    else if (id === 'lanes.details') act('details', x);
    else if (id === 'lanes.sendBack') act('sendBack', x);
    else if (id === 'lanes.updateBranch') act('updateBranch', x);
    else if (id === 'lanes.showConflicts') { if (baseConflict(x, base)) jumpToConflicts(x); else toast(`${x.title} doesn’t conflict with ${x.pr?.base || base || 'its base'}`); }
    else if (id === 'lanes.checkoutHere') act('checkoutHere', x);
    else if (PANE_KEYS[id] && split()) act(PANE_KEYS[id], x);
    else if (LANE_KEYS[id]) act(LANE_KEYS[id], x);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  el.addEventListener('keydown', (e) => {
    if (paneHost.contains(e.target)) return; // the pane's own keys (review-view.js)
    if (e.target === filter || command(e, false)) return;
    // With an empty filter, the window's own keys (the G of the go-to chords) go through to it.
    if (!filter.value && ['menu', 'global'].some((s) => keymap.chordStart(s, e) || keymap.match(s, e))) return;
    // Any other letter starts filtering.
    if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      filter.value += e.key;
      filter.focus();
      render();
    }
  });
  filter.addEventListener('keydown', (e) => { if (!command(e, true)) e.stopPropagation(); });
  filter.addEventListener('input', () => render());

  // Local data first, so the list shows at once; PRs (`gh pr list` plus your review requests) only when asked
  // (Reload, or after your own approve, close or merge) or when the repo opens (loadPrs joins that load), and on.
  // A local refresh that lands while `gh` is still running doesn't discard the PRs (loadGuard); `gh` gets PR_TIMEOUT.
  async function fetchLanes({ prs }) {
    const withPrs = Boolean(prs && prsOn());
    const t = loads.start(withPrs);
    if (withPrs) { reloading = true; inboxFailed = false; render(); } // Reload / Retry: "Reloading…"
    let res;
    try {
      res = await (withPrs ? loadPrs(repo, load) : load({ prs: false }));
    } catch (e) {
      if (withPrs && !loads.prs(t)) return; // a newer PR load took over: this error is old news (AK-315)
      if (withPrs) reloading = false;
      if (!withPrs || !el.isConnected) { if (withPrs && el.isConnected) render(); throw e; }
      inboxFailed = true;
      loaded = true;
      render();
      toast('Could not load pull requests', { kind: 'error', detail: e.message });
      return;
    }
    if (!res) return; // the repository closed while it loaded (app:lanes-list)
    const newest = loads.lanes(t);
    if (withPrs && loads.prs(t)) reloading = false;
    if ((!newest && !loads.prs(t)) || (loaded && !el.isConnected)) return;
    if (withPrs && loads.prs(t)) {
      // Without the login and review requests (res.inboxError) the PRs still show.
      inboxFailed = !res.prs;
      if (!inboxFailed) { inbox = { prs: res.prs, remote: res.remote, viewer: res.viewer || null, ...(res.inbox || {}) }; loadedAt = Date.now(); }
      if (res.inboxError) toast('Could not load your review requests', { kind: 'error', detail: res.inboxError.message });
    }
    if (!prsOn()) { inbox = null; inboxFailed = false; loadedAt = null; seedLanes = []; prCache = null; }
    if (newest) {
      base = res.base;
      const next = prsOn() ? (prs ? res.lanes : keepPrs(res.lanes, [...seedLanes, ...lanes])) : res.lanes;
      lanes = sortLanes(withConflicts(next, conflicts));
      seedLanes = [];
    } else {
      lanes = sortLanes(withConflicts(takePrs(lanes, res.lanes), conflicts)); // a newer local refresh has the lanes
      seedLanes = res.lanes; // and that refresh puts these PRs on branches `lanes` doesn't have yet (AK-315)
    }
    loaded = true;
    if (withPrs && inbox) remember();
    if (res.prError) toast('Could not load pull requests', { kind: 'error', detail: res.prError.message });
    render();
    if (newest) runForecast(t);
    if (withPrs && loads.prs(t) && inbox) recheckStates();
  }
  // GitHub works out a PR's merge state lazily: just after a push it answers unknown, and such a PR
  // has no stage of its own yet (AK-625). Review asks again for those PRs only (one GraphQL call per
  // 20, github.mergeStates), RECHECK's rounds, then leaves them to Reload. A newer PR load or
  // leaving Review stops it.
  let recheck = null;
  function recheckStates(round = 0) {
    clearTimeout(recheck);
    const from = inbox;
    const remote = from?.remote;
    if (!mergeStates || round >= RECHECK.length || !remote || !from.prs.some(unknownState)) return;
    recheck = setTimeout(async () => {
      if (!el.isConnected || inbox !== from || reloading) return;
      const res = await mergeStates(remote, from.prs.filter(unknownState).map((p) => p.number)).catch(() => null);
      if (!el.isConnected || inbox !== from || reloading) return;
      const known = new Map((res?.ok || []).filter((x) => x.mergeState && x.mergeState !== 'unknown').map(({ number, ...x }) => [number, x]));
      if (known.size) {
        inbox = { ...from, prs: from.prs.map((p) => (known.has(p.number) ? { ...p, ...known.get(p.number) } : p)) };
        remember();
        render();
      }
      recheckStates(round + 1);
    }, RECHECK[round]);
  }
  // Off the hot path: after the list shows. Unchanged pairs come from the main process's cache;
  // a newer list cancels this run (main resolves the cancelled one to null).
  async function runForecast(t) {
    const res = await forecast().catch(() => null);
    if (!res || !loads.lanes(t) || !el.isConnected) return;
    forecastOk = res.supported;
    conflicts = conflictsByLane(res.pairs, base, (o) => laneTitle(lanes.find((x) => laneKey(x) === laneKey(o)) || o));
    lanes = sortLanes(withConflicts(lanes, conflicts));
    render();
  }
  const fail = (e) => { loaded = true; render(); toast('Could not load Review', { kind: 'error', detail: e.message }); };
  // Reload (button, ⌘R, ⌘K, the not-loaded line, Retry): the one way Review asks GitHub for its PRs
  // on its own (besides recheckStates, for merge states GitHub hadn't worked out yet).
  const reload = () => (reloading ? Promise.resolve() : fetchLanes({ prs: true }).catch(fail));
  // Keep the last PR load for the next visit to Review.
  function remember() {
    if (!prsOn() || !inbox || !loadedAt) return;
    prCache = { repo, inbox, prs: lanes.filter(hadPr), loadedAt };
  }

  // Called on every repo change: debounced, local only (no network), keeps the selection.
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.isConnected) { fetchLanes({ prs: false }).catch(fail); paneObj?.refresh(); } }, DEBOUNCE);
  }
  // Other worktrees' files aren't watched: recount when the window comes back (local only; Reload asks GitHub).
  const onFocus = () => { if (el.isConnected) fetchLanes({ prs: false }).catch(fail); else window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);
  // "Updated 4m ago" keeps up while Review is open; stops once the page is gone.
  const tick = setInterval(() => { if (el.isConnected) renderReload(); else clearInterval(tick); }, AGO_TICK);

  render();
  // The load from opening the repo is still running: show "Reloading…" and its PRs when they land (no second `gh` call).
  // Before the local load, so that one is the newest lanes and the list shows at once (loadGuard).
  if (prsOn() && prLoads.pending(repo)) reload();
  fetchLanes({ prs: false }).catch(fail);
  setTimeout(() => el.focus({ preventScroll: true }));
  // The selected row's lane (for ⌘K "Merge and tidy…", rebase, delete) and its primary button's label.
  const selected = () => {
    const x = current();
    if (!x) return null;
    return x.lane ? { lane: asLane(x), base, step: STEPS[step(x)].label } : null;
  };
  // Where the user is, for Back and Forward (app.js passes it back as `place`).
  const location = () => ({ key: selKey, filter: filter.value, tab, scroll: left.scrollTop });
  // ⌘K "Next step on …": the selected row's primary button.
  const runStep = () => {
    const x = current();
    if (!x) return;
    act(step(x), x);
  };
  // The selected row and its pane context, for ⌘K's pane actions (split view only).
  const paneSelection = () => { const x = split() ? current() : null; return x ? { row: x, ctx: paneCtx(x) } : null; };
  // ⌘K's Show conflicts (AK-359): the selected row's conflicting files in its pane.
  const showRowConflicts = () => { const x = current(); if (x && baseConflict(x, base)) jumpToConflicts(x); };
  // Send back (⌘K, and Merge plan's links): the selected row when it's stuck, or PR #number's row.
  const stuckSelection = () => { const x = current(); return x && x.stage === 'stuck' ? x : null; };
  function sendBack(number = null) {
    const r = number == null ? stuckSelection() : (staged?.all || []).find((x) => x.pr?.number === number);
    if (!r && number != null && sendBackWaits({ loaded, prsOn: prsOn(), inbox, inboxFailed })) { pendingSendBack = number; return; }
    if (!r) return toast(number == null ? 'Select a stuck row first' : `#${number} isn’t in Review`);
    select(r.key);
    act('sendBack', r);
  }
  // [ / ] (AK-537): the PR the selected one sits on, or the next one up its stack.
  function stackTarget(d) {
    const s = current()?.stack;
    return s ? s.path[s.at - 1 + d] ?? null : null;
  }
  function stackStep(d) {
    const x = current();
    if (!x?.stack) { toast(x ? `${x.pr ? `#${x.pr.number}` : x.title} isn’t in a stack` : 'Nothing selected'); return; }
    const n = stackTarget(d);
    if (n == null) { toast(d < 0 ? `#${x.pr.number} is the bottom of its stack: it merges into ${x.stack.base || 'the base'}` : `#${x.pr.number} is the top of its stack`); return; }
    selectPr(n);
  }
  // A PR's row, from the pane's links; one the tab doesn't list opens All open first.
  function selectPr(n) {
    const row = staged?.all.find((y) => y.pr?.number === n);
    if (!row) { toast(`#${n} isn’t listed`); return; }
    if (!shown.includes(row)) setTab('open');
    select(row.key);
  }
  // ⌘K's stack entries: the PRs below and above the selected one, or null outside a stack.
  const stackSelection = () => (current()?.stack ? { number: current().pr.number, down: stackTarget(-1), up: stackTarget(1) } : null);

  // A PR picked outside Review (the sidebar, AK-385): its row, selected, on a tab that lists it.
  function showPr(number) {
    const r = (staged?.all || []).find((x) => x.pr?.number === number);
    if (!r && !loaded) { pendingPr = number; return; }
    if (!r) return toast(`#${number} isn’t in Review`, { detail: 'Reload pull requests to list it.' });
    if (filter.value) { filter.value = ''; render(); }
    if (!TAB.get(tab).stages.includes(r.stage)) setTab(TABS.find((t) => t.stages.length === 1 && t.stages[0] === r.stage)?.id || 'open');
    select(r.key);
  }
  // The page is being replaced: drop its window listener and timer now, not on the next focus.
  function destroy() { window.removeEventListener('focus', onFocus); clearInterval(tick); clearTimeout(timer); clearTimeout(recheck); }
  return { el, destroy, stackStep, stackSelection, stackActions, setTab, tab: () => tab, refresh, stuckSelection, evidence: () => paneObj?.evidence?.(), media: () => paneObj?.media?.(), showRowConflicts, sendBack, showPr, mergePlan, mergeTargets, canPlan, planGated, inboxPrs: () => inbox?.prs || [], inboxRemote: () => inbox?.remote || null, afterAction, paneSelection, rerender: render, selected, location, step: runStep, reload, canReload: () => prsOn() };
}

// The load when a repo opens (AK-382): the same pull requests Reload asks for, into prCache, so Review shows
// them without a Reload. Review open on this repo calls its own reload() instead (app.js). Quiet on
// failure: Reload says why. A repo switch before it lands drops it.
export async function prefetchReview({ repo, load, prsOn }) {
  openRepo = repo;
  if (!prsOn()) return;
  const res = await loadPrs(repo, load).catch(() => null);
  if (!res?.prs || openRepo !== repo || !prsOn()) return;
  prCache = { repo, inbox: { prs: res.prs, remote: res.remote, ...(res.inbox || {}) }, prs: (res.lanes || []).filter(hadPr), loadedAt: Date.now() };
  if (lastCounts?.repo === repo) lastCounts = null; // Catch up's line counts from these PRs
}

const hadPr = (l) => l.pr || l.done?.reason === 'pr';

// The repo's commits moved (a lane got stuck, a PR merged outside Review): Catch up recounts locally
// instead of showing Review's last numbers (AK-366).
export function forgetCounts(repo) { if (lastCounts?.repo === repo) lastCounts = null; }

// The pull requests of the last load for `repo` (lanes with `pr` or merged by one), for keepPrs: Branches shows "PR #N open"
// from them without a `gh` call (AK-396).
export const cachedPrs = (repo) => (prCache?.repo === repo ? prCache.prs : []);

// Catch up's line to Review and Review's sidebar badge: its stuck, ready-to-merge and needs-you counts. Review's
// last ones for this repo, or worked out from local lanes and the cached PRs (no `gh` call). load → app:lanes-list.
export async function reviewCounts({ repo, load, prsOn }) {
  if (lastCounts?.repo === repo) return lastCounts;
  const res = await load({ prs: false });
  if (!res) return null; // the repository closed
  const cached = prsOn() && prCache?.repo === repo ? prCache : null;
  const lanes = cached ? keepPrs(res.lanes, cached.prs) : res.lanes;
  const { stages } = reviewRows({ lanes, prs: cached?.inbox.prs || [], reviewRequested: cached?.inbox.requested || [], forecast: null, prsOn: prsOn(), now: Date.now(), previous: null });
  return { repo, stuck: stages.stuck.length, ready: stages.ready.length, needs: needsYou(stages) };
}
