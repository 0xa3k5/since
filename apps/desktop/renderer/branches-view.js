import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast, tipFor } from './ui.js';
import { ACTIONS, sortLanes, laneKey, laneTitle, keepPrs, loadGuard, conflictsByLane, withConflicts, conflictText, canRemove, actionWhy } from './lanes.js';
import { cleanupPanel } from './cleanup-view.js';
import { authorsOf } from './review-rows.js';
import { BRANCH_TABS, branchTabs, branchLine, branchDot, filterBranches, isFinished } from './branches.js';
import { branchPreview, laneBadges } from './branch-preview.js';
import { authorsStack } from './reader.js';
import * as keymap from './keymap.js';

// Branches (AK-396, ⌘5): every local branch and worktree on this Mac, one list at a time behind tabs
// (branches.js BRANCH_TABS; 1–5): Active · Agent-made · Would conflict · Idle · Finished. Finished is
// Clean up (cleanup-view.js): cards per reason in place of the list and the pane. The head
// spans the view like Review's; the list sits left, the branch preview (branch-preview.js) right.
// A row: status dot · the branch name (mono) over one quiet line: who made it, ↑ahead ↓behind,
// worktree, PR, uncommitted changes (on Would conflict: what it clashes with) · age.
// Keyboard-first: ↑/↓ move, ↵ shows it in the Map (or switches to its worktree), R reviews it, M merges
// and tidies, B rebases, O opens its checks, ⌘⌫ deletes it (⌘Z brings it back), X cleans up a finished one;
// typing filters. Local data only (no `gh`): pull requests come from Review's last load.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const TAB = new Map(BRANCH_TABS.map((t) => [t.id, t]));
const DEBOUNCE = 400;
// Branch keys → their action (lanes.js ACTIONS).
const KEYS = { 'branches.review': 'review', 'branches.merge': 'merge', 'branches.rebase': 'rebase', 'branches.checks': 'checks', 'branches.delete': 'delete', 'branches.cleanup': 'cleanup' };
const ACTION_KEYS = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [v, k]));
// The last tab, kept across visits (this window, this session).
let lastTab = 'active';

