// Review's catch-up checkpoint (AK-281): "caught up to <sha> on <base>", per repository, kept in
// app data (one JSON file keyed by repository root), never in the repository. The checkpoint only
// moves when the user clicks Mark caught up (`mark`). Every open records the base's tip (`noteOpen`);
// the first catch-up fixes the checkpoint at the tip the base had the time before this that the
// repository was opened here, or at seven days ago when that isn't known.
import fs from 'node:fs';
import path from 'node:path';
import * as check from '../ipc.ts';

/** Where catch-up starts: a base tip ('opened', 'mark') or a date ('week'). */
export interface Checkpoint { sha: string | null; base: string | null; date: number; source: string; at?: number }
/** The base's tip at one open. */
export interface BaseTip { sha: string; base: string; date: number }
interface RepoEntry { checkpoint?: Checkpoint; opened?: BaseTip; previous?: BaseTip; touched?: number }
export type CatchupSince = 'checkpoint' | 'yesterday' | 'week' | 'tag';
export interface CatchupOptions {
  kind: CatchupSince; tag: string | null; withPrs: boolean; base: string | null | undefined; isDefault: boolean;
  cp: Checkpoint | null; since: { sha?: string | undefined; ref?: string; date?: number };
}

export const WEEK = 7 * 24 * 3600 * 1000;
const MAX_REPOS = 200;

export function readAll(file: string): Record<string, RepoEntry> {
  try { const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, RepoEntry> : {}; } catch { return {}; }
}
function writeAll(file: string, all: Record<string, RepoEntry>): void {
  // Keep the newest entries only, so the file can't grow without bound.
  const keys = Object.keys(all).sort((a, b) => (all[b]?.touched || 0) - (all[a]?.touched || 0)).slice(0, MAX_REPOS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(keys.map((k) => [k, all[k]]))));
}

// The checkpoint a repository without one starts from: the tip from its previous open, else a week back.
const initial = (entry: RepoEntry, now: number): Checkpoint => (entry.previous?.sha ? { ...entry.previous, source: 'opened' } : { sha: null, base: null, date: now - WEEK, source: 'week' });

// The repository's checkpoint, created (and saved) on first use.
export function checkpoint(file: string, root: string, now = Date.now()): Checkpoint {
  const all = readAll(file);
  const entry = all[root] || {};
  if (!entry.checkpoint) {
    entry.checkpoint = initial(entry, now);
    all[root] = { ...entry, touched: now };
    writeAll(file, all);
    return entry.checkpoint;
  }
  return entry.checkpoint;
}

// On every open: record the base's tip ({ sha, base, date }; null without a base branch), keeping
// the one from the open before.
export function noteOpen(file: string, root: string, tip: BaseTip | null | undefined, now = Date.now()): void {
  const all = readAll(file);
  const entry = all[root] || {};
  if (entry.opened) entry.previous = entry.opened;
  if (tip) entry.opened = { sha: tip.sha, base: tip.base, date: tip.date };
  all[root] = { ...entry, touched: now };
  writeAll(file, all);
}

// Mark caught up: the checkpoint becomes `to` ({ sha, base, date }); → the one it replaced, for undo.
export function mark(file: string, root: string, to: { sha?: string | null; base?: string | null; date: number; source?: string }, now = Date.now()): Checkpoint {
  const all = readAll(file);
  const entry = all[root] || {};
  const before = entry.checkpoint || initial(entry, now);
  entry.checkpoint = { sha: to.sha ?? null, base: to.base ?? null, date: to.date, source: to.source || 'mark', at: now };
  all[root] = { ...entry, touched: now };
  writeAll(file, all);
  return before;
}

// app:catchup's options (AK-374, AK-377): { since, tag, prs, base } checked and resolved. A `base` that is
// the default base counts as none; any other branch has no checkpoint, so a checkpoint read falls back
// to last week. defaultRef() → the default base's full ref (only asked when `base` is given);
// checkpoint() → this repo's checkpoint. → { kind, tag, withPrs, base, isDefault, cp, since }, `base`
// undefined for the default one.
const SINCE = check.oneOf('checkpoint', 'yesterday', 'week', 'tag');
const DAY = 24 * 3600 * 1000;
export async function catchupOptions(raw: unknown, { defaultRef, checkpoint: cpOf, now = Date.now() }: { defaultRef: () => Promise<string | null> | string | null; checkpoint: () => Checkpoint | null; now?: number }): Promise<CatchupOptions> {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => !['since', 'tag', 'prs', 'base'].includes(k)))) throw new check.IpcArgError('Invalid catch-up options');
  const opts = raw as { since?: unknown; tag?: unknown; prs?: unknown; base?: unknown } | null | undefined; // keys checked above
  let kind: CatchupSince = opts?.since == null ? 'checkpoint' : SINCE(opts.since, 'since');
  const tag = kind === 'tag' ? check.rev(opts?.tag, 'tag') : null;
  const withPrs = opts?.prs == null ? false : check.bool(opts.prs, 'prs');
  const base = opts?.base == null ? null : check.rev(opts.base, 'base');
  if (base && !/^refs\/(heads|remotes)\//.test(base)) throw new check.IpcArgError('Invalid base: not a branch');
  const isDefault = !base || (await defaultRef()) === base;
  const cp = isDefault ? cpOf() : null;
  if (!cp && kind === 'checkpoint') kind = 'week';
  const since = kind === 'checkpoint' ? { sha: cp?.sha || undefined, date: cp?.date ?? now }
    : kind === 'tag' ? { ref: `refs/tags/${tag}` }
      : { date: now - (kind === 'yesterday' ? DAY : WEEK) };
  return { kind, tag, withPrs, base: isDefault ? undefined : base, isDefault, cp, since };
}

