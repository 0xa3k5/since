import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast } from './ui.js';
import { BUCKETS, ACTIONS, sortLanes, filterLanes, laneKey, aheadBehind, keepPrs, conflictsByLane, withConflicts, conflictText, laneActions, laneTitle, canRemove } from './lanes.js';
import { STAGES, reviewRows, primaryAction, STEPS, rowBadges, filterRows, applyAction, rowPrNumber, nextSelection, stuckReason } from './review-rows.js';
import { catchupCard } from './catchup-view.js';
import * as keymap from './keymap.js';

// Review, the home view: one row per piece of work (per pull request while PRs are on), top to
// bottom: the catch-up card (catchup-view.js: what landed since your checkpoint; ⇧↵ walks through it
// one row at a time in the split pane, Esc stops), Stuck · N (each row says why, review-rows.js stuckReason), Ready to
// merge · N, then lines that open in place: In progress · N ▸, Everything else · N ▸ (every branch
// and worktree as one triage list, the lanes that need you first; lanes.js has the order) and
// "N finished · Clean up". Keyboard-first: ↑/↓ or J/K move, Space runs the row's one primary
// button, ↵ opens it, R reviews, M merges, D shows its details (branch, commits, worktree,
// uncommitted changes, Show in Map), E opens In progress, S opens Everything else (A agent lanes
// only, C predicted conflicts only), typing filters every row.
// Refreshes in place, keeping the selection. The conflict forecast runs after the list shows (git
// merge-tree, main process) and re-sorts the list when it lands. With pull requests off the rows
// come from local data alone, plus one line to turn them on: no `gh` calls.

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
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
export function lanesView({ catchup = null, pane = null, onPaneAction = null, paneWidth = () => null, setPaneWidth = () => {}, onSettle = () => {}, load, forecast = async () => null, prsOn, markAgents, onOpen, onCleanup, onReview = () => {}, onMerge = () => {}, onAction = () => {}, progress = () => null, onCheckout = () => {}, onPrReview = () => {}, onMergeReady = () => {}, onPrSetup = () => {}, actions = () => [], all = false, place = null }) {
  let lanes = [];
  let inbox = null; // { prs, remote, me, requested } from the last PR load
  let inboxFailed = false;
  let staged = null; // the last reviewRows result
  let shown = [];
  let selKey = null;
  let agentsOnly = false;
  let conflictsOnly = false;
  let conflicts = new Map(); // laneKey → forecast entries (conflictsByLane)
  let forecastOk = true; // false on git before 2.38: no forecast, no chip
  let loaded = false;
  let base = null;
  let timer = 0;
  let seq = 0;
  const opened = new Set(); // collapsed stages the user opened
  const details = new Set(); // rows with Details ▸ open
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
  const hint = h('div.diff-hint.wt-hint');
  const cleanupBtn = onCleanup ? h('button.btn.ghost', { onclick: () => onCleanup(), title: 'Find stale branches and worktrees and remove them in bulk' }, icon('trash', 14), 'Clean up…', kbd(...keymap.keys('global.cleanup'))) : null;
  const left = h('div.page.flush.lanes', null,
    h('div.page-head', null,
      h('div', null, title, lede),
      h('div.page-actions', null, count, cleanupBtn)),
    h('div.lanes-bar', null, icon('search', 14), filter, allChip, agentChip, conflictChip),
    list,
    empty,
    hint,
  );
  const paneHost = h('div.review-pane-host');
  const handle = h('div.review-split-handle', { role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const el = h('div.review-split', { tabIndex: 0 }, left, handle, paneHost);
  let paneObj = null;
  let paneTimer = 0;
  let settled = null; // the row the pane last showed, for Back and Forward
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
      l.isBase ? h('span.badge', null, 'Base') : null,
      l.worktree?.current ? h('span.badge.local', null, 'This window') : null,
      l.done ? h('span.badge', { title: doneText(l) }, 'Merged') : null,
      l.upstreamGone ? h('span.badge.warn', { title: 'Its upstream branch was deleted' }, 'Gone') : null,
      l.worktree?.prunable ? h('span.badge.warn', { title: 'The worktree folder no longer exists' }, 'Missing') : null,
    ];
  }

  function prCell(pr) {
    if (!pr) return h('span.lanes-pr.muted', null, '');
    return h('span.lanes-pr', { title: [`#${pr.number} ${pr.title || ''}`, pr.checks ? `CI: ${pr.checks}` : null, pr.review ? `Review: ${pr.review}` : null].filter(Boolean).join('\n') },
      `#${pr.number}`,
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
    return h('div.list-row.lanes-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-key': allKey(l),
      onclick: () => select(allKey(l)),
      ondblclick: () => onOpen(l),
      oncontextmenu: (e) => { e.preventDefault(); select(allKey(l)); menu(e.clientX, e.clientY, l); },
    },
      icon(l.worktree ? 'worktree' : 'branch', 14),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name', { title: laneTitle(l) }, laneTitle(l)), ...badges(l)),
        h('div.list-sub', null,
          laneTitle(l) !== l.name ? h('span.lanes-branch', null, l.name) : null,
          l.worktree ? h('span', { title: l.worktree.path }, l.worktree.short || tildify(l.worktree.path)) : h('span', null, l.upstream || (l.detached ? 'Detached HEAD' : 'Local branch'))),
        // The selected lane spells out who it conflicts with and where, with the fixes right there (CSS shows it on .active).
        l.conflicts ? h('div.lanes-conflicts', null,
          ...l.conflicts.map((c) => h('div', { title: c.files.join('\n') }, conflictText(c))),
          h('div.lanes-fix', null, ...laneActions(l, 'conflicts').filter((id) => id !== 'delete').map((id) => actionBtn(l, id, true)))) : null),
      stepBtn(l),
      reviewCell(l),
      h('span.lanes-changes' + (l.changes ? '.dirty' : ''), { title: l.changes == null ? '' : 'Uncommitted changes in its worktree' }, l.changes ? `${l.changes} changed` : ''),
      h('span.lanes-ab', { title: base && ab ? `Ahead/behind ${base}` : '' }, ab),
      prsOn() ? prCell(l.pr) : null,
      h('span.lanes-time', { title: l.activity ? fullDate(l.activity / 1000) : '' }, l.activity ? timeAgo(l.activity / 1000) : ''),
    );
  }

  // The lane's next step as a button, and the dispatcher every row action goes through.
  function actionBtn(l, id, inline = false) {
    const a = ACTIONS[id];
    return h(inline ? 'button.btn.subtle.lanes-fix-btn' : 'button.btn.subtle.lanes-step', {
      title: `${a.label} (${keymap.keys(a.keyId).join(' or ')})`,
      onclick: (e) => { e.stopPropagation(); select(allKey(l)); run(id, l); },
      ondblclick: (e) => e.stopPropagation(),
    }, icon(a.icon, 12), a.label);
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
  const paneCtx = (r) => (r.landed ? { base: r.landed.parent, remote: null, requested: new Set(), step: null, prsOn: false } : { base, remote: inbox?.remote || null, requested: requested(), step: step(r), prsOn: prsOn() });
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
    const sub = r.pr
      ? [`#${r.pr.number}`, r.pr.author, r.branch].filter(Boolean).join(' · ')
      : [r.branch, r.worktree ? r.lane?.worktree?.short || tildify(r.worktree.path) : null].filter(Boolean).join(' · ');
    return h('div.list-row.lanes-row.review-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'aria-expanded': String(open), 'data-key': r.key,
      onclick: () => select(r.key),
      ondblclick: () => act('open', r),
      oncontextmenu: (e) => { e.preventDefault(); select(r.key); stagedMenu(e.clientX, e.clientY, r); },
    },
      icon(r.pr ? 'merge' : r.worktree ? 'worktree' : 'branch', 14),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name', { title: r.title }, r.title),
          ...rowBadges(r, { requested: requested() }).map((b) => h('span.badge.review-badge' + (b.kind ? `.${b.kind}` : ''), { title: b.title }, b.text)),
          r.lane?.agent && markAgents() ? h('span.badge.agent', { title: `Looks agent-made (${r.lane.agent.reason}: ${r.lane.agent.match})` }, 'Agent') : null),
        h('div.list-sub', null, sub),
        r.stage === 'stuck' && reason(r) ? h('div.review-reason', { title: reason(r, 20) }, reason(r)) : null,
        open ? detailsEl(r) : null),
      h('button.btn.ghost.review-details-btn', {
        title: `Details (${keymap.keys('lanes.details').join(' or ').toUpperCase()})`, 'aria-expanded': String(open),
        onclick: (e) => { e.stopPropagation(); select(r.key); toggleDetails(r.key); },
        ondblclick: (e) => e.stopPropagation(),
      }, open ? 'Details ▾' : 'Details ▸'),
      h('button.btn.subtle.lanes-step', {
        title: `${s.label} (${keymap.keys(s.keyId).join(' or ')})`,
        onclick: (e) => { e.stopPropagation(); select(r.key); act(id, r); },
        ondblclick: (e) => e.stopPropagation(),
      }, icon(s.icon, 12), s.label),
      h('span.lanes-time', { title: at ? fullDate(at / 1000) : '' }, at ? timeAgo(at / 1000) : ''),
    );
  }

  const reason = (r, max = 2) => stuckReason(r, { base, max });

  // Details ▸: the branch, its commits, worktree and uncommitted changes, and the way into the map.
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
    syncPane();
  }

  // The pane follows the selection, a moment after it stops moving (a PR not here is fetched).
  function syncPane() {
    el.classList.toggle('split', split());
    const r = split() ? current() : null;
    if (!r || isLaneEntry(r)) {
      clearTimeout(paneTimer); paneObj?.destroy(); paneObj = null;
      paneHost.replaceChildren(r ? h('div.empty', null, `${laneTitle(r.lane)}: ↵ ${r.lane.worktree && !r.lane.worktree.current ? 'switches to its worktree' : 'shows it in the Map'} · R reviews the branch`) : '');
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
    if (had) el.focus({ preventScroll: true });
    if (moved && settled && settled !== r.key) onSettle({ ...location(), key: settled });
    moved = false;
    settled = r.key;
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
  const card = catchup ? catchupCard({ ...catchup, prsOn, onWalk: () => walk() }) : null;
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
      icon(e.kind === 'pr' ? 'merge' : 'commit', 14),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name', { title: r.title }, r.title), e.key ? h('span.badge', null, e.key) : null),
        h('div.list-sub', null, [e.sha.slice(0, 7), e.author, e.kind === 'pr' ? e.branch : null, e.area].filter(Boolean).join(' · '))),
      h('span.lanes-time', { title: fullDate(e.date / 1000) }, timeAgo(e.date / 1000)));
  }

  function renderStaged() {
    lede.textContent = prsOn() ? 'What’s stuck and what’s ready to merge come first. Everything else is a step away.' : 'Your branches and worktrees. What’s stuck comes first.';
    const prsLoading = prsOn() && !inbox && !inboxFailed;
    staged = reviewRows({ lanes, prs: inbox?.prs || [], reviewRequested: inbox?.requested || [], forecast: forecastOk && conflicts.size ? conflicts : null, prsOn: prsOn(), now: Date.now() });
    if (agentsOnly && !markAgents()) agentsOnly = false;
    const everything = filterLanes(lanes, '', { agentsOnly, conflictsOnly }).map((l) => ({ key: allKey(l), lane: l, entry: true }));
    const rows = [];
    const q = filter.value.trim();
    card?.setCounts({ stuck: staged.stages.stuck.length, ready: staged.stages.ready.length });
    if (walking) {
      shown = walking;
      rows.push(catchUp, h('div.lanes-group.needs', { role: 'presentation', 'data-stage': 'landed' }, `What landed · ${walking.length}`,
        h('button.btn.ghost.small.catchup-stop', { onclick: () => walk(false), title: 'Back to Review (Esc)' }, 'Done', kbd('Esc'))));
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
          rows.push(h('button.lanes-group.review-stage', { 'aria-expanded': String(!collapsed), 'data-stage': s.id, onclick: () => toggleStage(s.id), title: `Show or hide (${keymap.keys('lanes.stages').join(' or ').toUpperCase()})` }, `${s.label} · ${rs.length} ${collapsed ? '▸' : '▾'}`));
        } else rows.push(h('div.lanes-group.needs', { role: 'presentation', 'data-stage': s.id }, `${s.label} · ${rs.length}`));
        if (collapsed) continue;
        if (!rs.length && loaded && !prsLoading) rows.push(h('div.review-none', null, s.id === 'stuck' ? 'Nothing is stuck.' : 'Nothing is ready to merge yet.'));
        for (const r of rs) { shown.push(r); rows.push(stagedRow(r)); }
      }
      rows.push(h('button.lanes-group.review-stage', { 'aria-expanded': String(all), 'data-stage': 'everything', onclick: () => setAll(!all), title: `Every branch and worktree (${keymap.keys('lanes.all').join(' or ').toUpperCase()})` }, `Everything else · ${lanes.length} ${all ? '▾' : '▸'}`));
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
    count.textContent = !loaded || prsLoading ? 'Loading…' : [`${n} stuck`, prsOn() ? `${ready} ready to merge` : null].filter(Boolean).join(' · ');
    empty.textContent = !loaded ? '' : prsLoading ? 'Loading pull requests…' : inboxFailed && prsOn() ? 'Couldn’t load pull requests.' : q && !shown.length ? 'Nothing matches.' : '';
    empty.hidden = !empty.textContent;
    const many = readyPrs().length;
    if (walking) { hint.textContent = 'J/K Next and previous · ↵ Show in Map · R Read the diff · Esc Done'; return; }
    hint.textContent = `Space Primary button · ↵ Open · R Review${pane ? ' (Esc back)' : ''} · M Merge${pane && prsOn() ? ' · ⇧A Approve · ⇧X Close · W Check out · ⇧O GitHub' : ''} · D Details · E In progress · S Everything else${all ? ` · A Agent-made only${forecastOk ? ' · C Conflicts only' : ''}` : ''} · J/K Move · / Filter${many > 1 ? ' · ⇧M Merge all ready' : ''}`;
  }

  // Ready-to-merge PRs whose primary button is Merge: ⇧M merges them all after one confirmation.
  const readyPrs = () => (staged ? staged.stages.ready.filter((r) => r.pr && step(r) === 'merge').map((r) => r.pr) : []);
  function mergeReady() {
    const prs = readyPrs();
    if (!prs.length) return toast('Nothing is ready to merge', { detail: 'Ready means approved, checks passed (or none), and no conflicts.' });
    onMergeReady(prs, inbox?.remote);
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
    if (loaded && (!prsOn() || inbox || inboxFailed)) wanted = null; // gone since: keep the usual first row
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
    if (!id || (typing && e.key.length === 1)) return false;
    const x = current();
    const l = isLaneEntry(x) ? x.lane : null; // an Everything else row
    if (id === 'lanes.next') move(1);
    else if (id === 'lanes.prev') move(-1);
    else if (id === 'lanes.filter') filter.focus();
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

  // Local data first, so the list shows at once; PRs (`gh pr list` plus your review requests) only when asked and on.
  async function fetchLanes({ prs }) {
    const n = ++seq;
    const withPrs = Boolean(prs && prsOn());
    card?.reload({ prs: withPrs });
    const res = await load({ prs: withPrs, ...(withPrs ? { inbox: true } : {}) });
    if (n !== seq || (loaded && !el.isConnected)) return;
    base = res.base;
    if (withPrs) {
      // Without the login and review requests (res.inboxError) the PRs still show.
      inboxFailed = !res.prs;
      if (!inboxFailed) inbox = { prs: res.prs, remote: res.remote, ...(res.inbox || {}) };
      if (res.inboxError) toast('Could not load your review requests', { kind: 'error', detail: res.inboxError.message });
    }
    if (!prsOn()) { inbox = null; inboxFailed = false; }
    const next = prsOn() ? (prs ? res.lanes : keepPrs(res.lanes, lanes)) : res.lanes;
    lanes = sortLanes(withConflicts(next, conflicts));
    loaded = true;
    if (res.prError) toast('Could not load pull requests', { kind: 'error', detail: res.prError.message });
    render();
    runForecast(n);
  }
  // Off the hot path: after the list shows. Unchanged pairs come from the main process's cache;
  // a newer list cancels this run (main resolves the cancelled one to null).
  async function runForecast(n) {
    const res = await forecast().catch(() => null);
    if (!res || n !== seq || !el.isConnected) return;
    forecastOk = res.supported;
    conflicts = conflictsByLane(res.pairs, base, (o) => laneTitle(lanes.find((x) => laneKey(x) === laneKey(o)) || o));
    if (!forecastOk) conflictsOnly = false;
    lanes = sortLanes(withConflicts(lanes, conflicts));
    render();
  }
  const fail = (e) => { loaded = true; render(); toast('Could not load Review', { kind: 'error', detail: e.message }); };

  // Called on every repo change: debounced, local only (no network), keeps the selection.
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.isConnected) { fetchLanes({ prs: false }).catch(fail); paneObj?.refresh(); } }, DEBOUNCE);
  }
  // Other worktrees' files aren't watched: recount (and re-read PRs) when the window comes back.
  const onFocus = () => { if (el.isConnected) fetchLanes({ prs: true }).catch(fail); else window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);

  render();
  fetchLanes({ prs: false }).then(() => (prsOn() ? fetchLanes({ prs: true }) : null)).catch(fail);
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
  return { el, walk: () => walk(), markCaughtUp: () => card?.markCaughtUp(), pickSince: () => card?.pickSince(), refresh, afterAction, paneSelection, rerender: render, showAll, isAll: () => all, showConflicts, selected, location, step: runStep, reload: () => fetchLanes({ prs: true }).catch(fail) };
}
