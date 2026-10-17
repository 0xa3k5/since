import { h, icon, kbd, loading, contextMenu, tipFor, timeAgo, fullDate } from './ui.js';
import { reviewView } from './review-view.js';
import { laneKey } from './lanes.js';
import { rowBadges, rowAuthors, reviewers as reviewersOf, mergeOrder, stuckReason } from './review-rows.js';
import { loadPrReview, paneActions, fixActions, prDescription } from './pr-review.js';
import { readerHead, descriptionBlock, miniHeader, miniContent, readerKey } from './reader.js';
import * as keymap from './keymap.js';

// Review's right-hand pane, one scroll from top to bottom (AK-379), built from the reader shared with
// Catch up (reader.js, AK-381): the selected row's head (‹ N of M ›, #number and title, CI and review
// state, who made it (AK-390: the author, + the agent, or the bot alone), branch → base, size, draft, last update, reviewers and their states), a
// status strip (Stuck and why / Ready to merge / In progress, the actions on the right, primary
// last), the description (… Show more where it's cut), then the branch review (review-view.js: each
// file a reader.js card under a sticky header; "changed since last look"). A slim bar with the
// avatars, number, title and primary action fades in at the top once the head scrolls away.
// Keys once focus is in the pane (↵ from the list): ↑/↓ scroll (⇧ for four times as far), Page Up/Down and Space by a page,
// ←/→ the previous or next row (ctx.nav), , and . the files, Esc back to the list. A row with a local branch reviews that branch; a
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

