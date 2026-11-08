import { prDescription } from '../prs/pr-review.ts';
import type { FileDiff, LandedCommit } from '../../shared/git-types.ts';

/** A merged PR's GitHub stack: its number (the bottom PR), size and parts bottom first. */
export interface MergedStack { number: number; size?: number; parts?: number[] }
export interface Stat { additions: number; deletions: number; files: number }
/** A merged PR from app:catchup; `merge` is its merge commit on the base. */
export interface MergedPr { number: number; title?: string; branch?: string; merge?: string | null; body?: string; stack?: MergedStack | null; stat?: Stat | null }
/** What app:catchup returns, as far as these helpers read it. */
export interface CatchupResult {
  kind?: string; tag?: string; base?: string; date?: number | null;
  checkpoint?: { sha?: string | null; date?: number | null; base?: string | null; source?: string } | null;
  fallback?: { sha?: string; reason: string } | null;
  commits?: LandedCommit[]; merged?: MergedPr[] | null; ci?: unknown;
}
/** One thing that landed: a merged PR, or a commit that came without one. */
export interface LandedEntry {
  id: string; kind: 'pr' | 'commit'; number?: number; branch?: string; body?: string; stack?: MergedStack; stat?: Stat;
  title: string; sha: string; parent: string | null; date: number; author: string; files: string[]; key: string | null; area: string;
}
/** A day's parts of one merged stack, as one timeline item. */
export interface StackItem {
  id: string; kind: 'stack'; stack: MergedStack; parts: LandedEntry[]; lo: number; hi: number;
  title: string; date: number | null; author: string;
}
export type TimelineItem = LandedEntry | StackItem;
export interface Day<T> { id: string; label: string; entries: T[] }

// Review's catch-up card (AK-281), the pure part: what landed on the base since a checkpoint, as
// entries (a merged PR, or a commit that came without one) and as groups to read at a glance.
// Built from app:catchup (git log on the base's first-parent line, plus merged PRs from `gh` while
// PRs are on). No AI: issue keys and folders only.

// A generic issue key: "AK-12", "WEB2-345".
export const ISSUE_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
// Standards and encodings that look like keys ("read UTF-8 paths", "SHA-256") are never one (AK-287).
const NOT_KEYS = new Set(['UTF', 'UCS', 'SHA', 'MD', 'ISO', 'IEC', 'HTTP', 'TLS', 'SSL', 'RFC', 'CVE', 'ES', 'ECMA', 'X']);
const keyIn = (t: string | null | undefined): string | undefined => [...(t || '').matchAll(ISSUE_KEY)].map((m) => m[0]).find((k) => !NOT_KEYS.has(k.slice(0, k.lastIndexOf('-'))));
export const issueKey = (...texts: (string | null | undefined)[]): string | null => texts.map(keyIn).find(Boolean) || null;

// The area a path belongs to: apps/<name> and packages/<name>, else its top-level folder.
export function areaOf(file: string): string {
  const parts = file.split('/');
  if (parts.length === 1) return 'Top level';
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? file;
}
// A change's area: the one most of its files are in (first seen wins a tie).
function mainArea(files: readonly string[] = []): string {
  const n = new Map<string, number>();
  for (const f of files) { const a = areaOf(f); n.set(a, (n.get(a) || 0) + 1); }
  let best: string | null = null;
  for (const [a, c] of n) if (!best || c > (n.get(best) ?? 0)) best = a;
  return best || 'No files';
}

// commits: app:catchup commits (newest first); merged: its merged PRs or null. A commit that is a
// merged PR's merge commit (squash, merge or the last of a rebase) becomes that PR.
// → [{ id, kind: 'pr' | 'commit', number?, title, branch?, sha, parent, date, author, files, key, area }]
// A git-only result with the merged PRs and CI of a slower PR load that it overtook (AK-338).
export function withLateExtra<R extends CatchupResult>(res: R | null | undefined, extra: Pick<CatchupResult, 'merged' | 'ci'> | null | undefined): R | null | undefined {
  return res && extra ? { ...res, merged: extra.merged, ci: extra.ci } : res;
}

