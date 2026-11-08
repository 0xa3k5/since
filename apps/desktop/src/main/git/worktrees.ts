import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, GitError, W_ENV, chunk, SEP } from './run.ts';
import { getOperationState } from './status.ts';
import { getRemotes } from './remotes.ts';
import { stashPush, getStashes, stashApply, dropStashCommit } from './stash.ts';
import { dirtyPaths } from './undo.ts';
import type { CleanupFailure, CleanupRemoved, CleanupResult, OperationKind, SavedWorktree, Worktree } from '../../shared/git-types.ts';

/** A removed worktree, with the stash or saved changes undo puts back. */
export type RemovedWorktree = Worktree & { stash?: string; saved?: SavedWorktree };
/** One Clean up item: a worktree to remove and/or a branch to delete (kept if it moved from `head`). */
export interface CleanupItem { branch?: string | null; head?: string | null; worktree?: string | null; force?: boolean; stash?: boolean; abort?: boolean }

// Worktrees. Each one is a plain record, so later features (per-agent lanes)
// can hang more fields off it without changing the callers.

export const realpath = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
export const samePath = (a: string, b: string): boolean => realpath(a) === realpath(b);
const NULL_OID = /^0+$/;

export async function getWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await run(cwd, ['worktree', 'list', '--porcelain', '-z']);
  const here = realpath(cwd);
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const field of out.split('\0')) {
    if (!field) { cur = null; continue; }
    const sp = field.indexOf(' ');
    const key = sp === -1 ? field : field.slice(0, sp);
    const val = sp === -1 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      cur = { path: val, name: path.basename(val), head: null, branch: null, detached: false, bare: false, main: !list.length, current: realpath(val) === here, locked: false, lockReason: '', missing: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (key === 'HEAD') cur.head = NULL_OID.test(val) ? null : val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') { cur.locked = true; cur.lockReason = val; }
    else if (key === 'prunable') cur.missing = true;
  }
  return list.filter((w) => !w.bare);
}

export async function findWorktree(cwd: string, dir: string): Promise<Worktree> {
  const wt = (await getWorktrees(cwd)).find((w) => samePath(w.path, dir));
  if (!wt) throw new GitError('That worktree no longer exists.');
  return wt;
}

// Number of changed, untracked or conflicted paths in a worktree.
export async function worktreeChanges(dir: string): Promise<number> {
  return new Set(await dirtyPaths(dir)).size;
}

// Where a new worktree goes when the user gives no location: next to the main
// worktree, named "<repo>-<branch>", with a number added if that is taken.
function defaultWorktreePath(mainPath: string, label: string): string {
  const slug = label.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'worktree';
  const base = path.join(path.dirname(mainPath), `${path.basename(mainPath)}-${slug}`);
  let dir = base;
  for (let i = 2; fs.existsSync(dir); i++) dir = `${base}-${i}`;
  return dir;
}

function resolveWorktreePath(mainPath: string, dir: string): string {
  if (dir.startsWith('~/') || dir === '~') dir = path.join(os.homedir(), dir.slice(1));
  return path.resolve(path.dirname(mainPath), dir);
}

// Add a worktree. `branch`: an existing local branch is checked out, a new name
// is created at `base`; no branch gives a detached HEAD at `base`. Returns the path.
// `force` moves an existing `branch` to `base` (`-B`), so the move and the new worktree are one step.
export async function addWorktree(cwd: string, { dir, branch, base, force = false }: { dir?: string | null; branch?: string | null; base?: string | null; force?: boolean } = {}): Promise<string> {
  const mainPath = (await getWorktrees(cwd)).find((w) => w.main)?.path ?? cwd;
  const at = base || 'HEAD';
  dir = dir ? resolveWorktreePath(mainPath, dir) : defaultWorktreePath(mainPath, branch || (await run(cwd, ['rev-parse', '--short', at])).trim());
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new GitError(`${dir} already exists and is not an empty folder.`);
  const local = branch && (await run(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { allowCodes: [0, 1] })).trim();
  const args = ['worktree', 'add', '-q'];
  if (!branch) args.push('--detach', dir, at);
  else if (local && force && base) args.push('-B', branch, dir, base);
  else if (local) args.push(dir, branch);
  else args.push('-b', branch, dir, at);
  await run(cwd, args, { env: W_ENV });
  return realpath(dir);
}

