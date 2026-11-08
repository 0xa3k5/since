import { h, icon, kbd, toast, loading, type Child } from '../lib/ui.ts';
import { renderDiff, statusBadge, fileName, fileRef } from '../commit/diff.ts';
import { storeKey, readTicks, writeTicks, fileStates, toggleTick, refreshSummary } from './review.ts';
import * as keymap from '../palette/keymap.ts';
import { prStatusLine, draftSwitch } from '../prs/prs.ts';
import { PR_ACTIONS, prActionFor } from '../prs/pr-review.ts';
import { fileCard, foldShut, commitLines, markCommit } from './reader.ts';
import type { FileState } from './review.ts';
import type { git as gitCall } from '../lib/bridge.ts';
import type { BranchReview, ConflictHunk, ConflictReview, FileDiff } from '../../shared/git-types.ts';
import type { PullRequest } from '../../shared/github-types.ts';

type BranchFile = BranchReview['files'][number];
type ConflictFile = ConflictReview['files'][number];
/** A file's card in the stacked view, with the file and the tip it diffs from. */
type FileBlock = HTMLElement & { file?: BranchFile; since?: string | null };
export interface ReviewViewOptions {
  lane: { key: string; name: string; rev: string | null }; base: string | null; fallback?: string | null; root: string;
  git: typeof gitCall; store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; onClose(): void; onMerge?: (() => void) | null;
  pr?: (PullRequest & { remote?: string | null }) | null; onPrAction?(id: string): void; prWhy?(id: string): string | null;
  header?: Child; embedded?: boolean; onKey?: ((id: string) => boolean | undefined) | null; checkConflicts?: boolean;
  onConflicts?(files: ConflictFile[]): void; onReview?: ((review: BranchReview) => void) | null;
  onCommit?: ((sha: string, mark: (sha: string | null) => void) => void) | null;
}
export interface ReviewView { el: HTMLElement; refresh(): void; showConflicts(): void; hasFile(path: string): boolean; goToLine(path: string, line: number): Promise<boolean>; setDraft(draft: boolean): void }

// Review a branch: its whole change against the base (from the merge-base, as a pull request
// shows it), one file at a time, with a "reviewed" tick per file (review.js has the rules).
// The delta toggle narrows the list to files changed since they were ticked and diffs each one
// from the tip it was ticked at to the current tip.

