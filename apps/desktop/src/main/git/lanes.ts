import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AGENT_HINTS } from '../../renderer/lib/agents.ts'; // shared with the renderer (AK-393)
import { run, GitError, mapLimit, REC, SEP, onGitPathChange, BASE_ENV, gitPath } from './run.ts';
import { canForecast } from './support.ts';
import { diffTreeFiles, LOG_FORMATS, LOG_ENV, parseCoAuthors } from './log.ts';
import { dirtyPaths } from './undo.ts';
import { getWorktrees } from './worktrees.ts';
import type { AgentGuess, BaseTouch, BranchReview, Lane, LaneDone, Landed, LandedCommit, LanesResult, Worktree } from '../../shared/git-types.ts';

/** The base lanes are measured against; `local` is the local branch name it stands for. */
export interface LaneBase { ref: string; sha: string; name: string; local: string | null }
export interface Trailer { key: string; value: string }
/** A merged pull request's head commit (github.mergedPrs). */
export interface PrHead { sha: string; number: number; title?: string }
// A commit ahead of base, as lanes() reads it.
interface LaneCommit { order: number; parents: string[]; subject: string; trailers: Trailer[] }
interface BaseRow { sha: string; subject: string }
// A lane while lanes() works it out; the fields after `ab` are filled in step by step.
interface WorkLane {
  name: string; branch: string | null; head: string | null; tree: string | undefined; date: number | undefined;
  detached: boolean; isBase: boolean; wt: Worktree | null; upstream: string | null; upstreamGone: boolean;
  ahead: number | null; behind: number | null; ab: string | undefined;
  commits?: string[]; complete?: boolean; forkPoint?: string | null; subject?: string | null; noWork?: boolean;
  merged?: 'ancestor' | 'squash' | null; mergedAs?: string | null; mergeBase?: string | null;
  netEmpty?: boolean; prCheck?: boolean; done?: LaneDone;
}
interface LaneInput { name: string; branch: string | null; head: string | null; tree?: string; date?: number; upstream?: string; track?: string; ab?: string; wt?: Worktree | null }
interface PrFacts { head: string | null; commits: string[]; all: Map<string, LaneCommit> }

// Lanes: one record per local branch and per worktree, measured against the repository's
// default branch. A fixed handful of git calls however many branches there are (one
// for-each-ref, one worktree list, one log, three patch-id passes), plus one status per worktree
// for its uncommitted-file count. Read-only.