// Remove a worktree's folder. Refused unless the worktree is clean (code 'dirty-worktree'
// otherwise): undo recreates it from its branch or commit.
// Ignored files (build output, dependencies) are deleted with the folder.
// `stash` first stashes its uncommitted changes (the stash's SHA is returned as `stash`);
// `abort` first aborts a stopped rebase, merge, cherry-pick or revert there (not undoable).
// `changes` (cleanup redo only, not over IPC): 'stash' or 'discard' its changes via saveWorktree,
// returned as `saved`.
export async function removeWorktree(cwd: string, dir: string, { stash = false, abort = false, changes }: { stash?: boolean; abort?: boolean; changes?: 'stash' | 'discard' } = {}): Promise<RemovedWorktree> {
  let wt = await findWorktree(cwd, dir);
  if (wt.main) throw new GitError('The main worktree can’t be removed.');
  if (wt.current) throw new GitError('This window is showing that worktree. Switch to another one first.');
  if (wt.locked || wt.missing) await checkRemovable(wt);
  if (abort) {
    const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
    if (op) await run(wt.path, [op, '--abort'], { env: W_ENV });
    // An aborted rebase puts its branch back: undo re-adds the worktree on that, not the detached HEAD.
    if (op) wt = await findWorktree(cwd, dir);
  }
  let sha: string | null = null, saved: SavedWorktree | null = null;
  if (stash && await worktreeChanges(wt.path)) sha = await stashWorktree(wt.path, `Since: ${wt.name} before removing it`);
  else if (changes) saved = await saveWorktree(wt, changes === 'stash');
  try {
    await checkRemovable(wt);
    await run(cwd, ['worktree', 'remove', wt.path], { env: W_ENV });
  } catch (err) {
    if (sha) await popStash(wt.path, sha).catch(() => {});
    if (saved) await unstashWorktree(wt.path, saved).catch(() => {});
    throw err;
  }
  return sha ? { ...wt, stash: sha } : saved ? { ...wt, saved } : wt;
}

// Stash everything in worktree `dir` (untracked files too); returns the new stash's SHA.
async function stashWorktree(dir: string, message: string): Promise<string> {
  const top = () => run(dir, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowCodes: [0, 1] }).then((o) => o.trim());
  const prev = await top();
  await stashPush(dir, { message, untracked: true });
  const sha = await top();
  if (!sha || sha === prev) throw new GitError('Its changes could not be stashed.');
  return sha;
}

// Apply and drop the stash with this SHA in worktree `dir`.
export async function popStash(dir: string, sha: string): Promise<void> {
  const i = (await getStashes(dir)).findIndex((x) => x.sha === sha);
  if (i === -1) throw new GitError('Its stash was applied or dropped since.');
  await stashApply(dir, `stash@{${i}}`, true);
}

// Cleanup (cleanupLanes): stash every uncommitted change in a worktree, untracked files too.
// `keep` leaves the stash in the list; otherwise it is dropped and only the returned commit
// ({ sha, message, kept }) has it. Null when there was nothing to stash.
async function saveWorktree(wt: Worktree, keep: boolean): Promise<SavedWorktree | null> {
  const top = () => run(wt.path, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowCodes: [0, 1] }).then((o) => o.trim());
  const message = `Worktree ${wt.name} before it was removed`;
  const prev = await top();
  await stashPush(wt.path, { message, untracked: true });
  const sha = await top();
  if (!sha || sha === prev) return null;
  if (!keep) await run(wt.path, ['stash', 'drop', '-q', 'stash@{0}'], { env: W_ENV });
  return { sha, message, kept: keep };
}

