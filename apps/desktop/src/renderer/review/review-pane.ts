import { h, icon, kbd, loading, contextMenu, tipFor, ago, fullDate, toast } from '../lib/ui.ts';
import { draftSwitch } from '../prs/prs.ts';
import { reviewView, type ReviewView } from './review-view.ts';
import { laneKey } from '../lanes/lanes.ts';
import { rowBadges, rowAuthors, reviewers as reviewersOf, mergeOrder, stuckReason, stackFoldOrder, type Reviewer, type ReviewRow } from './review-rows.ts';
import { loadPrReview, stackedBase, paneActions, fixActions, prDescription, type FixAction, type PaneAction } from '../prs/pr-review.ts';
import { readerHead, descriptionBlock, miniHeader, miniContent, readerKey, factsBlock, evidenceStrip, markCommit, type CommitsArg, type EvidenceEl, type ReaderAuthor, type ReaderCommit, type ReaderNav } from './reader.ts';
import { factsFor, peekFacts, evidenceFor, peekEvidence } from './evidence-store.ts';
import * as keymap from '../palette/keymap.ts';
import { loginProfile } from '../lib/profile.ts';
import type { git as gitCall } from '../lib/bridge.ts';
import type { BranchReview, ChangeFacts, ConflictReview } from '../../shared/git-types.ts';
import type { PrEvidence, PullRequest, Viewer } from '../../shared/github-types.ts';
import type { SinceBridge } from '../../shared/ipc-contract.ts';

/** What the pane knows about the list around its row. */
export interface PaneContext {
  base: string | null; remote?: string | null; requested?: Set<number>; step?: string | null; prsOn?: boolean; agents?: boolean;
  /** The row conflicts with its base, so the files start with what conflicts. */
  conflicts?: boolean;
  onConflicts?(files: ConflictReview['files']): void; nav?: ReaderNav | null; viewer?: Viewer | null;
  stageOf?(n: number): string | null | undefined; onSelectPr?(n: number): void; onStack?(d: number): void; onFacts?(): void;
}
export interface ReviewPaneOptions {
  row: ReviewRow; ctx: PaneContext; root: string; git: typeof gitCall; store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  call: SinceBridge['app']; run(id: string, row: ReviewRow, ctx: PaneContext): unknown; onBack(): void;
  commitSide?: ((host: HTMLElement, sha: string, mark: (sha: string | null) => void) => void) | null;
}
export interface ReviewPane {
  el: HTMLElement; key: string; refresh(): void; update(row: ReviewRow, ctx: PaneContext): void;
  evidence(): boolean; media(): boolean; destroy(): void; showConflicts(): void; focus(): void;
}
/** A button in the pane: a pane action, a fix, Checks or the draft switch. */
type ButtonAction = { id: string; label: string; key?: string; icon: string; note?: string | null; remote?: boolean; gated?: boolean; danger?: boolean };
type Mountable = { lane: { key: string; name: string; rev: string | null }; base: string | null; fallback?: string | null; pr?: PullRequest & { remote?: string | null } };

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
// AK-520: the facts line (change-facts.js, git only) sits under the meta once the diff is known, and a
// PR's evidence strip (github.evidence: checks, annotations, media, reviews, open threads) under the
// status strip, loaded when the PR is opened; E opens its next tab. ctx.onFacts() tells the list
// there's something new for the row's chips.
// AK-640: the branch's commits are the strip's first tab (Commits), for a lane without a PR too; a
// commit opens the map's commit details on the right of the pane (commitSide, app.js).

// Fetched PR heads for this window, so moving back to a PR doesn't fetch it again. Keyed by its
// last update, so a pushed PR is fetched afresh.
const fetched = new Map<string, Awaited<ReturnType<typeof loadPrReview>>>();

