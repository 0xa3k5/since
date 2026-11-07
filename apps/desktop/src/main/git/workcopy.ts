import fs from 'node:fs';
import path from 'node:path';
import { run, W_ENV, GitError } from './run.ts';
import { workingDiff, buildPartialPatch, applyPatch, getOperationState } from './status.ts';
import type { DiffTarget } from './status.ts';
import type { ConflictFile, SavedResolved } from '../../shared/git-types.ts';

// Destructive working-copy operations. Run them through the journal
// (journal.js), which snapshots what they destroy.

export async function discardFiles(cwd: string, files: readonly { path: string; status: string }[]): Promise<void> {
  const tracked = files.filter((f) => f.status !== '?').map((f) => f.path);
  const untracked = files.filter((f) => f.status === '?').map((f) => f.path);
  if (tracked.length) await run(cwd, ['checkout', '--', ...tracked], { env: W_ENV });
  if (untracked.length) await run(cwd, ['clean', '-f', '-q', '--', ...untracked], { env: W_ENV });
}

export async function discardLines(cwd: string, file: DiffTarget, selected: Iterable<string>): Promise<void> {
  const d = await workingDiff(cwd, file, { staged: false });
  const p = d && buildPartialPatch(d, selected, 'reverse');
  if (p) await applyPatch(cwd, p, { reverse: true });
}

export const resetHard = (cwd: string, sha?: string | null): Promise<string> => run(cwd, ['reset', '--hard', sha || 'HEAD'], { env: W_ENV });

// Index stages of one conflicted path: { 1: base oid, 2: ours oid, 3: theirs oid }, absent sides missing.
async function conflictStages(cwd: string, p: string): Promise<Record<string, string>> {
  const stages: Record<string, string> = {};
  for (const rec of (await run(cwd, ['ls-files', '-u', '-z', '--', p])).split('\0')) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t/.exec(rec);
    if (m) stages[m[2] ?? ''] = m[1] ?? '';
  }
  return stages;
}

// A side that deleted the file has no stage; choosing it removes the file.
export async function chooseSide(cwd: string, p: string, side: 'ours' | 'theirs'): Promise<void> {
  const stages = await conflictStages(cwd, p);
  if (!Object.keys(stages).length) throw new GitError(`${p} has no conflict to resolve.`);
  if (!stages[side === 'ours' ? 2 : 3]) {
    await run(cwd, ['rm', '-q', '-f', '--', p], { env: W_ENV });
    return;
  }
  await run(cwd, ['checkout', `--${side}`, '--', p], { env: W_ENV });
  await run(cwd, ['add', '--', p], { env: W_ENV });
}

// Built-in conflict editor. The editor works on the conflict markers in the working
// file, so every operation that leaves them (merge, rebase, cherry-pick, revert, stash
// apply) works the same. Binary, missing, very large or non-UTF-8 files can only take a whole side.
const CONFLICT_TEXT_MAX = 2 * 1024 * 1024;
export async function getConflict(cwd: string, p: string): Promise<ConflictFile> {
  const stages = await conflictStages(cwd, p);
  const sides = { base: !!stages[1], ours: !!stages[2], theirs: !!stages[3] };
  const st = await fs.promises.lstat(path.join(cwd, p)).catch(() => null);
  if (!st?.isFile()) return { path: p, ...sides, kind: st ? 'binary' : 'missing', text: null };
  const data = await fs.promises.readFile(path.join(cwd, p));
  if (data.subarray(0, 8000).includes(0)) return { path: p, ...sides, kind: 'binary', text: null };
  if (data.length > CONFLICT_TEXT_MAX) return { path: p, ...sides, kind: 'large', text: null };
  const text = data.toString('utf8');
  // Not UTF-8 (Latin-1, Shift-JIS…): editing would re-encode it, so it takes a whole side.
  if (!Buffer.from(text, 'utf8').equals(data)) return { path: p, ...sides, kind: 'encoding', text: null };
  return { path: p, ...sides, kind: 'text', text };
}

// Writes the edited result and stages it, which marks the path resolved.
export async function resolveConflict(cwd: string, p: string, content: string): Promise<void> {
  const st = await fs.promises.lstat(path.join(cwd, p)).catch(() => null);
  if (st && !st.isFile()) throw new GitError(`${p} is not a regular file. Pick a whole side instead.`);
  if (!Object.keys(await conflictStages(cwd, p)).length) throw new GitError(`${p} has no conflict to resolve.`);
  await fs.promises.writeFile(path.join(cwd, p), content);
  await run(cwd, ['add', '--', p], { env: W_ENV });
}

