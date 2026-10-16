import { h, icon, kbd, toast, loading, avatar } from './ui.js';
import { prAvatar } from './pr-avatars.js';
import { renderDiff, statusBadge, fileName, fileRef } from './diff.js';
import { storeKey, readTicks, writeTicks, fileStates, toggleTick, refreshSummary } from './review.js';
import * as keymap from './keymap.js';
import { prStatusLine } from './prs.js';
import { PR_ACTIONS, prActionFor } from './pr-review.js';

// Review a branch: its whole change against the base (from the merge-base, as a pull request
// shows it), one file at a time, with a "reviewed" tick per file (review.js has the rules).
// The delta toggle narrows the list to files changed since they were ticked and diffs each one
// from the tip it was ticked at to the current tip.

// lane: { key, name, rev } (key from lanes.laneKey; rev is the branch or the detached head).
// git(method, ...args) calls the main process; store is localStorage; onClose() goes back;
// onMerge() merges and tidies the branch (null: not offered, e.g. a detached head).
// pr: an Inbox pull request (pr-review.js): the head shows its author and checks, and
// onPrAction(id) runs approve / changes / merge / close / checkout (PR_ACTIONS) on it.
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
// ↑/↓ move between files, diffs load as their blocks come near the view.
// checkConflicts: the branch is known to conflict with its base (AK-305), so the files
// start with a Conflicting group (git mergeConflicts, merge-tree, read-only) and a conflicting file
// shows the base side against the branch's side. onConflicts(files) reports what it found.
export function reviewView({ lane, base, root, git, store, onClose, onMerge = null, pr = null, onPrAction = () => {}, header = null, embedded = false, onKey = null, checkConflicts = false, onConflicts = () => {} }) {
  const key = storeKey(root, lane.key);
  let review = null;
  let saved = readTicks(store, key);
  let states = new Map();
  let current = null;
  let delta = false;
  let full = false;
  let seq = 0;
  let timer = 0;
  let conflicts = null; // [{ path, hunks, inBase, inHead }] once read (checkConflicts)
  let onConflict = false; // `current` is its Conflicting entry, not its Changed one
  let jump = false; // showConflicts() before the conflicts were read
  let conflictsAt = null;

  const stacked = Boolean(header); // per-file blocks instead of a files column (AK-373)
  const diffs = new Map(); // stacked: `${path}@${tip}@${since}` → diff, so re-renders keep their height
  const folds = new Map(); // stacked: path → folded, set by hand; otherwise reviewed files are folded
  const fulls = new Set(); // stacked: files showing every line (Show all)
  let observer = null;
  const meta = h('div.quick-meta');
  const deltaBtn = h('button.chip', { title: 'Only files changed since you last looked (D)', onclick: () => toggleDelta() }, 'Changed since last look');
  const listEl = h('div.file-list.review-list', { role: 'listbox', 'aria-label': 'Files' });
  // With a header, the progress line (reviewed count, Changed since last look) sits under it once,
  // across the pane; the files column is just the list.
  const side = h('div.quick-side.review-side', null,
    header ? null : h('div.quick-head', null,
      embedded ? null : h('button.btn.ghost.small', { onclick: onClose }, icon('chevron', 12), 'Back', kbd(...keymap.keys('review.close'))),
      h('div.quick-title', { title: lane.name }, icon(pr ? 'merge' : 'branch', 14), ' ', lane.name),
      pr ? h('div.quick-meta.review-pr', null, pr.author ? avatar(pr.authorName || pr.author, pr.author, 16, prAvatar(pr.author)) : null, [pr.author ? `by ${pr.authorName || pr.author}` : null, `${pr.branch} → ${pr.base}`, prStatusLine(pr) || null].filter(Boolean).join(' · ')) : null,
      meta,
      h('div.review-tools', null, deltaBtn, !pr && onMerge ? h('button.chip', { title: 'Merge and tidy (M)', onclick: () => onMerge() }, 'Merge and tidy…') : null),
      pr ? h('div.review-tools.review-pr-actions', null, PR_ACTIONS.map((a) => h('button.chip' + (a.danger ? '.danger' : ''), { title: a.id === 'checkout' ? 'Check out as a new lane (undoable)' : 'Happens on GitHub: ⌘Z can’t undo it', onclick: () => onPrAction(a.id) }, icon(a.icon, 12), a.label, kbd(...keymap.keys(a.key))))) : null),
    listEl,
    embedded ? null : h('div.diff-hint', null, pr ? 'V Reviewed · D Changed only · A Approve · C Request changes · M Merge · X Close · ↵ Check out · Esc Back' : `V Reviewed · D Changed only${onMerge ? ' · M Merge and tidy' : ''} · ↑/↓ Move · Esc Back`),
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
    ].filter(Boolean));
    deltaBtn.classList.toggle('on', delta);
    deltaBtn.disabled = !changed && !delta;
  }

  function row(f) {
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

  function conflictRow(f) {
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
    const group = (label, n, cls = '') => h('div.lanes-group.review-files-group' + cls, { role: 'presentation' }, label, h('span.review-files-n', null, String(n)));
    listEl.replaceChildren(...(cs.length ? [group('Conflicting', cs.length, '.conflicting'), ...cs.map(conflictRow), group('Changed', files.length)] : []), ...files.map(row));
    if (!files.length) listEl.append(h('div.empty', null, delta ? 'Nothing changed since you last looked.' : 'No changes against the base.'));
    renderMeta();
  }

  // A conflicting file: each hunk's base side next to the branch's side, between a few lines of
  // context, with the markers git would write (conflict editor styles, cf-*).
  function renderConflict(f) {
    ++seq;
    const headName = pr ? `#${pr.number}` : lane.rev;
    main.replaceChildren(
      h('div.diff-head', null, h('span.badge.warn', null, 'Conflict'), h('span.mono', null, f.path), h('span.spacer'),
        h('span.muted', null, `${review.base || 'base'} ← ${headName}`)),
      h('div.diff-scroll', null, conflictBody(f)),
    );
  }
  function conflictBody(f) {
    const baseName = review.base || 'base';
    const headName = pr ? `#${pr.number}` : lane.rev;
    const text = (cls) => (l) => h('div.cf-line' + cls, null, l || ' ');
    const marker = (m) => h('div.cf-line.cf-marker', null, m);
    const side = (cls, name, list, open, close) => h('div.cf-col' + cls, null,
      h('div.cf-col-head', null, name), marker(open), ...(list.length ? list.map(text('')) : [h('div.cf-none', null, 'Nothing on this side')]), close ? marker(close) : null);
    const hunk = (k, i) => h('div.cf-block', null,
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
      for (const x of xs) if (x.isIntersecting) { observer.unobserve(x.target); fill(x.target); }
    }, { root: el, rootMargin: '800px 0px' }) : null;
    const group = (label, n, cls = '') => h('div.lanes-group.review-files-group' + cls, { role: 'presentation' }, label, h('span.review-files-n', null, String(n)));
    stack.replaceChildren(...(cs.length ? [group('Conflicting', cs.length, '.conflicting'), ...cs.map(conflictBlock), group('Changed', files.length)] : []), ...files.map(fileBlock));
    if (!files.length) stack.append(h('div.empty', null, delta ? 'Nothing changed since you last looked.' : 'No changes against the base.'));
    el.scrollTop = y;
    renderMeta();
  }

  function conflictBlock(f) {
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

  function fileBlock(f) {
    const st = states.get(f.path);
    const reviewed = st?.state === 'reviewed';
    const folded = folds.has(f.path) ? folds.get(f.path) : reviewed;
    const on = f.path === current && !onConflict;
    const since = delta && st?.state === 'changed' ? st.since : null;
    const body = folded ? null : h('div.review-file-body');
    const block = h('section.review-file' + (on ? '.active' : '') + (reviewed ? '.reviewed' : '') + (folded ? '.folded' : ''), { role: 'listitem', 'data-path': f.path, 'aria-label': f.path },
      h('div.review-file-head', {
        title: `${f.path}\n${folded ? 'Click to show the code' : 'Click to fold'}`,
        onclick: () => { select(f.path, false); fold(f.path); },
      },
        h('button.review-file-fold', {
          'aria-expanded': String(!folded), 'aria-label': `${folded ? 'Show' : 'Fold'} ${f.path}`,
          onclick: (e) => { e.stopPropagation(); select(f.path, false); fold(f.path); },
        }, icon(folded ? 'chevron' : 'chevronDown', 12)),
        h('button.review-tick' + (reviewed ? '.on' : ''), {
          role: 'checkbox', 'aria-checked': String(reviewed), 'aria-label': `Reviewed ${f.path}`,
          title: reviewed ? 'Reviewed (V to undo)' : 'Mark reviewed (V)',
          onclick: (e) => { e.stopPropagation(); select(f.path, false); tick(f.path); },
        }, reviewed ? icon('check', 12) : null),
        statusBadge(f.status),
        h('span.mono.review-file-path', null, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path),
        st?.state === 'changed' ? h('span.badge.warn', { title: 'Changed since you marked it reviewed' }, 'Changed') : null,
        since ? h('span.muted.small', null, `since ${since.slice(0, 7)}`) : null,
        h('span.spacer'),
        f.add || f.del ? h('span.stat.small', null, h('span.add', null, `+${f.add || 0}`), h('span.del', null, `−${f.del || 0}`)) : null),
      body);
    block.file = f;
    block.since = since;
    if (body) {
      const id = diffId(f, since);
      if (diffs.has(id)) showDiff(block, diffs.get(id));
      else if (observer) observer.observe(block);
      else fill(block);
    }
    return block;
  }
  const diffId = (f, since) => `${f.path}@${review?.tip}@${since || ''}`;
  function showDiff(block, d) {
    const f = block.file;
    block.lastChild.replaceChildren(d ? renderDiff(d, { full: fulls.has(f.path), onShowAll: () => { fulls.add(f.path); showDiff(block, d); } }) : h('div.empty', null, 'No content changes'));
  }
  // A block's diff, once it comes near the view; the same call the files column makes.
  async function fill(block) {
    const f = block.file;
    const since = block.since;
    const id = diffId(f, since);
    if (diffs.has(id)) return showDiff(block, diffs.get(id));
    block.lastChild.replaceChildren(loading('Loading diff…'));
    try {
      const d = await (since ? git('commitFileDiff', review.tip, { path: f.path }, since) : git('commitFileDiff', review.tip, fileRef(f), review.mergeBase));
      diffs.set(id, d);
      if (block.isConnected) showDiff(block, d);
    } catch (e) {
      if (block.isConnected) block.lastChild.replaceChildren(h('div.empty', null, since ? 'The version you reviewed is gone (garbage-collected or never fetched here).' : 'Couldn’t load the diff', h('div.muted.small', null, e.message)));
    }
  }
  // One file's block again, in place (after a tick or a fold), so the rest keeps its scroll.
  function reblock(path) {
    const old = stack.querySelector(`.review-file:not(.conflict)[data-path="${CSS.escape(path)}"]`);
    const f = review?.files.find((x) => x.path === path);
    if (old && f) old.replaceWith(fileBlock(f));
  }
  function fold(path) {
    const f = review?.files.find((x) => x.path === path);
    if (!f) return;
    const now = folds.has(path) ? folds.get(path) : states.get(path)?.state === 'reviewed';
    folds.set(path, !now);
    reblock(path);
    // Folding a file whose header was stuck at the top: bring its header back into view.
    const b = stack.querySelector(`.review-file:not(.conflict)[data-path="${CSS.escape(path)}"]`);
    if (b && b.getBoundingClientRect().top < el.getBoundingClientRect().top) b.scrollIntoView({ block: 'start' });
    b?.querySelector('.review-file-fold')?.focus({ preventScroll: true });
  }

  async function renderFile() {
    if (stacked) return;
    const c = onConflict ? conflicts?.find((x) => x.path === current) : null;
    if (c) return renderConflict(c);
    const f = review?.files.find((x) => x.path === current);
    const n = ++seq;
    if (!f) { main.replaceChildren(h('div.empty', null, review ? 'Pick a file' : '')); return; }
    const st = states.get(f.path);
    const since = delta && st?.state === 'changed' ? st.since : null;
    main.replaceChildren(loading('Loading diff…'));
    // A delta diffs the file from the tip it was ticked at; the whole review from the merge-base.
    const d = await (since ? git('commitFileDiff', review.tip, { path: f.path }, since) : git('commitFileDiff', review.tip, fileRef(f), review.mergeBase))
      .catch((e) => { if (n === seq) main.replaceChildren(h('div.empty', null, since ? 'The version you reviewed is gone (garbage-collected or never fetched here).' : 'Couldn’t load the diff', h('div.muted.small', null, e.message))); return undefined; });
    if (n !== seq || d === undefined) return;
    main.replaceChildren(
      h('div.diff-head', null, statusBadge(f.status), h('span.mono', null, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path),
        since ? h('span.muted', null, `since ${since.slice(0, 7)}`) : null,
        h('span.spacer'),
        h('button.btn.ghost.small', { onclick: () => tick(f.path) }, st?.state === 'reviewed' ? 'Mark not reviewed' : 'Mark reviewed', kbd(...keymap.keys('review.tick')))),
      h('div.diff-scroll', null, d ? renderDiff(d, { full, onShowAll: () => { full = true; renderFile(); } }) : h('div.empty', null, 'No content changes')),
    );
  }

  function select(path, scroll = true, conflict = false) {
    if (path === current && conflict === onConflict) return;
    current = path;
    onConflict = conflict;
    full = false;
    if (stacked) {
      stack.querySelectorAll('.review-file').forEach((b) => b.classList.toggle('active', b.dataset.path === path && (b.dataset.conflict === '1') === conflict));
      if (scroll) stack.querySelector('.review-file.active')?.scrollIntoView({ block: 'start' });
      return;
    }
    listEl.querySelectorAll('.review-row').forEach((r) => { const on = r.dataset.path === path && (r.dataset.conflict === '1') === conflict; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    if (scroll) listEl.querySelector('.review-row.active')?.scrollIntoView({ block: 'nearest' });
    renderFile();
  }
  function move(d) {
    const list = entries();
    const i = list.findIndex((e) => e.path === current && e.c === onConflict);
    const e = list[Math.max(0, Math.min(list.length - 1, i + d))];
    if (e) select(e.path, true, e.c);
  }

  // Reads the conflicts against the base once per base and tip (AK-305).
  async function loadConflicts() {
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

  // The row note "Conflicts in N files": select the first conflicting file, its group in view.
  function showConflicts() {
    if (!conflicts) { jump = true; return; }
    jump = false;
    if (delta) { delta = false; renderList(); renderFile(); }
    if (!conflicts.length) return;
    select(conflicts[0].path, false, true);
    listRoot.querySelector('.review-files-group.conflicting')?.scrollIntoView({ block: 'start' });
  }

  function computeStates() { states = new Map(fileStates(saved, review).map((s) => [s.path, s])); }

  // Ticking moves on to the next file still to review, the way you read a pull request.
  function tick(path) {
    if (!review || !path) return;
    saved = toggleTick(saved, review, path);
    writeTicks(store, key, saved);
    const ticked = saved.files[path]?.blob != null;
    computeStates();
    const files = shown();
    const i = files.findIndex((f) => f.path === path);
    const next = ticked ? files.slice(i + 1).find((f) => states.get(f.path).state !== 'reviewed') : null;
    const was = current;
    if (stacked) {
      // Ticking folds the file's code; unticking shows it again. Delta mode drops it from the list.
      folds.delete(path);
      if (delta) renderStack(); else { reblock(path); renderMeta(); }
      if (next && next.path !== current) { select(next.path); }
      return;
    }
    renderList(); // may move `current` when the ticked file leaves the list
    if (next && next.path !== current) { current = null; select(next.path); }
    else if (current !== was || path === current) renderFile();
    listEl.querySelector('.review-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function toggleDelta() {
    if (!delta && ![...states.values()].some((s) => s.state === 'changed')) return toast('Nothing changed since you last looked');
    delta = !delta;
    renderList();
    renderFile();
  }

  async function load() {
    let r;
    try { r = await git('branchReview', lane.rev, base || undefined); } catch (e) {
      if (!review) (stacked ? stack : main).replaceChildren(h('div.empty', null, 'Couldn’t review this branch', h('div.muted.small', null, e.message)));
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
    renderList();
    if (moved || !main.querySelector('.diff-scroll')) renderFile();
    loadConflicts();
  }

  el.addEventListener('keydown', (e) => {
    const id = keymap.match('review', e);
    // ↵ on a focused button (a file's chevron or tick) presses it rather than running the pane's ↵.
    if (id === 'review.checkout' && e.target !== el && e.target.closest?.('button')) return;
    if (id && onKey?.(id)) { e.preventDefault(); e.stopPropagation(); return; }
    if (!id || (!pr && prActionFor(id) && id !== 'review.merge')) return;
    e.preventDefault();
    e.stopPropagation();
    if (id === 'review.close') onClose();
    else if (pr && prActionFor(id)) onPrAction(prActionFor(id));
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
  return { el, refresh, showConflicts };
}
