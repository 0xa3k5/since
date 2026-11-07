import { h, icon, kbd, loading, toast, timeAgo, avatar } from '../lib/ui.ts';
import { renderDiff, statusBadge, fileRef } from '../commit/diff.js';
import * as keymap from '../palette/keymap.ts';
import { up } from '../lib/upcalls.ts';
import { state } from '../lib/app-helpers.ts';
import { git } from '../lib/bridge.ts';
import { openFileHistory, withHistoryMenu } from '../history/file-history.js';

// Quick view (full-height commit inspector)

// `back` is the file history the commit was opened from; Esc returns to it.
function openQuick(...args) { return up.go(() => openQuickNow(...args)); }
function openQuickNow(sha, path, back = null) {
  if (!sha) return;
  state.fileHistory = null;
  state.review = null;
  state.quick = { sha, path, back };
  up.renderTopbar();
  up.renderView();
}
function closeQuick(...args) { return up.go(() => closeQuickNow(...args)); }
// `back` is { path } (File History) or { review, lanes } (Review, the page or the lanes row it was on).
function closeQuickNow() {
  const sha = state.quick?.sha;
  const back = state.quick?.back;
  if (back?.path) return openFileHistory(back.path);
  state.quick = null;
  if (back && 'review' in back) { state.review = back.review; up.lanesPlace = back.lanes; up.renderTopbar(); up.renderView(); return; }
  up.renderTopbar();
  up.renderView();
  if (sha) up.selectCommit(sha, 'center');
}

function quickView({ sha, path }) {
  const el = h('div.quick');
  const side = h('div.quick-side');
  const main = h('div.quick-main', null, loading('Loading commit…'));
  el.append(side, main);
  let files = [];
  let current = path;
  let full = false;

  (async () => {
    const c = await up.loadCommit(sha).catch((e) => { main.replaceChildren(h('div.empty', null, e.message)); return null; });
    if (!c) return;
    files = c.files;
    if (!current && files[0]) current = files[0].path;
    side.replaceChildren(
      h('div.quick-head', null,
        h('button.btn.ghost.small', { onclick: closeQuick }, icon('chevron', 12), 'Back', kbd(...keymap.keys('quick.close'))),
        h('div.quick-title', null, c.message.split('\n')[0]),
        h('div.quick-meta', null, avatar(c.author, c.email, 16), c.author, ' · ', timeAgo(c.time), ' · ', h('span.mono', null, c.sha.slice(0, 7))),
      ),
      h('div.file-list', null, files.map((f) => {
        const r = withHistoryMenu(up.fileRow(f, () => { current = f.path; full = false; renderFile(); markActive(); }), f);
        r.dataset.path = f.path;
        return r;
      })),
    );
    markActive();
    renderFile();
  })();

  function markActive() { side.querySelectorAll('.file-row').forEach((r) => r.classList.toggle('active', r.dataset.path === current)); }

  async function renderFile() {
    const f = files.find((x) => x.path === current);
    if (!f) { main.replaceChildren(h('div.empty', null, 'No changes in this commit')); return; }
    main.replaceChildren(loading('Loading diff…'));
    const c = await up.loadCommit(sha);
    if (state.quick?.sha === sha) Object.assign(state.quick, { file: f, parent: c.parents[0] || null });
    const d = await git('commitFileDiff', sha, fileRef(f), c.parents[0] || null).catch((e) => { toast('Diff failed', { kind: 'error', detail: e.message }); return null; });
    main.replaceChildren(
      h('div.diff-head', null, statusBadge(f.status), h('span.mono', null, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path), h('span.spacer'),
        h('span.stat.small', null, h('span.add', null, '+' + f.add), h('span.del', null, '−' + f.del))),
      h('div.diff-scroll', null, renderDiff(d, { full, onShowAll: () => { full = true; renderFile(); } })),
    );
  }

  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    const id = keymap.match('quick', e);
    if (id === 'quick.close') { e.preventDefault(); closeQuick(); }
    if (id === 'quick.next' || id === 'quick.prev') {
      e.preventDefault();
      const i = files.findIndex((f) => f.path === current);
      const n = Math.max(0, Math.min(files.length - 1, i + (id === 'quick.next' ? 1 : -1)));
      if (files[n]) { current = files[n].path; full = false; markActive(); renderFile(); side.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' }); }
    }
  });
  setTimeout(() => el.focus());
  return el;
}

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { openQuick });

export { quickView, openQuick, closeQuick };