// load({ prs }) → app:lanes-list; forecast() → app:lanes-forecast; prs() → the lanes with a PR from
// Review's last load (keepPrs); markAgents() reads the setting. onOpen(lane), onReview(lane, base),
// onMerge(lane, base), onAction(id, lane, base) (rebase, delete, checks) act on a branch;
// onNewWorktree() opens New worktree…; onCount(n) gets the number of finished branches (the sidebar
// badge). paneWidth()/setPaneWidth(px) keep the pane's width, shared with Review. `tab` opens on that
// tab; `only` (a laneKey) opens Finished with just that branch ticked. `cleanup` holds Clean up's
// own props (cleanup-view.js cleanupPanel: run, runRemote, days, onProgress, onDone, onUndo).
export function branchesView({ repo = null, git = null, load, forecast = async () => null, prs = () => [], markAgents = () => true, onOpen, onReview, onMerge, onAction, canSwitch = null, onNewWorktree = null, onCount = () => {}, paneWidth = () => null, setPaneWidth = () => {}, tab: initial = null, only = null, cleanup }) {
  let lanes = [];
  let byTab = branchTabs([]);
  let shown = [];
  let selKey = null;
  let base = null;
  let loaded = false;
  let forecastOk = true;
  let conflicts = new Map();
  let timer = 0;
  let tab = TAB.has(initial) ? initial : lastTab;
  const loads = loadGuard();
  const previewFiles = new Map();

  const filter = h('input.lanes-filter', { type: 'search', placeholder: 'Filter branches…', spellcheck: false, 'aria-label': 'Filter branches' });
  const list = h('div.lanes-list', { role: 'listbox', 'aria-label': 'Branches' });
  const empty = h('div.empty');
  const count = h('span.muted.lanes-count');
  const sub = h('p.muted');
  const tabBar = h('div.review-tabs', { role: 'tablist', 'aria-label': 'Branch lists' });
  const hint = h('div.review-hints');
  const newBtn = onNewWorktree ? h('button.btn.ghost.small', { onclick: () => onNewWorktree(), 'data-tip': tipFor('New worktree…', 'repo.worktreeAdd') }, icon('plus', 14), 'New worktree…', kbd(...keymap.keys('repo.worktreeAdd'))) : null;
  const head = h('div.review-top', null,
    h('div.page-head.review-head', null,
      h('div.review-head-row', null, h('h1', null, 'Branches'), count, h('span.spacer'), newBtn),
      sub),
    tabBar);
  const left = h('div.page.flush.lanes', null,
    h('div.review-filter', null, h('div.lanes-bar', null, icon('search', 14), filter)),
    list,
    empty);
  const paneHost = h('div.review-pane-host');
  const handle = h('div.review-split-handle', { role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const panel = cleanupPanel({ ...cleanup, onBack: () => setTab('active') });
  if (only) { tab = 'finished'; panel.only(only); }
  const el = h('div.review-split.split.branches', { tabIndex: 0 }, head, left, handle, paneHost, panel.el, hint);
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

  // Who made it: the PR's author and the agent guess (review-rows.js authorsOf), when there's one.
  const authors = (l) => authorsOf({ pr: l.pr || null, agent: l.agent || null, agents: markAgents() });

  // The quiet line under the name. Would conflict: what it clashes with; Finished: why it's done.
  function line(l) {
    if (tab === 'conflict' && l.conflicts?.length) {
      const more = l.conflicts.length > 1 ? ` · and ${plural(l.conflicts.length - 1, 'other')}` : '';
      return { text: conflictText(l.conflicts[0], 2) + more, cls: '.warn', title: l.conflicts.map((c) => conflictText(c, 10)).join('\n') };
    }
    return { text: branchLine(l), cls: '' };
  }

  function row(l) {
    const key = laneKey(l);
    const active = key === selKey;
    const who = authors(l);
    const ln = line(l);
    const dot = branchDot(l);
    return h('div.list-row.lanes-row.review-row.branches-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-key': key,
      title: [laneTitle(l), l.worktree?.path, ln.title].filter(Boolean).join('\n'),
      onclick: () => select(key),
      ondblclick: () => onOpen(l),
      oncontextmenu: (e) => { e.preventDefault(); select(key); menu(e.clientX, e.clientY, l); },
    },
      h('span.review-dot' + (dot ? `.${dot}` : ''), { role: 'img', 'aria-label': { warn: 'Would conflict', red: 'CI failing', green: 'Work in progress' }[dot] || 'Branch' }),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name.branches-name', { title: l.name }, l.name), ...laneBadges(l).filter((b) => b && !b.classList.contains('lanes-conflict'))),
        h('div.list-sub.review-row-sub' + ln.cls, null,
          authorsStack(who, 14, '.review-row-authors'), who.length && ln.text ? h('span.review-row-sep', { 'aria-hidden': 'true' }, '·') : null, ln.text ? h('span.review-row-text', null, ln.text) : null)),
      l.activity ? h('span.review-row-age', { title: fullDate(l.activity / 1000) }, timeAgo(l.activity / 1000)) : h('span'));
  }

  function render() {
    byTab = branchTabs(lanes, { agents: markAgents() });
    el.classList.toggle('finished', tab === 'finished');
    const q = filter.value.trim();
    shown = filterBranches(byTab[tab], q);
    if (!shown.some((l) => laneKey(l) === selKey)) selKey = shown[0] ? laneKey(shown[0]) : null;
    const rows = [];
    if (tab === 'conflict' && !q) {
      rows.push(h('div.branches-explain', null, h('b', null, 'Would conflict'), ' lists branches that would conflict if they were merged — with ', h('span.mono', null, base || 'main'), ' or with another branch here. GitLanes checks this on your Mac with git, without merging anything.'));
    }
    rows.push(...shown.map(row));
    list.replaceChildren(...rows);
    renderHead();
    empty.textContent = !loaded ? 'Loading…' : shown.length ? '' : q ? 'Nothing matches.' : emptyText();
    empty.hidden = !empty.textContent;
    renderHints();
    syncPane();
  }

  function emptyText() {
    if (tab === 'agents' && !markAgents()) return 'Agent-made marks are off. Turn on “Mark branches that look agent-made” in ⌘K.';
    if (tab === 'conflict' && !forecastOk) return 'The conflict forecast needs git 2.38 or later.';
    return { active: 'No active branches. Branches with commits or edits in the last 3 days show here.', agents: 'No agent-made branches.', conflict: 'Nothing would conflict.', idle: 'No idle branches.', finished: 'Nothing to clean up.' }[tab];
  }

  function renderHead() {
    count.textContent = loaded ? '' : 'Loading…';
    sub.textContent = loaded ? `${plural(lanes.length, 'branch and worktree', 'branches and worktrees')} on your Mac` : 'Every branch and worktree on your Mac.';
    tabBar.replaceChildren(...BRANCH_TABS.map((t) => {
      const on = t.id === tab;
      const n = byTab[t.id].length;
      return h('button.review-tab', {
        role: 'tab', 'aria-selected': String(on), tabIndex: on ? 0 : -1, 'data-tab': t.id,
        'data-tip': tipFor(t.label, t.keyId), onclick: () => setTab(t.id),
      }, t.label, loaded ? h('span.review-tab-n' + (t.id === 'conflict' && n ? '.warn' : ''), null, String(n)) : null);
    }));
  }

  function renderHints() {
    const k = (keys, label, cls = '') => h('span.review-hint' + cls, null, kbd(...keys), label);
    const id = (x) => keymap.keys(x);
    if (tab === 'finished') {
      return hint.replaceChildren(k([...id('cleanup.prev'), ...id('cleanup.next')], 'Move'), k(id('cleanup.toggle'), 'Tick'), k(id('cleanup.expand'), 'Open'), k(id('cleanup.all'), 'Tick all safe'),
        k(id('cleanup.run'), 'Clean up'), k(['1–5'], 'Tabs'), k(keymap.keys('view.palette'), 'All commands', '.all'));
    }
    hint.replaceChildren(k([...id('branches.prev'), ...id('branches.next')], 'Move'), k(id('branches.open'), 'Show in Map'), k(id('branches.review'), 'Review'),
      k(id('branches.merge'), 'Merge and tidy'), k(id('branches.delete'), 'Delete'), k(['1–5'], 'Tabs'), k(keymap.keys('view.palette'), 'All commands', '.all'));
  }

  // The pane shows the selected branch.
  function syncPane() {
    if (tab === 'finished') return;
    const l = current();
    if (!l) { paneHost.replaceChildren(h('div.review-none.branches-pane-empty', null, loaded ? 'Select a branch to see it here.' : '')); return; }
    const key = laneKey(l);
    if (paneHost.firstChild?.dataset?.key === key && paneHost.firstChild.lane === l) return;
    paneHost.replaceChildren(branchPreview({ lane: l, key, base, git, cache: previewFiles, onRun: (a, x) => run(a, x), keys: ACTION_KEYS, remove: true }));
  }

  const current = () => shown.find((l) => laneKey(l) === selKey) || null;
  function select(key, scroll = true) {
    selKey = key;
    list.querySelectorAll('.lanes-row').forEach((r) => { const on = r.dataset.key === key; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    if (scroll) list.querySelector('.lanes-row.active')?.scrollIntoView({ block: 'nearest' });
    syncPane();
  }
  function move(d) {
    if (!shown.length) return;
    const i = shown.findIndex((l) => laneKey(l) === selKey);
    select(laneKey(shown[Math.max(0, Math.min(shown.length - 1, i + d))]));
  }
  function setTab(id) {
    if (!TAB.has(id)) return;
    tab = lastTab = id;
    if (filter.value) filter.value = '';
    render();
    el.focus({ preventScroll: true });
  }

  // Why an action doesn't apply to the lane (null when it does); the keys toast it, the menu greys it.
  const why = (id, l) => actionWhy(id, l, { base, finished: isFinished(l), canSwitch });
  const can = (id, l) => !why(id, l);
  function run(id, l) {
    if (!l) return;
    const no = why(id, l);
    if (no) return toast(`${ACTIONS[id]?.label || 'That'} doesn’t apply to ${l.name}`, { detail: no });
    if (id === 'review') onReview(l, base);
    else if (id === 'merge') onMerge(l, base);
    else if (id === 'open') onOpen(l);
    else if (id === 'cleanup') showCleanup(l);
    else onAction(id, l, base);
  }

  // Finished, with just this branch ticked (X, ⌘K, the global Clean up key on a branch).
  function showCleanup(l = null) {
    setTab('finished');
    if (l) panel.only(laneKey(l));
  }

  function menu(x, y, l) {
    contextMenu(x, y, [
      { label: l.worktree && !l.worktree.current && !l.worktree.prunable ? 'Switch to Worktree' : 'Show in Map', icon: l.worktree ? 'worktree' : 'map', kbd: keymap.keys('branches.open'), run: () => onOpen(l) },
      { label: 'Review Branch', icon: 'check', kbd: keymap.keys('branches.review'), disabled: !can('review', l), why: why('review', l), run: () => run('review', l) },
      { label: 'Merge and Tidy…', icon: 'merge', kbd: keymap.keys('branches.merge'), disabled: !can('merge', l), why: why('merge', l), run: () => run('merge', l) },
      { label: 'Rebase onto Base', icon: 'rebase', kbd: keymap.keys('branches.rebase'), disabled: !can('rebase', l), why: why('rebase', l), run: () => run('rebase', l) },
      ...(l.pr?.url ? [{ label: 'Open Checks', icon: 'external', kbd: keymap.keys('branches.checks'), run: () => run('checks', l) }] : []),
      ...(isFinished(l) ? [{ label: 'Clean Up…', icon: 'trash', kbd: keymap.keys('branches.cleanup'), run: () => run('cleanup', l) }] : []),
      '-',
      { label: l.changes ? 'Discard Branch…' : 'Delete Branch…', icon: 'trash', kbd: keymap.keys('branches.delete'), disabled: !canRemove(l, canSwitch), why: why('delete', l), run: () => run('delete', l) },
    ]);
  }

  // Keys shared by the list and the filter box; in the box, letters type instead.
  function command(e, typing) {
    const id = keymap.match('branches', e);
    if (!id || (typing && e.key.length === 1)) return false;
    if (id === 'branches.next') move(1);
    else if (id === 'branches.prev') move(-1);
    else if (id === 'branches.filter') filter.focus();
    else if (id === 'branches.clear') {
      if (!filter.value && !typing) return false;
      filter.value = '';
      render();
      el.focus({ preventScroll: true });
    } else if (id === 'branches.open') { const l = current(); if (l) onOpen(l); }
    else if (typing && id === 'branches.delete') return false; // ⌘⌫ deletes the word typed
    else if (BRANCH_TABS.some((t) => t.keyId === id)) { if (typing) return false; setTab(BRANCH_TABS.find((t) => t.keyId === id).id); }
    else if (KEYS[id]) { const l = current(); if (!l) return false; run(KEYS[id], l); }
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  el.addEventListener('keydown', (e) => {
    if (tab === 'finished') {
      if (e.target !== el && !panel.el.contains(e.target)) return;
      if (panel.keydown(e)) return;
      // Only the tab keys besides: the branch keys would act on a row the list isn't showing.
      const id = keymap.match('branches', e);
      if (BRANCH_TABS.some((t) => t.keyId === id)) command(e, false);
      return;
    }
    if (paneHost.contains(e.target) || e.target === filter || command(e, false)) return;
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

  // Local data first; the conflict forecast after it shows (git merge-tree in the main process).
  async function fetchLanes() {
    const t = loads.start(false);
    const res = await load({ prs: false });
    if (!loads.lanes(t) || (loaded && !el.isConnected)) return;
    base = res.base;
    lanes = sortLanes(withConflicts(keepPrs(res.lanes, prs()), conflicts));
    loaded = true;
    onCount(lanes.filter(isFinished).length);
    panel.update(lanes, base);
    render();
    runForecast(t);
  }
  async function runForecast(t) {
    const res = await forecast().catch(() => null);
    if (!res || !loads.lanes(t) || !el.isConnected) return;
    forecastOk = res.supported;
    conflicts = conflictsByLane(res.pairs, base, (o) => o.name || laneTitle(o));
    lanes = sortLanes(withConflicts(lanes, conflicts));
    render();
  }
  const fail = (e) => { loaded = true; panel.update(lanes, base); render(); toast('Could not load branches', { kind: 'error', detail: e.message }); };

  // Repo changes: debounced, local only; window focus recounts the other worktrees.
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.isConnected) fetchLanes().catch(fail); }, DEBOUNCE);
  }
  const onFocus = () => { if (el.isConnected) fetchLanes().catch(fail); else window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);

  render();
  fetchLanes().catch(fail);
  setTimeout(() => el.focus({ preventScroll: true }));
  // The selected branch, for ⌘K's branch commands.
  const selected = () => { if (tab === 'finished') return null; const l = current(); return l ? { lane: l, base } : null; };
  return { el, refresh, rerender: render, setTab, cleanup: showCleanup, panel, tab: () => tab, selected, run: (id) => run(id, current()), can: (id) => { const l = current(); return Boolean(l && can(id, l)); } };
}
