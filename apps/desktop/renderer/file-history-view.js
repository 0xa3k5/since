import { h, icon, kbd, toast, VirtualList, timeAgo, fullDate, avatar } from './ui.js';
import { blameRows, historyRows, splitPath } from './blame.js';

// File history & blame: the commits that touched a file (following renames) on the left,
// streamed in pages so long histories show up at once; the blame of the selected version on
// the right. Both lists are virtual, so 100k-commit histories and huge files stay smooth.

export const FILE_HISTORY_KEYS = { show: ['↵'], open: ['Space'], move: ['↑', '↓'], back: ['Esc'] };

const FIRST_PAGE = 200, PAGE = 1000;

// git(method, ...args) calls the main process; onShow(sha) shows a commit in the Map,
// onOpen(sha, path) opens it in the commit viewer, onClose() goes back.
export function fileHistoryView({ path, git, onShow, onOpen, onClose }) {
  const [name, dir] = splitPath(path);
  let rows = historyRows(path, []);
  let sel = 1; // HEAD's version once it's loaded; the working tree until then
  let complete = false;

  const count = h('span');
  const side = h('div.quick-side.fh-side', null,
    h('div.quick-head', null,
      h('button.btn.ghost.small', { onclick: onClose }, icon('chevron', 12), 'Back', kbd('Esc')),
      h('div.quick-title.fh-title', { title: path }, icon('file', 14), name),
      h('div.quick-meta', null, dir ? h('span.mono.fh-dir', null, dir) : null, count),
    ),
  );
  const listEl = h('div.fh-list');
  side.append(listEl);
  const blameHead = h('div.diff-head');
  const blameEl = h('div.fh-blame');
  const main = h('div.quick-main', null, blameHead, blameEl);
  const el = h('div.quick.fh', { tabIndex: 0 }, side, main);

  const list = new VirtualList(listEl, { rowHeight: 48, render: (i) => historyRow(rows[i], i) });

  function historyRow(r, i) {
    const row = h('div.fh-row' + (i === sel ? '.active' : ''), { onclick: () => select(i), ondblclick: () => r.sha && onShow(r.sha) },
      r.sha ? avatar(r.author, r.email, 18) : h('span.fh-wt', null, icon('edit', 14)),
      h('div.fh-row-text', null,
        h('div.fh-subject', null, r.subject),
        h('div.fh-meta', null, r.sha ? [h('span.mono', null, r.sha.slice(0, 7)), ` · ${r.author} · `, h('span', { title: fullDate(r.time) }, timeAgo(r.time))] : 'Uncommitted changes included',
          r.oldPath ? h('span.fh-renamed', { title: `${r.oldPath} → ${r.path}` }, ' · renamed') : null)),
    );
    return row;
  }

  function updateCount() {
    const n = rows.length - 1;
    count.textContent = complete ? `${n.toLocaleString()} commit${n === 1 ? '' : 's'}` : `Loading… ${n.toLocaleString()}`;
  }

  function select(i, scroll = false) {
    if (i < 0 || i >= rows.length) return;
    sel = i;
    list.invalidate();
    if (scroll) list.scrollToIndex(i);
    loadBlame();
  }

  // Pages through the history; stops when the view is gone (another view replaced it).
  async function loadHistory() {
    let page = { limit: FIRST_PAGE };
    while (page && el.isConnected) {
      let r;
      try { r = await git('fileHistory', path, page); } catch (e) { toast('Couldn’t read the file history', { kind: 'error', detail: e.message }); break; }
      if (!el.isConnected) return;
      const first = rows.length === 1;
      rows = rows.concat(r.entries);
      list.setCount(rows.length, { keep: true });
      if (first) { if (rows.length < 2) sel = 0; select(sel); }
      page = r.next && { ...r.next, limit: PAGE };
    }
    complete = true;
    updateCount();
    if (sel >= rows.length) select(0);
  }

  let blameToken = 0, blameTimer = 0, blameList = null;
  function loadBlame() {
    clearTimeout(blameTimer);
    const r = rows[sel], token = ++blameToken;
    blameHead.replaceChildren(
      h('span.fh-mode', null, 'Blame'),
      h('span.mono', null, r.path), h('span.muted', null, r.sha ? `at ${r.sha.slice(0, 7)}` : 'in the working tree'),
      h('span.spacer'),
      r.sha ? h('button.btn.ghost.small', { onclick: () => onShow(r.sha), title: 'Show this commit in the Map' }, 'Show in Map', kbd('↵')) : null,
      r.sha ? h('button.btn.ghost.small', { onclick: () => onOpen(r.sha, r.path), title: 'Open this commit’s changes' }, 'Open Commit', kbd('Space')) : null,
    );
    blameTimer = setTimeout(async () => {
      let b;
      try { b = await git('blame', r.path, r.sha || undefined); } catch (e) { b = { error: e.message }; }
      if (token !== blameToken || !el.isConnected) return;
      blameList?.destroy(); blameList = null;
      blameEl.replaceChildren();
      if (b.error) return blameEl.append(h('div.empty', null, r.sha ? 'Couldn’t blame this version' : 'The file isn’t in the working tree', h('div.muted.small', null, b.error)));
      if (!b.lines.length) return blameEl.append(h('div.empty', null, 'Empty file'));
      const lines = blameRows(b);
      const width = String(lines[lines.length - 1].line).length;
      blameList = new VirtualList(blameEl, { rowHeight: 20, render: (i) => blameLine(lines[i], b.commits[lines[i].commit], width) });
      blameList.setCount(lines.length);
    }, blameList ? 80 : 0);
  }

  function blameLine(l, c, width) {
    const meta = l.first && (c.uncommitted
      ? h('span.fh-gutter-text', null, 'Not committed yet')
      : h('span.fh-gutter-text', null, h('span.mono', null, c.sha.slice(0, 7)), ' ', c.author, h('span.fh-when', null, timeAgo(c.time))));
    return h('div.fh-line' + (l.first ? '.first' : ''), null,
      h(`span.fh-gutter.age-${l.age}`, {
        title: c.uncommitted ? 'Not committed yet' : `${c.summary}\n${c.author} · ${fullDate(c.time)}\n${c.sha.slice(0, 7)} — click to show in the Map`,
        onclick: c.uncommitted ? null : () => onShow(c.sha),
      }, meta || null),
      h('span.fh-num', null, String(l.line).padStart(width)),
      h('span.fh-text', null, l.text),
    );
  }

  el.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const r = rows[sel];
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); select(Math.min(rows.length - 1, sel + 1), true); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); select(Math.max(0, sel - 1), true); }
    else if (e.key === 'Enter' && r.sha) { e.preventDefault(); onShow(r.sha); }
    else if (e.key === ' ' && r.sha) { e.preventDefault(); onOpen(r.sha, r.path); }
  });

  updateCount();
  list.setCount(rows.length);
  setTimeout(() => { el.focus(); loadHistory(); });
  return el;
}
