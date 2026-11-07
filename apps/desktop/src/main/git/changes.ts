import { run, W_ENV, GitError } from './run.ts';
import { getStatus, workingDiff, buildPartialPatch, applyPatch } from './status.ts';
import type { CombinedDiff, CombinedHunk, CombinedLine, FileDiff, StatusEntry, WholeFileReason } from '../../shared/git-types.ts';

// Unified changes: one diff per file (HEAD → working tree) where every changed line says
// whether it is staged. It is composed from the staged diff (HEAD → index) and the unstaged
// diff (index → working tree) rather than diffed again, so each line maps back to exactly one
// line of one of those diffs, and staging a selection is a partial patch of that diff.

const COMBINED_LINE_CAP = 400; // bigger files come back with hunk headers only; load hunks on demand
const COMBINED_CONTEXT = 3;

/** A file the unified view is asked about: its path, and the path before a rename. */
export interface ChangeFile { path: string; oldPath?: string | null | undefined }

// A changed line of one side's diff: its buildPartialPatch key, text and run of changes.
interface SideLine { key: string; s: string; noEol: boolean; block: number }
interface Sides {
  added: Map<number, SideLine>; removed: Map<number, SideLine>;
  addsAt: Map<number, (SideLine & { n: number })[]>; delsAt: Map<number, (SideLine & { o: number })[]>;
}
// A composed line, with the keys of the staged (`_hi`) or unstaged (`_iw`) diff line it maps to.
// `_also`: removed unstaged lines that staging this one also has to take.
interface SeqLine extends Omit<CombinedLine, 'o' | 'n'> { o: number | null; n: number | null; _hi?: string; _iw?: string; _also?: string[] }
interface SeqHunk extends Omit<CombinedHunk, 'lines'> { lines: SeqLine[] }
interface ChangeEntry { path: string; oldPath: string | null; staged: StatusEntry | null; unstaged: StatusEntry | null; conflict: boolean; untracked: boolean }
interface Combined { entry: ChangeEntry; hi: FileDiff | null; iw: FileDiff | null; seq: SeqLine[]; hidden: number; binary: boolean }

// Where the changed lines of one parsed file diff sit. Keys are the "hunk:line" keys
// buildPartialPatch takes. `added`/`removed` are by new/old line number; `addsAt`/`delsAt`
// hold insertions/removals by how many old/new lines come before them. `block` numbers the
// runs of changed lines, so an edit's removed and added lines share one.
function diffSides(fd: FileDiff | null): Sides {
  const s: Sides = { added: new Map(), removed: new Map(), addsAt: new Map(), delsAt: new Map() };
  const at = <V>(m: Map<number, V[]>, k: number, v: V) => { let list = m.get(k); if (!list) m.set(k, list = []); list.push(v); };
  let block = 0;
  (fd?.hunks || []).forEach((h, hi) => {
    let o = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    let n = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    let prev = ' ';
    h.lines.forEach((ln, li) => {
      if (ln.t !== ' ' && prev === ' ') block++;
      prev = ln.t;
      const rec = { key: `${hi}:${li}`, s: ln.s, noEol: !!ln.noEol, block };
      if (ln.t === ' ') { o++; n++; } else if (ln.t === '-') {
        s.removed.set(o, rec);
        at(s.delsAt, n - 1, { ...rec, o });
        o++;
      } else {
        s.added.set(n, rec);
        at(s.addsAt, o - 1, { ...rec, n });
        n++;
      }
    });
  });
  return s;
}

const splitLines = (text: string): string[] => { const l = text.split('\n'); if (l.at(-1) === '') l.pop(); return l; };

// One file's state for the unified view: its status entry (the staged one carries a rename's
// old path), and whether it is untracked or conflicted.
async function changeEntry(cwd: string, file: ChangeFile): Promise<ChangeEntry> {
  const { staged, unstaged, conflicts } = await getStatus(cwd, [file.path, ...(file.oldPath ? [file.oldPath] : [])]);
  const s = staged.find((f) => f.path === file.path), u = unstaged.find((f) => f.path === file.path);
  return {
    path: file.path, oldPath: s?.oldPath || null, staged: s || null, unstaged: u || null,
    conflict: conflicts.some((f) => f.path === file.path), untracked: u?.status === '?',
  };
}

