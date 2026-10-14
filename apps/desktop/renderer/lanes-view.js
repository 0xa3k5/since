import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast } from './ui.js';
import { BUCKETS, sortLanes, filterLanes, laneKey, aheadBehind, keepPrs } from './lanes.js';
import { inboxBuckets } from './prs.js';
import * as keymap from './keymap.js';

// Lanes overview: every branch and worktree in the repository as one triage list, the lanes that
// need you first (lanes.js has the order). Keyboard-first: ↑/↓ or J/K move, ↵ opens the lane,
// typing filters, A shows agent lanes only. Refreshes in place, keeping the selection.
// While pull requests are on, Tab switches to the Inbox: the open PRs you can act on, in buckets
// (prs.js inboxBuckets). ↵ checks a PR out as a new lane, ⇧M merges the whole Ready bucket.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
const BUCKET = new Map(BUCKETS.map((b) => [b.id, b]));
// Live refreshes after commits are debounced; the watcher can fire several times per commit.
const DEBOUNCE = 400;

// load({ prs }) → app:lanes-list result; prsOn() and markAgents() read current settings;
// onOpen(lane) opens it in the graph. actions(lane) → extra context-menu items, the hook for
// later row actions (review, merge, delete); none yet. onCheckout(pr) and onMergeReady(prs, remote)
// are the Inbox's actions; `tab` picks the tab to start on.
export function lanesView({ load, prsOn, markAgents, onOpen, onCheckout = () => {}, onMergeReady = () => {}, actions = () => [], tab = 'lanes' }) {
  let lanes = [];
  let inbox = null; // { prs, remote, me, requested } from the last inbox load
  let inboxFailed = false;
  let shown = [];
  let selKey = null;
  let agentsOnly = false;
  let loaded = false;
  let base = null;
  let timer = 0;
  let seq = 0;

  const filter = h('input.lanes-filter', { type: 'search', placeholder: 'Filter lanes…', spellcheck: false, 'aria-label': 'Filter lanes' });
  const agentChip = h('button.chip', { title: 'Agent lanes only (A)', onclick: () => toggleAgents() }, 'Agent lanes');
  const count = h('span.muted.lanes-count');
  const list = h('div.lanes-list', { role: 'listbox', 'aria-label': 'Lanes' });
  const empty = h('div.empty');
  const title = h('h1');
  const lede = h('p.muted');
  const hint = h('div.diff-hint.wt-hint');
  const tabBtn = (id, label) => h('button.lanes-tab', { role: 'tab', 'data-tab': id, onclick: () => setTab(id) }, label);
  const tabs = h('div.lanes-tabs', { role: 'tablist', 'aria-label': 'Lanes overview' }, tabBtn('lanes', 'Lanes'), tabBtn('inbox', 'Inbox'));
  const el = h('div.page.flush.lanes', { tabIndex: 0 },
    h('div.page-head', null,
      h('div', null, title, lede),
      h('div.page-actions', null, count)),
    tabs,
    h('div.lanes-bar', null, icon('search', 14), filter, agentChip),
    list,
    empty,
    hint,
  );

  function badges(l) {
    return [
      l.agent && markAgents() ? h('span.badge.agent', { title: `Looks agent-made (${l.agent.reason}: ${l.agent.match})` }, 'Agent') : null,
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
        h('div.list-sub', null, l.worktree ? tildify(l.worktree.path) : l.upstream || (l.detached ? 'Detached HEAD' : 'Local branch'))),
      h('span.lanes-changes' + (l.changes ? '.dirty' : ''), { title: l.changes == null ? '' : 'Uncommitted changes in its worktree' }, l.changes ? `${l.changes} changed` : ''),
      h('span.lanes-ab', { title: base && ab ? `Ahead/behind ${base}` : '' }, ab),
      prsOn() ? prCell(l.pr) : null,
      h('span.lanes-time', { title: l.activity ? fullDate(l.activity / 1000) : '' }, l.activity ? timeAgo(l.activity / 1000) : ''),
    );
  }

  function render() {
    if (tab === 'inbox' && !prsOn()) tab = 'lanes';
    tabs.hidden = !prsOn();
    tabs.querySelectorAll('.lanes-tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    agentChip.hidden = tab === 'inbox';
    filter.placeholder = tab === 'inbox' ? 'Filter pull requests…' : 'Filter lanes…';
    if (tab === 'inbox') return renderInbox();
    title.textContent = 'Lanes';
    lede.textContent = 'Every branch and worktree in this repository. Lanes that need you come first.';
    hint.textContent = `↵ Open · J/K Move · / Filter · A Agent lanes only${prsOn() ? ' · Tab Inbox' : ''}`;
    if (agentsOnly && !markAgents()) agentsOnly = false;
    shown = filterLanes(lanes, filter.value, { agentsOnly });
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
    const needs = lanes.filter((l) => BUCKET.get(l.bucket).needs).length;
    count.textContent = loaded ? `${lanes.length} lane${lanes.length === 1 ? '' : 's'}${needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : ''}` : 'Loading…';
    empty.textContent = !loaded || shown.length ? '' : lanes.length ? 'No lanes match.' : 'No branches yet.';
    empty.hidden = !empty.textContent;
  }

  // The Inbox: PR rows keyed `p:<number>`, grouped by bucket, then by author.
  const prKey = (pr) => `p:${pr.number}`;
  const agentPrs = () => (markAgents() ? lanes.filter((l) => l.agent && l.pr).map((l) => l.pr.number) : []);
  const buckets = () => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const prs = (inbox?.prs || []).filter((p) => words.every((w) => `#${p.number} ${p.title} ${p.branch} ${p.author}`.toLowerCase().includes(w)));
    return inboxBuckets(prs, { me: inbox?.me, requested: inbox?.requested, agents: agentPrs() });
  };
  const ready = () => (inbox ? inboxBuckets(inbox.prs, { me: inbox.me, requested: inbox.requested, agents: agentPrs() }).find((b) => b.id === 'ready')?.groups.flatMap((g) => g.prs) || [] : []);

  function prRow(pr) {
    const active = prKey(pr) === selKey;
    return h('div.list-row.lanes-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-key': prKey(pr),
      onclick: () => select(prKey(pr)),
      ondblclick: () => onCheckout(pr),
      oncontextmenu: (e) => { e.preventDefault(); select(prKey(pr)); prMenu(e.clientX, e.clientY, pr); },
    },
      icon('merge', 14),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name', null, pr.title || pr.branch), pr.mergeable === false ? h('span.badge.warn', { title: 'GitHub says it conflicts with its base branch' }, 'Conflicts') : null),
        h('div.list-sub', null, `${pr.branch} → ${pr.base}`)),
      prCell(pr),
      h('span.lanes-time', { title: pr.updatedAt ? fullDate(Date.parse(pr.updatedAt) / 1000) : '' }, pr.updatedAt ? timeAgo(Date.parse(pr.updatedAt) / 1000) : ''),
    );
  }

  function renderInbox() {
    title.textContent = 'Inbox';
    lede.textContent = 'Open pull requests you can act on: ready to merge, waiting for your review, failing, and yours.';
    const bs = buckets();
    const order = bs.flatMap((b) => b.groups.flatMap((g) => g.prs));
    shown = order;
    if (!order.some((p) => prKey(p) === selKey)) selKey = order[0] ? prKey(order[0]) : null;
    const rows = [];
    for (const b of bs) {
      rows.push(h('div.lanes-group.needs', { role: 'presentation' }, `${b.label} · ${b.count}`));
      for (const g of b.groups) {
        rows.push(h('div.lanes-author', { role: 'presentation' }, g.author, g.agent && markAgents() ? h('span.badge.agent', { title: 'Its lanes look agent-made' }, 'Agent') : null, h('span.muted', null, g.prs.length > 1 ? `${g.prs.length} pull requests` : '')));
        for (const pr of g.prs) rows.push(prRow(pr));
      }
    }
    list.replaceChildren(...rows);
    const n = ready().length;
    count.textContent = !inbox ? (inboxFailed ? '' : 'Loading…') : `${order.length} pull request${order.length === 1 ? '' : 's'}${n ? ` · ${n} ready` : ''}`;
    hint.textContent = `↵ Check out as a lane · J/K Move · / Filter${n ? ' · ⇧M Merge all ready' : ''} · Tab Lanes`;
    empty.textContent = !inbox ? (inboxFailed ? 'Couldn’t load pull requests.' : 'Loading pull requests…') : order.length ? '' : inbox.prs.length ? 'Nothing here needs you.' : 'No open pull requests.';
    empty.hidden = !empty.textContent;
  }

  function prMenu(x, y, pr) {
    contextMenu(x, y, [
      { label: 'Check Out in New Worktree…', icon: 'worktree', kbd: keymap.keys('lanes.open'), run: () => onCheckout(pr) },
      ...(ready().some((p) => p.number === pr.number) ? [{ label: 'Merge All Ready…', icon: 'merge', kbd: keymap.keys('lanes.mergeReady'), run: mergeReady }] : []),
    ]);
  }

  function mergeReady() {
    const prs = ready();
    if (!prs.length) return toast('Nothing is ready to merge', { detail: 'Ready means approved, checks passed and no conflicts.' });
    onMergeReady(prs, inbox.remote);
  }

  function setTab(t) {
    if (t === tab || (t === 'inbox' && !prsOn())) return;
    tab = t;
    selKey = null;
    render();
    if (tab === 'inbox' && !inbox) fetchLanes({ prs: true }).catch(fail);
    el.focus({ preventScroll: true });
  }

  function select(key, scroll = true) {
    selKey = key;
    list.querySelectorAll('.lanes-row').forEach((r) => { const on = r.dataset.key === key; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    if (scroll) list.querySelector('.lanes-row.active')?.scrollIntoView({ block: 'nearest' });
  }
  function move(d) {
    if (!shown.length) return;
    const i = shown.findIndex((x) => keyOf(x) === selKey);
    select(keyOf(shown[Math.max(0, Math.min(shown.length - 1, i + d))]));
  }
  const keyOf = (x) => (tab === 'inbox' ? prKey(x) : laneKey(x));
  const current = () => shown.find((x) => keyOf(x) === selKey);

  function toggleAgents() {
    if (!agentsOnly && !markAgents()) return toast('Agent lanes are hidden', { detail: 'Turn on “Mark lanes that look agent-made” in Choose defaults (⌘⇧,).' });
    agentsOnly = !agentsOnly;
    render();
  }

  function menu(x, y, l) {
    const extra = actions(l);
    contextMenu(x, y, [
      { label: l.worktree && !l.worktree.current && !l.worktree.prunable ? 'Switch to Worktree' : 'Show in Map', icon: l.worktree ? 'worktree' : 'map', kbd: keymap.keys('lanes.open'), run: () => onOpen(l) },
      ...(extra.length ? ['-', ...extra] : []),
    ]);
  }

  // Commands shared by the list and the filter box. In the box, letters type instead.
  function command(e, typing) {
    const id = keymap.match('lanes', e);
    if (!id || (typing && e.key.length === 1)) return false;
    if (id === 'lanes.next') move(1);
    else if (id === 'lanes.prev') move(-1);
    else if (id === 'lanes.open') { const x = current(); if (x) (tab === 'inbox' ? onCheckout : onOpen)(x); }
    else if (id === 'lanes.tab') { if (!prsOn()) return false; setTab(tab === 'inbox' ? 'lanes' : 'inbox'); }
    else if (id === 'lanes.mergeReady') { if (tab !== 'inbox' || typing) return false; mergeReady(); }
    else if (id === 'lanes.agents' && tab !== 'inbox') toggleAgents();
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
    const withInbox = prs && prsOn() && tab === 'inbox';
    const res = await load({ prs: prs && prsOn(), ...(withInbox ? { inbox: true } : {}) });
    if (n !== seq || (loaded && !el.isConnected)) return;
    base = res.base;
    if (withInbox) {
      inboxFailed = !res.prs || !res.inbox;
      if (!inboxFailed) inbox = { prs: res.prs, remote: res.remote, ...res.inbox };
    }
    const next = prsOn() ? (prs ? res.lanes : keepPrs(res.lanes, lanes)) : res.lanes;
    lanes = sortLanes(next);
    loaded = true;
    if (res.prError) toast('Could not load pull requests', { kind: 'error', detail: res.prError.message });
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
  // Show a tab from outside (⌘⇧I opens the overview on the Inbox).
  const show = (t) => setTab(t);
  return { el, refresh, rerender: render, show, reload: () => fetchLanes({ prs: true }).catch(fail) };
}
