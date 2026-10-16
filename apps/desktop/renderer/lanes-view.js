import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast, tipFor, loading } from './ui.js';
import { BUCKETS, ACTIONS, sortLanes, filterLanes, laneKey, aheadBehind, keepPrs, takePrs, loadGuard, withTimeout, conflictsByLane, withConflicts, conflictText, laneActions, laneTitle, canRemove } from './lanes.js';
import { STAGES, reviewRows, primaryAction, STEPS, rowBadges, filterRows, applyAction, rowPrNumber, nextSelection, stuckReason, baseConflict, conflictNote, overlapNote } from './review-rows.js';
import { catchupCard } from './catchup-view.js';
import { statusBadge, fileName } from './diff.js';
import * as keymap from './keymap.js';

// "2h ago", but "just now" and "Oct 3" as they are.
const ago = (t) => { const s = timeAgo(t); return /^\d/.test(s) ? `${s} ago` : s; };

// Review, the home view: one row per piece of work (per pull request while PRs are on), top to
// bottom: the catch-up card (catchup-view.js: what landed since your checkpoint; ⇧↵ walks through it
// one row at a time in the split pane, Esc stops), Stuck · N (each row says why, review-rows.js stuckReason), Ready to
// merge · N, then lines that open in place: In progress · N ▾, Everything else · N ▾ (every branch
// and worktree as one triage list, the lanes that need you first; lanes.js has the order) and
// "N finished · Clean up". Keyboard-first: ↑/↓ move, Space runs the row's one primary
// button, ↵ opens it, R reviews, M merges, D shows its details (branch, commits, worktree,
// uncommitted changes, Show in Map), E opens In progress, S opens Everything else (A agent lanes
// only, C predicted conflicts only), typing filters every row.
// Refreshes in place, keeping the selection. The conflict forecast runs after the list shows (git
// merge-tree, main process) and re-sorts the list when it lands. With pull requests off the rows
// come from local data alone, plus one line to turn them on: no `gh` calls.
// Opening Review, repo changes and window focus read local data only: no network. Pull requests (and
// the catch-up card's merged PRs) load when you press Reload (⇧R, the header button, ⌘K) or right
// after your own approve, close or merge. The last PR load is kept in memory for the open repo
// (prCache), so coming back to Review shows it at once, with "Updated 4m ago" beside Reload.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
// Row-action keys → their action (lanes.js ACTIONS); review, merge and open have their own branches.
const LANE_KEYS = { 'lanes.rebase': 'rebase', 'lanes.checks': 'checks', 'lanes.delete': 'delete', 'lanes.cleanup': 'cleanup' };
// The split view's pane actions from the list (pr-review.js PANE_ACTIONS; M merges through lanes.merge).
const PANE_KEYS = { 'lanes.approve': 'approve', 'lanes.closePr': 'close', 'lanes.checkout': 'checkout', 'lanes.github': 'github' };
const BUCKET = new Map(BUCKETS.map((b) => [b.id, b]));
const COLLAPSED = new Set(['inProgress']);
// Everything else rows are lanes; their keys get this prefix so a lane can also be a staged row.
const ALL = 'all:';
const allKey = (l) => ALL + laneKey(l);
const isLaneEntry = (x) => Boolean(x?.entry);
// Live refreshes after commits are debounced; the watcher can fire several times per commit.
const DEBOUNCE = 400;
const PR_TIMEOUT = 30e3; // `gh` hung or offline: say so instead of loading forever
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The last pull request load, kept across visits to Review (this window, this session) so coming back
// costs no `gh` call: { repo, inbox, prs: the lanes that had a PR (for keepPrs), catchup: the catch-up
// card's PR part, loadedAt (ms) }. Another repo, or pull requests turned off, drops it.
let prCache = null;
const AGO_TICK = 30e3; // how often "Updated 4m ago" catches up

