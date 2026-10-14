import { h, icon } from './ui.js';
import { findColors } from './colors.js';
import { submoduleChange, describeSubmoduleChange } from './submodule.js';

const LIMIT = 4000;

// While drag-selecting lines, a pointer within EDGE px of the scroll pane's top or bottom scrolls it, faster
// the closer it gets (or the further past the edge): pixels to scroll this frame, negative is up.
const EDGE = 32;
export function edgeScroll(y, top, bottom) {
  const d = y < top + EDGE ? y - (top + EDGE) : y > bottom - EDGE ? y - (bottom - EDGE) : 0;
  return Math.max(-EDGE, Math.min(EDGE, Math.round(d / 2)));
}

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
// in `selection` (keys "hunk:line"), shift-click selects a range, and
// click-and-drag selects (or, starting on a selected line, deselects) every line passed over.
export function renderDiff(diff, { selectable = false, selection = new Set(), onSelect, hunkActions, full = false, onShowAll } = {}) {
  const root = h('div.diff');
  if (!diff) return h('div.diff-empty', null, 'No changes');
  if (diff.binary) return h('div.diff-empty', null, icon('file'), 'Binary file');
  const sub = submoduleChange(diff);
  if (sub) return h('div.diff-empty.diff-submodule', null, icon('submodule'), h('span', null, 'Submodule pointer: ', h('span.mono', { title: [sub.from, sub.to].filter(Boolean).join(' → ') }, describeSubmoduleChange(sub))));
  if (!diff.hunks.length) {
    const meta = diff.header.filter((l) => /^(old|new) mode|^rename|^similarity|^new file|^deleted file/.test(l));
    return h('div.diff-empty', null, meta.length ? meta.join(' · ') : 'Empty file');
  }
  let anchor = null;
  let drag = null; // { from, to, add, before }: an in-progress click-and-drag over lines
  let count = 0;
  const changeKeys = [];
  diff.hunks.forEach((hunk, hi) => hunk.lines.forEach((l, li) => { if (l.t !== ' ') changeKeys.push(`${hi}:${li}`); }));
  const setRange = (from, to, add) => {
    const a = changeKeys.indexOf(from), b = changeKeys.indexOf(to);
    const [x, y] = a < b ? [a, b] : [b, a];
    for (let i = x; i <= y; i++) add ? selection.add(changeKeys[i]) : selection.delete(changeKeys[i]);
  };
  const paint = () => root.querySelectorAll('.dl.pick').forEach((el) => el.classList.toggle('sel', selection.has(el.dataset.key)));
  let pointerY = 0, frame = 0;
  const scrollTick = () => {
    frame = 0;
    const pane = drag && root.closest('.diff-scroll');
    if (!pane) return;
    const r = pane.getBoundingClientRect();
    const dy = edgeScroll(pointerY, r.top, r.bottom);
    if (!dy) return;
    pane.scrollTop += dy; // the row now under the pointer gets mouseenter and extends the drag
    frame = requestAnimationFrame(scrollTick);
  };
  const dragMove = (e) => { pointerY = e.clientY; if (!frame) frame = requestAnimationFrame(scrollTick); };
  const endDrag = () => {
    drag = null;
    cancelAnimationFrame(frame); frame = 0;
    document.removeEventListener('mousemove', dragMove);
  };

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
          if (e.button !== 0) return;
          e.preventDefault();
          if (e.shiftKey && anchor) {
            const add = !selection.has(key) || selection.has(anchor);
            setRange(anchor, key, add);
          } else {
            const add = !selection.has(key);
            drag = { from: key, to: key, add, before: new Set(selection) };
            add ? selection.add(key) : selection.delete(key);
            anchor = key;
            document.addEventListener('mouseup', endDrag, { once: true });
            document.addEventListener('mousemove', dragMove);
          }
          paint();
          onSelect?.(selection);
        });
        row.addEventListener('mouseenter', (e) => {
          if (drag && !(e.buttons & 1)) endDrag(); // released outside the window
          if (!drag || drag.to === key) return;
          drag.to = key;
          // Rebuild from the pre-drag selection so dragging back un-applies rows.
          selection.clear();
          drag.before.forEach((k) => selection.add(k));
          setRange(drag.from, key, drag.add);
          paint();
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
