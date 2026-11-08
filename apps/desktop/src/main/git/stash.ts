import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, SEP, GitError, W_ENV, tooOld } from './run.ts';
import { workingDiff, buildPartialPatch, applyPatch } from './status.ts';
import { pinObjects } from './undo.ts';
import type { DiffTarget } from './status.ts';
import type { Stash } from '../../shared/git-types.ts';

export interface StashPushOptions { message?: string | null; untracked?: boolean; staged?: boolean; paths?: readonly string[] }

// Stashes

export async function getStashes(cwd: string): Promise<Stash[]> {
  const out = await run(cwd, ['stash', 'list', '--format=%gd%x00%H%x00%at%x00%gs'], { allowCodes: [0, 1, 128] });
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref = '', sha = '', time, msg = ''] = l.split(SEP);
    return { ref, sha, time: Number(time), message: msg };
  });
}

// Stash list edits used to undo and redo a dropped stash.

export async function dropStashCommit(cwd: string, sha: string): Promise<void> {
  const i = (await getStashes(cwd)).findIndex((x) => x.sha === sha);
  if (i === -1) throw new GitError('That stash no longer exists.');
  await run(cwd, ['stash', 'drop', '-q', `stash@{${i}}`], { env: W_ENV });
}

// Put a dropped stash back at its old position, with its old message.
export async function restoreStash(cwd: string, { sha, message, index }: { sha: string; message: string; index: number }): Promise<void> {
  const list = await getStashes(cwd);
  if (list.some((x) => x.sha === sha)) return;
  const above = list.slice(0, index);
  // Entries lifted off the top are pinned first, so a failure part-way loses nothing.
  const lift = 'refs/since/stash-lift';
  await pinObjects(cwd, lift, { objects: above.map((x) => x.sha) });
  for (let i = 0; i < above.length; i++) await run(cwd, ['stash', 'drop', '-q', 'stash@{0}'], { env: W_ENV });
  for (const e of [{ sha, message }, ...above.reverse()]) await run(cwd, ['stash', 'store', '-q', '-m', e.message, e.sha], { env: W_ENV });
  await pinObjects(cwd, lift);
}

// Stash some or all uncommitted changes: `paths` limits it to those files, `staged` to the index.
export async function stashPush(cwd: string, { message, untracked, staged, paths }: StashPushOptions = {}): Promise<void> {
  if (staged && untracked) throw new GitError('Staged-only stashes can’t include untracked files.');
  const args = ['stash', 'push', ...(staged ? ['--staged'] : []), ...(untracked ? ['-u'] : []), ...(message ? ['-m', message] : [])];
  // A path whose deletion is staged (the old side of a rename) isn't a pathspec git stash accepts.
  // Stash the rest (the stash's index already records the deletion), then put the old path back.
  let gone: string[] = [];
  if (paths?.length && !staged) {
    const known = new Set((await run(cwd, ['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean));
    gone = paths.filter((p) => !known.has(p) && !fs.existsSync(path.join(cwd, p)));
    if (gone.length === paths.length) gone = [];
  }
  if (paths?.length) args.push('--', ...paths.filter((p) => !gone.includes(p)));
  try {
    // With GIT_LITERAL_PATHSPECS, `stash -u` saves untracked files but leaves them in place; literal paths only matter with paths.
    await run(cwd, args, { env: paths?.length ? W_ENV : { GIT_OPTIONAL_LOCKS: '1' } });
    if (gone.length) await run(cwd, ['checkout', 'HEAD', '--', ...gone]);
  } catch (e) {
    // `stash push --staged` arrived in Git 2.35; older git rejects the option with a usage dump.
    const err = e as GitError;
    if (staged && /unknown option|usage: git stash/i.test(`${err.stderr || ''}\n${err.message}`)) throw tooOld('stashStaged');
    throw e;
  }
}

// Stash only the selected unstaged lines of one file, then take them out of the working tree.
// The stash is HEAD plus those lines, so the file may not have staged changes of its own.
export async function stashLines(cwd: string, file: DiffTarget, selected: readonly string[], message?: string | null): Promise<void> {
  const d = await workingDiff(cwd, file, { staged: false });
  const patch = d && buildPartialPatch(d, selected, 'stage');
  if (!patch) throw new GitError('Select changed lines to stash.');
  const head = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowCodes: [0, 1] })).trim();
  if (!head) throw new GitError('There’s no commit to stash on yet.');
  const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
  if ((await run(cwd, ['diff', '--cached', '--name-only', '--', ...paths], { env: W_ENV })).trim()) {
    throw new GitError(`${file.path} has staged changes. Unstage them first, or stash the whole file.`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'since-stash-'));
  try {
    const env = { ...W_ENV, GIT_INDEX_FILE: path.join(tmp, 'index') };
    await run(cwd, ['read-tree', head], { env });
    await run(cwd, ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], { input: patch, env });
    const tree = (await run(cwd, ['write-tree'], { env })).trim();
    const branch = (await run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] })).trim() || '(no branch)';
    const subject = (await run(cwd, ['log', '-1', '--format=%h %s', head])).trim();
    const msg = message ? `On ${branch}: ${message}` : `WIP on ${branch}: ${subject}`;
    const index = (await run(cwd, ['commit-tree', `${head}^{tree}`, '-p', head, '-m', `index on ${branch}: ${subject}`])).trim();
    const stash = (await run(cwd, ['commit-tree', tree, '-p', head, '-p', index, '-m', msg])).trim();
    await run(cwd, ['stash', 'store', '-q', '-m', msg, stash], { env: W_ENV });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await applyPatch(cwd, buildPartialPatch(d, selected, 'reverse') ?? '', { reverse: true });
}

export const stashApply = (cwd: string, ref: string, pop?: boolean): Promise<string> => run(cwd, ['stash', pop ? 'pop' : 'apply', '--index', ref], { env: W_ENV });
export const stashDrop = (cwd: string, ref: string): Promise<string> => run(cwd, ['stash', 'drop', ref], { env: W_ENV });