// row: a reviewRows row; ctx: { base, remote, requested, step, prsOn, agents, conflicts, onConflicts, nav }
// (nav: { at, of, onStep(±1) } for ‹ N of M › and ←/→)
// (conflicts: it conflicts with its base, so the files start with what conflicts, AK-305). run(id, row, ctx) runs a
// pane action (PANE_ACTIONS); call(channel, ...args) is api.app; onBack() returns focus to the list.
export function reviewPane({ row, ctx, root, git, store, call, run, onBack }) {
  const el = h('div.review-pane', { tabIndex: -1 });
  const head = h('div.review-pane-head');
  let mini = miniHeader(el);
  let wantFocus = false; // focus() before the review mounted
  let view = null;
  let actions = [];
  let fixes = [];
  let alive = true;
  let jump = false; // showConflicts() before the review mounted

  // Title, meta, status strip and description run across the whole pane and scroll with the files.
  // Labelled buttons for the actions you take most, icon buttons for the rest, the primary one last.
  // The pane is a size container (styles.css): narrower, Merge and Approve drop their labels, then
  // everything but the primary button moves into the ⋯ menu. Wider panes whose buttons still don't fit
  // (long labels, a Fix prompt button) never clip one: GitHub goes icon-only first, then Merge and Approve.
  const ro = new ResizeObserver(() => fit());
  ro.observe(head);
  function fit() {
    const bar = head.querySelector('.review-pane-actions');
    if (!bar) return;
    bar.classList.remove('fit-github', 'fit-shrink');
    if (bar.scrollWidth > bar.clientWidth) bar.classList.add('fit-github');
    if (bar.scrollWidth > bar.clientWidth) bar.classList.add('fit-shrink');
    // Still too wide: everything but the primary button goes into ⋯, so nothing runs off the edge.
    const strip = bar.parentElement;
    strip.classList.remove('fit-more');
    if (bar.scrollWidth > bar.clientWidth) strip.classList.add('fit-more');
  }

  function renderHead() {
    const { pr, lane } = row;
    const { actions: list, primary: paneP } = paneActions(row, ctx.step);
    actions = list;
    const size = pr?.size;
    const updated = pr?.updatedAt ? Date.parse(pr.updatedAt) / 1000 : 0;
    const badges = rowBadges(row, { requested: ctx.requested });
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
      const note = a.note || (a.remote ? `${label} on GitHub: ⌘Z can’t undo it` : a.id === 'github' ? 'Opens in your browser' : a.id === 'sendBack' ? 'A ready-made prompt to fix it, for you or an agent' : a.id === 'checks' ? 'Opens the failing checks' : `${label} (undoable)`);
      const onclick = () => (fixing.has(a.id) ? fix(a.id) : run(a.id, row, ctx));
      const cls = (a.id === primary ? '.primary' : a.id === 'github' ? '.ghost' : '.subtle') + (a.id === primary ? '' : '.pane-secondary' + (['merge', 'approve', 'sendBack', 'github', 'rebase', 'checkout', 'updateBranch'].includes(a.id) ? '.pane-shrink' : '') + (a.id === 'github' ? '.pane-github' : ''));
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
    // Who made it (AK-390): the person, + the agent when its lane looks agent-made, or the bot alone.
    const authors = rowAuthors(row, { agents: ctx.agents });
    const num = pr ? `#${pr.number}` : icon(lane?.worktree ? 'worktree' : 'branch', 14);
    const top = readerHead({
      num, title: row.title, nav: ctx.nav || null,
      badges: badges.filter((b) => b !== draft).map((b) => h('span.badge.review-badge' + (b.kind ? `.${b.kind}` : ''), { title: b.title }, b.spin ? h('span.badge-spinner', { 'aria-hidden': 'true' }) : null, b.text)),
      authors,
      branch: pr ? pr.branch : row.branch || null, base: pr ? pr.base : null,
      meta: [
        size ? h('span.stat.small', { title: `${size.files} file${size.files === 1 ? '' : 's'} changed` }, h('span.add', null, `+${size.additions}`), ' ', h('span.del', null, `−${size.deletions}`), ` · ${size.files} file${size.files === 1 ? '' : 's'}`) : null,
        draft ? h('span.badge.review-badge.draft', { title: draft.title }, draft.text) : null,
        updated ? h('span.review-pane-updated', { title: fullDate(updated) }, `Updated ${ago(updated)}`) : null,
      ].filter(Boolean),
      below: [pr ? reviewersLine(pr) : null, ...(pr ? mergeOrderLines() : [])].filter(Boolean),
    });
    head.replaceChildren(...[
      top,
      statusStrip([...rest.map(button), rest.length && icons.length ? h('span.review-pane-sep.pane-secondary') : null, ...icons.map(button), github ? button(github) : null, moreBtn, lead ? button(lead) : null].filter(Boolean)),
      pr ? descriptionBlock({ text: prDescription(pr) }) : null,
    ].filter(Boolean));
    // The slim bar once the head scrolls away: avatar, number, title and the primary action.
    mini.set(miniContent({ authors, num: pr ? `#${pr.number}` : null, title: row.title, action: lead ? { label: lead.label.replace('…', ''), icon: lead.icon, run: () => (fixing.has(lead.id) ? fix(lead.id) : run(lead.id, row, ctx)) } : null }));
    mini.watch(top);
    fit();
  }

  // The status strip (AK-379): where the row stands on the left (Stuck and why, Ready to merge, In
  // progress) as a red or green pill, its actions on the right with the primary one last, one row (AK-502).
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
    const f = fixes.find((x) => x.key === id);
    if (f) { fix(f.id); return true; }
    const a = actions.find((x) => x.key === id);
    if (!a) return false;
    run(a.id, row, ctx);
    return true;
  };

  function mount(review) {
    view = reviewView({ ...review, root, git, store, header: head, embedded: true, onKey, onClose: onBack, checkConflicts: Boolean(ctx.conflicts), onConflicts: (files) => ctx.onConflicts?.(files) });
    const had = wantFocus || el.contains(document.activeElement);
    // The view is the reader's scroll: the slim bar moves into it.
    mini.destroy();
    mini = miniHeader(view.el);
    view.el.prepend(mini.el);
    el.replaceChildren(view.el);
    renderHead();
    if (had) { wantFocus = false; view.el.focus({ preventScroll: true }); }
    if (jump) view.showConflicts();
  }

  async function load() {
    const { pr, lane } = row;
    const rev = lane && !lane.isBase ? lane.branch || lane.head : null;
    if (rev) return mount({ lane: { key: laneKey(lane), name: lane.name, rev }, base: ctx.base });
    if (!pr || !ctx.prsOn) return el.replaceChildren(mini.el, head, h('div.empty', null, lane?.isBase ? 'This is the base branch.' : 'Nothing to review here.'));
    el.replaceChildren(mini.el, head, loading(`Fetching #${pr.number}…`));
    const id = `${JSON.stringify(ctx.remote ?? null)}#${pr.number}@${pr.updatedAt || ''}`;
    let res = fetched.get(id);
    if (!res) {
      res = await loadPrReview(pr, ctx.remote, call);
      if (!res.error) fetched.set(id, res);
    }
    if (!alive) return;
    if (res.error) return el.replaceChildren(mini.el, head, h('div.empty', null, `Couldn’t fetch #${pr.number}`, h('div.muted.small', null, res.error.message)));
    mount(res.review);
  }

  // The reader's keys (reader.js), for the loaded view (its own handler lets them through) and the
  // pane while it's still fetching.
  el.addEventListener('keydown', (e) => {
    readerKey(e, { scroller: view?.el || el, onStep: ctx.nav?.onStep ? (d) => ctx.nav.onStep(d) : null, onBack });
  });

  el.prepend(mini.el);
  renderHead();
  load();
  return {
    el,
    key: row.key,
    refresh: () => view?.refresh(),
    // The row changed under the pane (approved, CI finished): new header, same diff and ticks.
    update(r, c) { row = r; ctx = c; renderHead(); },
    destroy() { alive = false; ro.disconnect(); mini.destroy(); },
    // The row's "Conflicts in N files" note: jump to the Conflicting group.
    showConflicts,
    // ↵ / R from the list: focus the reader's scroll, once it's there.
    focus() { if (view) view.el.focus({ preventScroll: true }); else { wantFocus = true; el.focus({ preventScroll: true }); } },
  };
}
