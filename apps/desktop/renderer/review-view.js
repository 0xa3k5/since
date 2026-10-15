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
export function reviewView({ lane, base, root, git, store, onClose, onMerge = null, pr = null, onPrAction = () => {}, header = null, embedded = false, onKey = null }) {
  const key = storeKey(root, lane.key);
  let review = null;
  let saved = readTicks(store, key);
  let states = new Map();
  let current = null;
  let delta = false;
  let full = false;
  let seq = 0;
  let timer = 0;

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
    return h('div.file-row.review-row' + (f.path === current ? '.active' : '') + (st === 'reviewed' ? '.reviewed' : ''), {
      role: 'option', 'aria-selected': String(f.path === current), 'data-path': f.path, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
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

  function renderList() {
    const files = shown();
    if (!files.some((f) => f.path === current)) current = files[0]?.path || null;
    listEl.replaceChildren(...files.map(row));
    if (!files.length) listEl.append(h('div.empty', null, delta ? 'Nothing changed since you last looked.' : 'No changes against the base.'));
    renderMeta();
  }

  async function renderFile() {
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

  function select(path, scroll = true) {
    if (path === current) return;
    current = path;
    full = false;
    listEl.querySelectorAll('.review-row').forEach((r) => { const on = r.dataset.path === path; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    if (scroll) listEl.querySelector('.review-row.active')?.scrollIntoView({ block: 'nearest' });
    renderFile();
  }
  function move(d) {
    const files = shown();
    const i = files.findIndex((f) => f.path === current);
    const f = files[Math.max(0, Math.min(files.length - 1, i + d))];
    if (f) select(f.path);
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
    else if (id === 'review.tick') tick(current);
    else if (id === 'review.delta') toggleDelta();
  });

  // Called on every repo change: debounced; picks up a moved tip and re-checks the ticks.
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.isConnected) load(); }, 400);
  }

  setTimeout(() => { if (!embedded) el.focus({ preventScroll: true }); load(); });
  return { el, refresh };
}