export function landedEntries(commits: readonly LandedCommit[] = [], merged: readonly MergedPr[] | null = null): LandedEntry[] {
  const byMerge = new Map((merged || []).filter((p) => p.merge).map((p) => [p.merge, p]));
  return commits.map((c) => {
    const pr = byMerge.get(c.sha);
    const title = pr ? pr.title || c.subject : c.subject;
    return {
      id: pr ? `pr:${pr.number}` : `commit:${c.sha}`,
      kind: pr ? 'pr' : 'commit',
      ...(pr ? { number: pr.number, branch: pr.branch } : {}),
      // The PR's description when GitHub sent one with the merged list (the reader falls back to the commit message).
      ...(typeof pr?.body === 'string' ? { body: pr.body } : {}),
      // Its GitHub stack and size (AK-616) when the merged-stacks lookup found them.
      ...(pr?.stack ? { stack: pr.stack } : {}), ...(pr?.stat ? { stat: pr.stat } : {}),
      title, sha: c.sha, parent: c.parent, date: c.date, author: c.author, files: c.files || [],
      key: issueKey(pr?.title, pr?.branch, c.subject),
      area: mainArea(c.files),
    };
  });
}

// The "Since…" picker: last checkpoint, yesterday, last week, then the newest tags.
export interface SinceOption { kind: 'checkpoint' | 'yesterday' | 'week' | 'tag'; label: string; tag?: string }
export function sinceOptions(tags: readonly string[] = [], max = 8): SinceOption[] {
  return [
    { kind: 'checkpoint', label: 'Last checkpoint' },
    { kind: 'yesterday', label: 'Yesterday' },
    { kind: 'week', label: 'Last week' },
    ...tags.slice(0, max).map((t): SinceOption => ({ kind: 'tag', tag: t, label: `Tag ${t}` })),
  ];
}

// The card's headline for a catch-up result: where it counts from. Relative time is a label only.
// res: app:catchup. → { text, warn? }
type SinceText = { text: string; warn?: string };
export function sinceText(res: CatchupResult, { short = (s: string) => s.slice(0, 7), ago = (_ms: number) => '' }: { short?: (sha: string) => string; ago?: (ms: number) => string } = {}): SinceText {
  const cp = res.checkpoint || {};
  if (res.kind === 'tag') return withFallback(res, `Since tag ${res.tag}`, short);
  if (res.kind === 'yesterday') return { text: 'Since yesterday' };
  if (res.kind === 'week') return { text: 'Since last week' };
  const at = cp.date ? ago(cp.date) : '';
  if (!cp.sha) return { text: cp.source === 'week' ? 'Since last week (no checkpoint yet)' : 'No checkpoint yet' };
  return withFallback(res, `Caught up to ${short(cp.sha)} on ${cp.base || res.base}${at ? ` · ${at}` : ''}`, short);
}
function withFallback(res: CatchupResult, text: string, short: (sha: string) => string): SinceText {
  if (!res.fallback) return { text };
  const what = res.kind === 'tag' ? `Tag ${res.tag}` : short(res.fallback.sha ?? '');
  const why = res.fallback.reason === 'missing' ? 'no longer exists' : `is no longer on ${res.base} (force-pushed?)`;
  return { text, warn: res.date != null ? `${what} ${why}. Showing what landed since its date.` : `${what} ${why}.` };
}

// The Catch up view's timeline (AK-365): entries by local day, newest first. "Today", "Yesterday",
// then dateLabel(start of that day). Entries without a date go last. → [{ id, label, entries }]
const dayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const longDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
export interface DayOptions { now?: number; dateLabel?: (dayStart: number) => string }
export function byDay<E extends { date?: number | null }>(entries: readonly E[] = [], { now = Date.now(), dateLabel = longDate }: DayOptions = {}): Day<E>[] {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const days = new Map<string, Day<E>>();
  for (const e of [...entries].sort((a, b) => (b.date || 0) - (a.date || 0))) {
    const d = e.date ? dayStart(e.date) : null;
    const id = d == null ? 'undated' : String(d);
    let g = days.get(id);
    if (!g) { g = { id, label: d == null ? 'Undated' : d === today ? 'Today' : d === yesterday ? 'Yesterday' : dateLabel(d), entries: [] }; days.set(id, g); }
    g.entries.push(e);
  }
  return [...days.values()];
}