// Lane commits read for trailers and squash checks, and base commits searched for squash merges.
const LANE_COMMITS = 5000;
// Squash merges older than BASE_COMMITS base commits aren't detected: such a branch reads merged: null.
const BASE_COMMITS = 2000;
// The base side of the squash checks (its log and patch ids) only depends on the base tip: one entry
// per repo, replaced when the base moves.
export const baseSquash = new Map<string, { sha: string; data: Promise<[string, Map<string, string>]> }>();
function baseSquashData(cwd: string, sha: string): Promise<[string, Map<string, string>]> {
  const hit = baseSquash.get(cwd);
  if (hit?.sha === sha) return hit.data;
  const data = Promise.all([
    run(cwd, ['log', `--max-count=${BASE_COMMITS}`, '--format=%H%x00%T%x00%s', sha, '--']),
    patchIds(cwd, ['log', '-p', '--no-merges', '--no-color', '--no-ext-diff', `--max-count=${BASE_COMMITS}`, '--format=commit %H', sha, '--']).then(newestBy),
  ]);
  baseSquash.set(cwd, { sha, data });
  // A failure, or patch ids cut short (size or time limit: empty), is not kept.
  data.then(([, ids]) => { if (!ids.size && baseSquash.get(cwd)?.data === data) baseSquash.delete(cwd); }, () => { if (baseSquash.get(cwd)?.data === data) baseSquash.delete(cwd); });
  return data;
}
// Lanes further ahead than this skip the per-commit (cherry) check: too much diff for too little.
const CHERRY_MAX = 100;
// Commits that say nothing about a lane's work: the empty commit an agent's task worktree starts
// from, and the commit that sweeps up its scratch files at the end. Merge commits (merging base
// in) are skipped by parent count.
const BASELINE = /^chore\(agent\): (?:baseline\b|uncommitted changes from task\b)/i;
// An issue key in a branch name's segment ("agent/x/ak-228", "ak-228-fix-thing") → "AK-228".
export function branchKey(branch: string | null | undefined): string | null {
  for (const seg of String(branch || '').split('/').reverse()) {
    const m = /^([a-z][a-z0-9]{0,9}-\d+)(?:[-_.]|$)/i.exec(seg);
    if (m) return (m[1] ?? '').toUpperCase();
  }
  return null;
}
// A commit subject as the base shows it after a squash merge: without the trailing "(#123)".
export const plainSubject = (s: string | null | undefined): string => String(s || '').trim().replace(/\s*\(#\d+\)$/, '').toLowerCase();
// "~/…/<last two segments>" for a worktree path; the full path stays on `worktree.path`.
export function shortPath(p: string, home = os.homedir()): string {
  const inHome = home && (p === home || p.startsWith(`${home}/`));
  const segs = (inHome ? p.slice(home.length) : p).split('/').filter(Boolean);
  const tail = segs.slice(-2).join('/');
  return `${inHome ? '~/' : '/'}${segs.length > 2 ? `…/${tail}` : tail}`;
}

export function parseTrailers(text: string): Trailer[] {
  return text.split('\n').flatMap((l) => {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(l.trim());
    return m ? [{ key: m[1] ?? '', value: m[2] ?? '' }] : [];
  });
}

// { reason: 'trailer' | 'branch prefix', match } or null.
export function agentGuess(branch: string | null | undefined, trailers: readonly Trailer[] = []): AgentGuess | null {
  for (const t of trailers) {
    const key = t.key.toLowerCase();
    if (AGENT_HINTS.trailers.includes(key)) return { reason: 'trailer', match: `${t.key}: ${t.value}` };
    if (key === 'co-authored-by') {
      const words = t.value.toLowerCase().split(/[^a-z0-9]+/);
      if (AGENT_HINTS.coauthors.some((n) => words.includes(n))) return { reason: 'trailer', match: `${t.key}: ${t.value}` };
    }
  }
  const b = String(branch || '').toLowerCase();
  const prefix = AGENT_HINTS.prefixes.find((p) => b.startsWith(p));
  return prefix ? { reason: 'branch prefix', match: prefix } : null;
}

const shortRef = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '');

// The base lanes are measured against: `base` if given, else origin/HEAD, else main or master.
// { ref, sha, name, local } (local = the local branch name it stands for), or null when there is none.
export async function laneBase(cwd: string, base?: string | null): Promise<LaneBase | null> {
  if (base) {
    if (String(base).startsWith('-')) throw new GitError(`Unknown base ${base}`);
    const sha = (await run(cwd, ['rev-parse', '--verify', '-q', `${base}^{commit}`], { allowCodes: [0, 1] })).trim();
    if (!sha) throw new GitError(`Unknown base ${base}`);
    const ref = (await run(cwd, ['rev-parse', '--symbolic-full-name', base], { allowCodes: [0, 128] })).trim() || base;
    return { ref, sha, name: shortRef(ref), local: ref.startsWith('refs/heads/') ? shortRef(ref) : ref.startsWith('refs/remotes/') ? shortRef(ref).replace(/^[^/]+\//, '') : null };
  }
  const order = ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
  const out = await run(cwd, ['for-each-ref', '--format=%(refname)%00%(symref)', ...order]);
  const found = new Map(out.split('\n').filter(Boolean).map((l): [string, string] => { const [r = '', s = ''] = l.split('\0'); return [r, s]; }));
  const ref = order.map((r) => (r.endsWith('/HEAD') ? found.get(r) : found.has(r) ? r : '')).find(Boolean);
  if (!ref) return null;
  const sha = (await run(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowCodes: [0, 1] })).trim();
  if (!sha) return null;
  return { ref, sha, name: shortRef(ref), local: shortRef(ref).replace(/^origin\//, '') };
}

// Review's catch-up card (AK-281): what reached the base since a checkpoint, one entry per commit
// on the base's first-parent line (a merged PR is one entry), with the files each changed against
// its first parent. `since` is { sha } (a checkpoint), { ref } (a tag) and/or { date } (ms). A sha
// or tag that is no longer part of the base (force-push) falls back to `since.date`, or to the
// commit's own date, and says so (`fallback`). Local git only. → { base, baseSha, baseDate, from,
// fallback, commits: [{ sha, parent, date, author, subject, files }], truncated, tags } or null
// without a base branch.
export async function landed(cwd: string, { base, since = {}, limit = 300 }: { base?: string | null; since?: { sha?: string; ref?: string; date?: number | null }; limit?: number } = {}): Promise<Landed | null> {
  const b = await laneBase(cwd, base);
  if (!b) return null;
  let date: number | null = since.date ?? null;
  let from: string | null = null;
  let fallback: Landed['fallback'] = null;
  const at = since.sha || since.ref;
  if (at) {
    if (String(at).startsWith('-')) throw new GitError(`Unknown checkpoint ${at}`);
    const sha = (await run(cwd, ['rev-parse', '--verify', '-q', `${at}^{commit}`], { allowCodes: [0, 1, 128] })).trim();
    const onBase = sha && await run(cwd, ['merge-base', '--is-ancestor', sha, b.sha]).then(() => true, () => false);
    if (onBase) from = sha;
    else {
      if (sha && date == null) date = Number((await run(cwd, ['log', '-1', '--format=%ct', sha])).trim()) * 1000;
      fallback = { sha: since.sha || since.ref, reason: sha ? 'unreachable' : 'missing' };
    }
  }
  const range = from ? [`${from}..${b.sha}`] : [b.sha, ...(date != null ? [`--since=${new Date(date).toISOString()}`] : [])];
  const [out, baseDate, tags] = await Promise.all([
    from || date != null ? run(cwd, ['log', '--first-parent', '-m', '--name-only', '-z', `--max-count=${limit + 1}`, '--format=%x1e%H%x00%P%x00%ct%x00%an%x00%s%x00', ...range, '--']) : '',
    run(cwd, ['log', '-1', '--format=%ct', b.sha]),
    run(cwd, ['for-each-ref', '--sort=-creatordate', '--count=20', '--format=%(refname:short)', 'refs/tags']),
  ]);
  const commits: LandedCommit[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec) continue;
    const [sha = '', parents = '', ct, author = '', subject = '', ...rest] = rec.split('\0');
    commits.push({ sha, parent: parents.split(' ')[0] || null, date: Number(ct) * 1000, author, subject, files: [...new Set(rest.map((f) => f.replace(/^\n+/, '')).filter(Boolean))] });
  }
  const truncated = commits.length > limit;
  return { base: b.name, baseSha: b.sha, baseDate: Number(baseDate.trim()) * 1000, from, date, fallback, commits: commits.slice(0, limit), truncated, tags: tags.split('\n').filter(Boolean) };
}

// Merge-bases and `merge-tree --write-tree` results only depend on the commits: kept per repo by SHA,
// so a refresh only asks git about lanes whose tip or base moved (AK-639). Cleared when full.
const SHA_MEMO_MAX = 5000;
const shaMemo = new Map<string, unknown>();
function memoBySha<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (shaMemo.has(key)) return Promise.resolve(shaMemo.get(key) as T);
  return fn().then((v) => {
    if (shaMemo.size >= SHA_MEMO_MAX) shaMemo.clear();
    shaMemo.set(key, v);
    return v;
  });
}

// A merged PR's head below the tip only ships the lane when everything on top of it is
// bookkeeping: baselines and merges from base. A branch stacked on a merged PR, or new commits
// after the merge, still have work to ship.
function prBelow(head: string | null, laneCommits: readonly string[], heads: Map<string, PrHead>, commits: Map<string, LaneCommit>): PrHead | undefined {
  return laneCommits.flatMap((c) => { const p = heads.get(c); return c !== head && p ? [p] : []; }).find((p) => {
    const under = new Set<string>();
    const stack = [p.sha];
    while (stack.length) {
      const sha = stack.pop();
      const c = sha === undefined ? undefined : commits.get(sha);
      if (sha === undefined || under.has(sha) || !c) continue;
      under.add(sha);
      stack.push(...c.parents);
    }
    return laneCommits.every((sha) => {
      const c = commits.get(sha);
      return under.has(sha) || !c || BASELINE.test(c.subject) || (c.parents.length > 1 && c.parents.slice(1).every((x) => !commits.has(x)));
    });
  });
}

// What prShipped needs of a lanes() lane that a merged PR can ship (ahead of base, not the base,
// some net change, own work): result lane → { head, commits, all }.
const prFacts = new WeakMap<Lane, PrFacts>();

// The merged-PR "shipped" check, after lanes() so the local list never waits on `gh` (AK-639). A
// lane whose tip is a merged PR's head (by SHA: task branches are often named differently from the
// PR branch), or that holds one under only bookkeeping, is done by that PR, whatever else matched.
// `prHeads` ([{ sha, number, title }], merged PRs from github.mergedPrs, only while pull requests
// are on). Returns the lanes, the changed ones copied: the result may be shared (sharedLanes).
export function prShipped(res: { lanes: Lane[] }, prHeads: readonly (PrHead | null | undefined)[] | null | undefined): Lane[] {
  const heads = new Map((prHeads || []).filter((p): p is PrHead => !!p && /^[0-9a-f]{40}$/.test(p.sha)).map((p) => [p.sha, p] as const));
  if (!heads.size) return res.lanes;
  return res.lanes.map((l) => {
    const f = prFacts.get(l);
    const pr = f && (heads.get(f.head ?? '') || prBelow(f.head, f.commits, heads, f.all));
    return pr ? { ...l, done: { reason: 'pr', pr: pr.number }, title: pr.title || l.title } : l;
  });
}

// Shipped checks on top of `merged`, for lanes with commits ahead of base, cheapest first: the
// branch's issue key or its newest subject on a squash-merged base commit, then the net patch
// (merged PRs: prShipped, after this). Sets l.done ({ reason, key?, sha?, pr? }), l.prCheck (prShipped
// applies), and l.netEmpty (tip tree = merge-base tree: nothing to ship, never done).
// The key matches "(AK-12)" anywhere or "AK-12:" leading a base subject.
// Batched: one merge-base per lane (none for a lane whose single fork point is it, or with only
// bookkeeping), one log, one diff-tree, one patch-id, then merge-tree only for lanes still open.
async function shipped(cwd: string, b: LaneBase | null, lanes: WorkLane[], { baseIds, baseRows, baseTree }: { baseIds: Map<string, string>; baseRows: BaseRow[]; baseTree: string | null }): Promise<void> {
  if (!b || !lanes.length) return;
  // Key and subject matches only count on base commits newer than the lane's merge-base (the
  // base log is newest first), so a subject the lane forked from never marks it shipped.
  const rowAt = new Map(baseRows.map((r, i) => [r.sha, i]));
  const since = new Map<string | null | undefined, { rows: BaseRow[]; subjects: Map<string, string>; keys: string }>();
  const newer = (mb: string | null | undefined) => {
    let hit = since.get(mb);
    if (!hit) {
      const rows = baseRows.slice(0, rowAt.get(mb ?? '') ?? baseRows.length);
      // Subjects only of squash-merged PRs ("… (#12)"): plain subjects like "fix tests" repeat.
      const subjects = new Map<string, string>();
      for (const r of rows) if (/\(#\d+\)\s*$/.test(r.subject) && !subjects.has(plainSubject(r.subject))) subjects.set(plainSubject(r.subject), r.sha);
      since.set(mb, hit = { rows, subjects, keys: `\n${rows.map((r) => r.subject).join('\n').toUpperCase()}` });
    }
    return hit;
  };
  // A complete lane's one boundary commit is its merge-base: every path from the tip to base leaves
  // the lane there. A lane with only bookkeeping never needs one (no done, no net-patch).
  const mbs = await mapLimit(lanes, 8, async (l) => (l.noWork ? null : l.forkPoint || memoBySha(`${cwd}\0mb\0${l.head}\0${b.sha}`,
    () => run(cwd, ['merge-base', l.head ?? '', b.sha], { allowCodes: [0, 1] }).then((o) => o.trim() || null)).catch(() => null)));
  const uniq = [...new Set(mbs.filter((x): x is string => !!x))];
  const mbTrees = new Map<string, string>();
  if (uniq.length) {
    const out = await run(cwd, ['log', '--no-walk=unsorted', '--format=%H %T', ...uniq, '--']);
    for (const line of out.split('\n')) { const [h = '', t] = line.split(' '); if (t) mbTrees.set(h, t); }
  }
  const open: WorkLane[] = [];
  lanes.forEach((l, i) => {
    l.mergeBase = mbs[i] ?? null;
    l.netEmpty = l.mergeBase != null && mbTrees.get(l.mergeBase) === l.tree;
    if (l.netEmpty || l.noWork) return;
    l.prCheck = true;
    // The key in the branch name, else the one leading its newest subject ("AK-48: …").
    const key = branchKey(l.branch) || (/^([a-z][a-z0-9]{0,9}-\d+):/i.exec(l.subject || '')?.[1] || '').toUpperCase() || null;
    const subject = plainSubject(l.subject);
    const base = newer(l.mergeBase);
    if (l.merged) return;
    else if (key && (base.keys.includes(`(${key})`) || base.keys.includes(`\n${key}:`))) {
      const row = base.rows.find((r) => { const s = r.subject.toUpperCase(); return s.includes(`(${key})`) || s.startsWith(`${key}:`); });
      l.done = { reason: 'key', key, ...squashOf(row) };
    } else if (subject.length >= 10 && base.subjects.has(subject)) l.done = { reason: 'subject', ...squashOf(baseRows[rowAt.get(base.subjects.get(subject) ?? '') ?? -1]) };
    else if (l.mergeBase) open.push(l);
  });
  if (!open.length) return;
  // Net patch: the lane's whole change since its merge-base (merges of base and the empty baseline
  // drop out) is a base commit's patch, or merging the lane into base changes nothing.
  const lines = [...new Set(open.map((l) => `${l.head} ${l.mergeBase}`))];
  const ids = await patchIds(cwd, ['diff-tree', '--stdin', '-p', '--no-color', '--no-ext-diff'], { input: `${lines.join('\n')}\n` });
  const rest = open.filter((l) => {
    const id = ids.get(l.head ?? '');
    if (id === undefined || !baseIds.has(id)) return true;
    l.done = { reason: 'net-patch', sha: baseIds.get(id) };
    return false;
  });
  if (!rest.length || !baseTree || !(await canForecast(cwd))) return;
  await mapLimit(rest, 8, async (l) => {
    const tree = await memoBySha(`${cwd}\0mt\0${b.sha}\0${l.head}`, () => run(cwd, ['merge-tree', '--write-tree', '--no-messages', b.sha, l.head ?? ''], { allowCodes: [0, 1] }).then((o) => (o.split('\n')[0] ?? '').trim()))
      .catch(() => '');
    if (tree === baseTree) l.done = { reason: 'net-patch' };
  });
}

const REVIEW_COMMITS = 200;

// Branch review: the whole change of `branch` against `base` the way a pull request shows it,
// from their merge-base (`base...branch`). Each file carries its blob at the tip (the zero id
// for a deletion), which is what a "reviewed" tick is keyed by. `base` defaults to laneBase's.
// commits: the branch's commits, newest first, at most REVIEW_COMMITS, [{ sha, subject, author,
// email, time, coAuthors }] (`time` the author date in Unix seconds, `coAuthors` as in getLog);
// commitCount: all of them.
export async function branchReview(cwd: string, branch: string, base?: string | null): Promise<BranchReview> {
  if (String(branch).startsWith('-')) throw new GitError(`Unknown branch ${branch}`);
  const b = await laneBase(cwd, base);
  if (!b) throw new GitError('There is no base branch (main or master) to review against.');
  const tip = (await run(cwd, ['rev-parse', '--verify', '-q', `${branch}^{commit}`], { allowCodes: [0, 1] })).trim();
  if (!tip) throw new GitError(`${branch} has no commits yet.`);
  const mergeBase = (await run(cwd, ['merge-base', b.sha, tip], { allowCodes: [0, 1] })).trim();
  if (!mergeBase) throw new GitError(`${branch} shares no history with ${b.name}.`);
  // The branch's own commits: `base..tip` (not `mergeBase..tip`), so a criss-cross merge from the
  // base can't list the base's commits either.
  const range = `${b.sha}..${tip}`;
  const [raw, files, log, count] = await Promise.all([
    run(cwd, ['diff-tree', '-r', '-z', '-M', '--raw', '--no-commit-id', '--abbrev=40', mergeBase, tip]),
    diffTreeFiles(cwd, mergeBase, tip),
    run(cwd, ['log', `-n${REVIEW_COMMITS}`, LOG_FORMATS.details, range, '--'], { env: LOG_ENV }),
    run(cwd, ['rev-list', '--count', range, '--']),
  ]);
  const blobs = parseRawBlobsZ(raw);
  const commits = log.split(REC).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha = '', author = '', email = '', t, subject = '', co] = r.split(SEP);
    return { sha, subject, author, email, time: Number(t), coAuthors: parseCoAuthors(co, email) };
  });
  return {
    branch, base: b.name, baseSha: b.sha, mergeBase, tip,
    files: files.map((f) => ({ ...f, blob: blobs.get(f.path) || null })),
    commits, commitCount: Number(count.trim()),
  };
}

// path → blob at the new side, from `diff-tree --raw -z` (":old new oldsha newsha S\0path\0[path\0]").
function parseRawBlobsZ(out: string): Map<string, string> {
  const blobs = new Map<string, string>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (!part.startsWith(':')) continue;
    const meta = part.split(' ');
    const twoPaths = /^[RC]/.test(meta[4] ?? '');
    blobs.set(parts[i + (twoPaths ? 2 : 1)] ?? '', meta[3] ?? '');
    i += twoPaths ? 2 : 1;
  }
  return blobs;
}

