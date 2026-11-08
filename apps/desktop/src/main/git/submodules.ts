import fs from 'node:fs';
import path from 'node:path';
import { run, GitError, W_ENV } from './run.ts';
import { stashPush, getStashes } from './stash.ts';
import type { Submodule, SubmoduleHead, SubmoduleState } from '../../shared/git-types.ts';

/** What updating a submodule changed, for undo: its checkout before and after, and a stash it made. */
export interface SubmoduleChange { path: string; before: SubmoduleHead | null; after: SubmoduleHead | null; stash?: string | undefined; discarded?: boolean; message?: string }

// Submodules: read their state, update them, and stash, discard or restore their changes.

// Submodules. The superproject records one commit per submodule (a gitlink entry in the
// index); each submodule's `state` compares its own checkout with that:
//   uninitialized: not cloned or not checked out yet (Update fixes that)
//   outdated: checked out at another commit than the one recorded
//   modified: its work tree has uncommitted changes or untracked files
//   conflict: the recorded commit is in a merge conflict
//   clean: checked out at the recorded commit, nothing changed
const SUBMODULE_CAP = 500;

// .gitmodules as `git config -z --get-regexp` prints it → Map(path → { name, url }).
export function parseGitmodules(out: string): Map<string, { name: string; url: string }> {
  const byName = new Map<string, { name: string; path?: string; url?: string }>();
  for (const rec of out.split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl === -1) continue;
    const m = /^submodule\.(.+)\.(path|url)$/.exec(rec.slice(0, nl));
    if (!m) continue;
    const name = m[1] ?? '';
    const e = byName.get(name) || { name };
    e[m[2] as 'path' | 'url'] = rec.slice(nl + 1);
    byName.set(name, e);
  }
  return new Map([...byName.values()].flatMap((e) => (e.path ? [[e.path, { name: e.name, url: e.url || '' }] as const] : [])));
}

// The submodule's checked-out commit and branch, or null when it isn't checked out.
export async function submoduleHead(cwd: string, p: string): Promise<SubmoduleHead | null> {
  const abs = path.join(cwd, p);
  if (!fs.existsSync(path.join(abs, '.git'))) return null;
  const sha = (await run(abs, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] }).catch(() => '')).trim();
  if (!sha) return null;
  const branch = (await run(abs, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] }).catch(() => '')).trim();
  return { sha, branch: branch || null };
}

const submoduleDirty = async (cwd: string, p: string): Promise<boolean> => !!(await run(path.join(cwd, p), ['status', '--porcelain', '-z', '--ignore-submodules=none']).catch(() => ''));

export async function getSubmodules(cwd: string): Promise<Submodule[]> {
  // Runs on every status refresh, so the index is only read at the paths .gitmodules lists.
  if (!fs.existsSync(path.join(cwd, '.gitmodules'))) return [];
  const info = parseGitmodules(await run(cwd, ['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\.'], { allowCodes: [0, 1] }));
  if (!info.size) return [];
  const staged = await run(cwd, ['ls-files', '-s', '-z', '--', ...[...info.keys()].map((p) => `:(literal)${p}`)]);
  const links = new Map<string, { recorded: string | null; conflict: boolean }>();
  for (const rec of staged.split('\0')) {
    const m = /^160000 ([0-9a-f]+) (\d)\t(.+)$/.exec(rec);
    if (!m) continue;
    const p = m[3] ?? '';
    const e = links.get(p) || { recorded: null, conflict: false };
    if (m[2] === '0') e.recorded = m[1] ?? null; else e.conflict = true;
    links.set(p, e);
  }
  const list = [...links].slice(0, SUBMODULE_CAP);
  return Promise.all(list.map(async ([p, l]) => {
    const head = await submoduleHead(cwd, p);
    const dirty = head ? await submoduleDirty(cwd, p) : false;
    const state: SubmoduleState = l.conflict ? 'conflict' : !head ? 'uninitialized' : dirty ? 'modified' : head.sha !== l.recorded ? 'outdated' : 'clean';
    return { path: p, name: info.get(p)?.name || p, url: info.get(p)?.url || '', recorded: l.recorded, head: head?.sha || null, branch: head?.branch || null, state };
  }));
}