// Reviewer states: the icon, the glyph for the narrow summary ("✓2 ✕1 ○1"), and how to say it.
const STATE: Record<string, { icon: string; glyph: string; verb: string; many: string }> = {
  changes: { icon: 'x', glyph: '✕', verb: 'requested changes', many: 'requested changes' },
  approved: { icon: 'check', glyph: '✓', verb: 'approved', many: 'approved' },
  commented: { icon: 'comment', glyph: '💬', verb: 'commented', many: 'commented' },
  pending: { icon: 'pending', glyph: '○', verb: 'review requested', many: 'haven’t reviewed yet' },
};
const SHOWN_REVIEWERS = 4;
const reviewerTip = (r: Reviewer) => `${r.name}${r.login && r.login !== r.name ? ` (${r.login})` : ''}: ${STATE[r.state]?.verb ?? r.state}${r.at ? ` · ${fullDate(Date.parse(r.at) / 1000)}` : ''}`;

// The reviewers: each with a state icon, "+N" past the first few, on a line under the meta or
// (inline) at the end of the change line. A narrow pane shows the counts instead (styles.css).
function reviewersLine(pr: PullRequest, inline = false) {
  const list = reviewersOf(pr);
  if (!list.length) return null;
  const all = list.map(reviewerTip).join('\n');
  const one = (r: Reviewer) => h('span.review-verdict.' + r.state, { title: reviewerTip(r) }, icon(STATE[r.state]?.icon ?? 'pending', 11), r.name);
  const counts = Object.keys(STATE).map((s): [string, number] => [s, list.filter((r) => r.state === s).length]).filter(([, n]) => n);
  return h((inline ? 'span' : 'div') + '.review-pane-reviewers' + (inline ? '.inline' : ''), null,
    h('span.review-reviewers-full', null,
      ...list.slice(0, SHOWN_REVIEWERS).map(one),
      list.length > SHOWN_REVIEWERS ? h('span.review-reviewers-more', { title: all }, `+${list.length - SHOWN_REVIEWERS}`) : null),
    h('span.review-reviewers-short', { title: all },
      ...counts.map(([s, n]) => h('span.review-verdict.' + s, { title: `${n} ${STATE[s]?.many}` }, `${STATE[s]?.glyph}${n}`))));
}