let gitVersion: Promise<number[]> | null = null;
onGitPathChange(() => { gitVersion = null; });
async function hasAheadBehind(cwd: string): Promise<boolean> {
  gitVersion ||= run(cwd, ['version']).then((v) => (/(\d+)\.(\d+)/.exec(v) || [0, 0, 0]).slice(1).map(Number), () => [0, 0]);
  const [major = 0, minor = 0] = await gitVersion;
  return major > 2 || (major === 2 && minor >= 41);
}

// The base commit a key or subject match points at: its sha and, for a squash-merged PR ("… (#12)"), the number.
function squashOf(row: BaseRow | undefined): { sha?: string; pr?: number } {
  if (!row) return {};
  const m = /\(#(\d+)\)\s*$/.exec(row.subject);
  return m ? { sha: row.sha, pr: Number(m[1]) } : { sha: row.sha };
}

// patch id → newest commit with it, from patchIds over a newest-first log.
const newestBy = (m: Map<string, string>): Map<string, string> => { const out = new Map<string, string>(); for (const [sha, id] of m) if (!out.has(id)) out.set(id, sha); return out; };

// Patch ids of a diff stream ("commit <sha>" headers) as Map(sha → patch id).
// For a diff-producing git command. Its output is piped straight into
// `git patch-id --stable`, so a huge diff (an icon repo's SVG history runs to hundreds of MB) never
// becomes a JS string. Past maxBytes or timeout both are killed and the result is empty: squash
// detection degrades, the main process keeps its heap.
const PATCH_MAX_BYTES = 1024 * 1024 * 1024;
const PATCH_TIMEOUT = 30000;
export function patchIds(cwd: string, args: string[], { input, maxBytes = PATCH_MAX_BYTES, timeout = PATCH_TIMEOUT }: { input?: string; maxBytes?: number; timeout?: number } = {}): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const opts = { cwd, env: BASE_ENV, detached: process.platform !== 'win32' };
    const src = spawn(gitPath(), args, opts);
    const ids = spawn(gitPath(), ['patch-id', '--stable'], opts);
    let bytes = 0; let out = ''; let err = ''; let capped: string | null = null; let failed: Error | null = null; let open = 2;
    const codes: { src?: number | null; ids?: number | null } = {};
    const stop = (why: string) => { if (capped) return; capped = why; src.kill(); ids.kill(); };
    const timer = setTimeout(() => stop(`took over ${timeout / 1000}s`), timeout);
    const finish = () => {
      clearTimeout(timer);
      if (capped) {
        console.warn(`lanes: squash detection skipped, git ${args[0]} ${capped}`);
        resolve(new Map());
      } else if (failed || codes.src !== 0 || codes.ids !== 0) {
        const msg = (err || failed?.message || '').trim().split('\n').slice(-6).join('\n');
        reject(new GitError(msg || `git ${args[0]} failed`, { code: codes.src || codes.ids || 1, stderr: err, args }));
      } else {
        resolve(new Map(out.split('\n').filter(Boolean).map((l): [string, string] => { const [id = '', sha = ''] = l.split(' '); return [sha, id]; })));
      }
    };
    src.stdout.on('data', (d: Buffer) => { bytes += d.length; if (bytes > maxBytes) stop(`passed ${maxBytes} bytes`); });
    src.stdout.pipe(ids.stdin);
    src.stdin.on('error', () => {});
    ids.stdin.on('error', () => {}); // EPIPE once a cap kills patch-id
    for (const c of [src, ids]) {
      c.stderr.setEncoding('utf8'); c.stderr.on('data', (d: string) => { err += d; });
      c.on('error', (e: Error) => { failed = failed || e; });
    }
    ids.stdout.setEncoding('utf8'); ids.stdout.on('data', (d: string) => { out += d; });
    src.on('close', (code) => { codes.src = code; if (!--open) finish(); });
    ids.on('close', (code) => { codes.ids = code; if (!--open) finish(); });
    src.stdin.end(input ?? undefined);
  });
}

