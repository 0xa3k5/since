import { h, icon, type Child } from '../lib/ui.ts';
import { statusBadge, fileName, fileRef, codeSpan } from './diff.ts';
import {
  changedFiles, commitSummary, summaryText, stagedText, tickStages, hunkState, linesStage, folded, wholeFileText,
  stepCursor, lineRange, BIG_FILE_LINES,
  type ChangedFile,
} from './unified.ts';
import type { git as gitCall } from '../lib/bridge.ts';
import type { CombinedDiff, CombinedLine, WorkStatus } from '../../shared/git-types.ts';

export interface UnifiedContext {
  git: typeof gitCall;
  /** Stages (`on`) or unstages a file, its hunks ('<hunk>:*') or lines ('<hunk>:<line>'), as one undo step. */
  stage(file: ChangedFile, sel: 'all' | string[], on: boolean, label: string): unknown;
  discard(file: ChangedFile): unknown;
  openFile(path: string): unknown;
  onSummary(text: string): void;
  lfsBadge(): Child;
}
export interface UnifiedChanges { index: HTMLElement; page: HTMLElement; load(status: Partial<WorkStatus> | null | undefined): Promise<void>; key(id: string): boolean }

// The unified changes view: every changed file on one scrolling page, with a tick box per file, hunk and line.
// Ticking stages or unstages through the journal (one undo step per tick). The Commit view keeps its composer and
// calls `key` with its own key ids (cv.next, cv.stage, …), so no new shortcuts.
//
// ctx: { git(method, ...args), stage(file, sel, on, label), discard(file), openFile(path), onSummary(text), lfsBadge }
export function unifiedChanges(ctx: UnifiedContext): UnifiedChanges {
  const index = h('div.ucv-index');
  const page = h('div.diff-scroll.ucv-page');
  let files: ChangedFile[] = [];
  const diffs = new Map<string, CombinedDiff>(); // path → combinedDiff result
  const userFold = new Map<string, boolean>(); // path → true / false once the user folds or unfolds it
  const loaded = new Map<string, Set<number>>(); // path → hunk numbers loaded in a big file
  let foldStaged = localStorage.getItem('pref:foldStaged') === '1';
  let cursor: string | null = null; // row key, see rowKey
  let sel: { path: string | null; keys: Set<string>; anchor: string | null } = { path: null, keys: new Set(), anchor: null };
  let token = 0;

  const rowKey = (kind: string, path: string, k: string | number = '') => `${kind}\x1f${path}\x1f${k}`;
  const parseKey = (key: string) => { const [kind = '', path = '', k = ''] = key.split('\x1f'); return { kind, path, k }; };
  const nameOf = (p: string) => fileName(p)[0];
  const fileOf = (path: string | null) => files.find((f) => f.path === path);

  async function load(status: Partial<WorkStatus> | null | undefined) {
    const t = ++token;
    const next = changedFiles(status);
    const got = await Promise.all(next.map((f) => {
      const want = loaded.get(f.path);
      return ctx.git('combinedDiff', fileRef(f), want?.size ? [...want] : null).catch(() => null);
    }));
    if (t !== token) return;
    files = next;
    diffs.clear();
    next.forEach((f, i) => { const g = got[i]; if (g) diffs.set(f.path, g); });
    for (const p of [...userFold.keys()]) if (!diffs.has(p)) { userFold.delete(p); loaded.delete(p); }
    if (sel.path && !diffs.has(sel.path)) sel = { path: null, keys: new Set(), anchor: null };
    render();
  }

  const isFolded = (path: string) => { const d = diffs.get(path); return d ? folded(d, { user: userFold.get(path), foldStaged }) : false; };

  function tick(state: string, label: string, onclick: () => void, { focusable = true } = {}) {
    return h('button.ucv-tick.' + state, {
      role: 'checkbox', 'aria-checked': state === 'all' ? 'true' : state === 'partial' ? 'mixed' : 'false',
      'aria-label': label, title: label, tabIndex: focusable ? 0 : -1,
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); onclick(); },
    }, state === 'all' ? icon('check', 11) : state === 'partial' ? icon('minus', 11) : null);
  }

  // --- staging
  const toggleFile = (f: ChangedFile) => {
    const d = diffs.get(f.path);
    if (!d) return;
    const on = tickStages(d.state);
    ctx.stage(f, 'all', on, `${on ? 'Stage' : 'Unstage'} ${nameOf(f.path)}`);
  };
  const toggleHunk = (f: ChangedFile, hi: number) => {
    const hunk = diffs.get(f.path)?.hunks[hi];
    if (!hunk) return;
    const on = tickStages(hunkState(hunk));
    ctx.stage(f, [`${hi}:*`], on, `${on ? 'Stage' : 'Unstage'} hunk in ${nameOf(f.path)}`);
  };
  const lineOf = (d: CombinedDiff, key: string) => { const [hi = '', li = ''] = key.split(':'); return d.hunks[+hi]?.lines?.[+li]; };
  function toggleLines(f: ChangedFile, keys: string[]) {
    const d = diffs.get(f.path);
    if (!d) return;
    const lines = keys.map((k) => lineOf(d, k)).filter((l): l is CombinedLine => !!l);
    if (!lines.length) return;
    const on = linesStage(lines);
    const n = lines.length;
    sel = { path: null, keys: new Set(), anchor: null };
    ctx.stage(f, keys, on, `${on ? 'Stage' : 'Unstage'} ${n} line${n > 1 ? 's' : ''} in ${nameOf(f.path)}`);
  }
  const fold = (path: string, v: boolean) => { userFold.set(path, v); render(); };
  async function loadHunk(f: ChangedFile, hi: number) {
    const set = loaded.get(f.path) || new Set();
    set.add(hi);
    loaded.set(f.path, set);
    const d = await ctx.git('combinedDiff', fileRef(f), [...set]).catch(() => null);
    if (d) { diffs.set(f.path, d); render(); }
  }

  // --- rendering
  function indexRow(f: ChangedFile) {
    const d = diffs.get(f.path);
    const [name, dir] = fileName(f.path);
    return h('div.file-row.ucv-index-row', { 'data-path': f.path, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, onclick: () => reveal(f.path) },
      d && !d.conflict ? tick(d.state, `${d.state === 'all' ? 'Unstage' : 'Stage'} ${name}`, () => toggleFile(f), { focusable: false }) : h('span.ucv-tick-gap'),
      statusBadge(f.status),
      h('span.fname', null, name),
      f.lfs ? ctx.lfsBadge() : null,
      h('span.fdir', null, dir),
      d && d.total ? h('span.ucv-count', null, `${d.staged}/${d.total}`) : null,
    );
  }

  function lineRow(f: ChangedFile, d: CombinedDiff, hi: number, li: number, l: CombinedLine) {
    const changed = l.t !== ' ';
    const key = `${hi}:${li}`;
    const cls = (l.t === '+' ? '.add' : l.t === '-' ? '.del' : '') + (changed && l.staged ? '.staged' : '') + (l.edited ? '.edited' : '');
    const row = h('div.dl.ucv-line' + cls, { title: l.edited ? 'Changed since it was staged' : null },
      h('span.ucv-gutter', null, changed && !d.wholeFile ? tick(l.staged ? 'all' : 'none', `${l.staged ? 'Unstage' : 'Stage'} line`, () => toggleLines(f, [key]), { focusable: false }) : null),
      h('span.ln', null, l.o ?? ''),
      h('span.ln', null, l.n ?? ''),
      h('span.sign', null, changed ? l.t : ''),
      codeSpan(l.s),
      l.noEol ? h('span.noeol', { title: 'No newline at end of file' }, '⏎̸') : null,
    );
    if (changed && !d.wholeFile) {
      row.dataset.cur = rowKey('l', f.path, key);
      row.classList.add('pick');
      if (sel.path === f.path && sel.keys.has(key)) row.classList.add('sel');
      row.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        clickLine(f.path, key, e.shiftKey);
      });
    }
    return row;
  }

  function fileSection(f: ChangedFile) {
    const d = diffs.get(f.path);
    const name = nameOf(f.path);
    if (!d) return h('section.ucv-file', null, h('div.ucv-file-head', null, statusBadge(f.status), h('span.mono', null, f.path), h('span.muted', null, 'Couldn’t read this file')));
    const isFold = isFolded(f.path);
    const head = h('div.ucv-file-head', { 'data-cur': rowKey('f', f.path) },
      d.conflict ? h('span.ucv-tick-gap') : tick(d.state, `${d.state === 'all' ? 'Unstage' : 'Stage'} ${name}`, () => toggleFile(f)),
      h('button.icon-btn.tiny.ucv-fold', { title: isFold ? 'Show the changes' : 'Fold this file', 'aria-expanded': String(!isFold), onclick: () => fold(f.path, !isFold) }, icon(isFold ? 'chevron' : 'chevronDown', 13)),
      statusBadge(f.status),
      h('span.mono.ucv-path', null, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path),
      f.lfs ? ctx.lfsBadge() : null,
      d.hidden ? h('span.ucv-note', { title: 'A staged line was edited again. Tick it to stage the new version.' }, 'Changed since staged') : null,
      h('span.spacer'),
      h('span.ucv-staged', null, d.conflict ? 'Conflict' : stagedText(d.staged, d.total)),
      d.conflict ? null : h('button.btn.ghost.tiny', { onclick: () => toggleFile(f) }, d.state === 'all' ? 'Unstage file' : 'Stage file'),
      h('button.icon-btn.tiny', { title: 'Open file', onclick: () => ctx.openFile(f.path) }, icon('external', 13)),
    );
    head.addEventListener('mousedown', (e) => { if (e.target === head || (e.target as Element).classList.contains('ucv-path')) setCursor(rowKey('f', f.path)); });
    const sec = h('section.ucv-file' + (d.state === 'all' ? '.all' : ''), { 'data-path': f.path }, head);
    if (isFold) return sec;
    const why = wholeFileText(d);
    if (why || !d.hunks.length) { sec.append(h('div.ucv-whole', null, why || 'No line changes.')); return sec; }
    const body = h('div.diff.ucv-body');
    d.hunks.forEach((hk, hi) => {
      const st = hunkState(hk);
      const hh = h('div.hunk-head.ucv-hunk-head', { 'data-cur': rowKey('h', f.path, hi) },
        tick(st, `${st === 'all' ? 'Unstage' : 'Stage'} hunk`, () => toggleHunk(f, hi), { focusable: false }),
        h('span.hunk-range', null, hk.header),
        hk.edited ? h('span.ucv-note', null, 'Changed since staged') : null,
        h('span.hunk-actions', null,
          h('span.ucv-staged', null, `${hk.staged}/${hk.total}`),
          h('button.btn.ghost.tiny', { onclick: () => toggleHunk(f, hi) }, st === 'all' ? 'Unstage hunk' : 'Stage hunk'),
        ),
      );
      hh.addEventListener('mousedown', (e) => { if (!(e.target as Element).closest('button')) setCursor(rowKey('h', f.path, hi)); });
      body.append(hh);
      if (!hk.lines) {
        body.append(h('button.diff-more', { onclick: () => loadHunk(f, hi) }, `Show ${hk.total} changed line${hk.total === 1 ? '' : 's'}`));
        return;
      }
      body.append(h('div.hunk', null, hk.lines.map((l, li) => lineRow(f, d, hi, li, l))));
    });
    sec.append(body);
    return sec;
  }

  function render() {
    const s = commitSummary(files.map((f) => diffs.get(f.path)));
    ctx.onSummary(summaryText(s));
    const anyAll = files.some((f) => diffs.get(f.path)?.state === 'all');
    index.replaceChildren(
      h('div.cv-section-head', null, h('span', null, 'Changes'), h('span.sb-count', null, files.length), h('span.spacer'),
        anyAll || foldStaged ? h('button.btn.ghost.tiny' + (foldStaged ? '.on' : ''), {
          title: 'Fold files whose every line is staged', 'aria-pressed': String(foldStaged),
          onclick: () => { foldStaged = !foldStaged; try { localStorage.setItem('pref:foldStaged', foldStaged ? '1' : '0'); } catch { /* ignore */ } render(); },
        }, foldStaged ? 'Unfold staged' : 'Fold staged') : null),
      files.length ? h('div.file-list', null, files.map(indexRow)) : h('div.cv-empty', null, 'Working tree clean'),
    );
    const top = page.scrollTop;
    if (!files.length) {
      page.replaceChildren(h('div.empty.big', null, icon('check', 28), h('div', null, 'Nothing to commit'), h('div.muted', null, 'Your working tree matches HEAD.')));
      return;
    }
    page.replaceChildren(...files.map(fileSection));
    page.scrollTop = top;
    if (!cursor || !page.querySelector(`[data-cur="${CSS.escape(cursor)}"]`)) {
      const p = cursor && parseKey(cursor).path;
      cursor = p && diffs.has(p) ? rowKey('f', p) : rowKey('f', files[0]!.path);
    }
    markCursor(false);
  }

  // --- cursor and selection
  const rows = () => [...page.querySelectorAll<HTMLElement>('[data-cur]')];
  function markCursor(scroll = true) {
    let cur: HTMLElement | null = null;
    for (const r of rows()) { const on = r.dataset.cur === cursor; r.classList.toggle('ucv-cur', on); if (on) cur = r; }
    const p = cursor && parseKey(cursor).path;
    index.querySelectorAll<HTMLElement>('.ucv-index-row').forEach((r) => r.classList.toggle('active', r.dataset.path === p));
    if (scroll) cur?.scrollIntoView({ block: 'nearest' });
  }
  function setCursor(key: string, scroll = true) { cursor = key; markCursor(scroll); }
  function paintSel() {
    page.querySelectorAll<HTMLElement>('.ucv-line.pick').forEach((r) => {
      const { path, k } = parseKey(r.dataset.cur ?? '');
      r.classList.toggle('sel', path === sel.path && sel.keys.has(k));
    });
  }
  // Line keys of one file in page order (only lines that are loaded and have a box).
  const lineOrder = (path: string) => rows().map((r) => parseKey(r.dataset.cur ?? '')).filter((x) => x.kind === 'l' && x.path === path).map((x) => x.k);
  function clickLine(path: string, key: string, extend: boolean) {
    if (extend && sel.path === path && sel.anchor) sel.keys = new Set(lineRange(lineOrder(path), sel.anchor, key));
    else sel = { path, keys: new Set([key]), anchor: key };
    setCursor(rowKey('l', path, key), false);
    paintSel();
  }
  function reveal(path: string) {
    if (isFolded(path) && !((diffs.get(path)?.total ?? 0) > BIG_FILE_LINES)) userFold.set(path, false);
    setCursor(rowKey('f', path), false);
    render();
    page.querySelector(`[data-cur="${CSS.escape(rowKey('f', path))}"]`)?.closest('.ucv-file')?.scrollIntoView({ block: 'start' });
  }

  // Keys from the Commit view's keymap; returns true when handled.
  function key(id: string): boolean {
    const step = ({ 'cv.next': 1, 'cv.prev': -1, 'cv.extendNext': 1, 'cv.extendPrev': -1 } as Record<string, number>)[id];
    if (step) {
      const next = stepCursor(rows().map((r) => r.dataset.cur ?? ''), cursor, step);
      if (!next) return true;
      const cur = cursor ? parseKey(cursor) : null, n = parseKey(next);
      if ((id === 'cv.extendNext' || id === 'cv.extendPrev') && n.kind === 'l' && cur?.kind === 'l' && cur.path === n.path) {
        if (sel.path !== n.path || !sel.anchor) sel = { path: n.path, keys: new Set([cur.k]), anchor: cur.k };
        sel.keys = new Set(lineRange(lineOrder(n.path), sel.anchor ?? n.k, n.k));
        paintSel();
      } else if (id === 'cv.next' || id === 'cv.prev') {
        if (sel.keys.size) { sel = { path: null, keys: new Set(), anchor: null }; paintSel(); }
      }
      setCursor(next);
      return true;
    }
    if (id === 'cv.single') {
      if (!sel.keys.size) return false;
      sel = { path: null, keys: new Set(), anchor: null };
      paintSel();
      return true;
    }
    const c = cursor ? parseKey(cursor) : null;
    const f = c ? fileOf(c.path) : null;
    if (!c || !f) return false;
    if (id === 'cv.selectAll') {
      const all = lineOrder(f.path);
      if (!all.length) return false;
      sel = { path: f.path, keys: new Set(all), anchor: all[0] ?? null };
      paintSel();
      return true;
    }
    if (id === 'cv.stage') {
      const d = diffs.get(f.path);
      const selFile = sel.keys.size && sel.path ? fileOf(sel.path) : null;
      if (selFile) { toggleLines(selFile, [...sel.keys]); return true; }
      if (d?.conflict) return true;
      if (c.kind === 'f') toggleFile(f);
      else if (c.kind === 'h') toggleHunk(f, +c.k);
      else toggleLines(f, [c.k]);
      return true;
    }
    if (id === 'cv.discard') {
      if (!f.lists.includes('unstaged')) return false;
      ctx.discard(f);
      return true;
    }
    return false;
  }

  return { index, page, load, key };
}
