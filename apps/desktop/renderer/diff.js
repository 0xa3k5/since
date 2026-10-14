import { h, icon } from './ui.js';
import { findColors } from './colors.js';

const LIMIT = 4000;

// Colour swatches before CSS colour codes (View → Show Colour Swatches in Diffs).
let swatches = true;
export function setSwatches(on) { swatches = on; }

// Code text with a swatch before each colour code. Swatches have no text, so copy/paste is unchanged.
function codeSpan(s) {
  const found = swatches ? findColors(s) : [];
  if (!found.length) return h('span.code', null, s || '\u200b');
  const parts = [];
  let at = 0;
  for (const c of found) {
    if (c.start > at) parts.push(s.slice(at, c.start));
    parts.push(h('span.swatch', { title: c.value, 'aria-hidden': 'true' }, h('i', { style: { background: c.value } })), s.slice(c.start, c.end));
    at = c.end;
  }
  if (at < s.length) parts.push(s.slice(at));
  return h('span.code', null, ...parts);
}

// Render a parsed file diff. When `selectable`, clicking +/- lines toggles them
// in `selection` (keys "hunk:line"), shift-click selects a range.
export function renderDiff(diff, { selectable = false, selection = new Set(), onSelect, hunkActions, full = false, onShowAll } = {}) {
  const root = h('div.diff');
  if (!diff) return h('div.diff-empty', null, 'No changes');
  if (diff.binary) return h('div.diff-empty', null, icon('file'), 'Binary file');
  if (!diff.hunks.length) {
    const meta = diff.header.filter((l) => /^(old|new) mode|^rename|^similarity|^new file|^deleted file/.test(l));
    return h('div.diff-empty', null, meta.length ? meta.join(' · ') : 'Empty file');
  }
  let anchor = null;
  let count = 0;
  const changeKeys = [];
  diff.hunks.forEach((hunk, hi) => hunk.lines.forEach((l, li) => { if (l.t !== ' ') changeKeys.push(`${hi}:${li}`); }));

  for (let hi = 0; hi < diff.hunks.length; hi++) {
    const hunk = diff.hunks[hi];
    const head = h('div.hunk-head', null,
      h('span.hunk-range', null, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
      h('span.hunk-ctx', null, hunk.context),
      hunkActions ? h('span.hunk-actions', null, hunkActions(hi, hunk)) : null,
    );
    root.append(head);
    const body = h('div.hunk');
    for (let li = 0; li < hunk.lines.length; li++) {
      if (!full && count++ > LIMIT) {
        root.append(body, h('button.diff-more', { onclick: onShowAll }, `Diff truncated — show all ${changeKeys.length} changes`));
        return root;
      }
      const l = hunk.lines[li];
      const key = `${hi}:${li}`;
      const cls = l.t === '+' ? '.add' : l.t === '-' ? '.del' : '';
      const sel = selectable && l.t !== ' ' && selection.has(key);
      const row = h('div.dl' + cls + (sel ? '.sel' : '') + (selectable && l.t !== ' ' ? '.pick' : ''), null,
        h('span.ln', null, l.o ?? ''),
        h('span.ln', null, l.n ?? ''),
        h('span.sign', null, l.t === ' ' ? '' : l.t),
        codeSpan(l.s),
        l.noEol ? h('span.noeol', { title: 'No newline at end of file' }, '⏎̸') : null,
      );
      if (selectable && l.t !== ' ') {
        row.dataset.key = key;
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (e.shiftKey && anchor) {
            const a = changeKeys.indexOf(anchor), b = changeKeys.indexOf(key);
            const [x, y] = a < b ? [a, b] : [b, a];
            const add = !selection.has(key) || selection.has(anchor);
            for (let i = x; i <= y; i++) add ? selection.add(changeKeys[i]) : selection.delete(changeKeys[i]);
          } else {
            selection.has(key) ? selection.delete(key) : selection.add(key);
            anchor = key;
          }
          root.querySelectorAll('.dl.pick').forEach((el) => el.classList.toggle('sel', selection.has(el.dataset.key)));
          onSelect?.(selection);
        });
      }
      body.append(row);
    }
    root.append(body);
  }
  return root;
}

export function hunkKeys(hunk, hi) {
  const out = [];
  hunk.lines.forEach((l, li) => { if (l.t !== ' ') out.push(`${hi}:${li}`); });
  return out;
}

export function statusLabel(s) {
  return { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict', '?': 'Untracked' }[s] || s;
}

export function statusBadge(s) {
  const map = { M: 'mod', A: 'add', '?': 'add', D: 'del', R: 'ren', C: 'ren', T: 'mod', U: 'con' };
  return h('span.fstatus.' + (map[s] || 'mod'), { title: statusLabel(s) }, s === '?' ? 'U' : s === 'U' ? '!' : s);
}

export function fileName(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? [p, ''] : [p.slice(i + 1), p.slice(0, i)];
}

// The fields of a file entry that file IPC calls accept (ipc.js fileEntry). Commit files also
// carry numstat counts (add/del/binary), which the strict validator rejects.
export function fileRef(f) {
  const r = { path: f.path };
  for (const k of ['oldPath', 'status', 'xy']) if (f[k] != null) r[k] = f[k];
  return r;
}
