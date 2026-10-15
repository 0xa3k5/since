import { h, icon, kbd, loading, contextMenu, tipFor, timeAgo, fullDate } from './ui.js';
import { reviewView } from './review-view.js';
import { laneKey } from './lanes.js';
import { rowBadges, reviewers as reviewersOf } from './review-rows.js';
import { loadPrReview, paneActions } from './pr-review.js';
import * as keymap from './keymap.js';

// Review's right-hand pane: the selected row's header (title, CI and review state, author, size,
// draft, last update, reviewers and their states, a link to the checks) and its actions over the
// branch review (review-view.js, per-file ticks and "changed since last look"). A row with a local branch reviews that branch; a
// PR that isn't here is fetched into FETCH_HEAD only (pr-review.js), never into a worktree.
// PR features off: rows are lanes, so nothing here touches the network.

// Fetched PR heads for this window, so moving back to a PR doesn't fetch it again. Keyed by its
// last update, so a pushed PR is fetched afresh.
const fetched = new Map();

// Reviewer states: the icon, the glyph for the narrow summary ("✓2 ✕1 ○1"), and how to say it.
const STATE = {
  changes: { icon: 'x', glyph: '✕', verb: 'requested changes', many: 'requested changes' },
  approved: { icon: 'check', glyph: '✓', verb: 'approved', many: 'approved' },
  commented: { icon: 'comment', glyph: '💬', verb: 'commented', many: 'commented' },
  pending: { icon: 'pending', glyph: '○', verb: 'review requested', many: 'haven’t reviewed yet' },
};
const SHOWN_REVIEWERS = 4;
// "2h ago", "just now", or a date for anything older than a month.
const ago = (t) => { const a = timeAgo(t); return /^\d+[mhd]$/.test(a) ? `${a} ago` : a; };
const reviewerTip = (r) => `${r.name}${r.login && r.login !== r.name ? ` (${r.login})` : ''}: ${STATE[r.state].verb}${r.at ? ` · ${fullDate(Date.parse(r.at) / 1000)}` : ''}`;

// The line under the meta: each reviewer with a state icon, "+N" past the first few. A narrow pane
// shows the counts instead (styles.css).
function reviewersLine(pr) {
  const list = reviewersOf(pr);
  if (!list.length) return null;
  const all = list.map(reviewerTip).join('\n');
  const one = (r) => h('span.review-verdict.' + r.state, { title: reviewerTip(r) }, icon(STATE[r.state].icon, 11), r.name);
  const counts = Object.keys(STATE).map((s) => [s, list.filter((r) => r.state === s).length]).filter(([, n]) => n);
  return h('div.review-pane-reviewers', null,
    h('span.review-reviewers-full', null,
      ...list.slice(0, SHOWN_REVIEWERS).map(one),
      list.length > SHOWN_REVIEWERS ? h('span.review-reviewers-more', { title: all }, `+${list.length - SHOWN_REVIEWERS}`) : null),
    h('span.review-reviewers-short', { title: all },
      ...counts.map(([s, n]) => h('span.review-verdict.' + s, { title: `${n} ${STATE[s].many}` }, `${STATE[s].glyph}${n}`))));
}

