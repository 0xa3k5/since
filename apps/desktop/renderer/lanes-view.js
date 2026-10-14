import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast } from './ui.js';
import { BUCKETS, sortLanes, filterLanes, laneKey, aheadBehind, keepPrs, conflictsByLane, withConflicts, conflictText } from './lanes.js';
import * as keymap from './keymap.js';

// Lanes overview: every branch and worktree in the repository as one triage list, the lanes that
// need you first (lanes.js has the order). Keyboard-first: ↑/↓ or J/K move, ↵ opens the lane,
// typing filters, A shows agent lanes only, C lanes with predicted conflicts only. Refreshes in
// place, keeping the selection. The conflict forecast runs after the list shows (git merge-tree,
// main process) and re-sorts the list when it lands.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
const BUCKET = new Map(BUCKETS.map((b) => [b.id, b]));
// Live refreshes after commits are debounced; the watcher can fire several times per commit.
const DEBOUNCE = 400;

// load({ prs }) → app:lanes-list result; forecast() → app:lanes-forecast result; prsOn() and markAgents() read current settings;
// onOpen(lane) opens it in the graph, onReview(lane, base) opens its branch review and
// progress(lane) → its review progress (review.js) or null. actions(lane) → extra context-menu items, the hook for
// later row actions (review, merge, delete); none yet.
export function lanesView({ load, forecast = async () => null, prsOn, markAgents, onOpen, onReview = () => {}, progress = () => null, actions = () => [] }) {
  let lanes = [];
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

  const filter = h('input.lanes-filter', { type: 'search', placeholder: 'Filter lanes…', spellcheck: false, 'aria-label': 'Filter lanes' });
  const agentChip = h('button.chip', { title: 'Agent lanes only (A)', onclick: () => toggleAgents() }, 'Agent lanes');
  const conflictChip = h('button.chip', { title: 'Lanes with predicted conflicts only (C)', onclick: () => toggleConflicts() }, 'Conflicts');
  const count = h('span.muted.lanes-count');
  const list = h('div.lanes-list', { role: 'listbox', 'aria-label': 'Lanes' });
  const empty = h('div.empty');
  const el = h('div.page.flush.lanes', { tabIndex: 0 },
    h('div.page-head', null,
      h('div', null, h('h1', null, 'Lanes'), h('p.muted', null, 'Every branch and worktree in this repository. Lanes that need you come first.')),
      h('div.page-actions', null, count)),
    h('div.lanes-bar', null, icon('search', 14), filter, agentChip, conflictChip),
    list,
    empty,
    h('div.diff-hint.wt-hint', null, '↵ Open · R Review · J/K Move · / Filter · A Agent lanes only · C Conflicts only'),
  );

  function badges(l) {
    return [
      l.agent && markAgents() ? h('span.badge.agent', { title: `Looks agent-made (${l.agent.reason}: ${l.agent.match})` }, 'Agent') : null,
      l.conflicts ? h('span.badge.warn.lanes-conflict', { title: l.conflicts.map((c) => conflictText(c, 10)).join('\n') }, icon('warning', 11), 'Conflicts') : null,
      l.isBase ? h('span.badge', null, 'Base') : null,
      l.worktree?.current ? h('span.badge.local', null, 'This window') : null,
      l.merged ? h('span.badge', { title: l.merged === 'squash' ? 'Its changes are already on the base branch' : 'Already part of the base branch' }, 'Merged') : null,
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

  function row(l) {
    const active = laneKey(l) === selKey;
    const ab = aheadBehind(l);
    return h('div.list-row.lanes-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-key': laneKey(l),
      onclick: () => select(laneKey(l)),
      ondblclick: () => onOpen(l),
      oncontextmenu: (e) => { e.preventDefault(); select(laneKey(l)); menu(e.clientX, e.clientY, l); },
    },
      icon(l.worktree ? 'worktree' : 'branch', 14),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name', null, l.name), ...badges(l)),
        h('div.list-sub', null, l.worktree ? tildify(l.worktree.path) : l.upstream || (l.detached ? 'Detached HEAD' : 'Local branch')),
        // The selected lane spells out who it conflicts with and where (CSS shows it on .active).
        l.conflicts ? h('div.lanes-conflicts', null, ...l.conflicts.map((c) => h('div', { title: c.files.join('\n') }, conflictText(c)))) : null),
      reviewCell(l),
      h('span.lanes-changes' + (l.changes ? '.dirty' : ''), { title: l.changes == null ? '' : 'Uncommitted changes in its worktree' }, l.changes ? `${l.changes} changed` : ''),
      h('span.lanes-ab', { title: base && ab ? `Ahead/behind ${base}` : '' }, ab),
      prsOn() ? prCell(l.pr) : null,
      h('span.lanes-time', { title: l.activity ? fullDate(l.activity / 1000) : '' }, l.activity ? timeAgo(l.activity / 1000) : ''),
    );
  }

  function render() {
    if (agentsOnly && !markAgents()) agentsOnly = false;
    shown = filterLanes(lanes, filter.value, { agentsOnly, conflictsOnly });
    if (!shown.some((l) => laneKey(l) === selKey)) selKey = shown[0] ? laneKey(shown[0]) : null;
    const rows = [];
    let bucket = null;
    for (const l of shown) {
      if (l.bucket !== bucket) {
        bucket = l.bucket;
        const b = BUCKET.get(bucket);
        rows.push(h('div.lanes-group' + (b.needs ? '.needs' : ''), { role: 'presentation' }, b.label));
      }
      rows.push(row(l));
    }
    list.replaceChildren(...rows);
    agentChip.classList.toggle('on', agentsOnly);
    conflictChip.classList.toggle('on', conflictsOnly);
    conflictChip.hidden = !forecastOk;
    const needs = lanes.filter((l) => BUCKET.get(l.bucket).needs).length;
    count.textContent = loaded ? `${lanes.length} lane${lanes.length === 1 ? '' : 's'}${needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : ''}` : 'Loading…';
    empty.textContent = !loaded || shown.length ? '' : conflictsOnly && !filter.value ? 'No predicted conflicts between active lanes.' : lanes.length ? 'No lanes match.' : 'No branches yet.';
    empty.hidden = !empty.textContent;
  }

  function select(key, scroll = true) {
    selKey = key;
    list.querySelectorAll('.lanes-row').forEach((r) => { const on = r.dataset.key === key; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    if (scroll) list.querySelector('.lanes-row.active')?.scrollIntoView({ block: 'nearest' });
  }
  function move(d) {
    if (!shown.length) return;
    const i = shown.findIndex((l) => laneKey(l) === selKey);
    select(laneKey(shown[Math.max(0, Math.min(shown.length - 1, i + d))]));
  }
  const current = () => shown.find((l) => laneKey(l) === selKey);

  function toggleAgents() {
    if (!agentsOnly && !markAgents()) return toast('Agent lanes are hidden', { detail: 'Turn on “Mark lanes that look agent-made” in Choose defaults (⌘⇧,).' });
    agentsOnly = !agentsOnly;
    render();
  }

  function toggleConflicts() {
    if (!forecastOk) return toast('Conflict forecast needs git 2.38 or later', { detail: 'Update git to see which lanes would conflict before you merge.' });
    conflictsOnly = !conflictsOnly;
    render();
  }

  function menu(x, y, l) {
    const extra = actions(l);
    contextMenu(x, y, [
      { label: l.worktree && !l.worktree.current && !l.worktree.prunable ? 'Switch to Worktree' : 'Show in Map', icon: l.worktree ? 'worktree' : 'map', kbd: keymap.keys('lanes.open'), run: () => onOpen(l) },
      { label: 'Review Branch', icon: 'check', kbd: keymap.keys('lanes.review'), run: () => onReview(l, base) },
      ...(extra.length ? ['-', ...extra] : []),
    ]);
  }

  // Commands shared by the list and the filter box. In the box, letters type instead.
  function command(e, typing) {
    const id = keymap.match('lanes', e);
    if (!id || (typing && e.key.length === 1)) return false;
    if (id === 'lanes.next') move(1);
    else if (id === 'lanes.prev') move(-1);
    else if (id === 'lanes.open') { const l = current(); if (l) onOpen(l); }
    else if (id === 'lanes.agents') toggleAgents();
    else if (id === 'lanes.review') { const l = current(); if (l) onReview(l, base); }
    else if (id === 'lanes.conflicts') toggleConflicts();
    else if (id === 'lanes.filter') filter.focus();
    else if (id === 'lanes.clear') {
      if (!filter.value && !typing) return false; // let Escape through
      filter.value = '';
      render();
      el.focus({ preventScroll: true });
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  el.addEventListener('keydown', (e) => {
    if (e.target === filter || command(e, false)) return;
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
  filter.addEventListener('input', render);

  // Local data first, so the list shows at once; PRs (one `gh pr list`) only when asked and on.
  async function fetchLanes({ prs }) {
    const n = ++seq;
    const res = await load({ prs: prs && prsOn() });
    if (n !== seq || (loaded && !el.isConnected)) return;
    base = res.base;
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
    conflicts = conflictsByLane(res.pairs, base);
    if (!forecastOk) conflictsOnly = false;
    lanes = sortLanes(withConflicts(lanes, conflicts));
    render();
  }
  const fail = (e) => { loaded = true; render(); toast('Could not load lanes', { kind: 'error', detail: e.message }); };

  // Called on every repo change: debounced, local only (no network), keeps the selection.
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.isConnected) fetchLanes({ prs: false }).catch(fail); }, DEBOUNCE);
  }
  // Other worktrees' files aren't watched: recount (and re-read PRs) when the window comes back.
  const onFocus = () => { if (el.isConnected) fetchLanes({ prs: true }).catch(fail); else window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);

  render();
  fetchLanes({ prs: false }).then(() => (prsOn() ? fetchLanes({ prs: true }) : null)).catch(fail);
  setTimeout(() => el.focus({ preventScroll: true }));
  // ⌘K "Show lanes with predicted conflicts": turn the filter on (never off).
  const showConflicts = () => { if (!conflictsOnly) toggleConflicts(); };
  return { el, refresh, rerender: render, showConflicts };
}