// Newest mtime among a worktree's dirty files (capped), or 0.
function dirtyMtime(dir: string, paths: readonly string[]): number {
  let t = 0;
  for (const p of paths.slice(0, 500)) {
    try { t = Math.max(t, fs.lstatSync(path.join(dir, p)).mtimeMs); } catch { /* deleted */ }
  }
  return t;
}

// `aheadBehind: false` forces the rev-list fallback git before 2.41 uses (for tests).
// `prHeads` (see prShipped) lets a lane count as shipped when a merged PR's head is its tip or one
// of its commits; app:lanes-list applies prShipped itself, so `gh` and git run side by side.
export async function lanes(cwd: string, { base, aheadBehind, prHeads = [] }: { base?: string | null; aheadBehind?: boolean; prHeads?: readonly PrHead[] } = {}): Promise<LanesResult> {
  const [b, worktrees] = await Promise.all([laneBase(cwd, base), getWorktrees(cwd)]);
  const gone = (w: Worktree) => w.missing || !fs.existsSync(w.path);
  // Each worktree's uncommitted files (one `git status` each): started now, beside the ref work
  // below, not after it (AK-639).
  const dirtyAt = new Map(worktrees.filter((w) => (w.branch || w.head) && !gone(w)).map((w) => [w.path, dirtyPaths(w.path).catch((): string[] => [])] as const));
  const fast = b && aheadBehind !== false && await hasAheadBehind(cwd);
  const fields = ['%(refname)', '%(objectname)', '%(tree)', '%(committerdate:unix)', '%(upstream:short)', '%(upstream:track)', ...(fast ? [`%(ahead-behind:${b.sha})`] : [])];
  const refs = await run(cwd, ['for-each-ref', `--format=${fields.join('%00')}`, 'refs/heads']);
  const wtByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w]));
  const list: WorkLane[] = [];
  const lane = (o: LaneInput): WorkLane => ({ name: o.name, branch: o.branch, head: o.head, tree: o.tree, date: o.date, detached: !o.branch, isBase: false, wt: o.wt || null, upstream: o.upstream || null, upstreamGone: o.track === '[gone]', ahead: null, behind: null, ab: o.ab });
  for (const line of refs.split('\n')) {
    if (!line) continue;
    const [ref = '', head = '', tree, date, upstream, track, ab] = line.split('\0');
    const name = ref.slice('refs/heads/'.length);
    list.push(lane({ name, branch: name, head, tree, date: Number(date) * 1000, upstream, track, ab, wt: wtByBranch.get(name) }));
    wtByBranch.delete(name);
  }
  // Worktrees on an unborn branch, and detached worktrees.
  for (const w of wtByBranch.values()) list.push(lane({ name: w.branch ?? '', branch: w.branch, head: null, wt: w }));
  const detached = worktrees.filter((w) => !w.branch && w.head);
  if (detached.length) {
    const out = await run(cwd, ['log', '--no-walk=unsorted', '--format=%H%x00%T%x00%ct', ...new Set(detached.map((w) => w.head ?? '')), '--'], { allowCodes: [0, 128] });
    const info = new Map(out.split('\n').filter(Boolean).map((l) => { const [h = '', t, d] = l.split('\0'); return [h, { tree: t, date: Number(d) * 1000 }] as const; }));
    for (const w of detached) list.push(lane({ name: w.name, branch: null, head: w.head, wt: w, ...info.get(w.head ?? '') }));
  }

  if (b) {
    for (const l of list) {
      // The base itself, or the local branch a remote base stands for (main for origin/main).
      l.isBase = l.branch != null && (b.ref === `refs/heads/${l.branch}` || (b.ref.startsWith('refs/remotes/') && l.branch === b.local));
      if (l.ab) { const [ahead = 0, behind = 0] = l.ab.split(' ').map(Number); l.ahead = ahead; l.behind = behind; }
    }
    const slow = list.filter((l) => l.head && l.ahead == null);
    await mapLimit(slow, 8, async (l) => {
      const out = await run(cwd, ['rev-list', '--left-right', '--count', `${l.head}...${b.sha}`, '--']);
      const [ahead = 0, behind = 0] = out.trim().split(/\s+/).map(Number);
      l.ahead = ahead; l.behind = behind;
    });
  }

  // Commits ahead of base: their trailers, and which lane each belongs to (walked from each tip).
  const ahead = b ? list.filter((l) => (l.ahead ?? 0) > 0) : [];
  const tips = [...new Set(ahead.map((l) => l.head ?? ''))];
  const commits = new Map<string, LaneCommit>();
  if (tips.length && b) {
    const out = await run(cwd, ['log', '-z', `--max-count=${LANE_COMMITS}`, '--format=%H%x1f%P%x1f%s%x1f%(trailers:unfold,only)', ...tips, '--not', b.sha, '--']);
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const [sha = '', parents, subject = '', trailers] = rec.split('\x1f');
      commits.set(sha, { order: commits.size, parents: parents ? parents.split(' ') : [], subject, trailers: parseTrailers(trailers || '') });
    }
  }
  for (const l of ahead) {
    const seen = new Set<string>();
    const boundary = new Set<string>();
    const stack = l.head ? [l.head] : [];
    while (stack.length) {
      const sha = stack.pop();
      if (sha === undefined || seen.has(sha)) continue;
      const c = commits.get(sha);
      if (!c) { boundary.add(sha); continue; }
      seen.add(sha);
      stack.push(...c.parents);
    }
    l.commits = [...seen];
    l.complete = l.commits.length === l.ahead;
    l.forkPoint = l.complete && boundary.size === 1 ? [...boundary][0] ?? null : null;
    // The newest commit that is the lane's own work (not a baseline, not a merge of base). No
    // such commit at all: the lane holds only agent bookkeeping, nothing to ship or forecast.
    const own = l.commits.map((c) => commits.get(c)).filter((c): c is LaneCommit => !!c && c.parents.length < 2 && !BASELINE.test(c.subject));
    l.subject = own.sort((x, y) => x.order - y.order)[0]?.subject || null;
    l.noWork = l.complete && !own.length;
  }

  // Squash-merge checks: a lane whose tip tree matches a base commit's tree, whose whole diff
  // matches a base commit's patch (squash), or whose every commit has a patch-equivalent commit
  // on base (`git cherry`; rebase-merged).
  const candidates = ahead.filter((l) => l.complete);
  let baseTrees = new Set<string | undefined>(); let baseIds = new Map<string, string>(); let laneIds = new Map<string, string>(); let squashIds = new Map<string, string>();
  let baseRows: BaseRow[] = []; let baseTree: string | null = null;
  if (ahead.length && b) {
    // Base side is bounded by count only: excluding lane tips would hide all of base whenever a
    // lane descends from the base tip (any freshly branched lane).
    const cherryTips = [...new Set(candidates.filter((l) => (l.ahead ?? 0) <= CHERRY_MAX).map((l) => l.head ?? ''))];
    const squashLines = [...new Set(candidates.filter((l) => l.forkPoint).map((l) => `${l.head} ${l.forkPoint}`))];
    let trees: string;
    [[trees, baseIds], laneIds, squashIds] = await Promise.all([
      baseSquashData(cwd, b.sha),
      cherryTips.length ? patchIds(cwd, ['log', '-p', '--no-merges', '--no-color', '--no-ext-diff', '--format=commit %H', ...cherryTips, '--not', b.sha, '--']) : new Map(),
      squashLines.length ? patchIds(cwd, ['diff-tree', '--stdin', '-p', '--no-color', '--no-ext-diff'], { input: `${squashLines.join('\n')}\n` }) : new Map(),
    ]);
    const rows = trees.split('\n').filter(Boolean).map((r) => r.split('\0'));
    baseTrees = new Set(rows.map((r) => r[1]));
    baseTree = rows[0]?.[1] || null;
    baseRows = rows.map((r) => ({ sha: r[0] ?? '', subject: r[2] || '' }));
  }

  for (const l of list) {
    l.merged = null;
    const squashId = squashIds.get(l.head ?? '') ?? '';
    if (l.ahead === 0 && (l.behind ?? 0) > 0) l.merged = 'ancestor';
    else if ((l.ahead ?? 0) > 0 && l.complete && !l.isBase) {
      const ids = (l.ahead ?? 0) <= CHERRY_MAX ? (l.commits ?? []).map((c) => laneIds.get(c)).filter((id) => id !== undefined) : [];
      if (baseTrees.has(l.tree) || baseIds.has(squashId) || (ids.length && ids.every((id) => baseIds.has(id)))) {
        l.merged = 'squash';
        l.mergedAs = baseIds.get(squashId) || null; // the base commit with the same change, when one matches
      }
    }
  }
  await shipped(cwd, b, ahead.filter((l) => !l.isBase), { baseIds, baseRows, baseTree });

  const result = await Promise.all(list.map(async (l) => {
    const merged = l.merged;
    const w = l.wt;
    const prunable = w ? gone(w) : false;
    let changes: number | null = null;
    let activity = l.date || 0;
    if (w && !prunable) {
      const dirty = [...new Set(await (dirtyAt.get(w.path) || dirtyPaths(w.path).catch((): string[] => [])))];
      changes = dirty.length;
      activity = Math.max(activity, dirtyMtime(w.path, dirty));
    }
    const trailers = (l.commits || []).flatMap((c) => commits.get(c)?.trailers || []);
    const out: Lane = {
      name: l.name,
      branch: l.branch,
      head: l.head,
      detached: l.detached,
      isBase: l.isBase,
      worktree: w ? { path: w.path, short: shortPath(w.path), main: w.main, current: w.current, locked: w.locked, prunable } : null,
      upstream: l.upstream,
      upstreamGone: l.upstreamGone,
      activity: activity || null,
      ahead: l.ahead,
      behind: l.behind,
      changes,
      merged: merged ?? null,
      mergedAs: l.mergedAs || null,
      // Shipped: { reason: 'merged' | 'pr' | 'key' | 'subject' | 'net-patch', pr?, key?, sha? } or null
      // (sha: the base commit with the same key, subject or change; pr: its pull request number). A done
      // lane is "Merged" in the list: never "needs you", never forecast. `changes` still shows
      // uncommitted files on it.
      done: l.netEmpty || l.noWork ? null : l.done || (merged ? { reason: 'merged' } : null),
      // The PR title (github.joinLanes, or the merged PR that shipped it), else the newest commit
      // subject of the lane's own work, else the branch name.
      title: l.subject || l.name,
      nothingAhead: l.ahead === 0,
      // Only agent bookkeeping commits ahead (baseline, swept-up scratch files): no forecast.
      noWork: Boolean(l.noWork),
      agent: agentGuess(l.branch, trailers),
    };
    if (l.prCheck) prFacts.set(out, { head: l.head, commits: l.commits ?? [], all: commits });
    return out;
  }));
  result.sort((x, y) => (y.activity || 0) - (x.activity || 0));
  const res: LanesResult = { base: b ? b.name : null, baseRef: b ? b.ref : null, baseSha: b ? b.sha : null, lanes: result };
  return prHeads.length ? { ...res, lanes: prShipped(res, prHeads) } : res;
}