// Merged stacks (AK-616): within a day, the parts of one GitHub stack become one timeline item, in
// place of its newest part: { id: 'stack:<stack>:<day>', kind: 'stack', stack, parts (bottom first),
// lo, hi (their numbers), title: "Stack · 14 PRs" | "Stack · 7 of 14 merged", date, author }. A
// stack merged across days gets an item per day; a day with one part keeps it a PR row. → days
const partAt = (e: LandedEntry) => { const i = e.stack?.parts?.indexOf(e.number ?? -1) ?? -1; return i < 0 ? Infinity : i; };
export function groupStacks(days: readonly Day<LandedEntry>[] = []): Day<TimelineItem>[] {
  return days.map((d) => {
    const by = new Map<number, LandedEntry[]>();
    for (const e of d.entries) if (e.kind === 'pr' && e.stack) { const list = by.get(e.stack.number) ?? []; list.push(e); by.set(e.stack.number, list); }
    const done = new Set<number>();
    const entries: TimelineItem[] = [];
    for (const e of d.entries) {
      const { stack } = e;
      const parts = e.kind === 'pr' && stack ? by.get(stack.number) : null;
      if (!stack || !parts || parts.length < 2) { entries.push(e); continue; }
      if (done.has(stack.number)) continue;
      done.add(stack.number);
      const sorted = [...parts].sort((a, b) => partAt(a) - partAt(b) || (a.date || 0) - (b.date || 0) || (a.number ?? 0) - (b.number ?? 0));
      const size = Math.max(stack.size || 0, parts.length);
      entries.push({
        id: `stack:${stack.number}:${d.id}`, kind: 'stack', stack, parts: sorted,
        // A stack has at least two parts, all PRs.
        lo: sorted[0]!.number!, hi: sorted[sorted.length - 1]!.number!,
        title: parts.length < size ? `Stack · ${parts.length} of ${size} merged` : `Stack · ${size} PRs`,
        date: Math.max(...parts.map((p) => p.date || 0)) || null, author: e.author,
      });
    }
    return { ...d, entries };
  });
}
// The timeline's items, a stack as one. → [entry | stack item]
export const landedItems = (entries: readonly LandedEntry[] = [], opts?: DayOptions): TimelineItem[] => groupStacks(byDay(entries, opts)).flatMap((d) => d.entries);
// The timeline's rows in order (AK-616): the items, an expanded stack's parts under it, newest first
// like the rest. A collapsed stack is one row for ↑/↓. opened: the expanded stack ids.
export const timelineRows = (items: readonly TimelineItem[] = [], opened: Set<string> = new Set()): TimelineItem[] => items.flatMap((x) => (x.kind === 'stack' && opened.has(x.id) ? [x, ...[...x.parts].reverse()] : [x]));
// ← and → on a stack (AK-616): → expands a collapsed one, ← collapses an expanded one, ← on one of
// its parts (`up`: the stack it sits under) goes up to it. → { open } | { close } | { select } (ids),
// or null when ←/→ step the timeline as before.
export function stackArrow(sel: TimelineItem | null | undefined, d: number, { opened = new Set<string>(), up = null }: { opened?: Set<string>; up?: StackItem | null } = {}): { open: string } | { close: string } | { select: string } | null {
  if (sel?.kind === 'stack' && (d > 0) !== opened.has(sel.id)) return d > 0 ? { open: sel.id } : { close: sel.id };
  if (d < 0 && up && opened.has(up.id)) return { select: up.id };
  return null;
}
// A part's place in its stack for the reader (AK-616): "Stack #257 → #271 · 5 of 14", from GitHub's
// list of its parts, else from the parts that merged with it (`item`). null outside a stack.
export function stackPlace(e: LandedEntry | null | undefined, item: StackItem | null = null): string | null {
  if (!e?.stack) return null;
  const all = e.stack.parts?.length ? e.stack.parts : item?.parts.map((p) => p.number ?? 0) || [];
  const at = all.indexOf(e.number ?? -1);
  if (at < 0 || !all.length) return null;
  return `Stack #${all[0]} → #${all[all.length - 1]} · ${at + 1} of ${Math.max(e.stack.size || 0, all.length)}`;
}
// A stack item's size: its parts' added and removed lines and files (those GitHub sent sizes for).
export function stackSize(item: StackItem | null | undefined): Stat | null {
  const sized = (item?.parts || []).flatMap((p) => (p.stat ? [p.stat] : []));
  return sized.length ? sized.reduce((z, st) => ({ additions: z.additions + st.additions, deletions: z.deletions + st.deletions, files: z.files + st.files }), { additions: 0, deletions: 0, files: 0 }) : null;
}

// How many rows the timeline shows before "+ N more ▸".
export const FIRST = 10;
// The first n entries across the days (days left empty drop out). → { days, more: how many are hidden }
export function firstOf<T>(days: readonly Day<T>[], n = FIRST): { days: Day<T>[]; more: number } {
  const out: Day<T>[] = [];
  let left = n;
  for (const d of days) {
    if (left <= 0) break;
    const entries = d.entries.slice(0, left);
    left -= entries.length;
    out.push({ ...d, entries });
  }
  const total = days.reduce((s, d) => s + d.entries.length, 0);
  return { days: out, more: Math.max(0, total - n) };
}