// The composed lines of one file, every line of the working tree and every removed line in
// file order, plus the staged and unstaged diffs they map to.
async function combine(cwd: string, file: ChangeFile): Promise<Combined> {
  const e = await changeEntry(cwd, file);
  const out: Combined = { entry: e, hi: null, iw: null, seq: [], hidden: 0, binary: false };
  if (e.conflict) return out;
  const fe = { path: e.path, oldPath: e.oldPath || undefined, status: e.untracked ? '?' : 'M' };
  if (e.untracked) out.iw = await workingDiff(cwd, fe, { staged: false });
  else {
    if (e.staged) out.hi = await workingDiff(cwd, fe, { staged: true });
    if (e.unstaged) out.iw = await workingDiff(cwd, { path: e.path, status: 'M' }, { staged: false });
  }
  out.binary = !!(out.hi?.binary || out.iw?.binary);
  if (out.binary) return out;
  const index = e.untracked || e.staged?.status === 'D' ? []
    : splitLines(await run(cwd, ['cat-file', 'blob', `:${e.path}`], { allowCodes: [0, 128] }));
  const hi = diffSides(out.hi), iw = diffSides(out.iw);
  // Removed lines of a run that also removes a staged line: staging them replaces that line.
  const hiddenIn = new Map<number, string[]>();
  for (let k = 1; k <= index.length; k++) {
    const r = iw.removed.get(k);
    if (r && hi.added.has(k)) { let list = hiddenIn.get(r.block); if (!list) hiddenIn.set(r.block, list = []); list.push(r.key); }
  }
  const unstagedLine = (line: SeqLine, r: SideLine): SeqLine => {
    const also = hiddenIn.get(r.block);
    return also ? { ...line, edited: true, _also: also } : line;
  };
  let o = 0, n = 0;
  for (let j = 0; j <= index.length; j++) {
    for (const d of hi.delsAt.get(j) || []) out.seq.push({ t: '-', s: d.s, o: ++o, n: null, staged: true, _hi: d.key });
    for (const a of iw.addsAt.get(j) || []) out.seq.push(unstagedLine({ t: '+', s: a.s, o: null, n: ++n, staged: false, _iw: a.key, ...(a.noEol && { noEol: true }) }, a));
    if (j === index.length) break;
    const k = j + 1, add = hi.added.get(k), rem = iw.removed.get(k), s = index[j] ?? '';
    if (add && rem) { out.hidden++; continue; } // staged, then changed or removed again
    if (add) out.seq.push({ t: '+', s, o: null, n: ++n, staged: true, _hi: add.key });
    else if (rem) out.seq.push(unstagedLine({ t: '-', s, o: ++o, n: null, staged: false, _iw: rem.key }, rem));
    else out.seq.push({ t: ' ', s, o: ++o, n: ++n });
  }
  return out;
}

// Group composed lines into hunks with a few lines of context, like a unified diff.
function combinedHunks(seq: SeqLine[]): SeqHunk[] {
  const hunks: SeqHunk[] = [];
  let i = 0;
  while (i < seq.length) {
    if (seq[i]?.t === ' ') { i++; continue; }
    const start = Math.max(0, i - COMBINED_CONTEXT);
    let end = i;
    // Extend while the next change is within twice the context.
    for (let j = i; j < seq.length && j <= end + 2 * COMBINED_CONTEXT; j++) if (seq[j]?.t !== ' ') end = j;
    end = Math.min(seq.length - 1, end + COMBINED_CONTEXT);
    const lines = seq.slice(start, end + 1);
    const first = (k: 'o' | 'n') => lines.find((l) => l[k] != null)?.[k] ?? 0;
    const oldLines = lines.filter((l) => l.t !== '+').length, newLines = lines.filter((l) => l.t !== '-').length;
    // An empty side starts at the line before, as git writes it.
    const before = (k: 'o' | 'n') => { for (let j = start - 1; j >= 0; j--) { const v = seq[j]?.[k]; if (v != null) return v; } return 0; };
    const oldStart = oldLines ? first('o') : before('o'), newStart = newLines ? first('n') : before('n');
    const changed = lines.filter((l) => l.t !== ' ');
    hunks.push({
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, oldStart, oldLines, newStart, newLines,
      lines, total: changed.length, staged: changed.filter((l) => l.staged).length, edited: changed.some((l) => l.edited),
    });
    i = end + 1;
  }
  return hunks;
}

const tickState = (staged: number, total: number): CombinedDiff['state'] => (!total || !staged ? 'none' : staged === total ? 'all' : 'partial');

// Why a file can only be staged whole (the UI hides its line boxes), or null.
function wholeFileReason(c: Combined): WholeFileReason | null {
  const e = c.entry;
  if (c.binary) return 'binary';
  if (e.oldPath) return 'renamed';
  if (e.staged?.status === 'D' || e.unstaged?.status === 'D') return 'deleted';
  if (e.staged?.status === 'T' || e.unstaged?.status === 'T') return 'typechange';
  if ([c.hi, c.iw].some((d) => d?.header.some((l) => /^(old|new) mode /.test(l) || /^Subproject /.test(l)))) return 'mode';
  return null;
}

