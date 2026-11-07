import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, GitError, EMPTY_TREE, SEP } from './run.ts';
import { getStatus, buildPartialPatch } from './status.ts';
import { readCommitDiffs } from './log.ts';
import type { FileDiff, RewriteOp } from '../../shared/git-types.ts';

/** A reword's message; a split's selection (each path: 'all' or "hunk:line" keys) and two messages. */
export interface RewriteExtra { message?: string; files?: Record<string, 'all' | readonly string[]>; messages?: readonly (string | null | undefined)[] }

// Cherry-pick one commit. One whose changes are already here stops git half-way; leave nothing
// in progress and say so ('empty-pick'). `keepEmpty` commits it anyway.
export async function cherryPick(cwd: string, sha: string, keepEmpty?: boolean): Promise<string> {
  if (keepEmpty) return run(cwd, ['cherry-pick', '--allow-empty', '--keep-redundant-commits', sha]);
  try {
    return await run(cwd, ['cherry-pick', sha]);
  } catch (e) {
    const err = e as GitError;
    if (!/is now empty|nothing to commit/.test(`${err.stderr || ''}\n${err.message}`) || (await getStatus(cwd)).conflicts?.length) throw err;
    await run(cwd, ['cherry-pick', '--abort']).catch(() => {});
    throw new GitError('Its changes are already on this branch.', { code: 'empty-pick' });
  }
}

// History rewriting (in-place commit editing), implemented as a
// non-interactive `git rebase -i` with a generated todo list.