// load({ prs, inbox }) → app:lanes-list result; forecast() → app:lanes-forecast result; prsOn() and markAgents() read current settings;
// onOpen(lane) opens it in the graph, onReview(lane, base) opens its branch review, onMerge(lane, base) merges and tidies it and
// progress(lane) → its review progress (review.js) or null. actions(lane) → extra context-menu items.
// onAction(id, lane, base) runs the other row actions (rebase, delete, discard, checks; ACTIONS in lanes.js).
// onCleanup(lane?) opens Clean up, with only that lane ticked when one is given. onCheckout(pr), onPrReview(pr, remote) and
// onMergeReady(prs, remote) act on pull requests; onPrSetup() turns pull requests on. `all` starts with Everything else open. `place` is a
// `location()` to return to (Back, ⌘[): its mode, row, filter, open stages and scroll, put back once the rows load.
// Split view (staged rows; Everything else rows open in the Map or a branch review): pane(row, ctx) builds the right-hand pane for the selected row (review-pane.js:
// { el, key, refresh, update, focus, destroy }), onPaneAction(id, row, ctx) runs its actions (PANE_ACTIONS) from the
// list's keys, paneWidth()/setPaneWidth(px) keep its width, and onSettle(from) records a move to another row once the
// pane shows it (`from` is the location before it), for Back and Forward. After an action app.js calls afterAction.
// catchup: { load, mark } for the catch-up card (app:catchup, app:catchup-mark); null leaves it out.
// git(method, ...args) reads the files an Everything else row's branch changes, for its preview in the pane.
export function lanesView({ repo = null, git = null, catchup = null, pane = null, onPaneAction = null, paneWidth = () => null, setPaneWidth = () => {}, onSettle = () => {}, load, forecast = async () => null, prsOn, markAgents, onOpen, onCleanup, onReview = () => {}, onMerge = () => {}, onAction = () => {}, progress = () => null, onCheckout = () => {}, onPrReview = () => {}, onMergeReady = () => {}, onPrSetup = () => {}, onSendBack = () => {}, onMergePlan = null, actions = () => [], all = false, place = null }) {
  if (prCache && prCache.repo !== repo) prCache = null; // another repo: its PRs don't apply
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
  let agentsOnly = false;
  let conflictsOnly = false;
  let conflicts = new Map(); // laneKey → forecast entries (conflictsByLane)
  let forecastOk = true; // false on git before 2.38: no forecast, no chip
  let loaded = false;
  let pendingSendBack = null; // sendBack(number) before Review listed it: opens once a refresh does
  let base = null;
  let timer = 0;
  const loads = loadGuard();
  const opened = new Set(); // collapsed stages the user opened
  const details = new Set(); // rows with Details ▾ open
  let wanted = place?.key ?? null; // the row to select once it's loaded
  let wantedScroll = place?.scroll ?? null;
  if (place) {
    all = !!place.all; agentsOnly = !!place.agentsOnly; conflictsOnly = !!place.conflictsOnly;
    for (const id of place.opened || []) opened.add(id);
  }

  const filter = h('input.lanes-filter', { type: 'search', placeholder: 'Filter…', spellcheck: false, 'aria-label': 'Filter', value: place?.filter || '' });
  const agentChip = h('button.chip', { title: 'Agent-made only (A)', onclick: () => toggleAgents() }, 'Agent-made');
  const conflictChip = h('button.chip', { title: 'Predicted conflicts only (C)', onclick: () => toggleConflicts() }, 'Conflicts');
  const allChip = h('button.chip.review-all', { title: `Every branch and worktree (${keymap.keys('lanes.all').join(' or ').toUpperCase()})`, onclick: () => setAll(!all) }, 'Everything else');
  const count = h('span.muted.lanes-count');
  const list = h('div.lanes-list', { role: 'listbox', 'aria-label': 'Review' });
  const empty = h('div.empty');
  const title = h('h1', null, 'Review');
  const lede = h('p.muted');
  const hint = h('div.review-hints');
  const reloadKeys = () => keymap.keys('lanes.reload');
  const updated = h('span.muted.review-updated', { 'aria-live': 'polite' });
  const reloadBtn = h('button.btn.ghost.small.review-reload', { onclick: () => reload(), 'data-tip': `${tipFor('Reload pull requests', 'lanes.reload')}\nAsk GitHub for the latest pull requests and review requests`, 'aria-label': 'Reload pull requests' });
  const cleanupBtn = onCleanup ? h('button.btn.ghost.icon-btn', { onclick: () => onCleanup(), 'data-tip': `${tipFor('Clean up…', 'global.cleanup')}\nFind stale branches and worktrees and remove them in bulk`, 'aria-label': 'Clean up…' }, icon('trash', 15)) : null;
  // One line: the title, the counts and Clean up; the description under it at full width.
  const left = h('div.page.flush.lanes', null,
    h('div.page-head.review-head', null,
      h('div.review-head-row', null, title, count, h('span.spacer'), updated, reloadBtn, cleanupBtn),
      lede),
    h('div.lanes-bar', null, icon('search', 14), filter, allChip, agentChip, conflictChip),
    list,
    empty,
  );
  const paneHost = h('div.review-pane-host');
  const handle = h('div.review-split-handle', { role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  // The key bar runs under both panes, across the window (the grid's last row).
  const el = h('div.review-split', { tabIndex: 0 }, left, handle, paneHost, hint);
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

  function doneText(l) {
    const why = l.done.reason === 'pr' ? `Pull request #${l.done.pr} was merged`
      : l.done.reason === 'key' ? `${l.done.key} is on the base branch`
        : l.done.reason === 'subject' ? 'A commit with its title is on the base branch'
          : l.merged === 'ancestor' ? 'Already part of the base branch' : 'Its changes are already on the base branch';
    return l.changes ? `${why} · ${l.changes} uncommitted file${l.changes === 1 ? '' : 's'}` : why;
  }

  function badges(l) {
    return [
      l.agent && markAgents() ? h('span.badge.agent', { title: `Looks agent-made (${l.agent.reason}: ${l.agent.match})` }, 'Agent') : null,
      l.conflicts ? h('span.badge.warn.lanes-conflict', { title: l.conflicts.map((c) => conflictText(c, 10)).join('\n') }, icon('warning', 11), 'Conflicts') : null,
      l.isBase ? h('span.badge', { title: 'The base branch' }, 'Base') : null,
      l.worktree?.current ? h('span.badge.local', { title: 'Open in this window' }, 'This window') : null,
      l.done ? h('span.badge', { title: doneText(l) }, 'Merged') : null,
      l.upstreamGone ? h('span.badge.warn', { title: 'Its upstream branch was deleted' }, 'Gone') : null,
      l.worktree?.prunable ? h('span.badge.warn', { title: 'The worktree folder no longer exists' }, 'Missing') : null,
    ];
  }

  function prCell(pr) {
    if (!pr) return h('span.lanes-pr.muted', null, '');
    // The number itself sits before the row's title; this column keeps draft, review and CI.
    return h('span.lanes-pr', { title: [`#${pr.number} ${pr.title || ''}`, pr.checks ? `CI: ${pr.checks}` : null, pr.review ? `Review: ${pr.review}` : null].filter(Boolean).join('\n') },
      pr.draft ? h('span.pr-draft', null, 'draft') : null,
      pr.review === 'approved' ? h('span.pr-review.approved', null, '✓') : pr.review === 'changes' ? h('span.pr-review.changes', null, '✗') : pr.review === 'required' ? h('span.pr-review', null, 'review') : null,
      pr.checks ? h('span.pr-ci.' + pr.checks, null, '●') : null);
  }

  function reviewCell(l) {
    const p = progress(l);
    if (!p) return h('span.lanes-review');
    return h('span.lanes-review' + (p.done && !p.moved ? '.done' : '') + (p.moved ? '.moved' : ''), {
      title: p.moved ? 'The branch moved since your last review. Open it (R) to see what changed.' : 'Files you marked reviewed',
    }, p.moved ? `${p.label} ·` : p.label, p.moved ? h('span.lanes-moved', null, ' moved') : null);
  }

  // Everything else: one row per branch or worktree.
  function row(l) {
    const active = allKey(l) === selKey;
    const ab = aheadBehind(l);
    // Narrow lists hide the ↑↓, PR and progress columns (styles.css); the row's tooltip keeps them.
    const tip = [laneTitle(l), ab && base ? `${ab} against ${base}` : ab, l.pr ? `#${l.pr.number}${l.pr.checks ? ` · CI ${l.pr.checks}` : ''}${l.pr.review ? ` · review ${l.pr.review}` : ''}` : null, progress(l)?.label ? `Reviewed ${progress(l).label}` : null, l.changes ? `${l.changes} uncommitted` : null].filter(Boolean).join('\n');
    return h('div.list-row.lanes-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-key': allKey(l), title: tip,
      onclick: () => select(allKey(l)),
      ondblclick: () => onOpen(l),
      oncontextmenu: (e) => { e.preventDefault(); select(allKey(l)); menu(e.clientX, e.clientY, l); },
    },
      icon(l.worktree ? 'worktree' : 'branch', 14),
      h('div.list-main', null,
        h('div.list-title', null, l.pr ? h('span.review-row-num', null, `#${l.pr.number}`) : null, h('span.lanes-name', { title: laneTitle(l) }, laneTitle(l)), ...badges(l)),
        h('div.list-sub', null,
          laneTitle(l) !== l.name ? h('span.lanes-branch', null, l.name) : null,
          l.worktree ? h('span', { title: l.worktree.path }, l.worktree.short || tildify(l.worktree.path)) : h('span', null, l.upstream || (l.detached ? 'Detached HEAD' : 'Local branch')),
          // The age lives on the sub line so it survives narrow lists and the split view.
          l.activity ? h('span.lanes-ago', { title: fullDate(l.activity / 1000) }, ` · ${ago(l.activity / 1000)}`) : null),
        // The selected lane spells out who it conflicts with and where, with the fixes right there (CSS shows it on .active).
        l.conflicts ? h('div.lanes-conflicts', null,
          ...l.conflicts.map((c) => h('div', { title: c.files.join('\n') }, conflictText(c))),
          h('div.lanes-fix', null, ...laneActions(l, 'conflicts').filter((id) => id !== 'delete').map((id) => actionBtn(l, id, true)))) : null),
      stepBtn(l),
      reviewCell(l),
      h('span.lanes-changes' + (l.changes ? '.dirty' : ''), { title: l.changes == null ? '' : 'Uncommitted changes in its worktree' }, l.changes ? `${l.changes} changed` : ''),
      h('span.lanes-ab', { title: base && ab ? `Ahead/behind ${base}` : '' }, ab),
      prsOn() ? prCell(l.pr) : null,
    );
  }

  // The lane's next step as a button, and the dispatcher every row action goes through.
  function actionBtn(l, id, inline = false) {
    const a = ACTIONS[id];
    return h(inline ? 'button.btn.subtle.lanes-fix-btn' : 'button.btn.subtle.lanes-step', {
      'data-tip': tipFor(a.label, a.keyId), 'aria-label': a.label,
      onclick: (e) => { e.stopPropagation(); select(allKey(l)); run(id, l); },
      ondblclick: (e) => e.stopPropagation(),
    }, icon(a.icon, 12), h('span.btn-label', null, a.label));
  }
  function stepBtn(l) {
    const [id] = laneActions(l);
    return id ? actionBtn(l, id) : h('span.lanes-step-none');
  }
  function run(id, l) {
    if (id === 'review') onReview(l, base);
    else if (id === 'merge') onMerge(l, base);
    else if (id === 'open') onOpen(l);
    else if (id === 'cleanup') onCleanup(l);
    else onAction(id, l, base);
  }
  // A key for a row action: runs it when the selected lane allows it (even when it isn't the row's button).
  function runKey(id, l) {
    if (!l) return;
    const ok = { rebase: Boolean(l.branch && !l.isBase && base), checks: Boolean(l.pr?.url), delete: canRemove(l), cleanup: Boolean(l.done) }[id];
    if (ok) run(id, l); else toast(`${ACTIONS[id].label} doesn’t apply to ${laneTitle(l)}`);
  }

  // Staged rows: the PR's actions, or the lane's when it has no PR.
  const requested = () => new Set(prsOn() ? inbox?.requested || [] : []);
  // A row as a lane for the lane actions: its PR joined on, or just the PR when it isn't checked out here.
  const asLane = (r) => (r.lane ? (r.pr && !r.lane.pr ? { ...r.lane, pr: r.pr } : r.lane) : { name: r.title, title: r.title, pr: r.pr });
  const paneCtx = (r) => (r.landed ? { base: r.landed.parent, remote: null, requested: new Set(), step: null, prsOn: false } : {
    base, remote: inbox?.remote || null, requested: requested(), step: step(r), prsOn: prsOn(), agents: markAgents(),
    conflicts: r.stage === 'stuck' && Boolean(baseConflict(r, base)), onConflicts: (files) => noteConflicts(r.key, files),
    onSelectPr: (n) => { const x = staged?.all.find((y) => y.pr?.number === n); if (x) select(x.key); else toast(`#${n} isn’t listed`); },
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
    if (r.landed) {
      if (id === 'review' || id === 'step') { if (paneObj?.key === r.key) paneObj.focus(); return; }
      if (id === 'open' || id === 'checkout') return onOpen(lane);
      return toast(`${r.title} already landed`);
    }
    if (split() && ['merge', 'approve', 'close', 'checkout', 'github'].includes(id) && onPaneAction) return onPaneAction(id, r, paneCtx(r));
    if (id === 'review' && split() && paneObj?.key === r.key) paneObj.focus();
    else if (id === 'review') { if (pr) onPrReview(pr, inbox?.remote); else if (lane) onReview(lane, base); }
    else if (id === 'merge') {
      if (lane?.branch && !lane.isBase) onMerge(asLane(r), base);
      else if (pr) onMergeReady([pr], inbox?.remote);
      else toast(`Nothing to merge on ${r.title}`);
    } else if (id === 'open') { if (lane) onOpen(lane); else if (pr) onPrReview(pr, inbox?.remote); }
    else if (id === 'checkout') { if (pr) onCheckout(pr); }
    else if (id === 'sendBack') { if (r.stage === 'stuck') onSendBack(r, paneCtx(r)); else toast(`${r.title} isn’t stuck`); }
    else if (id === 'details') toggleDetails(r.key);
    else runKey(id, asLane(r));
  }
  const step = (r) => primaryAction(r, { base, requested: requested() });

  function stagedRow(r) {
    const active = r.key === selKey;
    const id = step(r);
    const s = STEPS[id];
    const open = details.has(r.key);
    const at = r.pr?.updatedAt ? Date.parse(r.pr.updatedAt) : r.lane?.activity || 0;
    const overlap = overlapNote(r);
    const sub = r.pr
      ? [r.pr.authorName || r.pr.author, r.branch].filter(Boolean).join(' · ')
      : [r.branch, r.worktree ? r.lane?.worktree?.short || tildify(r.worktree.path) : null].filter(Boolean).join(' · ');
    return h('div.list-row.lanes-row.review-row.staged' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'aria-expanded': String(open), 'data-key': r.key,
      title: [r.pr ? `#${r.pr.number} ${r.title}` : r.title, r.ahead ? `↑${r.ahead} against ${base || 'the base'}` : null].filter(Boolean).join('\n'),
      onclick: () => select(r.key),
      ondblclick: () => act('open', r),
      oncontextmenu: (e) => { e.preventDefault(); select(r.key); stagedMenu(e.clientX, e.clientY, r); },
    },
      icon(r.pr ? 'merge' : r.worktree ? 'worktree' : 'branch', 14),
      // Two lines: the title, then status tags, who and where, and age. Only the selected row shows
      // its buttons (pinned to the title line, styles.css) and why it's stuck.
      h('div.list-main', null,
        h('div.list-title', null, r.pr ? h('span.review-row-num', null, `#${r.pr.number}`) : null, h('span.lanes-name', { title: r.title }, r.title)),
        h('div.list-sub.review-row-meta', null,
          // The review decision is an icon here; the pane's header spells it out.
          ...rowBadges(r, { requested: requested(), agents: markAgents() }).map((b) => b.icon
            ? h('span.review-decision' + (b.kind ? `.${b.kind}` : ''), { title: b.title, 'aria-label': b.text }, icon(b.icon, 12))
            : h('span.badge.review-badge' + (b.kind ? `.${b.kind}` : ''), { title: b.title }, b.spin ? h('span.badge-spinner', { 'aria-hidden': 'true' }) : null, b.text)),
          sub ? h('span.review-row-sub', { title: r.pr?.authorName && r.pr.authorName !== r.pr.author ? `${r.pr.authorName} (${r.pr.author})` : null }, sub) : null,
          // Overlaps with other open PRs (AK-321): quiet text, never a tag.
          overlap ? h('span.review-row-overlap', { title: overlap.title }, overlap.text) : null,
          at ? h('span.review-row-age', { title: fullDate(at / 1000) }, timeAgo(at / 1000)) : null),
        r.stage === 'stuck' && reason(r) ? reasonEl(r) : null,
        open ? detailsEl(r) : null),
      h('div.review-row-acts', null,
        r.stage === 'stuck' && id !== 'sendBack' ? h('button.btn.ghost.review-details-btn.review-sendback', {
          'data-tip': `${tipFor('Send back…', 'lanes.sendBack')}\nA ready-made prompt for whoever made it`, 'aria-label': 'Send back…',
          onclick: (e) => { e.stopPropagation(); select(r.key); act('sendBack', r); },
          ondblclick: (e) => e.stopPropagation(),
        }, icon('sparkle', 13), h('span.btn-label', null, 'Send back…')) : null,
        h('button.btn.ghost.icon-btn.review-details-btn', {
          'data-tip': tipFor(open ? 'Hide details' : 'Details', 'lanes.details'), 'aria-label': 'Details', 'aria-expanded': String(open),
          onclick: (e) => { e.stopPropagation(); select(r.key); toggleDetails(r.key); },
          ondblclick: (e) => e.stopPropagation(),
        }, icon('chevronDown', 13)),
        h('button.btn.subtle.lanes-step', {
          'data-tip': tipFor(s.label, s.keyId), 'aria-label': s.label,
          onclick: (e) => { e.stopPropagation(); select(r.key); act(id, r); },
          ondblclick: (e) => e.stopPropagation(),
        }, icon(s.icon, 12), h('span.btn-label', null, s.label))),
    );
  }

  const reason = (r, max = 2) => stuckReason(r, { base, max });
  // Why it's stuck; a conflict with the base is its own note that jumps to the conflicting files.
  function reasonEl(r) {
    const note = conflictNote(r, { base, files: paneConflicts.get(r.key) });
    const rest = stuckReason(r, { base, max: 2, noBase: Boolean(note) });
    return h('div.review-reason', { title: reason(r, 20) },
      note ? h('button.review-reason-link', { title: 'Show the conflicting files', onclick: (e) => { e.stopPropagation(); jumpToConflicts(r); }, ondblclick: (e) => e.stopPropagation() }, note) : null,
      note && rest ? ' · ' : null, rest);
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
          : r.pr ? h('button.btn.subtle.lanes-fix-btn', { onclick: () => onCheckout(r.pr), title: 'Check out in a new worktree' }, icon('worktree', 12), 'Check out') : null,
        l && !l.isBase ? h('button.btn.subtle.lanes-fix-btn', { onclick: () => onReview(l, base), title: 'Review the branch’s changes' }, icon('check', 12), 'Review branch') : null));
  }

  function toggleDetails(key) {
    if (!key) return;
    if (details.has(key)) details.delete(key); else details.add(key);
    render();
  }

  function stagedMenu(x, y, r) {
    const l = asLane(r);
    contextMenu(x, y, [
      ...(r.lane ? [{ label: r.lane.worktree && !r.lane.worktree.current && !r.lane.worktree.prunable ? 'Switch to Worktree' : 'Show in Map', icon: r.lane.worktree ? 'worktree' : 'map', kbd: keymap.keys('lanes.open'), run: () => onOpen(r.lane) }] : []),
      ...(r.pr ? [{ label: 'Review…', icon: 'diff', kbd: keymap.keys('lanes.review'), run: () => act('review', r) }] : [{ label: 'Review Branch', icon: 'check', kbd: keymap.keys('lanes.review'), run: () => act('review', r) }]),
      ...(r.pr && !r.lane ? [{ label: 'Check Out in New Worktree…', icon: 'worktree', run: () => onCheckout(r.pr) }] : []),
      { label: 'Merge…', icon: 'merge', kbd: keymap.keys('lanes.merge'), disabled: !r.pr && (!l.branch || l.isBase), run: () => act('merge', r) },
      ...(r.lane?.branch && !r.lane.isBase && base ? [{ label: 'Rebase onto Base', icon: 'rebase', kbd: keymap.keys('lanes.rebase'), run: () => act('rebase', r) }] : []),
      ...(r.pr?.url ? [{ label: 'Open Checks', icon: 'external', kbd: keymap.keys('lanes.checks'), run: () => act('checks', r) }] : []),
      ...(r.stage === 'stuck' ? [{ label: 'Send Back…', icon: 'copy', kbd: keymap.keys('lanes.sendBack'), run: () => act('sendBack', r) }] : []),
      { label: details.has(r.key) ? 'Hide Details' : 'Details', icon: 'lanes', kbd: keymap.keys('lanes.details'), run: () => toggleDetails(r.key) },
      ...(r.lane ? ['-', { label: r.lane.changes ? 'Discard Lane…' : 'Delete Lane…', icon: 'trash', kbd: keymap.keys('lanes.delete'), disabled: !canRemove(r.lane), run: () => act('delete', r) }] : []),
    ]);
  }

  function render() {
    agentChip.hidden = !all;
    conflictChip.hidden = !all || !forecastOk;
    allChip.classList.toggle('on', all);
    allChip.setAttribute('aria-pressed', String(all));
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
    if (!r || isLaneEntry(r)) {
      clearTimeout(paneTimer); paneObj?.destroy(); paneObj = null;
      if (!r) paneHost.replaceChildren('');
      else if (paneHost.firstChild?.dataset?.key !== r.key || paneHost.firstChild.lane !== r.lane) paneHost.replaceChildren(branchPreview(r));
      if (r && moved && settled && settled !== r.key) onSettle({ ...location(), key: settled });
      if (r) { moved = false; settled = r.key; }
      return;
    }
    if (paneObj?.key === r.key) { paneObj.update(r, paneCtx(r)); return; }
    clearTimeout(paneTimer);
    paneTimer = setTimeout(showPane, paneObj ? 120 : 0);
  }
  function showPane() {
    const r = split() ? current() : null;
    if (!r || isLaneEntry(r) || paneObj?.key === r.key || !el.isConnected) return;
    const had = paneHost.contains(document.activeElement);
    paneObj?.destroy();
    paneObj = pane(r, paneCtx(r));
    paneHost.replaceChildren(paneObj.el);
    if (jumpTo === r.key) paneObj.showConflicts?.();
    jumpTo = null;
    if (had) el.focus({ preventScroll: true });
    if (moved && settled && settled !== r.key) onSettle({ ...location(), key: settled });
    moved = false;
    settled = r.key;
  }

  // The pane for an Everything else row: the branch at a glance (upstream, ↑↓, worktree), its
  // actions, predicted conflicts, its commits and the files it changes against the base, then the
  // way in as a muted line. Files come from git branchReview, cached per branch tip.
  const previewFiles = new Map();
  function branchPreview(x) {
    const l = x.lane;
    const ab = aheadBehind(l);
    const ids = [...laneActions(l), ...(l.branch && !l.isBase && base ? ['rebase'] : []), ...(!l.isBase && (l.branch || l.head) ? ['review'] : [])]
      .filter((id, i, all) => all.indexOf(id) === i && id !== 'delete' && id !== 'discard');
    const section = (label, ...body) => h('section.branch-preview-section', null, h('div.lanes-group', null, label), ...body);
    const files = h('div.branch-preview-files');
    const el = h('div.review-pane.branch-preview', { 'data-key': x.key },
      h('div.review-pane-head', null,
        h('div.review-pane-title', null, h('div.quick-title', { title: laneTitle(l) }, icon(l.worktree ? 'worktree' : 'branch', 14), ' ', laneTitle(l)), ...badges(l)),
        h('div.quick-meta.review-pane-meta', null,
          h('span.mono', null, l.name),
          h('span', null, l.upstream || (l.detached ? 'Detached HEAD' : 'Local branch')),
          ab ? h('span', { title: base ? `Ahead/behind ${base}` : '' }, ab) : null,
          l.worktree ? h('span.mono', { title: l.worktree.path }, tildify(l.worktree.path)) : null),
        ids.length ? h('div.review-pane-actions', null, ...ids.map((id) => actionBtn(l, id, true))) : null),
      h('div.branch-preview-body', null,
        l.conflicts ? section('Predicted conflicts', ...l.conflicts.map((c) => h('div.review-detail.warn', { title: c.files.join('\n') }, conflictText(c)))) : null,
        l.isBase ? null : section(l.ahead != null ? `Commits not on ${base || 'the base'} · ${l.ahead}` : 'Commits',
          l.ahead === 0 ? h('div.review-none', null, 'Nothing here that isn’t on the base.')
            : h('div.branch-preview-commit', null, icon('commit', 13), h('span.lanes-name', { title: l.title || '' }, l.title || l.name), l.activity ? h('span.review-row-age', { title: fullDate(l.activity / 1000) }, timeAgo(l.activity / 1000)) : null),
          l.ahead > 1 ? h('div.review-none', null, `and ${plural(l.ahead - 1, 'older commit')}: R reviews them all`) : null),
        l.isBase ? h('div.review-none', null, 'This is the base branch.') : section('Changed files', files)),
      h('div.branch-preview-hint', null, `↵ ${l.worktree && !l.worktree.current ? 'switches to its worktree' : 'shows it in the Map'} · R reviews the branch`));
    el.lane = l;
    if (!l.isBase && git && (l.branch || l.head)) {
      const id = `${laneKey(l)}@${l.head || ''}@${base || ''}`;
      const show = (list) => files.replaceChildren(...(list.length ? list.map((f) => {
        const [name, dir] = fileName(f.path);
        return h('div.file-row', { title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }, statusBadge(f.status), h('span.fname', null, name), h('span.fdir', null, dir),
          f.add || f.del ? h('span.stat.small', null, f.add ? h('span.add', null, '+' + f.add) : null, f.del ? h('span.del', null, '−' + f.del) : null) : null);
      }) : [h('div.review-none', null, 'No changes against the base.')]));
      if (previewFiles.has(id)) show(previewFiles.get(id));
      else {
        files.replaceChildren(loading('Reading its changes…'));
        git('branchReview', l.branch || l.head, base || undefined)
          .then((res) => { previewFiles.set(id, res.files); if (files.isConnected) show(res.files); })
          .catch((e) => files.replaceChildren(h('div.review-none', null, `Couldn’t read its changes: ${e.message}`)));
      }
    }
    return el;
  }

  // After a pane action on row `key` (approve, merge, close…): re-stage it at once and move the
  // selection to the next row that needs you; the PR list reloads behind it.
  function afterAction(key, id) {
    const before = shown.map((r) => r.key);
    const n = rowPrNumber(key);
    if (inbox && n != null) inbox = { ...inbox, ...applyAction(inbox, n, id) };
    after = { before, key };
    render();
    list.querySelector('.lanes-row.active')?.scrollIntoView({ block: 'nearest' });
    if (prsOn() && (id === 'approve' || id === 'close' || id === 'merge')) fetchLanes({ prs: true }).catch(fail);
  }

  // The catch-up card, and the walk-through: its landed entries as rows (newest first) in the split pane.
  const card = catchup ? catchupCard({ ...catchup, prsOn, seed: seed?.catchup || null, onWalk: () => walk(), onChange: () => remember() }) : null;
  const catchUp = h('div.review-catchup', { 'data-slot': 'catch-up' }, card?.el);
  let walking = null; // landed rows while walking through what landed
  const landedRow = (e) => ({
    key: `landed:${e.id}`, landed: e, pr: null, stage: 'landed',
    title: e.kind === 'pr' ? `#${e.number} ${e.title}` : e.title,
    // A lane for the pane: it reviews parent..sha, and Show in Map selects the commit.
    lane: { name: e.sha, branch: null, head: e.sha, isBase: false, worktree: null },
  });
  function walk(on = true) {
    if (on && !card?.walkList().length) return toast('Nothing landed to walk through');
    walking = on ? card.walkList().map(landedRow) : null;
    filter.value = '';
    render();
    if (walking) select(walking[0].key);
    el.focus({ preventScroll: true });
  }
  function landedRowEl(r) {
    const e = r.landed;
    const active = r.key === selKey;
    return h('div.list-row.lanes-row.review-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-key': r.key,
      onclick: () => select(r.key),
      ondblclick: () => onOpen(r.lane),
    },
      // A merged PR gets the merged check; a commit pushed straight to the base keeps the commit dot.
      e.kind === 'pr' ? h('span.landed-merged', { title: 'Merged', 'aria-label': 'Merged' }, icon('check-circle', 14)) : icon('commit', 14),
      h('div.list-main', null,
        h('div.list-title', null,
          e.kind === 'pr' ? h('span.review-row-num', null, `#${e.number}`) : null,
          h('span.lanes-name', { title: r.title }, e.kind === 'pr' ? e.title : r.title),
          e.key ? h('span.badge', null, e.key) : null),
        // A PR's date is when it merged; a commit's is when it was made.
        h('div.list-sub', { title: e.date ? `${e.kind === 'pr' ? 'Merged' : 'Committed'} ${fullDate(e.date / 1000)}` : null },
          [e.sha.slice(0, 7), e.author, e.date ? (e.kind === 'pr' ? 'merged ' : '') + ago(e.date / 1000) : null, e.kind === 'pr' ? e.branch : null, e.area].filter(Boolean).join(' · '))));
  }

  function renderStaged() {
    lede.textContent = prsOn() ? 'What’s stuck and what’s ready to merge come first. Everything else is a step away.' : 'Your branches and worktrees. What’s stuck comes first.';
    const prsLoading = prsOn() && !inbox && !inboxFailed && reloading;
    const prsUnloaded = prsOn() && !inbox && !inboxFailed && !reloading; // nothing cached, Reload not pressed yet
    // A PR GitHub is still checking keeps the stage it had (AK-321).
    const previous = staged ? new Map(staged.all.map((x) => [x.key, x.stage])) : null;
    staged = reviewRows({ lanes, prs: inbox?.prs || [], reviewRequested: inbox?.requested || [], forecast: forecastOk && conflicts.size ? conflicts : null, prsOn: prsOn(), now: Date.now(), previous });
    if (pendingSendBack != null && staged.all.some((x) => x.pr?.number === pendingSendBack)) { const n = pendingSendBack; pendingSendBack = null; setTimeout(() => sendBack(n)); }
    if (agentsOnly && !markAgents()) agentsOnly = false;
    // A lane whose open PR a bot opened counts as agent-made too.
    const bots = new Map(markAgents() ? staged.all.filter((r) => r.lane && !r.lane.agent && r.pr?.bot).map((r) => [r.lane, r.pr.authorName || r.pr.author]) : []);
    const marked = bots.size ? lanes.map((l) => (bots.has(l) ? { ...l, agent: { reason: 'bot author', match: bots.get(l) } } : l)) : lanes;
    const everything = filterLanes(marked, '', { agentsOnly, conflictsOnly }).map((l) => ({ key: allKey(l), lane: l, entry: true }));
    const rows = [];
    const q = filter.value.trim();
    card?.setCounts({ stuck: staged.stages.stuck.length, ready: staged.stages.ready.length });
    if (walking) {
      shown = walking;
      rows.push(catchUp, h('div.lanes-group.needs', { role: 'presentation', 'data-stage': 'landed' }, h('span', null, `${walking[0].landed.kind === 'pr' ? 'Merged' : 'Landed'} ${card.sinceLabel()} `, h('span.lanes-count', null, `· ${walking.length}`)),
        h('button.btn.ghost.small.lanes-group-act', { onclick: () => walk(false), title: 'Back to Review (Esc)' }, 'Done', kbd('Esc'))));
      for (const r of walking) rows.push(landedRowEl(r));
    } else if (q) {
      shown = filterRows(staged.all, q);
      for (const r of shown) rows.push(stagedRow(r));
    } else {
      shown = [];
      rows.push(catchUp);
      for (const s of STAGES) {
        const rs = staged.stages[s.id];
        // Stuck and Ready to merge always show their count; with PRs off nothing is ever ready.
        if (!rs.length && (COLLAPSED.has(s.id) || (s.id === 'ready' && !prsOn()))) continue;
        const collapsed = COLLAPSED.has(s.id) && !opened.has(s.id);
        if (COLLAPSED.has(s.id)) {
          rows.push(h('button.lanes-group.review-stage', { 'aria-expanded': String(!collapsed), 'data-stage': s.id, onclick: () => toggleStage(s.id), title: `Show or hide (${keymap.keys('lanes.stages').join(' or ').toUpperCase()})` }, s.label, ' ', h('span.lanes-count', null, String(rs.length)), ` ${collapsed ? '▾' : '▴'}`));
        } else rows.push(h('div.lanes-group.needs', { role: 'presentation', 'data-stage': s.id }, h('span', null, s.label, ' ', h('span.lanes-count', null, String(rs.length))),
          s.id === 'ready' && canPlan() && readyPrs().length ? h('button.btn.ghost.small.lanes-group-act', { onclick: () => mergePlan(), title: `Work out an order with no conflicts, then merge in that order (${keymap.keys('lanes.mergePlan').join(' or ').toUpperCase()})` }, 'Plan merge ▸') : null));
        if (collapsed) continue;
        if (!rs.length && loaded && !prsLoading && !(prsUnloaded && s.id === 'ready')) rows.push(h('div.review-none', null, s.id === 'stuck' ? 'Nothing is stuck.' : 'Nothing is ready to merge yet.'));
        for (const r of rs) { shown.push(r); rows.push(stagedRow(r)); }
      }
      rows.push(h('button.lanes-group.review-stage', { 'aria-expanded': String(all), 'data-stage': 'everything', onclick: () => setAll(!all), title: `Every branch and worktree (${keymap.keys('lanes.all').join(' or ').toUpperCase()})` }, 'Everything else ', h('span.lanes-count', null, String(lanes.length)), ` ${all ? '▴' : '▾'}`));
      if (all) {
        let bucket = null;
        for (const x of everything) {
          if (x.lane.bucket !== bucket) {
            bucket = x.lane.bucket;
            const b = BUCKET.get(bucket);
            rows.push(h('div.lanes-subgroup' + (b.needs ? '.needs' : ''), { role: 'presentation' }, b.label));
          }
          shown.push(x);
          rows.push(row(x.lane));
        }
        if (loaded && !everything.length) rows.push(h('div.review-none', null, conflictsOnly ? 'No predicted conflicts between active branches.' : lanes.length ? 'Nothing matches.' : 'No branches yet.'));
      }
      if (staged.finished.count) {
        rows.push(h('button.review-finished', { onclick: () => onCleanup(), title: `Open Clean up with the finished branches and worktrees ticked (${keymap.keys('global.cleanup').join(' or ')}). ⌘Z brings them back.` },
          `${staged.finished.count} finished · `, h('span.review-finished-link', null, 'Clean up ▸')));
      }
      if (!prsOn()) rows.push(h('button.review-prs-off', { onclick: () => onPrSetup() }, icon('merge', 12), 'Local work only. Turn on PR features to see stuck and ready pull requests here'));
    }
    adopt(shown.map((r) => r.key));
    if (after) { selKey = nextSelection(after.before, staged, after.key) ?? selKey; after = null; }
    if (!shown.some((r) => r.key === selKey)) selKey = shown[0]?.key ?? null;
    list.replaceChildren(...rows);
    agentChip.classList.toggle('on', agentsOnly);
    conflictChip.classList.toggle('on', conflictsOnly);
    const n = staged.stages.stuck.length;
    const ready = staged.stages.ready.length;
    // While PRs load, the local counts show with a spinner; "ready" needs the PRs.
    count.replaceChildren(...(!loaded ? ['Loading…'] : prsLoading ? [`${n} stuck`, h('span.spinner.review-count-spin', { role: 'status', 'aria-label': 'Loading pull requests' })]
      : [[`${n} stuck`, prsOn() ? `${ready} ready` : null].filter(Boolean).join(' · ')]));
    const failed = loaded && !prsLoading && inboxFailed && prsOn();
    empty.replaceChildren(...(failed ? ['Couldn’t load pull requests. ', h('button.btn.ghost.small', { onclick: () => fetchLanes({ prs: true }).catch(fail) }, 'Retry')]
      : loaded && prsUnloaded && !(q && !shown.length) ? ['Pull requests aren’t loaded. ', h('button.btn.ghost.small', { onclick: () => reload() }, 'Reload', kbd(...reloadKeys()))]
        : [!loaded ? '' : prsLoading ? 'Loading pull requests…' : q && !shown.length ? 'Nothing matches.' : '']));
    empty.hidden = !empty.textContent;
    const many = readyPrs().length;
    // A few keys with short labels; everything else is in ⌘K.
    const k = (keys, label, cls = '') => h('span.review-hint' + cls, null, kbd(...keys), label);
    hint.replaceChildren(...(walking
      ? [k(['↑', '↓'], 'Next and previous'), k(['↵'], 'Show in Map'), k(['R'], 'Read the diff'), k(['Esc'], 'Done')]
      : [k(['Space'], 'Main action'), k(['↵'], 'Open'), k(['M'], 'Merge'), k(['R'], 'Read the diff'),
        pane ? k(['Esc'], 'Back') : many > 1 ? k(['⇧', 'M'], 'Merge all ready') : null].filter(Boolean)),
      k(keymap.keys('view.palette'), 'All commands', '.all'));
  }

  // Ready-to-merge PRs whose primary button is Merge: ⇧M merges them all after one confirmation.
  const readyPrs = () => (staged ? staged.stages.ready.filter((r) => r.pr && step(r) === 'merge').map((r) => r.pr) : []);
  function mergeReady() {
    const prs = readyPrs();
    if (!prs.length) return toast('Nothing is ready to merge', { detail: 'Ready means GitHub would merge it now.' });
    onMergeReady(prs, inbox?.remote);
  }

  // Merge plan (merge-plan-view.js): on git 2.38+ with pull requests on. With them off nothing is
  // ever ready, so there's no plan for local branches.
  const canPlan = () => Boolean(onMergePlan && prsOn() && forecastOk && inbox?.remote);
  function mergePlan() {
    if (!canPlan()) return toast(forecastOk ? 'Merge plan needs pull requests on' : 'Merge plan needs git 2.38 or later');
    const all = readyPrs();
    if (!all.length) return toast('Nothing is ready to merge', { detail: 'Ready means GitHub would merge it now.' });
    const to = all[0].base;
    const ready = all.filter((p) => p.base === to);
    const others = (inbox?.prs || []).filter((p) => p.base === to && !ready.some((x) => x.number === p.number));
    onMergePlan({ ready, others, base: to, remote: inbox.remote });
  }

  function toggleStage(id) {
    if (opened.has(id)) opened.delete(id); else opened.add(id);
    render();
  }
  // E: open the collapsed stages, or close them when any is open.
  function toggleStages() {
    const any = [...COLLAPSED].some((id) => opened.has(id));
    for (const id of COLLAPSED) if (any) opened.delete(id); else opened.add(id);
    render();
  }

  // Everything else, opened or closed in place; opening it moves the selection to its first row.
  function setAll(on) {
    if (on === all) return;
    all = on;
    if (!all) { agentsOnly = false; conflictsOnly = false; }
    render();
    if (all && !filter.value.trim()) { const first = shown.find(isLaneEntry); if (first) select(first.key); }
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

  function toggleAgents() {
    if (!agentsOnly && !markAgents()) return toast('Agent-made marks are off', { detail: 'Turn on “Mark lanes that look agent-made” in Choose defaults (⇧⌘,).' });
    all = true;
    agentsOnly = !agentsOnly;
    render();
  }

  function toggleConflicts() {
    if (!forecastOk) return toast('Conflict forecast needs git 2.38 or later', { detail: 'Update git to see which branches would conflict before you merge.' });
    all = true;
    conflictsOnly = !conflictsOnly;
    render();
  }

  function menu(x, y, l) {
    const extra = actions(l);
    contextMenu(x, y, [
      { label: l.worktree && !l.worktree.current && !l.worktree.prunable ? 'Switch to Worktree' : 'Show in Map', icon: l.worktree ? 'worktree' : 'map', kbd: keymap.keys('lanes.open'), run: () => onOpen(l) },
      { label: 'Review Branch', icon: 'check', kbd: keymap.keys('lanes.review'), run: () => onReview(l, base) },
      { label: 'Merge and Tidy…', icon: 'merge', kbd: keymap.keys('lanes.merge'), disabled: !l.branch || l.isBase, run: () => onMerge(l, base) },
      { label: 'Rebase onto Base', icon: 'rebase', kbd: keymap.keys('lanes.rebase'), disabled: !l.branch || l.isBase || !base, run: () => run('rebase', l) },
      ...(l.pr?.url ? [{ label: 'Open Checks', icon: 'external', kbd: keymap.keys('lanes.checks'), run: () => run('checks', l) }] : []),
      ...(l.done ? [{ label: 'Clean Up…', icon: 'trash', kbd: keymap.keys('lanes.cleanup'), run: () => run('cleanup', l) }] : []),
      '-',
      { label: l.changes ? 'Discard Lane…' : 'Delete Lane…', icon: 'trash', kbd: keymap.keys('lanes.delete'), disabled: !canRemove(l), run: () => run('delete', l) },
      ...(extra.length ? ['-', ...extra] : []),
    ]);
  }

  // Commands shared by the list and the filter box. In the box, letters type instead.
  function command(e, typing) {
    const id = keymap.match('lanes', e);
    if (!id || (typing && e.key.length === 1 && id !== 'lanes.reload')) return false;
    const x = current();
    const l = isLaneEntry(x) ? x.lane : null; // an Everything else row
    if (id === 'lanes.next') move(1);
    else if (id === 'lanes.prev') move(-1);
    else if (id === 'lanes.filter') filter.focus();
    else if (id === 'lanes.reload') reload();
    else if (id === 'lanes.open') { if (l) onOpen(l); else if (x) act('open', x); }
    else if (id === 'lanes.walk' && !typing) walk();
    else if (id === 'lanes.caughtUp' && !typing && card) card.markCaughtUp();
    else if (id === 'lanes.since' && !typing && card) card.pickSince();
    else if (id === 'lanes.clear') {
      if (walking && !filter.value) { walk(false); e.preventDefault(); e.stopPropagation(); return true; }
      if (!filter.value && !typing) return false; // let Escape through
      filter.value = '';
      render();
      el.focus({ preventScroll: true });
    } else if (typing) return false; // the rest are letters, Space or ⌘⌫: they edit the filter
    else if (id === 'lanes.all') setAll(!all);
    else if (id === 'lanes.agents') toggleAgents();
    else if (id === 'lanes.conflicts') toggleConflicts();
    else if (id === 'lanes.stages') toggleStages();
    else if (id === 'lanes.mergeReady') mergeReady();
    else if (id === 'lanes.mergePlan') mergePlan();
    else if (!x) return false;
    else if (l) {
      if (id === 'lanes.step') { const [a] = laneActions(l); if (a) run(a, l); else toast(`Nothing needs doing on ${laneTitle(l)}`); }
      else if (LANE_KEYS[id]) runKey(LANE_KEYS[id], l);
      else if (id === 'lanes.review') onReview(l, base);
      else if (id === 'lanes.merge') onMerge(l, base);
      else return false;
    } else if (x.landed) {
      if (id === 'lanes.step' || id === 'lanes.review') act('review', x);
      else if (id === 'lanes.checkout') act('checkout', x);
      else return false;
    } else if (id === 'lanes.step') act(step(x), x);
    else if (id === 'lanes.review') act('review', x);
    else if (id === 'lanes.merge') act('merge', x);
    else if (id === 'lanes.details') act('details', x);
    else if (id === 'lanes.sendBack') act('sendBack', x);
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
    // Any other letter starts filtering.
    if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      walking = null;
      filter.value += e.key;
      filter.focus();
      render();
    }
  });
  filter.addEventListener('keydown', (e) => { if (!command(e, true)) e.stopPropagation(); });
  filter.addEventListener('input', () => { walking = null; render(); });

  // Local data first, so the list shows at once; PRs (`gh pr list` plus your review requests) only when asked
  // (Reload, or after your own approve, close or merge) and on.
  // A local refresh that lands while `gh` is still running doesn't discard the PRs (loadGuard); `gh` gets PR_TIMEOUT.
  async function fetchLanes({ prs }) {
    const withPrs = Boolean(prs && prsOn());
    const t = loads.start(withPrs);
    card?.reload({ prs: withPrs });
    if (withPrs) { reloading = true; inboxFailed = false; render(); } // Reload / Retry: "Reloading…"
    let res;
    try {
      const p = load({ prs: withPrs, ...(withPrs ? { inbox: true } : {}) });
      res = await (withPrs ? withTimeout(p, PR_TIMEOUT, 'GitHub didn’t answer in time.') : p);
    } catch (e) {
      if (withPrs && loads.prs(t)) reloading = false;
      if (!withPrs || !loads.prs(t) || !el.isConnected) { if (withPrs && el.isConnected) render(); throw e; }
      inboxFailed = true;
      loaded = true;
      render();
      toast('Could not load pull requests', { kind: 'error', detail: e.message });
      return;
    }
    const newest = loads.lanes(t);
    if (withPrs && loads.prs(t)) reloading = false;
    if ((!newest && !loads.prs(t)) || (loaded && !el.isConnected)) return;
    if (withPrs && loads.prs(t)) {
      // Without the login and review requests (res.inboxError) the PRs still show.
      inboxFailed = !res.prs;
      if (!inboxFailed) { inbox = { prs: res.prs, remote: res.remote, ...(res.inbox || {}) }; loadedAt = Date.now(); }
      if (res.inboxError) toast('Could not load your review requests', { kind: 'error', detail: res.inboxError.message });
    }
    if (!prsOn()) { inbox = null; inboxFailed = false; loadedAt = null; seedLanes = []; prCache = null; }
    if (newest) {
      base = res.base;
      const next = prsOn() ? (prs ? res.lanes : keepPrs(res.lanes, lanes.length ? lanes : seedLanes)) : res.lanes;
      lanes = sortLanes(withConflicts(next, conflicts));
    } else lanes = sortLanes(withConflicts(takePrs(lanes, res.lanes), conflicts)); // a newer local refresh has the lanes
    loaded = true;
    seedLanes = [];
    if (withPrs && inbox) remember();
    if (res.prError) toast('Could not load pull requests', { kind: 'error', detail: res.prError.message });
    render();
    if (newest) runForecast(t);
  }
  // Off the hot path: after the list shows. Unchanged pairs come from the main process's cache;
  // a newer list cancels this run (main resolves the cancelled one to null).
  async function runForecast(t) {
    const res = await forecast().catch(() => null);
    if (!res || !loads.lanes(t) || !el.isConnected) return;
    forecastOk = res.supported;
    conflicts = conflictsByLane(res.pairs, base, (o) => laneTitle(lanes.find((x) => laneKey(x) === laneKey(o)) || o));
    if (!forecastOk) conflictsOnly = false;
    lanes = sortLanes(withConflicts(lanes, conflicts));
    render();
  }
  const fail = (e) => { loaded = true; render(); toast('Could not load Review', { kind: 'error', detail: e.message }); };
  // Reload (button, ⇧R, ⌘K, the not-loaded line, Retry): the one way Review asks GitHub on its own.
  const reload = () => (reloading ? Promise.resolve() : fetchLanes({ prs: true }).catch(fail));
  // Keep the last PR load (and the catch-up card's PR part) for the next visit to Review.
  function remember() {
    if (!prsOn() || !inbox || !loadedAt) return;
    prCache = { repo, inbox, prs: lanes.filter((l) => l.pr), catchup: card?.prData() || prCache?.catchup || null, loadedAt };
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
  fetchLanes({ prs: false }).catch(fail);
  setTimeout(() => el.focus({ preventScroll: true }));
  // ⌘K "Show everything else" / "Hide everything else".
  const showAll = (on = !all) => setAll(on);
  // ⌘K "Show branches with predicted conflicts": Show all with the filter on (never off).
  const showConflicts = () => { if (!conflictsOnly) toggleConflicts(); };
  // The selected row's lane (for ⌘K "Merge and tidy…", rebase, delete) and its primary button's label.
  const selected = () => {
    const x = current();
    if (!x || x.landed) return null;
    if (isLaneEntry(x)) { const [a] = laneActions(x.lane); return { lane: x.lane, base, step: a ? ACTIONS[a].label : null }; }
    return x.lane ? { lane: asLane(x), base, step: STEPS[step(x)].label } : null;
  };
  // Where the user is, for Back and Forward (app.js passes it back as `place`).
  const location = () => ({ all, key: selKey, filter: filter.value, agentsOnly, conflictsOnly, opened: [...opened], scroll: left.scrollTop });
  // ⌘K "Next step on …": the selected row's primary button.
  const runStep = () => {
    const x = current();
    if (!x) return;
    if (x.landed) return act('review', x);
    if (!isLaneEntry(x)) return act(step(x), x);
    const [a] = laneActions(x.lane);
    if (a) run(a, x.lane);
  };
  // The selected row and its pane context, for ⌘K's pane actions (split view only).
  const paneSelection = () => { const x = split() ? current() : null; return x && !isLaneEntry(x) && !x.landed ? { row: x, ctx: paneCtx(x) } : null; };
  // Send back (⌘K, and Merge plan's links): the selected row when it's stuck, or PR #number's row.
  const stuckSelection = () => { const x = current(); return x && !isLaneEntry(x) && x.stage === 'stuck' ? x : null; };
  function sendBack(number = null) {
    const r = number == null ? stuckSelection() : (staged?.all || []).find((x) => x.pr?.number === number);
    if (!r && number != null && !loaded) { pendingSendBack = number; return; }
    if (!r) return toast(number == null ? 'Select a stuck row first' : `#${number} isn’t in Review`);
    select(r.key);
    act('sendBack', r);
  }
  return { el, walk: () => walk(), markCaughtUp: () => card?.markCaughtUp(), pickSince: () => card?.pickSince(), refresh, stuckSelection, sendBack, mergePlan, canPlan, afterAction, paneSelection, rerender: render, showAll, isAll: () => all, showConflicts, selected, location, step: runStep, reload, canReload: () => prsOn() };
}
