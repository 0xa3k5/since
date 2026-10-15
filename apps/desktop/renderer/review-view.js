import { h, icon, kbd, toast, loading } from './ui.js';
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
// checkConflicts: the branch is known to conflict with its base (AK-305), so the files column
// starts with a Conflicting group (git mergeConflicts, merge-tree, read-only) and a conflicting file
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

  const meta = h('div.quick-meta');
  const deltaBtn = h('button.chip', { title: 'Only files changed since you last looked (D)', onclick: () => toggleDelta() }, 'Changed since last look');
  const listEl = h('div.file-list.review-list', { role: 'listbox', 'aria-label': 'Files' });
  // With a header, the progress line (reviewed count, Changed since last look) sits under it once,
  // across the pane; the files column is just the list.
  const side = h('div.quick-side.review-side', null,
    header ? null : h('div.quick-head', null,
      embedded ? null : h('button.btn.ghost.small', { onclick: onClose }, icon('chevron', 12), 'Back', kbd(...keymap.keys('review.close'))),
      h('div.quick-title', { title: lane.name }, icon(pr ? 'merge' : 'branch', 14), ' ', lane.name),
      pr ? h('div.quick-meta.review-pr', null, [pr.author ? `by ${pr.author}` : null, `${pr.branch} → ${pr.base}`, prStatusLine(pr) || null].filter(Boolean).join(' · ')) : null,
      meta,
      h('div.review-tools', null, deltaBtn, !pr && onMerge ? h('button.chip', { title: 'Merge and tidy (M)', onclick: () => onMerge() }, 'Merge and tidy…') : null),
      pr ? h('div.review-tools.review-pr-actions', null, PR_ACTIONS.map((a) => h('button.chip' + (a.danger ? '.danger' : ''), { title: a.id === 'checkout' ? 'Check out as a new lane (undoable)' : 'Happens on GitHub: ⌘Z can’t undo it', onclick: () => onPrAction(a.id) }, icon(a.icon, 12), a.label, kbd(...keymap.keys(a.key))))) : null),
    listEl,
    embedded ? null : h('div.diff-hint', null, pr ? 'V Reviewed · D Changed only · A Approve · C Request changes · M Merge · X Close · ↵ Check out · Esc Back' : `V Reviewed · D Changed only${onMerge ? ' · M Merge and tidy' : ''} · ↑/↓ Move · Esc Back`),
  );
  const top = header ? h('div.review-pane-top', null, header, h('div.review-progress-line', null, meta, deltaBtn)) : null;
  const main = h('div.quick-main', null, loading('Loading the branch…'));
  const el = h('div.quick.review' + (header ? '.with-header' : ''), { tabIndex: 0 }, top, side, main);

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
      st === 'changed' ? h('span.badge.warn', { title: 'Changed since you marked it reviewed' }, 'changed') : null,
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
    main.replaceChildren(
      h('div.diff-head', null, h('span.badge.warn', null, 'Conflict'), h('span.mono', null, f.path), h('span.spacer'),
        h('span.muted', null, `${review.base || 'base'} ← ${headName}`)),
      h('div.diff-scroll', null, f.hunks.length ? h('div.cf-body.review-conflict', null, ...f.hunks.map(hunk)) : h('div.empty', null, why)),
    );
  }

  async function renderFile() {
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
    listEl.querySelector('.review-files-group.conflicting')?.scrollIntoView({ block: 'start' });
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
      if (!review) main.replaceChildren(h('div.empty', null, 'Couldn’t review this branch', h('div.muted.small', null, e.message)));
      return;
    }
    if (!el.isConnected) return;
    const moved = review && review.tip !== r.tip;
    review = r;
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