// `git submodule update --init` for `paths` (all when empty). Refuses submodules with local
// changes (code 'dirty-submodule' when that is all that's in the way), so nothing uncommitted is
// lost, unless `stash`: then those changes are stashed in each submodule first. Returns
// [{ path, before, after, stash }] (before/after { sha, branch } or null when not checked out,
// `stash` the sha stashed in it) for undo, plus the error if git failed part-way.
export async function updateSubmodules(cwd: string, paths: readonly string[] = [], { stash = false }: { stash?: boolean } = {}): Promise<{ changes: SubmoduleChange[]; error: unknown }> {
  const subs = await getSubmodules(cwd);
  const chosen = paths.length ? subs.filter((s) => paths.includes(s.path)) : subs;
  if (!chosen.length) throw new GitError(paths.length ? 'That submodule no longer exists.' : 'This repository has no submodules.');
  const busy = chosen.filter((s) => s.state === 'conflict' || (s.state === 'modified' && !stash));
  if (busy.length) {
    const conflict = busy.some((s) => s.state === 'conflict');
    throw new GitError(`${busy.map((s) => s.path).join(', ')} ${busy.length > 1 ? 'have' : 'has'} ${conflict ? 'local changes or a conflict. Commit or stash them in the submodule first.' : 'local changes.'}`, { code: conflict ? undefined : 'dirty-submodule' });
  }
  const stashed = new Map<string, string | null>();
  for (const s of chosen.filter((x) => x.state === 'modified')) stashed.set(s.path, await stashSubmodule(cwd, s.path, 'Set aside to update submodules'));
  const before = await Promise.all(chosen.map((s) => submoduleHead(cwd, s.path)));
  let error: unknown = null;
  await run(cwd, ['submodule', 'update', '--init', '--checkout', '--', ...chosen.map((s) => s.path)]).catch((err: unknown) => { error = err; });
  const after = await Promise.all(chosen.map((s) => submoduleHead(cwd, s.path)));
  const changes = chosen.map((s, i): SubmoduleChange => { const st = stashed.get(s.path); return { path: s.path, before: before[i] ?? null, after: after[i] ?? null, ...(st ? { stash: st } : {}) }; })
    .filter((c) => c.stash || !sameHead(c.before, c.after));
  return { changes, error };
}

// Stash every uncommitted change in submodule `p`, untracked files too. Returns the stash sha, or
// null when there was nothing to stash. The stash lives in the submodule's own stash list.
export async function stashSubmodule(cwd: string, p: string, message: string): Promise<string | null> {
  const abs = path.join(cwd, p);
  const top = () => run(abs, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowCodes: [0, 1] }).then((o) => o.trim());
  const prev = await top();
  await stashPush(abs, { message, untracked: true });
  const sha = await top();
  return sha && sha !== prev ? sha : null;
}

// Pop the stash `sha` in submodule `p` (by sha, wherever it now is in its list).
export async function popSubmoduleStash(cwd: string, p: string, sha: string): Promise<void> {
  const abs = path.join(cwd, p);
  const i = (await getStashes(abs)).findIndex((x) => x.sha === sha);
  if (i === -1) throw new GitError(`the stash in submodule ${p} was applied or dropped since.`);
  await run(abs, ['stash', 'pop', '-q', '--index', `stash@{${i}}`], { env: W_ENV });
}