// Put a saveWorktree commit back into the worktree at `dir`; a kept stash leaves the list.
async function unstashWorktree(dir: string, saved: SavedWorktree): Promise<void> {
  await run(dir, ['stash', 'apply', '-q', '--index', saved.sha], { env: W_ENV });
  if (saved.kept) await dropStashCommit(dir, saved.sha).catch(() => {});
}

// Put a removed worktree back at the same path, on the same branch or commit, with the changes
// `saved` stashed when it was removed.
export async function restoreWorktree(cwd: string, { path: dir, branch, head, saved }: { path: string; branch?: string | null; head?: string | null; saved?: SavedWorktree | null }): Promise<void> {
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new GitError(`${dir} is in the way.`);
  if (saved?.kept && !(await getStashes(cwd)).some((x) => x.sha === saved.sha)) throw new GitError(`the stash of ${path.basename(dir)}’s changes was applied or dropped since.`);
  await run(cwd, ['worktree', 'add', '-q', ...(branch ? [dir, branch] : ['--detach', dir, head ?? ''])], { env: W_ENV });
  if (saved) await unstashWorktree(dir, saved);
}

export const lockWorktree = async (cwd: string, dir: string, reason?: string | null): Promise<string> => run(cwd, ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), (await findWorktree(cwd, dir)).path], { env: W_ENV });
export const unlockWorktree = async (cwd: string, dir: string): Promise<string> => run(cwd, ['worktree', 'unlock', (await findWorktree(cwd, dir)).path], { env: W_ENV });
export const pruneWorktrees = (cwd: string): Promise<string> => run(cwd, ['worktree', 'prune'], { env: W_ENV });