// row: a reviewRows row; ctx: { base, remote, requested, step, prsOn, agents, conflicts, onConflicts }
// (conflicts: it conflicts with its base, so the files start with what conflicts, AK-305). run(id, row, ctx) runs a
// pane action (PANE_ACTIONS); call(channel, ...args) is api.app; onBack() returns focus to the list.
export function reviewPane({ row, ctx, root, git, store, call, run, onBack }) {
  const el = h('div.review-pane');
  const head = h('div.review-pane-head');
  let view = null;
  let actions = [];
  let alive = true;
  let jump = false; // showConflicts() before the review mounted

  // Title, meta and actions run across the whole pane; the files and the diff sit below.
  // Labelled buttons for the actions you take most, icon buttons for the rest, GitHub on the right.
  // The pane is a size container (styles.css): narrower, Merge and Approve drop their labels, then
  // everything but the primary button moves into the ⋯ menu. Wider panes whose buttons still don't fit
  // (long labels, a Send back button) never clip one: GitHub goes icon-only first, then Merge and Approve.
  const ro = new ResizeObserver(() => fit());
  ro.observe(head);
  function fit() {
    const bar = head.querySelector('.review-pane-actions');
    if (!bar) return;
    bar.classList.remove('fit-github', 'fit-shrink');
    if (bar.scrollWidth > bar.clientWidth) bar.classList.add('fit-github');
    if (bar.scrollWidth > bar.clientWidth) bar.classList.add('fit-shrink');
  }

  function renderHead() {
    const { pr, lane } = row;
    const { actions: list, primary } = paneActions(row, ctx.step);
    actions = list;
    const size = pr?.size;
    const updated = pr?.updatedAt ? Date.parse(pr.updatedAt) / 1000 : 0;
    const badges = rowBadges(row, { requested: ctx.requested, agents: ctx.agents });
    const draft = badges.find((b) => b.kind === 'draft');
    const extra = [
      pr?.url ? { id: 'checks', label: 'Checks', key: 'lanes.checks', icon: 'checks' } : null,
      row.stage === 'stuck' ? { id: 'sendBack', label: 'Send back…', key: 'lanes.sendBack', icon: 'sparkle' } : null,
    ].filter(Boolean);
    const button = (a) => {
      const label = a.label.replace('…', '');
      const note = a.remote ? `${label} on GitHub: ⌘Z can’t undo it` : a.id === 'github' ? 'Opens in your browser' : a.id === 'sendBack' ? 'A ready-made prompt for whoever made it' : a.id === 'checks' ? 'Opens the failing checks' : `${label} (undoable)`;
      const onclick = () => run(a.id, row, ctx);
      const cls = (a.id === primary ? '.primary' : a.id === 'github' ? '.ghost' : '.subtle') + (a.id === primary ? '' : '.pane-secondary' + (['merge', 'approve', 'sendBack', 'github'].includes(a.id) ? '.pane-shrink' : '') + (a.id === 'github' ? '.pane-github' : ''));
      const tip = `${tipFor(a.label, a.key)}\n${note}`;
      if (a.id === 'close' || a.id === 'checks') return h('button.btn.ghost.icon-btn.pane-secondary' + (a.danger ? '.danger-hover' : ''), { 'data-tip': a.id === 'close' ? `${tipFor('Close PR…', a.key)}\n${note}` : tip, 'aria-label': a.id === 'close' ? 'Close PR…' : a.label, onclick }, icon(a.icon, 15));
      return h('button.btn' + cls, { 'data-tip': tip, 'aria-label': a.label, onclick }, icon(a.id === 'github' ? 'github' : a.icon, 14), h('span.btn-label', null, a.label), kbd(...keymap.keys(a.key)));
    };
    const main = actions.filter((a) => a.id !== 'close' && a.id !== 'github').sort((a, b) => (b.id === primary) - (a.id === primary));
    const close = actions.find((a) => a.id === 'close');
    const github = actions.find((a) => a.id === 'github');
    const send = extra.find((a) => a.id === 'sendBack');
    const icons = [...extra.filter((a) => a.id !== 'sendBack'), close].filter(Boolean);
    // ⋯: every action but the primary one, for the narrowest panes (their keys and ⌘K still work).
    const more = [...main, send, ...icons, github].filter((a) => a && a.id !== primary);
    const moreBtn = more.length ? h('button.btn.ghost.icon-btn.pane-more', {
      'data-tip': 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, more.map((a) => ({ label: a.id === 'close' ? 'Close PR…' : a.label, icon: a.id === 'github' ? 'github' : a.icon, kbd: keymap.keys(a.key), danger: a.danger, run: () => run(a.id, row, ctx) }))); },
    }, icon('more', 15)) : null;
    head.replaceChildren(...[
      h('div.review-pane-title', null,
        h('div.quick-title', { title: row.title }, pr ? h('span.review-pane-num', null, `#${pr.number}`) : icon(row.landed ? 'commit' : lane?.worktree ? 'worktree' : 'branch', 14), ' ', row.title),
        ...badges.filter((b) => b !== draft).map((b) => h('span.badge.review-badge' + (b.kind ? `.${b.kind}` : ''), { title: b.title }, b.text))),
      h('div.quick-meta.review-pane-meta', null,
        pr?.author ? h('span', { title: pr.bot ? `${pr.author} (a bot)` : pr.author }, pr.authorName || pr.author) : null,
        pr ? h('span', null, h('span.mono', null, pr.branch), h('span.review-pane-arrow', null, ' → '), h('span.mono', null, pr.base)) : row.branch ? h('span.mono', null, row.branch) : null,
        size ? h('span.stat.small', { title: `${size.files} file${size.files === 1 ? '' : 's'} changed` }, h('span.add', null, `+${size.additions}`), ' ', h('span.del', null, `−${size.deletions}`), ` · ${size.files} file${size.files === 1 ? '' : 's'}`) : null,
        draft ? h('span.badge.review-badge.draft', { title: draft.title }, draft.text) : null,
        updated ? h('span.review-pane-updated', { title: fullDate(updated) }, `Updated ${ago(updated)}`) : null),
      pr ? reviewersLine(pr) : null,
      main.length || icons.length || send || github ? h('div.review-pane-actions', null,
        ...main.map(button),
        send ? button(send) : null,
        main.length && icons.length ? h('span.review-pane-sep.pane-secondary') : null,
        ...icons.map(button),
        github || moreBtn ? h('span.spacer') : null,
        github ? button(github) : null,
        moreBtn) : null,
    ].filter(Boolean));
    fit();
  }

  const onKey = (id) => {
    const a = actions.find((x) => x.key === id);
    if (!a) return false;
    run(a.id, row, ctx);
    return true;
  };

  function mount(review) {
    view = reviewView({ ...review, root, git, store, header: head, embedded: true, onKey, onClose: onBack, checkConflicts: Boolean(ctx.conflicts), onConflicts: (files) => ctx.onConflicts?.(files) });
    el.replaceChildren(view.el);
    if (jump) view.showConflicts();
  }

  async function load() {
    const { pr, lane } = row;
    const rev = lane && !lane.isBase ? lane.branch || lane.head : null;
    if (rev) return mount({ lane: { key: laneKey(lane), name: lane.name, rev }, base: ctx.base });
    if (!pr || !ctx.prsOn) return el.replaceChildren(head, h('div.empty', null, lane?.isBase ? 'This is the base branch.' : 'Nothing to review here.'));
    el.replaceChildren(head, loading(`Fetching #${pr.number}…`));
    const id = `${JSON.stringify(ctx.remote ?? null)}#${pr.number}@${pr.updatedAt || ''}`;
    let res = fetched.get(id);
    if (!res) {
      res = await loadPrReview(pr, ctx.remote, call);
      if (!res.error) fetched.set(id, res);
    }
    if (!alive) return;
    if (res.error) return el.replaceChildren(head, h('div.empty', null, `Couldn’t fetch #${pr.number}`, h('div.muted.small', null, res.error.message)));
    mount(res.review);
  }

  renderHead();
  load();
  return {
    el,
    key: row.key,
    refresh: () => view?.refresh(),
    // The row changed under the pane (approved, CI finished): new header, same diff and ticks.
    update(r, c) { row = r; ctx = c; renderHead(); },
    destroy() { alive = false; ro.disconnect(); },
    // The row's "Conflicts in N files" note: jump to the Conflicting group.
    showConflicts() { if (view) view.showConflicts(); else jump = true; },
    focus: () => (view?.el || el).focus({ preventScroll: true }),
  };
}