// One lanes() per repository and base at a time (AK-639): Review, its counts and the badges all ask
// when a repo opens. A caller joins the run in flight unless the repository changed since it started
// (`gen`: main.js bumps it on every watcher event and after its own git commands); then it starts a
// fresh one. The result is shared: callers copy before changing it (prShipped does).
const lanesRuns = new Map<string, { gen: number; promise: Promise<LanesResult> }>(); // cwd \0 base → { gen, promise }
export function sharedLanes(cwd: string, { base, gen = 0 }: { base?: string | null; gen?: number } = {}): Promise<LanesResult> {
  const key = `${cwd}\0${base || ''}`;
  const hit = lanesRuns.get(key);
  if (hit && hit.gen === gen) return hit.promise;
  const run = { gen, promise: lanes(cwd, { base }) };
  lanesRuns.set(key, run);
  const done = () => { if (lanesRuns.get(key) === run) lanesRuns.delete(key); };
  run.promise.then(done, done);
  return run.promise;
}

// Send back (renderer/send-back.js): for each conflicting file, the commits on `base` since `head`
// left it that changed the file, newest first (at most 3 per file, 20 files). Read-only.
// { [file]: [{ sha, subject, pr }] }, pr from a squash title's "(#12)" or a merge commit; {} when
// the two have no merge base.
export async function baseTouches(cwd: string, head: string, base: string, files: readonly string[] = []): Promise<Record<string, BaseTouch[]>> {
  let mb: string;
  try { mb = (await run(cwd, ['merge-base', head, base])).trim(); } catch { return {}; }
  if (!mb) return {};
  const out: Record<string, BaseTouch[]> = {};
  await mapLimit(files.slice(0, 20), 4, async (f) => {
    const log = await run(cwd, ['log', '-n', '3', '--format=%h%x1f%s', `${mb}..${base}`, '--', f]).catch(() => '');
    out[f] = log.split('\n').filter(Boolean).map((l) => {
      const [sha = '', subject = ''] = l.split('\x1f');
      const m = /\(#(\d+)\)\s*$/.exec(subject) || /^Merge pull request #(\d+)\b/.exec(subject);
      return { sha, subject: subject.slice(0, 200), pr: m ? Number(m[1]) : null };
    });
  });
  return out;
}