// Lanes → Clean up: remove worktrees and delete branches in bulk. Each item is
// { branch, head, worktree, force }: `head` is the branch tip the user saw (a branch that has
// moved since is kept), `force` allows removing a dirty worktree (its uncommitted files are lost to
// git, though undo brings them back), `stash` does too but keeps them in the stash list, `abort`
// aborts a rebase, merge, cherry-pick or revert stopped in it (a failure over one has `op` set).
// Worktrees go first, since a branch checked out in one can't be deleted: one `worktree remove`
// each, or a single `worktree prune` when every missing folder is selected. Branches then go in
// one `git branch -D` per 200. Never throws part-way: returns { removed, deleted, failed } so the
// journal can record exactly what happened. `onProgress({ done, total })` after each step.
export async function cleanupLanes(cwd: string, items: readonly CleanupItem[], { onProgress = () => {} }: { onProgress?: (p: { done: number; total: number }) => void } = {}): Promise<CleanupResult> {
  const worktrees = await getWorktrees(cwd);
  const removed: CleanupRemoved[] = [];
  const failed: CleanupFailure[] = [];
  const keep = new Set<string>(); // branches whose worktree is still there
  const wtItems = items.filter((i) => i.worktree);
  const found = wtItems.map((i) => ({ item: i, wt: worktrees.find((w) => samePath(w.path, i.worktree ?? '')) }));
  const branches = items.filter((i) => i.branch);
  const batches = chunk(branches, 200);
  const total = wtItems.length + batches.length;
  let done = 0;
  const tick = () => onProgress({ done: ++done, total });

  const missing = worktrees.filter((w) => w.missing && !w.locked);
  const pruneAll = missing.length > 0 && missing.every((m) => found.some((f) => f.wt === m));
  if (pruneAll) {
    try { await pruneWorktrees(cwd); } catch { /* fall back to one remove each below */ }
  }
  const after = pruneAll ? await getWorktrees(cwd) : worktrees;
  for (const { item, wt } of found) {
    try {
      if (!wt) throw new GitError('That worktree no longer exists.');
      if (wt.missing && !after.some((w) => w.path === wt.path)) {
        removed.push({ path: wt.path, branch: wt.branch, head: wt.head, pruned: true, lost: 0 });
        continue;
      }
      if (wt.main) throw new GitError('The main worktree can’t be removed.');
      if (wt.current) throw new GitError('This window is showing it.');
      if (wt.locked) throw new GitError('It is locked.');
      let lost = 0;
      if (!wt.missing) {
        const op = await worktreeOp(wt.path);
        if (op && item.abort) {
          await run(wt.path, [op, '--abort'], { env: W_ENV });
          Object.assign(wt, await findWorktree(cwd, wt.path)); // the branch it was rebasing is back
        } else if (op) throw opInProgress(`It has a ${op} in progress.`, op);
        lost = await worktreeChanges(wt.path);
        if (lost && !item.force && !item.stash && !item.abort) throw new GitError(`It has ${lost} uncommitted change${lost > 1 ? 's' : ''}.`);
      }
      // Uncommitted changes are stashed first (the stash dropped again unless `stash` or `abort`), so undo has them.
      const saved = lost ? await saveWorktree(wt, !!(item.stash || item.abort)) : null;
      await run(cwd, ['worktree', 'remove', ...(lost || wt.missing ? ['--force'] : []), wt.path], { env: W_ENV });
      removed.push({ path: wt.path, branch: wt.branch, head: wt.head, pruned: wt.missing, lost, ...(saved ? { saved } : {}) });
    } catch (e) {
      const err = e as GitError & { op?: string };
      failed.push({ name: wt?.name || path.basename(item.worktree ?? ''), message: err.message, ...(err.op ? { op: err.op, worktree: wt?.path ?? '' } : {}) });
      if (item.branch) keep.add(item.branch);
    } finally {
      tick();
    }
  }

  const deleted: string[] = [];
  if (branches.length) {
    const tips = new Map((await run(cwd, ['for-each-ref', '--format=%(refname:lstrip=2)%00%(objectname)', 'refs/heads'])).split('\n').filter(Boolean).map((l): [string, string] => { const [b = '', o = ''] = l.split(SEP); return [b, o]; }));
    for (const batch of batches) {
      const go: string[] = [];
      for (const i of batch) {
        const b = i.branch ?? '';
        if (keep.has(b)) continue;
        if (!tips.has(b)) failed.push({ name: b, message: 'That branch no longer exists.' });
        else if (i.head && tips.get(b) !== i.head) failed.push({ name: b, message: 'It has new commits since. Kept.' });
        else go.push(b);
      }
      let error: GitError | null = null;
      try { if (go.length) await run(cwd, ['branch', '-D', '--', ...go], { env: W_ENV }); } catch (err) { error = err as GitError; }
      const left = error ? new Set((await run(cwd, ['for-each-ref', '--format=%(refname:lstrip=2)', ...go.map((b) => `refs/heads/${b}`)])).split('\n').filter(Boolean)) : new Set<string>();
      for (const b of go) {
        if (!left.has(b)) deleted.push(b);
        else failed.push({ name: b, message: (error?.stderr || error?.message || '').split('\n').find((l) => l.includes(`'${b}'`))?.replace(/^error: /, '') || (error?.message ?? '') });
      }
      tick();
    }
  }
  return { removed, deleted, failed };
}