// lane: { key, name, rev } (key from lanes.laneKey; rev is the branch or the detached head).
// git(method, ...args) calls the main process; store is localStorage; onClose() goes back;
// onMerge() merges and tidies the branch (null: not offered, e.g. a detached head).
// pr: an Inbox pull request (pr-review.js): the head shows its author and checks, and
// onPrAction(id) runs approve / changes / merge / close / checkout (PR_ACTIONS) or draft on it; prWhy(id) is why
// one doesn't apply (greyed, its click says why), or null.
// Embedded in Review's pane (review-pane.js): `header` replaces the title, PR line and buttons and
// runs across the full width above the files and the diff; there's no Back button and it doesn't
// take focus; onKey(keyId) runs first and returns true when
// it handled a `review` key (the pane's actions); Esc still calls onClose.
// With a header (Review's pane, AK-373) there's no files column: every file is a card of its own,
// one after the other, under a sticky header with a fold chevron, the reviewed tick, the path and
// +N −M. The header and the files share one scroll (AK-379): the whole view scrolls, so the pane's
// head and description move away as you read and each file header sticks to the top while its file
// is in view. Ticking a file (V or the tick) folds its code; clicking anywhere else on a header (or
// ↵/Space on its chevron) folds or unfolds that file, remembered per file while the view is open.
// The cards are reader.js fileCard, shared with Catch up (AK-381). Stacked, ↑/↓ scroll and , / .
// jump between files (the reader keys, handled by the pane); with a files column ↑/↓ move between
// files. Diffs load as their blocks come near the view.
// checkConflicts: the branch is known to conflict with its base (AK-305), so the files
// start with a Conflicting group (git mergeConflicts, merge-tree, read-only) and a conflicting file
// shows the base side against the branch's side. onConflicts(files) reports what it found.
// fallback: a base to use instead when `base` can't be resolved (a stacked PR's base not fetched here).
// The branch's commits (AK-640, branchReview's `commits`, newest first): on this page they head the
// files column (reader.js commitLines); in Review's pane (stacked) they're the evidence strip's
// Commits tab, so onReview(review) hands them over. onCommit(sha, mark) opens a commit beside the
// diff (app.js) and calls mark(sha or null) as it opens and closes.
export function reviewView({ lane, base, fallback = null, root, git, store, onClose, onMerge = null, pr = null, onPrAction = () => {}, prWhy = () => null, header = null, embedded = false, onKey = null, checkConflicts = false, onConflicts = () => {}, onReview = null, onCommit = null }: ReviewViewOptions): ReviewView {
  const key = storeKey(root, lane.key);
  let review: BranchReview | null = null;
  let saved = readTicks(store, key);
  let states = new Map<string, FileState>();
  let current: string | null = null;
  let delta = false;
  let full = false;
  let seq = 0;
  let timer = 0;
  let conflicts: ConflictFile[] | null = null; // once read (checkConflicts)
  let onConflict = false; // `current` is its Conflicting entry, not its Changed one
  let jump = false; // showConflicts() before the conflicts were read
  let conflictsAt: string | null = null;
  let allCommits = false; // Show all pressed
  let openCommit: string | null = null; // the commit open beside the diff

  const stacked = Boolean(header); // per-file blocks instead of a files column (AK-373)
  const diffs = new Map<string, FileDiff | null>(); // stacked: `${path}@${tip}@${since}` → diff, so re-renders keep their height
  const folds = new Map<string, boolean>(); // stacked: path → folded, set by hand; otherwise reviewed files are folded
  const fulls = new Set<string>(); // stacked: files showing every line (Show all)
  let observer: IntersectionObserver | null = null;
  const meta = h('div.quick-meta');
  const deltaBtn = h('button.chip', { title: 'Only files changed since you last looked (D)', onclick: () => toggleDelta() }, 'Changed since last look');
  const listEl = h('div.file-list.review-list', { role: 'listbox', 'aria-label': 'Files' });
  const commitsEl = h('div.review-commits-host');
  // With a header, the progress line (reviewed count, Changed since last look) sits under it once,
  // across the pane; the files column is just the list.
  // Draft ↔ ready (AK-610): the switch that applies; onPrAction('draft') flips it on GitHub, then
  // setDraft(draft) relabels it. None once the PR is closed or merged.
  const draftChip = pr && draftSwitch(pr, null) ? h('button.chip', { onclick: () => onPrAction('draft') }) : null;
  const setDraft = (draft: boolean) => {
    const d = draftChip && pr && draftSwitch({ ...pr, draft }, null);
    if (!d) return;
    draftChip.classList.toggle('gated', Boolean(prWhy('draft')));
    draftChip.title = prWhy('draft') || 'Happens on GitHub: ⌘Z can’t undo it';
    draftChip.replaceChildren(icon(d.icon, 12), d.label);
  };
  setDraft(Boolean(pr?.draft));
  const side = h('div.quick-side.review-side', null,
    header ? null : h('div.quick-head', null,
      embedded ? null : h('button.btn.ghost.small', { onclick: onClose }, icon('chevron', 12), 'Back', kbd(...(keymap.keys('review.close') ?? []))),
      h('div.quick-title', { title: lane.name }, icon(pr ? 'merge' : 'branch', 14), ' ', lane.name),
      pr ? h('div.quick-meta.review-pr', null, [pr.author ? `by ${pr.authorName || pr.author}` : null, `${pr.branch} → ${pr.base}`, prStatusLine(pr) || null].filter(Boolean).join(' · ')) : null,
      meta,
      h('div.review-tools', null, deltaBtn, !pr && onMerge ? h('button.chip', { title: 'Merge and tidy (M)', onclick: () => onMerge() }, 'Merge and tidy…') : null),
      pr ? h('div.review-tools.review-pr-actions', null, PR_ACTIONS.map((a) => h('button.chip' + (a.danger ? '.danger' : '') + (prWhy(a.id) ? '.gated' : ''), { title: prWhy(a.id) || (a.id === 'checkout' ? 'Check out in a new worktree (undoable)' : 'Happens on GitHub: ⌘Z can’t undo it'), onclick: () => onPrAction(a.id) }, icon(a.icon, 12), a.label, kbd(...(keymap.keys(a.key) ?? [])))), draftChip) : null),
    commitsEl,
    listEl,
  );
  const top = header ? h('div.review-pane-top', null, header, h('div.review-progress-line', null, meta, deltaBtn)) : null;
  const main = h('div.quick-main', null, loading('Loading the branch…'));
  const stack = stacked ? h('div.review-stack', { role: 'list', 'aria-label': 'Files' }, loading('Loading the branch…')) : null;
  // Stacked, `el` itself is the one scroll (styles.css), so the observer and scroll restore use it.
  const el = stacked ? h('div.quick.review.with-header.stacked', { tabIndex: 0 }, top, stack)
    : h('div.quick.review' + (header ? '.with-header' : ''), { tabIndex: 0 }, top, side, main);
  const listRoot = stacked ? stack : listEl;

  const shown = () => (review ? review.files.filter((f) => !delta || states.get(f.path)?.state === 'changed') : []);
  const conflicting = () => (delta ? [] : conflicts || []);
  // Every row in list order: the Conflicting group first, then the changed files.
  const entries = () => [...conflicting().map((f) => ({ path: f.path, c: true })), ...shown().map((f) => ({ path: f.path, c: false }))];

  function renderMeta() {
    if (!review) return;
    const s = [...states.values()];
    const done = s.filter((x) => x.state === 'reviewed').length;
    const changed = s.filter((x) => x.state === 'changed').length;
    meta.replaceChildren(...[
      ...(header && pr ? [] : [h('span', null, `against ${/^[0-9a-f]{40}$/.test(review.base) ? review.base.slice(0, 7) : review.base}`), ' · ']),
      h('span.review-progress' + (done === review.files.length && done ? '.done' : ''), null, `${done} / ${review.files.length} reviewed`),
      changed ? h('span.review-changed', null, ` · ${changed} changed since you last looked`) : null,
    ].filter((x) => x !== null));
    deltaBtn.classList.toggle('on', delta);
    deltaBtn.disabled = !changed && !delta;
  }

  // The branch's commits above the files column.
  function commitsBlock() {
    const list = review?.commits;
    if (!review || !list?.length) return null;
    const count = Math.max(review.commitCount || 0, list.length);
    const mark = (sha: string | null) => { openCommit = sha; markCommit(commitsEl, sha); };
    return h('section.review-commits', { 'aria-label': 'Commits' },
      h('div.lanes-group.review-files-group', null, 'Commits', h('span.review-files-n', null, String(count))),
      ...commitLines({ list, count, selected: openCommit, onOpen: onCommit ? (sha) => onCommit(sha, mark) : null }, allCommits, () => { allCommits = true; renderList(); }));
  }

  function row(f: BranchFile) {
    const st = states.get(f.path)?.state;
    const [name, dir] = fileName(f.path);
    const on = f.path === current && !onConflict;
    return h('div.file-row.review-row' + (on ? '.active' : '') + (st === 'reviewed' ? '.reviewed' : ''), {
      role: 'option', 'aria-selected': String(on), 'data-path': f.path, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
      onclick: () => select(f.path),
    },
      h('button.review-tick' + (st === 'reviewed' ? '.on' : ''), { title: st === 'reviewed' ? 'Reviewed (V to undo)' : 'Mark reviewed (V)', 'aria-pressed': String(st === 'reviewed'), onclick: (e) => { e.stopPropagation(); tick(f.path); } }, st === 'reviewed' ? icon('check', 12) : null),
      statusBadge(f.status),
      h('span.fname', null, name),
      h('span.fdir', null, dir),
      st === 'changed' ? h('span.badge.warn', { title: 'Changed since you marked it reviewed' }, 'Changed') : null,
      f.add || f.del ? h('span.stat.small', null, f.add ? h('span.add', null, '+' + f.add) : null, f.del ? h('span.del', null, '−' + f.del) : null) : null,
    );
  }

  function conflictRow(f: ConflictFile) {
    const on = f.path === current && onConflict;
    const [name, dir] = fileName(f.path);
    return h('div.file-row.review-row.review-conflict-row' + (on ? '.active' : ''), {
      role: 'option', 'aria-selected': String(on), 'data-path': f.path, 'data-conflict': '1', title: `${f.path}\nConflicts with ${review?.base || 'the base'}`,
      onclick: () => select(f.path, true, true),
    },
      icon('warning', 13),
      h('span.fname', null, name),
      h('span.fdir', null, dir),
      f.hunks.length ? h('span.review-conflict-count', null, f.hunks.length === 1 ? '1 hunk' : `${f.hunks.length} hunks`) : null,
    );
  }

  function renderList() {
    if (stacked) return renderStack();
    const files = shown();
    const cs = conflicting();
    const list = entries();
    if (!list.some((e) => e.path === current && e.c === onConflict)) { current = list[0]?.path || null; onConflict = Boolean(list[0]?.c); }
    const group = (label: string, n: number, cls = '') => h('div.lanes-group.review-files-group' + cls, { role: 'presentation' }, label, h('span.review-files-n', null, String(n)));
    if (!stacked) commitsEl.replaceChildren(...[commitsBlock()].filter((x) => x !== null));
    listEl.replaceChildren(...(cs.length ? [group('Conflicting', cs.length, '.conflicting'), ...cs.map(conflictRow), group('Changed', files.length)] : []), ...files.map(row));
    if (!files.length) listEl.append(h('div.empty', null, delta ? 'Nothing changed since you last looked.' : 'No changes against the base.'));
    renderMeta();
  }

  // A conflicting file: each hunk's base side next to the branch's side, between a few lines of
  // context, with the markers git would write (conflict editor styles, cf-*).
  function renderConflict(f: ConflictFile) {
    ++seq;
    const headName = pr ? `#${pr.number}` : lane.rev;
    main.replaceChildren(
      h('div.diff-head', null, h('span.badge.warn', null, 'Conflict'), h('span.mono', null, f.path), h('span.spacer'),
        h('span.muted', null, `${review?.base || 'base'} ← ${headName}`)),
      h('div.diff-scroll', null, conflictBody(f)),
    );
  }
  function conflictBody(f: ConflictFile) {
    const baseName = review?.base || 'base';
    const headName = pr ? `#${pr.number}` : lane.rev;
    const text = (cls: string) => (l: string) => h('div.cf-line' + cls, null, l || ' ');
    const marker = (m: string) => h('div.cf-line.cf-marker', null, m);
    const side = (cls: string, name: string | null, list: string[], open: string, close: string | null) => h('div.cf-col' + cls, null,
      h('div.cf-col-head', null, name), marker(open), ...(list.length ? list.map(text('')) : [h('div.cf-none', null, 'Nothing on this side')]), close ? marker(close) : null);
    const hunk = (k: ConflictHunk, i: number) => h('div.cf-block', null,
      h('div.cf-block-head', null, h('span.cf-title', null, `Conflict ${i + 1} of ${f.hunks.length}`), h('span.muted.small', null, `line ${k.line}`)),
      ...k.before.map(text('.ctx')),
      h('div.cf-cols', null, side('.cf-ours', baseName, k.base, `<<<<<<< ${baseName}`, '======='), side('.cf-theirs', headName, k.head, '=======', `>>>>>>> ${headName}`)),
      ...k.after.map(text('.ctx')));
    const why = !f.inBase ? `Deleted on ${baseName}, changed on ${headName}.` : !f.inHead ? `Deleted on ${headName}, changed on ${baseName}.` : 'Changed on both sides, with no text to compare (binary, or too big to show).';
    return f.hunks.length ? h('div.cf-body.review-conflict', null, ...f.hunks.map(hunk)) : h('div.empty', null, why);
  }

  // Stacked (Review's pane): the Conflicting group, then every file as a block under a sticky header.
  function renderStack() {
    const files = shown();
    const cs = conflicting();
    const list = entries();
    if (!list.some((e) => e.path === current && e.c === onConflict)) { current = list[0]?.path || null; onConflict = Boolean(list[0]?.c); }
    const y = el.scrollTop;
    observer?.disconnect();
    observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((xs) => {
      for (const x of xs) if (x.isIntersecting) { observer?.unobserve(x.target); fill(x.target as FileBlock); }
    }, { root: el, rootMargin: '800px 0px' }) : null;
    const group = (label: string, n: number, cls = '') => h('div.lanes-group.review-files-group' + cls, { role: 'presentation' }, label, h('span.review-files-n', null, String(n)));
    stack?.replaceChildren(...(cs.length ? [group('Conflicting', cs.length, '.conflicting'), ...cs.map(conflictBlock), group('Changed', files.length)] : []), ...files.map(fileBlock));
    if (!files.length) stack?.append(h('div.empty', null, delta ? 'Nothing changed since you last looked.' : 'No changes against the base.'));
    el.scrollTop = y;
    renderMeta();
  }

  function conflictBlock(f: ConflictFile) {
    const on = f.path === current && onConflict;
    const headName = pr ? `#${pr.number}` : lane.rev;
    return h('section.review-file.conflict' + (on ? '.active' : ''), { role: 'listitem', 'data-path': f.path, 'data-conflict': '1', 'aria-label': `${f.path}, conflicts` },
      h('div.review-file-head', { title: `${f.path}\nConflicts with ${review?.base || 'the base'}`, onclick: () => select(f.path, false, true) },
        icon('warning', 13),
        h('span.mono.review-file-path', null, f.path),
        h('span.spacer'),
        f.hunks.length ? h('span.review-conflict-count', null, f.hunks.length === 1 ? '1 hunk' : `${f.hunks.length} hunks`) : null,
        h('span.muted.small', null, `${review?.base || 'base'} ← ${headName}`)),
      h('div.review-file-body', null, conflictBody(f)));
  }

  function fileBlock(f: BranchFile): FileBlock {
    const st = states.get(f.path);
    const reviewed = st?.state === 'reviewed';
    const folded = folds.has(f.path) ? folds.get(f.path) : reviewed;
    const on = f.path === current && !onConflict;
    const since = delta && st?.state === 'changed' ? st.since : null;
    // The shared file card (reader.js), with the status letter, Changed and "since abc1234".
    const block: FileBlock = fileCard({
      path: f.path, shown: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, add: f.add || 0, del: f.del || 0, cls: on ? '.active' : '',
      checked: reviewed, checkLabel: `Reviewed ${f.path}`, checkTip: reviewed ? 'Reviewed (V to undo)' : 'Mark reviewed (V)',
      onCheck: () => { select(f.path, false); tick(f.path); },
      collapsed: folded, onToggle: () => { select(f.path, false); fold(f.path); },
      lead: [statusBadge(f.status)],
      tail: [st?.state === 'changed' ? h('span.badge.warn', { title: 'Changed since you marked it reviewed' }, 'Changed') : null, since ? h('span.muted.small', null, `since ${since.slice(0, 7)}`) : null].filter(Boolean),
    });
    block.file = f;
    block.since = since;
    if (!folded) {
      const id = diffId(f, since);
      if (diffs.has(id)) showDiff(block, diffs.get(id) ?? null);
      else if (observer) observer.observe(block);
      else fill(block);
    }
    return block;
  }
  const diffId = (f: BranchFile, since: string | null | undefined) => `${f.path}@${review?.tip}@${since || ''}`;
  function showDiff(block: FileBlock, d: FileDiff | null | undefined) {
    const f = block.file;
    if (!f) return;
    block.lastElementChild?.replaceChildren(d ? renderDiff(d, { full: fulls.has(f.path), onShowAll: () => { fulls.add(f.path); showDiff(block, d); } }) : h('div.empty', null, 'No content changes'));
  }
  // A block's diff, once it comes near the view; the same call the files column makes.
  async function fill(block: FileBlock) {
    const f = block.file;
    const r = review;
    if (!f || !r) return;
    const since = block.since;
    const id = diffId(f, since);
    if (diffs.has(id)) return showDiff(block, diffs.get(id) ?? null);
    block.lastElementChild?.replaceChildren(loading('Loading diff…'));
    try {
      const d = await (since ? git('commitFileDiff', r.tip, { path: f.path }, since) : git('commitFileDiff', r.tip, fileRef(f), r.mergeBase));
      diffs.set(id, d);
      if (block.isConnected) showDiff(block, d);
    } catch (e) {
      if (block.isConnected) block.lastElementChild?.replaceChildren(h('div.empty', null, since ? 'The version you reviewed is gone (garbage-collected or never fetched here).' : 'Couldn’t load the diff', h('div.muted.small', null, (e as Error).message)));
    }
  }
  // One file's block again, in place (after a tick or a fold), so the rest keeps its scroll.
  function reblock(path: string): FileBlock | null {
    const old = stack?.querySelector(`.review-file:not(.conflict)[data-path="${CSS.escape(path)}"]`);
    const f = review?.files.find((x) => x.path === path);
    if (!old || !f) return null;
    const block = fileBlock(f);
    old.replaceWith(block);
    return block;
  }
  function fold(path: string) {
    const f = review?.files.find((x) => x.path === path);
    if (!f) return;
    const now = folds.has(path) ? folds.get(path) : states.get(path)?.state === 'reviewed';
    folds.set(path, !now);
    reblock(path);
    // Folding a file whose header was stuck at the top: bring its header back into view.
    const b = stack?.querySelector(`.review-file:not(.conflict)[data-path="${CSS.escape(path)}"]`);
    if (b && b.getBoundingClientRect().top < el.getBoundingClientRect().top) b.scrollIntoView({ block: 'start' });
    b?.querySelector<HTMLElement>('.review-file-fold')?.focus({ preventScroll: true });
  }

  async function renderFile() {
    if (stacked) return;
    const c = onConflict ? conflicts?.find((x) => x.path === current) : null;
    if (c) return renderConflict(c);
    const f = review?.files.find((x) => x.path === current);
    const n = ++seq;
    if (!f || !review) { main.replaceChildren(h('div.empty', null, review ? 'Pick a file' : '')); return; }
    const st = states.get(f.path);
    const since = delta && st?.state === 'changed' ? st.since : null;
    main.replaceChildren(loading('Loading diff…'));
    // A delta diffs the file from the tip it was ticked at; the whole review from the merge-base.
    const d = await (since ? git('commitFileDiff', review.tip, { path: f.path }, since) : git('commitFileDiff', review.tip, fileRef(f), review.mergeBase))
      .catch((e: Error) => { if (n === seq) main.replaceChildren(h('div.empty', null, since ? 'The version you reviewed is gone (garbage-collected or never fetched here).' : 'Couldn’t load the diff', h('div.muted.small', null, e.message))); return undefined; });
    if (n !== seq || d === undefined) return;
    main.replaceChildren(
      h('div.diff-head', null, statusBadge(f.status), h('span.mono', null, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path),
        since ? h('span.muted', null, `since ${since.slice(0, 7)}`) : null,
        h('span.spacer'),
        h('button.btn.ghost.small', { onclick: () => tick(f.path) }, st?.state === 'reviewed' ? 'Mark not reviewed' : 'Mark reviewed', kbd(...(keymap.keys('review.tick') ?? [])))),
      h('div.diff-scroll', null, d ? renderDiff(d, { full, onShowAll: () => { full = true; renderFile(); } }) : h('div.empty', null, 'No content changes')),
    );
  }

  function select(path: string | null, scroll = true, conflict = false) {
    if (path === current && conflict === onConflict) return;
    current = path;
    onConflict = conflict;
    full = false;
    if (stacked) {
      stack?.querySelectorAll<HTMLElement>('.review-file').forEach((b) => b.classList.toggle('active', b.dataset.path === path && (b.dataset.conflict === '1') === conflict));
      if (scroll) stack?.querySelector('.review-file.active')?.scrollIntoView({ block: 'start' });
      return;
    }
    listEl.querySelectorAll<HTMLElement>('.review-row').forEach((r) => { const on = r.dataset.path === path && (r.dataset.conflict === '1') === conflict; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    if (scroll) listEl.querySelector('.review-row.active')?.scrollIntoView({ block: 'nearest' });
    return renderFile();
  }
  function move(d: number) {
    const list = entries();
    const i = list.findIndex((e) => e.path === current && e.c === onConflict);
    const e = list[Math.max(0, Math.min(list.length - 1, i + d))];
    if (e) select(e.path, true, e.c);
  }

  // Reads the conflicts against the base once per base and tip (AK-305).
  async function loadConflicts() {
    if (!review) return;
    const at = `${review.baseSha} ${review.tip}`;
    if (!checkConflicts || conflictsAt === at) return;
    conflictsAt = at;
    const res = await git('mergeConflicts', review.baseSha, review.tip).catch(() => null);
    if (!el.isConnected || conflictsAt !== at) return;
    conflicts = res?.files || [];
    onConflicts(conflicts);
    renderList();
    if (jump) showConflicts();
    else if (onConflict) renderFile();
  }

  // Go to line (AK-530): an annotation's or a review thread's line in the file's diff, centred and
  // flashed; the nearest shown line when that one isn't in a hunk. False when the file isn't here.
  const hasFile = (path: string) => Boolean(review?.files.some((f) => f.path === path));
  async function goToLine(path: string, line: number): Promise<boolean> {
    if (!hasFile(path)) return false;
    if (delta) { delta = false; renderList(); }
    let box: FileBlock | null | undefined;
    if (stacked) {
      if (folds.has(path) ? folds.get(path) : states.get(path)?.state === 'reviewed') fold(path);
      select(path, false);
      box = stack?.querySelector<FileBlock>(`.review-file:not(.conflict)[data-path="${CSS.escape(path)}"]`);
      if (!box) return false;
      if (!box.querySelector('.diff')) await fill(box);
      if (!fulls.has(path) && box.querySelector('.diff-more') && box.file) { fulls.add(path); showDiff(box, diffs.get(diffId(box.file, box.since))); }
    } else {
      if (current !== path || onConflict) await select(path, true);
      else if (!main.querySelector('.diff')) await renderFile();
      if (!full && main.querySelector('.diff-more')) { full = true; await renderFile(); }
      box = main;
    }
    const rows = [...box.querySelectorAll('.dl')].map((r) => ({ r, n: Number(r.children[1]?.textContent) })).filter((x) => x.n > 0);
    if (!rows.length) return true;
    const at = rows.reduce((a, b) => (Math.abs(b.n - line) < Math.abs(a.n - line) ? b : a));
    at.r.scrollIntoView({ block: 'center' });
    at.r.classList.add('flash');
    setTimeout(() => at.r.classList.remove('flash'), 1200);
    return true;
  }

  // The row note "Conflicts in N files": select the first conflicting file, its group in view.
  function showConflicts() {
    if (!conflicts) { jump = true; return; }
    jump = false;
    if (delta) { delta = false; renderList(); renderFile(); }
    if (!conflicts.length) return;
    select(conflicts[0]!.path, false, true);
    listRoot?.querySelector('.review-files-group.conflicting')?.scrollIntoView({ block: 'start' });
  }

  function computeStates() { if (review) states = new Map(fileStates(saved, review).map((s) => [s.path, s])); }

  // Ticking moves on to the next file still to review, the way you read a pull request.
  function tick(path: string | null) {
    if (!review || !path) return;
    saved = toggleTick(saved, review, path);
    writeTicks(store, key, saved);
    const ticked = saved.files[path]?.blob != null;
    computeStates();
    const files = shown();
    const i = files.findIndex((f) => f.path === path);
    const next = ticked ? files.slice(i + 1).find((f) => states.get(f.path)?.state !== 'reviewed') : null;
    const was = current;
    if (stacked) {
      // Ticking folds the file's code; unticking shows it again. Delta mode drops it from the list.
      // The ticked header stays put and the next file comes up under it (AK-523), so V reads on.
      const card = stack?.querySelector<HTMLElement>(`.review-file:not(.conflict)[data-path="${CSS.escape(path)}"]`);
      const shut = Boolean(ticked && !delta && card && !card.classList.contains('folded'));
      // A file already folded by hand swaps in place too (AK-524): no scroll to the next file.
      const inPlace = Boolean(ticked && !delta && card && !shut);
      const nudge = () => stack?.querySelector('.review-file.active > .review-file-head')?.scrollIntoView({ block: 'nearest' });
      folds.delete(path);
      if (delta) renderStack(); else { if (!shut) reblock(path)?.classList.toggle('just-ticked', inPlace); renderMeta(); }
      if (!next || next.path === current) { if (shut) foldShut(card, el, () => reblock(path)); return; }
      if (!shut && !inPlace) return select(next.path);
      select(next.path, false);
      if (inPlace) return nudge();
      foldShut(card, el, () => { const block = reblock(path); nudge(); return block; });
      return;
    }
    const focused = el.contains(document.activeElement);
    renderList(); // may move `current` when the ticked file leaves the list
    if (next && next.path !== current) { current = null; select(next.path); }
    else if (current !== was || path === current) renderFile();
    listEl.querySelector('.review-row.active')?.scrollIntoView({ block: 'nearest' });
    // The re-render removed the clicked tick button: keep the view's keys working.
    if (focused && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }

  function toggleDelta() {
    if (!delta && ![...states.values()].some((s) => s.state === 'changed')) return toast('Nothing changed since you last looked');
    delta = !delta;
    renderList();
    renderFile();
  }

  async function load(): Promise<void> {
    let r: BranchReview;
    try { r = await git('branchReview', lane.rev, base || undefined); } catch (e) {
      if (fallback) { base = fallback; fallback = null; return load(); } // the stacked PR's base isn't fetched here
      if (!review) (stack ?? main).replaceChildren(h('div.empty', null, 'Couldn’t review this branch', h('div.muted.small', null, (e as Error).message)));
      return;
    }
    if (!el.isConnected) return;
    const moved = review && review.tip !== r.tip;
    review = r;
    if (moved) diffs.clear();
    saved = readTicks(store, key); // another window may have ticked files
    const s = refreshSummary(saved, review);
    if (s) { saved = s; writeTicks(store, key, saved); }
    computeStates();
    if (delta && ![...states.values()].some((x) => x.state === 'changed')) delta = false;
    onReview?.(review);
    renderList();
    if (moved || !main.querySelector('.diff-scroll')) renderFile();
    loadConflicts();
  }

  el.addEventListener('keydown', (e) => {
    // Stacked, the view is Review's reader (AK-381): , and . jump between files; the other reader
    // keys (↑/↓ scroll, ←/→ step the list, Esc) go up to the pane (review-pane.js, reader.js).
    if (stacked) {
      const r = keymap.match('reader', e);
      if (r === 'reader.nextFile' || r === 'reader.prevFile') { e.preventDefault(); e.stopPropagation(); move(r === 'reader.nextFile' ? 1 : -1); return; }
      if (r) return;
    }
    const id = keymap.match('review', e);
    // ↵ on a focused button (a file's chevron or tick) presses it rather than running the pane's ↵.
    if (id === 'review.checkout' && e.target !== el && (e.target as Element | null)?.closest?.('button')) return;
    if (id && onKey?.(id)) { e.preventDefault(); e.stopPropagation(); return; }
    if (!id || (!pr && prActionFor(id) && id !== 'review.merge')) return;
    e.preventDefault();
    e.stopPropagation();
    if (id === 'review.close') onClose();
    else if (pr && prActionFor(id)) onPrAction(prActionFor(id) ?? '');
    else if (id === 'review.merge' && onMerge) onMerge();
    else if (id === 'review.next') move(1);
    else if (id === 'review.prev') move(-1);
    else if (id === 'review.tick') { if (!onConflict) tick(current); }
    else if (id === 'review.delta') toggleDelta();
  });

  // Called on every repo change: debounced; picks up a moved tip and re-checks the ticks.
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.isConnected) load(); }, 400);
  }

  setTimeout(() => { if (!embedded) el.focus({ preventScroll: true }); load(); });
  return { el, refresh, showConflicts, hasFile, goToLine, setDraft };
}