// Check that `sha` can be rewritten by `op` on `tip` (HEAD, or the branch about to be checked
// out), and find where the rebase starts (`base`, null for the root) and the commits it replays.
export async function rewriteRange(cwd: string, op: RewriteOp, sha: string, tip = 'HEAD'): Promise<{ parents: string[]; base: string | null; list: string[] }> {
  const onBranch = await run(cwd, ['merge-base', '--is-ancestor', sha, tip]).then(() => true, () => false);
  if (!onBranch) throw new GitError(tip === 'HEAD' ? 'This commit is not on the current branch.' : `This commit is not on ${tip}.`);
  const parents = (await run(cwd, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').slice(1);
  if (parents.length > 1) throw new GitError('Rewriting merge commits is not supported.');

  // Where does the rebase start? swap/squash/fixup need the grandparent.
  const needsGrandparent = op === 'swapParent' || op === 'squash' || op === 'fixup';
  if (needsGrandparent && parents.length === 0) throw new GitError('The root commit has no parent to combine with.');
  let base = parents[0] || null;
  if (needsGrandparent) {
    const gp = (await run(cwd, ['rev-list', '--parents', '-n', '1', parents[0] ?? ''])).trim().split(' ').slice(1);
    if (gp.length > 1) throw new GitError('The parent is a merge commit; cannot rewrite across it.');
    base = gp[0] || null;
  }
  const range = base ? `${base}..${tip}` : tip;
  const merges = (await run(cwd, ['rev-list', '--merges', range])).trim();
  if (merges) throw new GitError('There are merge commits between this commit and HEAD; rewriting would flatten them.');
  const list = (await run(cwd, ['rev-list', '--reverse', range])).trim().split('\n').filter(Boolean);
  return { parents, base, list };
}

// Whether `sha` is on HEAD, and the local branches that contain it (to switch to and rewrite it there).
export async function commitBranches(cwd: string, sha: string): Promise<{ onHead: boolean; branches: string[] }> {
  const onHead = await run(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']).then(() => true, () => false);
  const out = await run(cwd, ['branch', '--format=%(refname:short)', '--contains', sha]).catch(() => '');
  return { onHead, branches: out.split('\n').map((b) => b.trim()).filter(Boolean) };
}

export async function rewrite(cwd: string, op: RewriteOp, sha: string, extra: RewriteExtra = {}): Promise<void> {
  // A merge commit at HEAD can't be replayed by a rebase: reword it in place.
  if (op === 'reword' && (await run(cwd, ['rev-parse', 'HEAD'])).trim() === sha
    && (await run(cwd, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').length > 2) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'since-'));
    try {
      fs.writeFileSync(path.join(tmp, 'msg'), extra.message ?? '');
      await run(cwd, ['commit', '--amend', '--only', '--allow-empty', '--no-verify', '-q', '-F', path.join(tmp, 'msg')], { env: { GIT_OPTIONAL_LOCKS: '1' } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  const { parents, base, list } = await rewriteRange(cwd, op, sha);
  // A split builds its two commits up front; the rebase picks them in place of the original.
  const halves = op === 'split' ? await splitCommits(cwd, sha, parents[0] || null, extra) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'since-'));
  const todo: string[] = [];
  for (const c of list) {
    if (c === sha) {
      if (op === 'drop') todo.push(`drop ${c}`);
      else if (op === 'split' && halves) todo.push(`pick ${halves[0]}`, `pick ${halves[1]}`);
      else if (op === 'reword') {
        const f = path.join(tmp, 'msg');
        fs.writeFileSync(f, extra.message ?? '');
        todo.push(`pick ${c}`, `exec git commit --amend --allow-empty --no-verify -q -F ${JSON.stringify(f)}`);
      } else if (op === 'squash') todo.push(`squash ${c}`);
      else if (op === 'fixup') todo.push(`fixup ${c}`);
      else if (op === 'swapParent') {
        // previous todo line is the parent; swap the two
        const prev = todo.pop();
        todo.push(`pick ${c}`, prev ?? '');
      } else todo.push(`pick ${c}`);
    } else todo.push(`pick ${c}`);
  }
  const todoFile = path.join(tmp, 'todo');
  fs.writeFileSync(todoFile, todo.join('\n') + '\n');
  const args = ['-c', 'rebase.instructionFormat=%s', 'rebase', '-i', '--autostash', '--empty=keep'];
  args.push(base ? base : '--root');
  try {
    await run(cwd, args, {
      env: {
        GIT_SEQUENCE_EDITOR: `cp ${JSON.stringify(todoFile)}`,
        GIT_EDITOR: 'true',
        GIT_OPTIONAL_LOCKS: '1',
      },
    });
  } catch (e) {
    // A rebase stopped by a signing failure has nothing for the user to resolve; put the branch back.
    if ((e as Error).message.startsWith("Couldn't sign")) await run(cwd, ['rebase', '--abort'], { env: { GIT_OPTIONAL_LOCKS: '1' } }).catch(() => {});
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Build the two commits that replace `sha` when it is split. `files` maps each
// path to 'all' or to the selected line keys ("hunk:line") of its commitDiffs
// entry; the selection becomes the first commit, the rest the second. Both keep
// the original author and date. Returns [first, second]; the second has the
// original tree, so the commits on top replay without conflicts.
async function splitCommits(cwd: string, sha: string, parent: string | null, { files = {}, messages = [] }: RewriteExtra): Promise<[string, string]> {
  const msgs = messages.map((m) => String(m || '').trim());
  if (msgs.length !== 2 || !msgs[0] || !msgs[1]) throw new GitError('Both commits need a message.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'since-split-'));
  try {
    return await buildSplit(cwd, sha, parent, files, msgs, { GIT_INDEX_FILE: path.join(tmp, 'index') });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The first commit's tree is built in a private index, so the working tree and real index are untouched.
async function buildSplit(cwd: string, sha: string, parent: string | null, files: Record<string, 'all' | readonly string[]>, msgs: string[], env: NodeJS.ProcessEnv): Promise<[string, string]> {
  const diffs = new Map((await readCommitDiffs(cwd, sha)).map(([, r]) => [r.path, r]));
  await run(cwd, ['read-tree', ...(parent ? [parent] : ['--empty'])], { env });
  // Removals go first, so a file replaced by a folder of the same name (or the
  // reverse) can take its place when both changes are selected.
  const removals: string[] = [], edits: (() => Promise<unknown>)[] = [];
  for (const [p, sel] of Object.entries(files)) {
    const d = diffs.get(p);
    if (!d) throw new GitError(`${p} is not changed in this commit.`);
    const keys = sel === 'all' ? null : [...new Set(sel)];
    if (keys && !keys.length) continue;
    const changes = d.hunks.reduce((n, hk) => n + hk.lines.filter((l) => l.t !== ' ').length, 0);
    if (keys && keys.length < changes) { edits.push(() => applyPartial(cwd, d, keys, env)); continue; }
    // The whole file (binary, mode-only and submodule changes have no lines to pick):
    // take its entry from the commit, or remove it if the commit deletes it. Only a
    // file or submodule at exactly this path counts: if a folder replaced the file,
    // ls-tree lists that folder, and the file is gone.
    const entry = (await run(cwd, ['ls-tree', '-z', sha, '--', p])).split('\0')[0] ?? '';
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (entry && entry.slice(tab + 1) === p && (type === 'blob' || type === 'commit')) {
      edits.push(() => run(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${p}`], { env }));
    } else removals.push(p);
  }
  if (removals.length) await run(cwd, ['update-index', '--force-remove', '-z', '--stdin'], { input: removals.join('\0') + '\0', env });
  for (const edit of edits) {
    try { await edit(); } catch (e) {
      throw /file\/directory conflict|already exists|cannot add to the index|does not exist in index/i.test((e as Error).message)
        ? new GitError('A file and a folder with the same name changed in this commit. Select both changes for the first commit, or neither.')
        : e;
    }
  }
  const tree = (await run(cwd, ['write-tree'], { env })).trim();
  const treeOf = async (rev: string | null) => (rev ? (await run(cwd, ['rev-parse', `${rev}^{tree}`])).trim() : EMPTY_TREE);
  if (tree === await treeOf(parent)) throw new GitError('Select at least one change for the first commit.');
  if (tree === await treeOf(sha)) throw new GitError('Leave at least one change for the second commit.');

  const [name, email, date] = (await run(cwd, ['show', '-s', '--date=raw', '--format=%an%x00%ae%x00%ad', sha])).split(SEP);
  const author = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: (date ?? '').trim() };
  // commit-tree only signs when asked, unlike commit and rebase.
  const sign = (await run(cwd, ['config', '--bool', 'commit.gpgsign'], { allowCodes: [0, 1] })).trim() === 'true';
  const make = async (t: string, p: string | null, msg: string) => (await run(cwd, ['commit-tree', ...(sign ? ['-S'] : []), t, ...(p ? ['-p', p] : []), '-F', '-'], { input: msg + '\n', env: author })).trim();
  const first = await make(tree, parent, msgs[0] ?? '');
  return [first, await make(await treeOf(sha), first, msgs[1] ?? '')];
}

// Apply the selected lines of a raw (latin1) file diff to the private index, as bytes.
async function applyPartial(cwd: string, d: FileDiff, keys: string[], env: NodeJS.ProcessEnv): Promise<void> {
  // Removing some lines of a deleted file keeps the file in the first commit.
  const minus = d.header.find((l) => l.startsWith('--- '));
  const fd: FileDiff = d.newPath !== '/dev/null' ? d : {
    ...d, header: d.header.filter((l) => !l.startsWith('deleted file')).map((l) => (l === '+++ /dev/null' ? '+++ ' + (minus ?? '').slice(4).replace(/^("?)a\//, '$1b/') : l)),
  };
  const patch = buildPartialPatch(fd, keys, 'stage');
  if (patch) await run(cwd, ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], { input: Buffer.from(patch, 'latin1'), env });
}

