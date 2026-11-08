// Branch review: pure helpers (no DOM) for the per-file "reviewed" ticks in review-view.js.
// A review is `git branchReview` (the branch's change from its merge-base, each file with its
// blob at the tip). Ticks live in app data (localStorage), per repository and lane, never in the
// repository. Each tick remembers the file's blob and the tip it was ticked at: when the branch
// moves and a file's blob changes, the tick no longer applies and the file shows as "changed
// since you last looked", with the tip to diff the delta from.
//
// Saved record: { files: { [path]: { blob, tip } }, summary: { tip, done, total } }. The summary
// is what the lanes overview shows ("7 / 12 reviewed") without running git per lane.

interface Tick { blob: string | null; tip: string }
export interface ReviewSummary { tip: string; done: number; total: number }
/** The saved ticks of one lane, and the summary the lanes overview shows. */
export interface Ticks { files: Record<string, Tick>; summary: ReviewSummary | null }
/** What the ticks need from git.branchReview: the tip and each file's blob there. */
export interface ReviewFiles { tip: string; files: readonly { path: string; blob: string | null }[] }
export type FileState = { path: string; state: 'new' | 'reviewed' } | { path: string; state: 'changed'; since: string };

export const storeKey = (root: string, lane: string): string => `review:${root}:${lane}`;

export function readTicks(store: Pick<Storage, 'getItem'>, key: string): Ticks {
  try {
    const v = JSON.parse(store.getItem(key) || 'null');
    if (v && typeof v === 'object' && v.files && typeof v.files === 'object') return v;
  } catch { /* corrupt: start over */ }
  return { files: {}, summary: null };
}

export function writeTicks(store: Pick<Storage, 'setItem' | 'removeItem'>, key: string, saved: Ticks): void {
  try {
    if (!Object.keys(saved.files).length) store.removeItem(key);
    else store.setItem(key, JSON.stringify(saved));
  } catch { /* storage full or unavailable: ticks stay for this session only */ }
}

// Each file's state: 'reviewed' (ticked at this blob), 'changed' (ticked at another blob, so it
// changed since) or 'new' (never ticked). `since` is the tip a changed file was ticked at.
export function fileStates(saved: Ticks, review: ReviewFiles): FileState[] {
  return review.files.map((f) => {
    const t = saved.files[f.path];
    if (!t) return { path: f.path, state: 'new' };
    if (t.blob === f.blob) return { path: f.path, state: 'reviewed' };
    return { path: f.path, state: 'changed', since: t.tip };
  });
}

export function summarize(saved: Ticks, review: ReviewFiles): ReviewSummary {
  const done = fileStates(saved, review).filter((s) => s.state === 'reviewed').length;
  return { tip: review.tip, done, total: review.files.length };
}

// Ticks or unticks `path` at its current blob. Ticks of files no longer in the review are
// dropped, and the summary is brought up to date. Returns a new record.
export function toggleTick(saved: Ticks, review: ReviewFiles, path: string): Ticks {
  const f = review.files.find((x) => x.path === path);
  if (!f) return saved;
  const files: Record<string, Tick> = {};
  for (const x of review.files) { const t = saved.files[x.path]; if (t) files[x.path] = t; }
  if (files[path]?.blob === f.blob) delete files[path];
  else files[path] = { blob: f.blob, tip: review.tip };
  const next: Ticks = { files, summary: null };
  next.summary = summarize(next, review);
  return next;
}

// Brings the stored summary up to date after (re)loading a review; null when nothing changed.
export function refreshSummary(saved: Ticks, review: ReviewFiles): Ticks | null {
  const s = summarize(saved, review);
  const old = saved.summary;
  if (old && old.tip === s.tip && old.done === s.done && old.total === s.total) return null;
  return { ...saved, summary: s };
}

// The lanes overview label: "7 / 12 reviewed", or null when the lane was never reviewed.
// `moved` when the lane's tip is no longer the one the summary was made at.
export function progress(saved: Ticks | null | undefined, head: string | null | undefined): { label: string; done: boolean; moved: boolean } | null {
  const s = saved?.summary;
  if (!s || !Object.keys(saved?.files || {}).length) return null;
  return { label: `${s.done} / ${s.total} reviewed`, done: s.done === s.total, moved: Boolean(head && s.tip !== head) };
}
