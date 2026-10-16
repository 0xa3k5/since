import { h, icon, kbd, loading, contextMenu, tipFor, timeAgo, fullDate, avatar } from './ui.js';
import { prAvatar } from './pr-avatars.js';
import { reviewView } from './review-view.js';
import { laneKey } from './lanes.js';
import { rowBadges, reviewers as reviewersOf, mergeOrder, stuckReason } from './review-rows.js';
import { loadPrReview, paneActions, fixActions, prDescription } from './pr-review.js';
import * as keymap from './keymap.js';

// Review's right-hand pane, one scroll from top to bottom (AK-379): the selected row's head (title,
// CI and review state, author, size, draft, last update, reviewers and their states), a status strip
// (Stuck and why / Ready to merge / In progress, the actions on the right, primary last), the
// description box, then the branch review (review-view.js: each file a card under a sticky header
// with its reviewed tick, path and +N −M; ticking folds it, clicking the header folds or unfolds it;
// "changed since last look"). A row with a local branch reviews that branch; a
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
// The description shows its first lines until Show more (I); that choice sticks across PRs.
let descOpen = false;
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
  let fixes = [];
  let alive = true;
  let jump = false; // showConflicts() before the review mounted

  // Title, meta, status strip and description run across the whole pane and scroll with the files.
  // Labelled buttons for the actions you take most, icon buttons for the rest, the primary one last.
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
    // Show more only when the clamped description has more to show.
    const d = head.querySelector('.review-pane-desc:not(.open)');
    const t = d?.querySelector('.review-pane-desc-text');
    if (t) d.classList.toggle('fits', t.scrollHeight <= t.clientHeight + 1);
  }

  // The PR's description in its own box under the status strip: a "Description" label with Show
  // more on the right, then plain text, a few lines until Show more. Nothing when GitHub didn't send
  // one; "No description" when the author left it empty.
  function descriptionEl(pr) {
    const text = prDescription(pr);
    if (text == null) return null;
    const label = h('span.review-pane-desc-label', null, 'Description');
    if (!text) return h('div.review-pane-desc.none', null, h('div.review-pane-desc-head', null, label), h('div.review-pane-desc-text', null, 'No description'));
    return h('div.review-pane-desc' + (descOpen ? '.open' : ''), null,
      h('div.review-pane-desc-head', null, label,
        h('button.review-reason-link.review-pane-desc-more', { 'aria-expanded': String(descOpen), 'data-tip': tipFor(descOpen ? 'Show less' : 'Show more', 'review.description'), onclick: toggleDescription }, descOpen ? 'Show less' : 'Show more')),
      h('div.review-pane-desc-text', null, text));
  }

  function toggleDescription() {
    if (!prDescription(row.pr)) return false;
    descOpen = !descOpen;
    renderHead();
    return true;
  }

  function renderHead() {
    const { pr, lane } = row;
    const { actions: list, primary: paneP } = paneActions(row, ctx.step);
    actions = list;
    const size = pr?.size;
    const updated = pr?.updatedAt ? Date.parse(pr.updatedAt) / 1000 : 0;
    const badges = rowBadges(row, { requested: ctx.requested, agents: ctx.agents });
    const draft = badges.find((b) => b.kind === 'draft');
    // A stuck row's fixes lead its strip, so the actions don't repeat them.
    fixes = fixActions(row, ctx);
    const fixing = new Set(fixes.map((a) => a.id));
    const primary = ctx.step === 'rebase' && fixing.has('rebase') ? 'rebase' : paneP;
    const extra = [
      pr?.url && !fixing.has('checks') ? { id: 'checks', label: 'Checks', key: 'lanes.checks', icon: 'checks' } : null,
    ].filter(Boolean);
    const button = (a) => {
      const label = a.label.replace('…', '');
      const note = a.note || (a.remote ? `${label} on GitHub: ⌘Z can’t undo it` : a.id === 'github' ? 'Opens in your browser' : a.id === 'sendBack' ? 'A ready-made prompt for whoever made it' : a.id === 'checks' ? 'Opens the failing checks' : `${label} (undoable)`);
      const onclick = () => (fixing.has(a.id) ? fix(a.id) : run(a.id, row, ctx));
      const cls = (a.id === primary ? '.primary' : a.id === 'github' ? '.ghost' : '.subtle') + (a.id === primary ? '' : '.pane-secondary' + (['merge', 'approve', 'sendBack', 'github', 'rebase', 'checkout'].includes(a.id) ? '.pane-shrink' : '') + (a.id === 'github' ? '.pane-github' : ''));
      const tip = `${tipFor(a.label, a.key)}\n${note}`;
      if (a.id === 'close' || (a.id === 'checks' && !fixing.has('checks'))) return h('button.btn.ghost.icon-btn.pane-secondary' + (a.danger ? '.danger-hover' : ''), { 'data-tip': a.id === 'close' ? `${tipFor('Close PR…', a.key)}\n${note}` : tip, 'aria-label': a.id === 'close' ? 'Close PR…' : a.label, onclick }, icon(a.icon, 15));
      return h('button.btn' + cls, { 'data-tip': tip, 'aria-label': a.label, onclick }, icon(a.id === 'github' ? 'github' : a.icon, 14), h('span.btn-label', null, a.label), kbd(...keymap.keys(a.key)));
    };
    const main = actions.filter((a) => a.id !== 'close' && a.id !== 'github' && !fixing.has(a.id));
    const close = actions.find((a) => a.id === 'close');
    const github = actions.find((a) => a.id === 'github');
    const icons = [...extra, close].filter(Boolean);
    const lead = [...fixes, ...main].find((a) => a.id === primary) || null;
    const rest = [...fixes, ...main].filter((a) => a !== lead);
    // ⋯: every action but the primary one, for the narrowest panes (their keys and ⌘K still work).
    const more = [...rest, ...icons, github].filter(Boolean);
    const moreBtn = more.length ? h('button.btn.ghost.icon-btn.pane-more', {
      'data-tip': 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, more.map((a) => ({ label: a.id === 'close' ? 'Close PR…' : a.label, icon: a.id === 'github' ? 'github' : a.icon, kbd: keymap.keys(a.key), danger: a.danger, run: () => (fixing.has(a.id) ? fix(a.id) : run(a.id, row, ctx)) }))); },
    }, icon('more', 15)) : null;
    head.replaceChildren(...[
      h('div.review-pane-ph', null,
        h('div.review-pane-title', null,
          h('div.quick-title', { title: row.title }, pr ? h('span.review-pane-num', null, `#${pr.number}`) : icon(lane?.worktree ? 'worktree' : 'branch', 14), ' ', row.title),
          ...badges.filter((b) => b !== draft).map((b) => h('span.badge.review-badge' + (b.kind ? `.${b.kind}` : ''), { title: b.title }, b.spin ? h('span.badge-spinner', { 'aria-hidden': 'true' }) : null, b.text))),
        h('div.quick-meta.review-pane-meta', null,
          pr?.author ? h('span', { title: pr.bot ? `${pr.author} (a bot)` : pr.author }, avatar(pr.authorName || pr.author, pr.author, 16, prAvatar(pr.author)), pr.authorName || pr.author) : null,
          pr ? h('span', null, h('span.mono', null, pr.branch), h('span.review-pane-arrow', null, ' → '), h('span.mono', null, pr.base)) : row.branch ? h('span.mono', null, row.branch) : null,
          size ? h('span.stat.small', { title: `${size.files} file${size.files === 1 ? '' : 's'} changed` }, h('span.add', null, `+${size.additions}`), ' ', h('span.del', null, `−${size.deletions}`), ` · ${size.files} file${size.files === 1 ? '' : 's'}`) : null,
          draft ? h('span.badge.review-badge.draft', { title: draft.title }, draft.text) : null,
          updated ? h('span.review-pane-updated', { title: fullDate(updated) }, `Updated ${ago(updated)}`) : null),
        pr ? reviewersLine(pr) : null,
        ...(pr ? mergeOrderLines() : [])),
      statusStrip([...rest.map(button), rest.length && icons.length ? h('span.review-pane-sep.pane-secondary') : null, ...icons.map(button), github ? button(github) : null, moreBtn, lead ? button(lead) : null].filter(Boolean)),
      pr ? descriptionEl(pr) : null,
    ].filter(Boolean));
    fit();
  }

  // The status strip (AK-379): where the row stands on the left (Stuck and why, Ready to merge, In
  // progress), its actions on the right with the primary one last. Tinted red when stuck, green when ready.
  // "Stuck  conflicts with main in a.js · CI ✗ lint     [Conflicts F] [Checks O] … [Rebase onto main B]"
  function statusStrip(buttons) {
    const stage = row.stage;
    const label = stage === 'stuck' ? 'Stuck' : stage === 'ready' ? 'Ready to merge' : stage === 'inProgress' ? 'In progress' : null;
    if (!label && !buttons.length) return null;
    const why = stage === 'stuck' ? stuckReason(row, { base: ctx.base, max: 3 }) : null;
    return h('div.review-pane-status' + (stage === 'stuck' || stage === 'ready' ? `.${stage}` : ''), { role: 'group', 'aria-label': stage === 'stuck' ? 'Fix what’s stuck' : 'Actions' },
      label ? h('div.review-pane-status-why', { title: stage === 'stuck' ? stuckReason(row, { base: ctx.base, max: 20 }) || '' : '' },
        h('span.review-pane-status-label', null, icon(stage === 'stuck' ? 'warning' : stage === 'ready' ? 'check' : 'pending', 13), label),
        why ? h('span.review-pane-status-text', null, why) : null) : null,
      buttons.length ? h('div.review-pane-actions', null, ...buttons) : null);
  }

  function fix(id) {
    if (id === 'showConflicts') showConflicts();
    else run(id, row, ctx);
  }
  function showConflicts() { if (view) view.showConflicts(); else jump = true; }

  // Merge order (AK-321), one line per open PR this one overlaps: "Overlaps #87 in lanes-view.js.
  // Whichever merges second needs a rebase. Smaller first: this one (+28 −12)." #87 selects that PR.
  function mergeOrderLines() {
    return mergeOrder(row).map((o) => h('div.review-pane-order', null,
      h('span.muted', null, 'Merge order'),
      h('span', null, 'Overlaps ',
        h('button.review-reason-link', { 'data-tip': `Select #${o.number}`, onclick: () => ctx.onSelectPr?.(o.number) }, `#${o.number}`),
        o.files ? [' in ', h('span.mono', null, o.files)] : null,
        '. Whichever merges second needs a rebase.',
        o.smaller ? [' Smaller first: ', o.smaller.self ? 'this one' : `#${o.number}`, ' (', h('span.add', null, `+${o.smaller.size.additions}`), ' ', h('span.del', null, `−${o.smaller.size.deletions}`), ').'] : null)));
  }

  const onKey = (id) => {
    if (id === 'review.description') return toggleDescription();
    const f = fixes.find((x) => x.key === id);
    if (f) { fix(f.id); return true; }
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
    // I and ⌘K: Show more or less of the description. False when there's none.
    toggleDescription,
    // The row's "Conflicts in N files" note: jump to the Conflicting group.
    showConflicts,
    focus: () => (view?.el || el).focus({ preventScroll: true }),
  };
}
