// The unified changes view (Commit view, "Show changes as one list"): pure helpers, no DOM. The view is
// unified-view.js; the combined diffs come from git.combinedDiff.

import type { StatusEntry, WorkStatus } from '../../shared/git-types.ts';

type List = 'conflicts' | 'unstaged' | 'staged';
/** A changed path, with every status list it is in. */
export type ChangedFile = StatusEntry & { lists: List[] };
/** What the helpers read from a combined diff: line counts, and the tick state. */
export interface DiffCounts { staged: number; total: number }

// Files over this many changed lines start folded (git.js returns them without lines, see COMBINED_LINE_CAP).
export const BIG_FILE_LINES = 400;

// One entry per changed path: conflicts, then unstaged, then staged-only files. A partly staged file is in both
// status lists; it keeps the staged entry's status when that says more (added, renamed, deleted) and its old path.
export function changedFiles(status: Partial<WorkStatus> | null | undefined): ChangedFile[] {
  const seen = new Map<string, ChangedFile>();
  for (const list of ['conflicts', 'unstaged', 'staged'] as const) {
    for (const f of status?.[list] || []) {
      const had = seen.get(f.path);
      if (!had) { seen.set(f.path, { ...f, lists: [list] }); continue; }
      had.lists.push(list);
      if (list === 'staged' && /^[ARCD]$/.test(f.status) && had.status !== 'U') had.status = f.status;
      if (!had.oldPath && f.oldPath) had.oldPath = f.oldPath;
    }
  }
  return [...seen.values()];
}

// What the commit box says will go in: staged lines, files with something staged, lines left out.
export function commitSummary(diffs: readonly (DiffCounts | null | undefined)[]): { lines: number; files: number; left: number } {
  let lines = 0, files = 0, left = 0;
  for (const d of diffs) {
    if (!d) continue;
    lines += d.staged;
    left += d.total - d.staged;
    if (d.staged) files++;
  }
  return { lines, files, left };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function summaryText({ lines, files, left }: { lines: number; files: number; left: number }): string {
  if (!lines) return left ? `Nothing staged · ${left} left` : 'Nothing to commit';
  return `${plural(lines, 'line')} in ${plural(files, 'file')} will be committed${left ? ` · ${left} left` : ''}`;
}

// "8 of 22 lines staged" in a file header.
export function stagedText(staged: number, total: number): string {
  if (!total) return 'No line changes';
  if (!staged) return `${plural(total, 'line')}, none staged`;
  return staged === total ? `All ${plural(total, 'line')} staged` : `${staged} of ${plural(total, 'line')} staged`;
}

// A tick box over a file or hunk stages what's left, or unstages everything once it's all staged.
export const tickStages = (state: string): boolean => state !== 'all';
export const hunkState = (hunk: DiffCounts): 'none' | 'all' | 'partial' => (!hunk.total || !hunk.staged ? 'none' : hunk.staged === hunk.total ? 'all' : 'partial');

// Lines picked together go in when any of them is out, and come out only when all are in.
export const linesStage = (lines: readonly { staged: boolean }[]): boolean => lines.some((l) => !l.staged);

// Whether a file starts folded: the user's choice when they made one, else big files, else (with "Fold staged
// files" on) files whose every line is staged.
export function folded(d: { total: number; state?: string }, { user, foldStaged }: { user?: boolean | null; foldStaged?: boolean }): boolean {
  if (user != null) return user;
  if (d.total > BIG_FILE_LINES) return true;
  return Boolean(foldStaged) && d.state === 'all';
}

// Why a file has no line boxes, in words for its body.
export function wholeFileText(d: { wholeFile?: string | null; oldPath?: string | null }): string | null {
  return ({
    binary: 'Binary file. It stages as a whole file.',
    deleted: 'Deleted file. It stages as a whole file.',
    renamed: d.oldPath ? `Renamed from ${d.oldPath}. It stages as a whole file.` : 'Renamed file. It stages as a whole file.',
    typechange: 'File type changed. It stages as a whole file.',
    mode: 'File mode changed. It stages as a whole file.',
    conflict: 'This file has a conflict. Resolve it in the split view (Show staged and unstaged separately).',
  } as Record<string, string>)[d.wholeFile ?? ''] || null;
}

// The next cursor row from `keys` (row keys in page order), `step` rows away, clamped.
export function stepCursor<K>(keys: readonly K[], cur: K | null | undefined, step: number): K | null {
  if (!keys.length) return null;
  const i = cur == null ? -1 : keys.indexOf(cur);
  // Both indexes are inside the non-empty list.
  if (i === -1) return keys[step < 0 ? keys.length - 1 : 0]!;
  return keys[Math.max(0, Math.min(keys.length - 1, i + step))]!;
}

// Line keys ("hunk:line") between two keys of one file, in page order, both ends included.
export function lineRange(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a), j = order.indexOf(b);
  if (i === -1 || j === -1) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}