// row: a reviewRows row; ctx: { base, remote, requested, step, prsOn, agents, conflicts, onConflicts, nav }
// (nav: { at, of, onStep(±1) } for ‹ N of M › and ←/→)
// (conflicts: it conflicts with its base, so the files start with what conflicts, AK-305). run(id, row, ctx) runs a
// pane action (PANE_ACTIONS); call(channel, ...args) is api.app; onBack() returns focus to the list.
// commitSide(host, sha, mark) toggles a commit's details on the right of `host` (app.js).
export function reviewPane({ row, ctx, root, git, store, call, run, onBack, commitSide = null }: ReviewPaneOptions): ReviewPane {
  const el = h('div.review-pane', { tabIndex: -1 });
  const head = h('div.review-pane-head');
  let mini = miniHeader(el);
  let wantFocus = false; // focus() before the review mounted
  let view: ReviewView | null = null;
  let actions: PaneAction[] = [];
  let fixes: FixAction[] = [];
  let alive = true;
  let jump = false; // showConflicts() before the review mounted
  let facts: ChangeFacts | null = null; // change facts for the diff, once read
  let ev: PrEvidence | null | undefined; // the PR's evidence: undefined while it loads, null when there's nothing
  let strip: EvidenceEl | null = null;
  let commits: { list: ReaderCommit[]; count: number } | null = null; // from the branch review, for the Commits tab
  let openCommit: string | null = null; // the commit open on the right

  // Title, meta, status strip and description run across the whole pane and scroll with the files.
  // Labelled buttons for the actions you take most, icon buttons for the rest, the primary one last.
  // The pane is a size container (styles.css): narrower, Merge and Approve drop their labels, then
  // everything but the primary button moves into the ⋯ menu. Wider panes whose buttons still don't fit
  // (long labels, a Fix prompt button) never clip one: GitHub goes icon-only first, then Merge and Approve.
  const ro = new ResizeObserver(() => fit());
  ro.observe(head);
  function fit() {
    foldStack();
    const bar = head.querySelector<HTMLElement>('.review-pane-actions');
    if (!bar) return;
    bar.classList.remove('fit-github', 'fit-shrink');
    if (bar.scrollWidth > bar.clientWidth) bar.classList.add('fit-github');
    if (bar.scrollWidth > bar.clientWidth) bar.classList.add('fit-shrink');
    // Still too wide: everything but the primary button goes into ⋯, so nothing runs off the edge.
    const strip = bar.parentElement;
    if (!strip) return;
    strip.classList.remove('fit-more', 'fit-wrap');
    if (bar.scrollWidth > bar.clientWidth) strip.classList.add('fit-more');
    // Even ⋯ and the primary button don't fit beside the label: they move to a line of their own.
    if (bar.scrollWidth > bar.clientWidth) strip.classList.add('fit-wrap');
  }

  function renderHead() {
    const { pr, lane } = row;
    const { actions: list, primary: paneP } = paneActions(row, ctx.step, { viewer: ctx.viewer });
    actions = list;
    const size = pr?.size;
    const updated = pr?.updatedAt ? Date.parse(pr.updatedAt) / 1000 : 0;
    const badges = rowBadges(row, { requested: ctx.requested });
    const draft = badges.find((b) => b.kind === 'draft');
    // A stuck row's fixes lead its strip, so the actions don't repeat them.
    fixes = fixActions(row, ctx);
    const fixing = new Set(fixes.map((a) => a.id));
    const primary = ctx.step === 'rebase' && fixing.has('rebase') ? 'rebase' : paneP;
    const extra: ButtonAction[] = pr?.url && !fixing.has('checks') ? [{ id: 'checks', label: 'Checks', key: 'lanes.checks', icon: 'checks' }] : [];
    const button = (a: ButtonAction) => {
      const label = a.label.replace('…', '');
      const note = a.id === 'merge' && row.stack?.on ? `It merges into #${row.stack.on}’s branch, not ${row.stack.base || 'the base'}: merge #${row.stack.on} first` : a.note || (a.remote ? `${label} on GitHub: ⌘Z can’t undo it` : a.id === 'github' ? 'Opens in your browser' : a.id === 'sendBack' ? 'A ready-made prompt to fix it, for you or an agent' : a.id === 'checks' ? 'Opens the failing checks' : `${label} (undoable)`);
      const onclick = () => (fixing.has(a.id) ? fix(a.id) : run(a.id, row, ctx));
      const cls = (a.gated ? '.gated' : '') + (a.id === primary ? '.primary' : a.id === 'github' ? '.ghost' : '.subtle') + (a.id === primary ? '' : '.pane-secondary' + (['merge', 'approve', 'sendBack', 'github', 'rebase', 'checkout', 'updateBranch'].includes(a.id) ? '.pane-shrink' : '') + (a.id === 'github' ? '.pane-github' : ''));
      const tip = `${tipFor(a.label, a.key)}\n${note}`;
      if (a.id === 'close' || (a.id === 'checks' && !fixing.has('checks'))) return h('button.btn.ghost.icon-btn.pane-secondary' + (a.danger ? '.danger-hover' : ''), { 'data-tip': a.id === 'close' ? `${tipFor('Close PR…', a.key)}\n${note}` : tip, 'aria-label': a.id === 'close' ? 'Close PR…' : a.label, onclick }, icon(a.icon, 15));
      return h('button.btn' + cls, { 'data-tip': tip, 'aria-label': a.label, onclick }, icon(a.id === 'github' ? 'github' : a.icon, 14), h('span.btn-label', null, a.label), kbd(...(a.key ? keymap.keys(a.key) ?? [] : [])));
    };
    const main = actions.filter((a) => a.id !== 'close' && a.id !== 'github' && !fixing.has(a.id));
    const close = actions.find((a) => a.id === 'close');
    const github = actions.find((a) => a.id === 'github');
    const icons = [...extra, close].filter((a): a is ButtonAction => !!a);
    const all: ButtonAction[] = [...fixes, ...main];
    const lead = all.find((a) => a.id === primary) || null;
    const rest = all.filter((a) => a !== lead);
    // ⋯: every action but the primary one, for the narrowest panes (their keys and ⌘K still work).
    // Draft ↔ ready (AK-610) is only here, so with it ⋯ always shows.
    const ds = pr ? draftSwitch(pr, ctx.viewer) : null;
    const draftItem: ButtonAction | null = ds ? { id: 'draft', label: ds.label, icon: ds.icon, gated: Boolean(ds.why), note: ds.why } : null;
    const more = [...rest, ...icons, draftItem, github].filter((a): a is ButtonAction => !!a);
    const moreBtn = more.length ? h('button.btn.ghost.icon-btn.pane-more' + (draftItem ? '.always' : ''), {
      'data-tip': 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
      onclick: (e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, more.map((a) => ({ label: a.id === 'close' ? 'Close PR…' : a.label, icon: a.id === 'github' ? 'github' : a.icon, kbd: a.key ? keymap.keys(a.key) : null, danger: a.danger, disabled: a.gated, why: a.gated ? a.note : null, run: () => (fixing.has(a.id) ? fix(a.id) : run(a.id, row, ctx)) }))); },
    }, icon('more', 15)) : null;
    // Who made it (AK-390): the person, + the agent when its lane looks agent-made, or the bot alone.
    const authors = rowAuthors(row, { agents: ctx.agents });
    // A PR's author on GitHub opens their profile (AK-627); agents and bots stay plain.
    const authorProfile = (a: ReaderAuthor) => {
      const p = !a.agent && a.key === pr?.author && /^https:\/\/github\.com\//.test(pr?.url || '') ? loginProfile(a.key) : null;
      return p ? { ...p, open: () => call('external', p.url) } : null;
    };
    const num = pr ? `#${pr.number}` : icon(lane?.worktree ? 'worktree' : 'branch', 14);
    const top = readerHead({
      num, title: row.title, nav: ctx.nav || null,
      badges: badges.filter((b) => b !== draft).map((b) => h('span.badge.review-badge' + (b.kind ? `.${b.kind}` : ''), { title: b.title }, b.spin ? h('span.badge-spinner', { 'aria-hidden': 'true' }) : null, b.text)),
      authors, authorProfile,
      branch: pr ? pr.branch : row.branch || null, base: pr ? pr.base : null,
      meta: [
        size && !facts ? h('span.stat.small', { title: `${size.files} file${size.files === 1 ? '' : 's'} changed` }, h('span.add', null, `+${size.additions}`), ' ', h('span.del', null, `−${size.deletions}`), ` · ${size.files} file${size.files === 1 ? '' : 's'}`) : null,
        draft ? h('span.badge.review-badge.draft', { title: draft.title }, draft.text) : null,
        updated ? h('span.review-pane-updated', { title: fullDate(updated) }, `Updated ${ago(updated)}`) : null,
      ].filter(Boolean),
      // The reviewers sit on the change line once the facts are in (AK-516), else on a line of their own.
      below: [stackLine(), facts ? factsBlock(facts, { after: pr ? reviewersLine(pr, true) : null }) : pr ? reviewersLine(pr) : null, ...(pr ? mergeOrderLines() : [])].filter(Boolean),
    });
    const prOn = Boolean(pr && ctx.prsOn);
    // The strip redraws itself on a tab switch, so `selected` follows the open commit.
    const cm: CommitsArg | null = commits && { ...commits, selected: openCommit, onOpen: commitSide ? (sha) => commitSide(el, sha, mark) : null };
    function mark(sha: string | null) { openCommit = sha; if (cm) cm.selected = sha; markCommit(head, sha); }
    strip = prOn || commits ? evidenceStrip({
      evidence: prOn ? ev : null, key: prOn ? `${ctx.remote ?? ''}#${pr?.number}` : `lane:${row.key}`,
      openUrl: (u) => call('external', u), loadImage: (id) => call('pr-media-image', id).then((r) => r?.ok ?? null), goTo: view ? { has: view.hasFile, go: view.goToLine } : null,
      commits: cm,
    }) : null;
    head.replaceChildren(...[
      top,
      statusStrip([...rest.map(button), rest.length && icons.length ? h('span.review-pane-sep.pane-secondary') : null, ...icons.map(button), github ? button(github) : null, moreBtn, lead ? button(lead) : null].filter((x): x is HTMLElement => !!x)),
      strip,
      pr ? descriptionBlock({ text: prDescription(pr) }) : null,
    ].filter((x) => x !== null));
    // The slim bar once the head scrolls away: avatar, number, title and the primary action.
    mini.set(miniContent({ authors, num: pr ? `#${pr.number}` : null, title: row.title, action: lead ? { label: lead.label.replace('…', ''), icon: lead.icon, run: () => (fixing.has(lead.id) ? fix(lead.id) : run(lead.id, row, ctx)) } : null }));
    mini.watch(top);
    fit();
  }

  // The status strip (AK-379): where the row stands on the left (Stuck and why, Ready to merge, In
  // progress) in red or green text, its actions on the right with the primary one last, one row (AK-502).
  // "Stuck  conflicts with main in a.js · CI ✗ lint     [Conflicts F] [Checks O] … [Rebase onto main B]"
  function statusStrip(buttons: HTMLElement[]) {
    const stage = row.stage;
    const label = stage === 'stuck' ? 'Stuck' : stage === 'ready' ? 'Ready to merge' : stage === 'inProgress' ? 'In progress' : null;
    if (!label && !buttons.length) return null;
    // A stacked PR merges into the one under it, so that one goes first (AK-537).
    const why = stage === 'stuck' ? stuckReason(row, { base: ctx.base, max: 3 }) : row.stack?.on ? `Merge #${row.stack.on} first` : null;
    return h('div.review-pane-status' + (stage === 'stuck' || stage === 'ready' ? `.${stage}` : ''), { role: 'group', 'aria-label': stage === 'stuck' ? 'Fix what’s stuck' : 'Actions' },
      label ? h('div.review-pane-status-why', { title: stage === 'stuck' ? stuckReason(row, { base: ctx.base, max: 20 }) || '' : '' },
        h('span.review-pane-status-label', null, icon(stage === 'stuck' ? 'warning' : stage === 'ready' ? 'check' : 'pending', 13), label),
        why ? h('span.review-pane-status-text', null, why) : null) : null,
      buttons.length ? h('div.review-pane-actions', null, ...buttons) : null);
  }

  function fix(id: string) {
    if (id === 'showConflicts') showConflicts();
    else run(id, row, ctx);
  }
  function showConflicts() { if (view) view.showConflicts(); else jump = true; }

  // The stack path (AK-537): "Stack  main ‹ ● #41 ‹ ● #42 this PR ‹ ● #43", each PR's dot in its
  // stage's colour. A PR selects that row; [ and ] step down and up. null outside a stack.
  // One line, never wrapped (AK-540): out of room, foldStack() tucks PRs into a "··· N" chip whose menu lists them.
  function stackLine() {
    const s = row.stack;
    if (!s) return null;
    const sep = () => h('span.review-stack-sep', { 'aria-hidden': 'true' }, '‹');
    const dot = (n: number) => h('span.review-dot' + (ctx.stageOf?.(n) ? `.${ctx.stageOf(n)}` : ''), { 'aria-hidden': 'true' });
    const keyOf = (n: number) => (n === s.path[s.at - 2] ? 'lanes.stackDown' : n === s.path[s.at] ? 'lanes.stackUp' : null);
    const steps = s.path.map((n) => h('span.review-stack-step', { 'data-pr': n }, sep(), n === row.pr?.number
      ? h('span.review-stack-pr.current', { 'aria-current': 'true' }, dot(n), `#${n}`, h('span.review-stack-this', null, 'this PR'))
      : h('button.review-stack-pr', { 'data-tip': keyOf(n) ? tipFor(`Select #${n}`, keyOf(n)) : `Select #${n}`, onclick: () => ctx.onSelectPr?.(n) }, dot(n), `#${n}`)));
    const more = h('button.review-stack-more', { 'aria-haspopup': 'menu', onclick: (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const hidden = steps.filter((x) => x.hidden).map((x) => Number(x.dataset.pr));
      contextMenu(r.left, r.bottom + 4, hidden.map((n) => ({ label: `#${n}`, lead: dot(n), run: () => ctx.onSelectPr?.(n) })), { focus: e.detail === 0 ? 0 : -1 });
    } });
    const chip = h('span.review-stack-step.review-stack-fold', { hidden: true }, sep(), more);
    return h('div.review-pane-stack', { role: 'navigation', 'aria-label': `Stack, ${s.at} of ${s.of}` },
      h('span.muted', null, 'Stack'),
      h('span.review-stack-path', null,
        h('span.mono.review-stack-base', { title: `The stack merges into ${s.base || 'the base'}, bottom first` }, s.base || 'base'),
        chip, ...steps));
  }

  // Fold the stack path until it fits on its line: farthest PRs first, this PR's neighbours last (stackFoldOrder).
  // The chip stands where the first folded PR was.
  function foldStack() {
    const path = head.querySelector('.review-stack-path');
    const s = row.stack;
    const chip = path?.querySelector<HTMLElement>('.review-stack-fold');
    if (!path || !s || !chip) return;
    const steps = [...path.querySelectorAll<HTMLElement>('.review-stack-step[data-pr]')];
    const order = stackFoldOrder(s.path, s.at);
    const hide = (k: number) => {
      const out = new Set(order.slice(0, k));
      steps.forEach((x, i) => { x.hidden = out.has(i); });
      chip.hidden = !k;
      if (!k) return;
      const first = steps.find((x) => x.hidden);
      first?.before(chip);
      const btn = chip.lastElementChild as HTMLElement | null;
      if (!btn) return;
      btn.textContent = `··· ${k}`;
      btn.setAttribute('aria-label', `${k} more PR${k === 1 ? '' : 's'} in the stack`);
      btn.dataset.tip = steps.filter((x) => x.hidden).map((x) => `#${x.dataset.pr}`).join(', ');
    };
    for (let k = 0; k <= order.length; k++) {
      hide(k);
      if (path.scrollWidth <= path.clientWidth) return;
    }
  }

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

  // E: the evidence strip's next tab (the last one closes it).
  function nextEvidence() {
    const s = strip ? head.querySelector<EvidenceEl>('section.evidence') : null;
    if (s?.next) return s.next();
    toast(!row.pr ? 'Only pull requests have checks and reviews' : !ctx.prsOn ? 'Turn on PR features to see checks and reviews' : ev === undefined ? 'Still loading checks and reviews' : 'No checks, annotations, media or reviews on this pull request');
    return true;
  }

  // I: the Media tab, focused on its first thumbnail.
  function showMedia() {
    const s = strip ? head.querySelector<EvidenceEl>('section.evidence') : null;
    if (s?.media?.()) return true;
    toast(!row.pr ? 'Only pull requests have images and videos' : !ctx.prsOn ? 'Turn on PR features to see images and videos' : ev === undefined ? 'Still loading checks and reviews' : 'No images or videos on this pull request');
    return true;
  }

  const onKey = (id: string): boolean => {
    if (id === 'review.evidence') return nextEvidence();
    if (id === 'review.media') return showMedia();
    const f = fixes.find((x) => x.key === id);
    if (f) { fix(f.id); return true; }
    const a = actions.find((x) => x.key === id);
    if (!a) return false;
    run(a.id, row, ctx);
    return true;
  };

  function loadFacts(base: string | null | undefined, rev: string | null | undefined) {
    if (!base || !rev) return;
    const known = peekFacts(base, rev);
    if (known !== undefined) { facts = known; return; }
    factsFor(git, base, rev).then((f) => { if (!alive || !f) return; facts = f; renderHead(); ctx.onFacts?.(); });
  }
  function loadEvidence() {
    const { pr } = row;
    if (!pr || !ctx.prsOn) return;
    ev = peekEvidence(ctx.remote, pr);
    if (ev !== undefined) return;
    const want = pr;
    evidenceFor(call, ctx.remote, pr).then((e) => { if (!alive || row.pr?.number !== want.number) return; ev = e; renderHead(); ctx.onFacts?.(); });
  }

  function mount(review: Mountable) {
    loadFacts(review.base, review.lane?.rev);
    view = reviewView({
      ...review, root, git, store, header: head, embedded: true, onKey, onClose: onBack, checkConflicts: Boolean(ctx.conflicts), onConflicts: (files) => ctx.onConflicts?.(files),
      onReview: (r: BranchReview) => {
        const next = r.commits?.length ? { list: r.commits, count: Math.max(r.commitCount || 0, r.commits.length) } : null;
        if (next?.list[0]?.sha === commits?.list[0]?.sha && next?.count === commits?.count) return;
        commits = next;
        renderHead();
      },
    });
    const had = wantFocus || el.contains(document.activeElement);
    // The view is the reader's scroll: the slim bar moves into it.
    const v = view;
    mini.destroy();
    mini = miniHeader(v.el);
    v.el.prepend(mini.el);
    el.replaceChildren(v.el);
    renderHead();
    if (had) { wantFocus = false; v.el.focus({ preventScroll: true }); }
    if (jump) v.showConflicts();
  }

  async function load() {
    const { pr, lane } = row;
    const rev = lane && !lane.isBase ? lane.branch || lane.head : null;
    const own = rev && ctx.prsOn ? stackedBase(pr, ctx.base, ctx.remote) : null;
    if (rev && lane) return mount({ lane: { key: laneKey(lane), name: lane.name, rev }, base: own || ctx.base, fallback: own ? ctx.base : null });
    if (!pr || !ctx.prsOn) return el.replaceChildren(mini.el, head, h('div.empty', null, lane?.isBase ? 'This is the base branch.' : 'Nothing to review here.'));
    el.replaceChildren(mini.el, head, loading(`Fetching #${pr.number}…`));
    const id = `${JSON.stringify(ctx.remote ?? null)}#${pr.number}@${pr.updatedAt || ''}`;
    let res = fetched.get(id);
    if (!res) {
      res = await loadPrReview(pr, ctx.remote, call);
      if (!('error' in res)) fetched.set(id, res);
    }
    if (!alive) return;
    if ('error' in res) return el.replaceChildren(mini.el, head, h('div.empty', null, `Couldn’t fetch #${pr.number}`, h('div.muted.small', null, res.error.message)));
    mount(res.review);
  }

  // The reader's keys (reader.js), for the loaded view (its own handler lets them through) and the
  // pane while it's still fetching.
  el.addEventListener('keydown', (e) => {
    const st = keymap.match('lanes', e);
    if ((st === 'lanes.stackDown' || st === 'lanes.stackUp') && ctx.onStack && !(e.target as Element | null)?.closest?.('input, textarea')) {
      e.preventDefault(); e.stopPropagation(); ctx.onStack(st === 'lanes.stackUp' ? 1 : -1); return;
    }
    readerKey(e, { scroller: view?.el || el, onStep: ctx.nav?.onStep ? (d) => ctx.nav?.onStep(d) : null, onBack });
  });

  el.prepend(mini.el);
  loadEvidence();
  renderHead();
  load();
  return {
    el,
    key: row.key,
    refresh: () => view?.refresh(),
    // The row changed under the pane (approved, CI finished): new header, same diff and ticks.
    update(r: ReviewRow, c: PaneContext) {
      const moved = r.pr?.head !== row.pr?.head || r.pr?.updatedAt !== row.pr?.updatedAt || r.pr?.checks !== row.pr?.checks;
      row = r; ctx = c;
      if (moved) loadEvidence();
      renderHead();
    },
    // ⌘K "Show checks and reviews": the evidence strip's next tab.
    evidence: nextEvidence,
    // ⌘K "Show media".
    media: showMedia,
    destroy() { alive = false; ro.disconnect(); mini.destroy(); },
    // The row's "Conflicts in N files" note: jump to the Conflicting group.
    showConflicts,
    // ↵ / R from the list: focus the reader's scroll, once it's there.
    focus() { if (view) view.el.focus({ preventScroll: true }); else { wantFocus = true; el.focus({ preventScroll: true }); } },
  };
}