// Delete branches on their remotes, one `git push --delete` per remote. `shorts` are
// remote-tracking names ("origin/feature/x"), split on the longest matching remote name.
// Never deletes a remote's default branch (its `<remote>/HEAD`) or a branch a local branch still
// tracks: run it after the local branches are gone. Duplicates are dropped.
// Not undoable. Returns { deleted, failed }.
export async function deleteRemoteBranches(cwd: string, shorts: Iterable<string>): Promise<{ deleted: string[]; failed: CleanupFailure[] }> {
  const remotes = (await getRemotes(cwd)).map((r) => r.name).sort((a, b) => b.length - a.length);
  const tracked = new Set((await run(cwd, ['for-each-ref', '--format=%(upstream:short)', 'refs/heads'])).split('\n').filter(Boolean));
  const heads = new Map<string, Set<string>>();
  const defaultOf = async (remote: string): Promise<Set<string>> => {
    // Without a known `<remote>/HEAD`, main and master both count as the default.
    if (!heads.has(remote)) {
      const head = (await run(cwd, ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
      heads.set(remote, new Set(head ? [head, `${remote}/HEAD`] : [`${remote}/main`, `${remote}/master`, `${remote}/HEAD`]));
    }
    return heads.get(remote) ?? new Set<string>();
  };
  const byRemote = new Map<string, string[]>();
  const failed: CleanupFailure[] = [];
  for (const s of new Set(shorts)) {
    const remote = remotes.find((r) => s.startsWith(`${r}/`) && s.length > r.length + 1);
    if (!remote) { failed.push({ name: s, message: 'No such remote.' }); continue; }
    if ((await defaultOf(remote)).has(s)) { failed.push({ name: s, message: 'It’s the default branch.' }); continue; }
    if (tracked.has(s)) { failed.push({ name: s, message: 'A local branch still tracks it.' }); continue; }
    byRemote.set(remote, [...(byRemote.get(remote) || []), s.slice(remote.length + 1)]);
  }
  const deleted: string[] = [];
  for (const [remote, names] of byRemote) {
    try {
      await run(cwd, ['push', remote, '--delete', '--', ...names]);
      deleted.push(...names.map((n) => `${remote}/${n}`));
    } catch (err) {
      // A partial push still deleted some: whatever is no longer listed as a remote-tracking ref is gone.
      const left = new Set((await run(cwd, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`]).catch(() => '')).split('\n'));
      for (const n of names) (left.has(`${remote}/${n}`) ? failed.push({ name: `${remote}/${n}`, message: (err as Error).message }) : deleted.push(`${remote}/${n}`));
    }
  }
  return { deleted, failed };
}

// Whether `wt` (from getWorktrees) can be removed: unlocked, on disk, nothing in progress (unless
// `abort`: then it is aborted here, or `ignoreOp`: a later removal aborts it), clean (unless
// `dirty` is allowed). A refusal over an operation has code 'op-in-progress' and `op` set; a
// dirty one has code 'dirty-worktree' and `changes` set.
export async function checkRemovable(wt: Worktree, { dirty = false, abort = false, ignoreOp = false }: { dirty?: boolean; abort?: boolean; ignoreOp?: boolean } = {}): Promise<void> {
  if (wt.locked) throw new GitError(`“${wt.name}” is locked${wt.lockReason ? ` (${wt.lockReason})` : ''}. Unlock it first.`);
  if (wt.missing) throw new GitError(`“${wt.name}” no longer exists on disk. Use Prune Missing Worktrees instead.`);
  const op = await worktreeOp(wt.path);
  if (op && abort) await run(wt.path, [op, '--abort'], { env: W_ENV });
  else if (op && !ignoreOp) throw opInProgress(`“${wt.name}” has a ${op} in progress. Finish or abort it first.`, op);
  const n = dirty || (op && ignoreOp) ? 0 : await worktreeChanges(wt.path);
  if (n) throw Object.assign(new GitError(`“${wt.name}” has ${n} uncommitted change${n > 1 ? 's' : ''}. Commit, stash or discard ${n > 1 ? 'them' : 'it'} first.`), { code: 'dirty-worktree', changes: n });
}

// The rebase, merge, cherry-pick or revert stopped in the worktree at `dir`, or null.
export async function worktreeOp(dir: string): Promise<OperationKind | null> {
  return getOperationState((await run(dir, ['rev-parse', '--absolute-git-dir'])).trim());
}

export const opInProgress = (message: string, op: string): GitError & { op: string } => Object.assign(new GitError(message), { code: 'op-in-progress', op });