// Discard every uncommitted change in submodule `p`, untracked files too. They are kept as a
// stash commit pinned under refs/since/discarded in the submodule (not in its stash list), so
// undo can bring them back. Returns that commit's sha, or null when there was nothing to discard.
export async function discardSubmodule(cwd: string, p: string): Promise<string | null> {
  const sha = await stashSubmodule(cwd, p, `Discarded changes in ${p}`);
  if (!sha) return null;
  const abs = path.join(cwd, p);
  await run(abs, ['update-ref', `refs/since/discarded/${sha}`, sha], { env: W_ENV });
  await run(abs, ['stash', 'drop', '-q', 'stash@{0}'], { env: W_ENV });
  return sha;
}

// Put changes `discardSubmodule` removed back into submodule `p`.
async function restoreDiscardedSubmodule(cwd: string, p: string, sha: string): Promise<void> {
  await run(path.join(cwd, p), ['stash', 'apply', '-q', '--index', sha], { env: W_ENV });
}

// How many files have uncommitted changes in submodule `p`.
// The uncommitted changes inside submodule `p`: { count, files: [{ status, path }] (first `max`),
// head: { sha, branch } }, for the Discard sheet.
export async function submoduleChanges(cwd: string, p: string, max = 5): Promise<{ count: number; files: { status: string; path: string }[]; head: SubmoduleHead | null }> {
  const out = await run(path.join(cwd, p), ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
  const lines = out.split('\0').filter(Boolean);
  const files = lines.slice(0, max).map((l) => ({ status: l.startsWith('??') ? '?' : (l.charAt(0) !== ' ' ? l.charAt(0) : l.charAt(1)), path: l.slice(3) }));
  return { count: lines.length, files, head: await submoduleHead(cwd, p) };
}

const sameHead = (a: SubmoduleHead | null | undefined, b: SubmoduleHead | null | undefined): boolean => (a?.sha || null) === (b?.sha || null) && (a?.branch || null) === (b?.branch || null);

// Undo or redo `updateSubmodules` changes. Each submodule must still be where the change left
// it (`after` for undo) and clean (code 'dirty-submodule' if not); going back to "not checked
// out" deinitialises it, which keeps its clone under .git/modules so redo needs no network.
// Changes the update stashed (`stash`) are popped on undo and stashed again on redo.
export async function restoreSubmodules(cwd: string, changes: SubmoduleChange[], dir: 'undo' | 'redo'): Promise<void> {
  const [cur, next] = dir === 'undo' ? ['after', 'before'] as const : ['before', 'after'] as const;
  for (const c of changes) {
    if (!sameHead(await submoduleHead(cwd, c.path), c[cur])) throw new GitError(`submodule ${c.path} has moved since.`);
    if (c[cur] && !(dir === 'redo' && c.stash) && (await submoduleDirty(cwd, c.path))) throw new GitError(`submodule ${c.path} has local changes.`, { code: 'dirty-submodule' });
    if (dir === 'undo' && c.stash && !c.discarded && !(await getStashes(path.join(cwd, c.path))).some((x) => x.sha === c.stash)) throw new GitError(`the stash in submodule ${c.path} was applied or dropped since.`);
  }
  for (const c of changes) {
    if (dir === 'redo' && c.stash) c.stash = await (c.discarded ? discardSubmodule(cwd, c.path) : stashSubmodule(cwd, c.path, c.message || 'Set aside to update submodules')) || undefined;
    const want = c[next];
    if (!want) { await run(cwd, ['submodule', 'deinit', '-q', '--', c.path]); continue; }
    if (!c[cur]) await run(cwd, ['submodule', 'update', '--init', '--checkout', '-q', '--', c.path]);
    const abs = path.join(cwd, c.path);
    const onBranch = want.branch && (await run(abs, ['rev-parse', '-q', '--verify', `refs/heads/${want.branch}`], { allowCodes: [0, 1] })).trim() === want.sha;
    await run(abs, onBranch ? ['checkout', '-q', want.branch ?? ''] : ['checkout', '-q', '--detach', want.sha]);
    if (dir === 'undo' && c.stash) await (c.discarded ? restoreDiscardedSubmodule(cwd, c.path, c.stash) : popSubmoduleStash(cwd, c.path, c.stash));
  }
}

