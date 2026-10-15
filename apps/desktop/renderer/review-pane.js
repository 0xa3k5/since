import { h, icon, kbd, loading } from './ui.js';
import { reviewView } from './review-view.js';
import { laneKey } from './lanes.js';
import { rowBadges } from './review-rows.js';
import { loadPrReview, paneActions } from './pr-review.js';
import * as keymap from './keymap.js';

// Review's right-hand pane: the selected row's header (title, CI and review state, reviewers'
// verdicts, size, a link to the checks) and its actions over the branch review (review-view.js,
// per-file ticks and "changed since last look"). A row with a local branch reviews that branch; a
// PR that isn't here is fetched into FETCH_HEAD only (pr-review.js), never into a worktree.
// PR features off: rows are lanes, so nothing here touches the network.

// Fetched PR heads for this window, so moving back to a PR doesn't fetch it again. Keyed by its
// last update, so a pushed PR is fetched afresh.
const fetched = new Map();

// row: a reviewRows row; ctx: { base, remote, requested, step, prsOn }. run(id, row, ctx) runs a
// pane action (PANE_ACTIONS); call(channel, ...args) is api.app; onBack() returns focus to the list.
export function reviewPane({ row, ctx, root, git, store, call, run, onBack }) {
  const el = h('div.review-pane');
  const head = h('div.review-pane-head');
  let view = null;
  let actions = [];
  let alive = true;

  function renderHead() {
    const { pr, lane } = row;
    const { actions: list, primary } = paneActions(row, ctx.step);
    actions = list;
    const reviewers = pr?.reviews || [];
    const size = pr?.size;
    head.replaceChildren(...[
      h('div.quick-title', { title: row.title }, icon(pr ? 'merge' : row.landed ? 'commit' : lane?.worktree ? 'worktree' : 'branch', 14), ' ', pr ? `#${pr.number} ${row.title}` : row.title),
      h('div.quick-meta.review-pane-meta', null,
        ...rowBadges(row, { requested: ctx.requested }).map((b) => h('span.badge.review-badge' + (b.kind ? `.${b.kind}` : ''), { title: b.title }, b.text)),
        pr ? h('span', null, [pr.author ? `by ${pr.author}` : null, `${pr.branch} → ${pr.base}`].filter(Boolean).join(' · ')) : row.branch ? h('span', null, row.branch) : null,
        size ? h('span.stat.small', { title: `${size.files} file${size.files === 1 ? '' : 's'} changed` }, h('span.add', null, `+${size.additions}`), h('span.del', null, `−${size.deletions}`), ` · ${size.files} file${size.files === 1 ? '' : 's'}`) : null,
        pr?.url ? h('button.btn.ghost.small.review-pane-checks', { title: `Open the checks on GitHub (${keymap.keys('lanes.checks').join(' or ').toUpperCase()} in the list)`, onclick: () => run('checks', row, ctx) }, icon('external', 12), 'Checks') : null),
      reviewers.length ? h('div.quick-meta.review-pane-reviewers', null, ...reviewers.map((r) => h('span.review-verdict.' + r.state, { title: r.state === 'approved' ? `${r.login} approved` : `${r.login} requested changes` }, r.state === 'approved' ? icon('check', 11) : icon('x', 11), r.login))) : null,
      h('div.review-tools.review-pr-actions', null, ...actions.map((a) => h((a.id === primary ? 'button.btn.primary.small' : 'button.chip') + (a.danger ? '.danger' : ''), {
        title: a.remote ? `${a.label.replace('…', '')} on GitHub: ⌘Z can’t undo it` : a.id === 'github' ? 'Opens in your browser' : `${a.label.replace('…', '')} (undoable)`,
        onclick: () => run(a.id, row, ctx),
      }, icon(a.icon, 12), a.label, kbd(...keymap.keys(a.key))))),
    ].filter(Boolean));
  }

  const onKey = (id) => {
    const a = actions.find((x) => x.key === id);
    if (!a) return false;
    run(a.id, row, ctx);
    return true;
  };

  function mount(review) {
    view = reviewView({ ...review, root, git, store, header: head, embedded: true, onKey, onClose: onBack });
    el.replaceChildren(view.el);
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
    destroy() { alive = false; },
    focus: () => (view?.el || el).focus({ preventScroll: true }),
  };
}