// The unified view of one changed file. Every changed line has `staged`; `edited` marks a line
// that replaces a staged one (it changed since staging). Files over COMBINED_LINE_CAP changed
// lines come back `collapsed`, with `lines: null` on every hunk not listed in `opts.hunks`.
export async function combinedDiff(cwd: string, file: ChangeFile, { hunks: want }: { hunks?: readonly number[] } = {}): Promise<CombinedDiff> {
  const c = await combine(cwd, file);
  const e = c.entry;
  const base = { path: e.path, oldPath: e.oldPath, untracked: e.untracked, conflict: e.conflict, binary: c.binary, hidden: c.hidden };
  if (e.conflict) return { ...base, wholeFile: 'conflict', hunks: [], staged: 0, total: 0, state: 'none', collapsed: false };
  const wholeFile = wholeFileReason(c);
  const hunks = combinedHunks(c.seq);
  let staged = hunks.reduce((s, h) => s + h.staged, 0), total = hunks.reduce((s, h) => s + h.total, 0);
  if (c.binary) { total = 1; staged = e.staged && !e.unstaged ? 1 : 0; }
  const collapsed = total > COMBINED_LINE_CAP && !want;
  const keep = want ? new Set(want) : null;
  const strip = (l: SeqLine): CombinedLine => { const { _hi, _iw, _also, ...rest } = l; return rest; };
  return {
    ...base, wholeFile, staged, total, collapsed,
    // A staged change hidden by a later edit or removal leaves the file partly staged, whatever the visible lines say.
    state: (c.binary && e.staged && e.unstaged) || c.hidden ? 'partial' : tickState(staged, total),
    hunks: hunks.map((h, i) => ({ ...h, lines: collapsed || (keep && !keep.has(i)) ? null : h.lines.map(strip) })),
  };
}

// The composed lines a selection names: "hunk:line" keys, or "hunk:*" for a whole hunk.
function pickLines(hunks: SeqHunk[], sel: Iterable<string>): SeqLine[] {
  const picked = new Set<SeqLine>();
  for (const k of sel) {
    const [h, l] = k.split(':');
    const hunk = hunks[Number(h)];
    if (!hunk) continue;
    const line = hunk.lines[Number(l)];
    if (l === '*') hunk.lines.forEach((x) => picked.add(x));
    else if (line) picked.add(line);
  }
  return [...picked].filter((x) => x.t !== ' ');
}

// The paths staging `file` can change in the index (a staged rename's old path too).
export async function changePaths(cwd: string, file: ChangeFile): Promise<string[]> {
  const e = await changeEntry(cwd, file);
  return [e.path, ...(e.oldPath ? [e.oldPath] : file.oldPath ? [file.oldPath] : [])];
}

// Stage (`stage` true) or unstage part of one file in the unified view: 'all', or the
// "hunk:line" / "hunk:*" keys of combinedDiff's hunks. Lines already in the wanted state are
// skipped. Binary, renamed, deleted and conflicted files go whole only.
export async function setStaged(cwd: string, file: ChangeFile, sel: 'all' | readonly string[], stage: boolean): Promise<string | undefined> {
  if (sel === 'all') {
    const paths = await changePaths(cwd, file);
    if (stage) return run(cwd, ['add', '-A', '--', ...paths], { env: W_ENV });
    const hasHead = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim();
    return run(cwd, hasHead ? ['reset', '-q', 'HEAD', '--', ...paths] : ['rm', '--cached', '-q', '-r', '--ignore-unmatch', '--', ...paths], { env: W_ENV });
  }
  const c = await combine(cwd, file);
  if (c.entry.conflict) throw new GitError(`${file.path} has a conflict. Resolve it first.`);
  const why = wholeFileReason(c);
  if (why) throw new GitError(`${file.path} can only be ${stage ? 'staged' : 'unstaged'} as a whole file.`);
  const lines = pickLines(combinedHunks(c.seq), sel).filter((l) => l.staged !== stage);
  if (!lines.length) return;
  if (stage) {
    const keys = new Set(lines.flatMap((l) => [l._iw, ...(l._also || [])]).filter((k) => k !== undefined));
    const patch = c.iw && buildPartialPatch(c.iw, keys, 'stage');
    if (patch) await applyPatch(cwd, patch, { cached: true });
  } else {
    const patch = c.hi && buildPartialPatch(c.hi, lines.flatMap((l) => (l._hi === undefined ? [] : [l._hi])), 'reverse');
    if (patch) await applyPatch(cwd, patch, { cached: true, reverse: true });
  }
}