// Resolved files of a stopped merge, rebase, cherry-pick or revert (AK-584): staged, no longer
// unmerged and changed from HEAD; limited to the conflicts git listed in MERGE_MSG when it did.
// Listed conflicts resolved to HEAD's version only: { sha: null, paths: [], unchanged: n }.
// Saved as a stash-shaped commit (parents HEAD and an index commit, both with those files over
// HEAD) so it can be applied with `git stash apply <sha>` later. Returns { sha, paths } or null.
export async function saveResolved(cwd: string, gitDir: string): Promise<SavedResolved | null> {
  const head = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowCodes: [0, 1] })).trim();
  if (!head) return null;
  const z = (out: string) => out.split('\0').filter(Boolean);
  const unmerged = new Set(z(await run(cwd, ['ls-files', '-u', '-z'], { env: W_ENV })).map((r) => r.slice(r.indexOf('\t') + 1)));
  let paths = z(await run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD'], { env: W_ENV })).filter((p) => !unmerged.has(p));
  let msg = '';
  try { msg = fs.readFileSync(path.join(gitDir, 'MERGE_MSG'), 'utf8'); } catch {}
  const at = msg.split('\n').findIndex((l) => /^\S\s*Conflicts:\s*$/.test(l));
  const listed = new Set<string>();
  if (at !== -1) {
    for (const l of msg.split('\n').slice(at + 1)) { const m = /^\S\t(.+)$/.exec(l); if (!m) break; listed.add(m[1] ?? ''); }
    paths = paths.filter((p) => listed.has(p));
  }
  if (!paths.length) {
    // Resolved to what HEAD has (all ours): nothing to save, but say so ({ sha: null, unchanged }).
    const unchanged = [...listed].filter((p) => !unmerged.has(p)).length;
    return unchanged ? { sha: null, paths: [], unchanged } : null;
  }
  const staged = new Map<string, string>();
  for (const rec of z(await run(cwd, ['ls-files', '-s', '-z', '--', ...paths], { env: W_ENV }))) {
    const tab = rec.indexOf('\t');
    const [mode, oid] = rec.slice(0, tab).split(' ');
    staged.set(rec.slice(tab + 1), `${mode} ${oid}`);
  }
  const indexFile = path.join(gitDir, `since-resolved-${process.pid}.index`);
  const env = { ...W_ENV, GIT_INDEX_FILE: indexFile };
  try {
    await run(cwd, ['read-tree', head], { env });
    const info = paths.map((p) => `${staged.get(p) || `0 ${'0'.repeat(head.length)}`}\t${p}\0`).join('');
    await run(cwd, ['update-index', '-z', '--index-info'], { env, input: info });
    const tree = (await run(cwd, ['write-tree'], { env })).trim();
    const index = (await run(cwd, ['commit-tree', tree, '-p', head], { input: 'index of resolved files\n' })).trim();
    const sha = (await run(cwd, ['commit-tree', tree, '-p', head, '-p', index], { input: 'Resolved files\n' })).trim();
    return { sha, paths };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

// Put saved resolved files back (saveResolved's commit). With an operation stopped here again on
// those same files, write them and stage them (that resolves their conflicts); otherwise apply
// them to the work tree as a stash (by SHA).
export async function restoreResolved(cwd: string, gitDir: string, sha: string): Promise<string | undefined> {
  const paths = await resolvedPaths(cwd, sha);
  const unmerged = new Set((await run(cwd, ['ls-files', '-u', '-z'], { env: W_ENV })).split('\0').filter(Boolean).map((r) => r.slice(r.indexOf('\t') + 1)));
  const again = (await getOperationState(gitDir)) && paths.every((p) => unmerged.has(p));
  if (!again) return run(cwd, ['stash', 'apply', '--index', sha], { env: W_ENV });
  const present = new Set((await run(cwd, ['ls-tree', '-r', '-z', '--name-only', sha, '--', ...paths], { env: W_ENV })).split('\0').filter(Boolean));
  const gone = paths.filter((p) => !present.has(p));
  if (present.size) await run(cwd, ['checkout', sha, '--', ...present], { env: W_ENV });
  if (gone.length) await run(cwd, ['rm', '-q', '-f', '--ignore-unmatch', '--', ...gone], { env: W_ENV });
}

// The files saveResolved kept in `sha` (it must look like one: two parents with the same tree).
export async function resolvedPaths(cwd: string, sha: string): Promise<string[]> {
  const [tree, ...parents] = (await run(cwd, ['show', '-s', '--format=%T %P', sha])).trim().split(' ');
  const indexTree = parents.length === 2 && (await run(cwd, ['rev-parse', `${parents[1]}^{tree}`])).trim();
  if (indexTree !== tree) throw new GitError('Those saved files are not available.');
  return (await run(cwd, ['diff', '--name-only', '--no-renames', '-z', parents[0] ?? '', sha], { env: W_ENV })).split('\0').filter(Boolean);
}