// The big number: merged PRs, or the commits that landed when none came with a PR. `items`: the
// timeline's (landedItems), where a stack counts once however many days it merged on (AK-616).
// → { count, text: "PRs merged" | "commits landed" | "stack and 1 PR merged", extra: "· 3 other commits" | null, total }
export function headline(items: readonly TimelineItem[] = []): { count: number; text: string; extra: string | null; total: number } {
  const stacks = new Set(items.flatMap((e) => (e.kind === 'stack' ? [e.stack.number] : [])));
  const prs = items.filter((e) => e.kind === 'pr' && !(e.stack && stacks.has(e.stack.number))).length;
  const loose = items.filter((e) => e.kind !== 'pr' && e.kind !== 'stack').length;
  const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const total = stacks.size + prs + loose;
  if (!prs && !stacks.size) return { count: loose, text: s(loose, 'commit landed', 'commits landed'), extra: null, total };
  const extra = loose ? `${loose} other ${s(loose, 'commit', 'commits')}` : null;
  if (!stacks.size) return { count: prs, text: s(prs, 'PR merged', 'PRs merged'), extra, total };
  return { count: stacks.size, text: `${s(stacks.size, 'stack', 'stacks')}${prs ? ` and ${prs} ${s(prs, 'PR', 'PRs')}` : ''} merged`, extra, total };
}

// The since picker's label in the view: "since your checkpoint", "since yesterday", "since tag v0.1.0".
export function sincePhrase(since: { since?: string; tag?: string } = { since: 'checkpoint' }): string {
  if (since.since === 'tag') return `since tag ${since.tag}`;
  if (since.since === 'yesterday') return 'since yesterday';
  if (since.since === 'week') return 'since last week';
  return 'since your checkpoint';
}
// When a checkpoint was: "Tuesday 18:40" within the week, "Oct 3 18:40" before that.
export function whenText(ms: number | null | undefined, { now = Date.now() }: { now?: number } = {}): string {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = now - ms < 6 * 24 * 3600e3 ? d.toLocaleDateString(undefined, { weekday: 'long' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} ${time}`;
}

// The reader (AK-372, AK-381): ←/→ step the timeline. The id `d` steps from `id` in `list` (entries), clamped to its ends; the first when `id` isn't in it.
export function stepId(list: readonly { id: string }[] = [], id: string | null = null, d = 1): string | null {
  if (!list.length) return null;
  const i = list.findIndex((e) => e.id === id);
  return list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d))]!.id;
}
// A parsed file diff's added and removed lines. → { add, del }
export function diffCounts(diff: Pick<FileDiff, 'hunks'> | null | undefined): { add: number; del: number } {
  let add = 0, del = 0;
  for (const hunk of diff?.hunks || []) for (const l of hunk.lines) { if (l.t === '+') add++; else if (l.t === '-') del++; }
  return { add, del };
}
// The whole change's size for the reader head: { additions, deletions, files } over its file diffs.
export function changeSize(diffs: readonly Pick<FileDiff, 'hunks'>[] = []): Stat {
  let additions = 0, deletions = 0;
  for (const d of diffs) { const c = diffCounts(d); additions += c.add; deletions += c.del; }
  return { additions, deletions, files: diffs.length };
}
// The first path in `paths` not in `viewed` (a Set), or null.
export const firstUnviewed = (paths: readonly string[] = [], viewed: Set<string> = new Set()): string | null => paths.find((p) => !viewed.has(p)) ?? null;
// What the reader shows above the files: the PR's description when GitHub sent it, else the commit
// message without its subject line and its Co-authored-by / Signed-off-by trailers.
// → { text, from: 'pr' | 'commit' } ('' when there's nothing to say)
export function readerDescription(entry: { body?: unknown } | null | undefined, message: unknown = ''): { text: string; from: 'pr' | 'commit' } {
  if (typeof entry?.body === 'string') return { text: prDescription(entry) ?? '', from: 'pr' };
  const rest = String(message || '').split('\n').slice(1).filter((l) => !/^(co-authored-by|signed-off-by):/i.test(l.trim())).join('\n');
  return { text: prDescription({ body: rest }) ?? '', from: 'commit' };
}
