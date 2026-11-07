import fs from 'node:fs';
import path from 'node:path';
import { run, SEP, chunk, W_ENV, GitError, UNDO_REFS } from './run.ts';
import { getStatus } from './status.ts';

/** Every branch and tag tip, HEAD, and each branch's `[branch "x"]` config entries. */
export interface RefState { refs: Record<string, string>; head: string | null; headOid: string | null; config: Record<string, [string, string][]> }
/** An index entry of a snapshot path. */
export interface IndexEntry { mode: string; oid: string; stage: number }
/** A path's working-tree file: its mode and blob, or 'dir' (left alone) or 'keep' (index-only snapshot). */
export interface WorkTreeEntry { mode: string; oid?: string | null }
export interface SnapshotFile { path: string; index: IndexEntry[]; wt: WorkTreeEntry | null }
/** The exact index entries and working-tree bytes of a set of paths (see snapshotWork). */
export interface WorkSnapshot { files: SnapshotFile[]; indexOnly?: boolean }
/** Objects a journal step keeps from `git gc`: blobs (gathered in one tree) and commits or tags. */
export interface PinnedObjects { blobs?: readonly (string | null | undefined)[]; objects?: readonly (string | null | undefined)[] }
const present = (x: string | null | undefined): x is string => !!x;

// Snapshot of refs, used for unlimited undo/redo.

export async function captureRefState(cwd: string): Promise<RefState> {
  const out = await run(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags']);
  const refs: Record<string, string> = {};
  for (const l of out.split('\n')) { if (!l) continue; const [n = '', o = ''] = l.split(SEP); refs[n] = o; }
  const sym = (await run(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] })).trim();
  const oid = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim();
  // Each branch's `[branch "x"]` entries (upstream), so a redo that recreates the branch can put them back.
  const config: Record<string, [string, string][]> = {};
  const cfg = await run(cwd, ['config', '--local', '-z', '--get-regexp', '^branch\\.'], { allowCodes: [0, 1] }).catch(() => '');
  for (const e of cfg.split('\0')) {
    const i = e.indexOf('\n');
    const key = i === -1 ? e : e.slice(0, i);
    const n = `refs/heads/${key.slice(7, key.lastIndexOf('.'))}`;
    if (key && n in refs) (config[n] ||= []).push([key, i === -1 ? '' : e.slice(i + 1)]);
  }
  return { refs, head: sym || null, headOid: oid || null, config };
}

export async function restoreRefState(cwd: string, state: RefState, { soft = false, refsOnly = false }: { soft?: boolean; refsOnly?: boolean } = {}): Promise<void> {
  let current = await captureRefState(cwd);
  const env = { GIT_OPTIONAL_LOCKS: '1' };
  // Move the working copy first so a dirty tree blocks the restore before any ref changes.
  // `soft` keeps the undone commit's changes staged (undoing a commit). `refsOnly` leaves
  // the index and working tree alone; the caller restores them from a work snapshot.
  if (!refsOnly && state.headOid && state.headOid !== current.headOid) {
    await run(cwd, ['reset', soft ? '--soft' : '--keep', state.headOid], { env });
    // The reset moved the branch HEAD is on; when HEAD goes back to another branch, that one moves back below.
    current = await captureRefState(cwd);
  }
  const lines = [];
  for (const [n, o] of Object.entries(state.refs)) if (current.refs[n] !== o) lines.push(`update ${n} ${o}`);
  for (const n of Object.keys(current.refs)) if (!(n in state.refs)) lines.push(`delete ${n}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin', '-m', 'since: undo'], { input: lines.join('\n') + '\n', env });
  // A deleted branch takes its `[branch "x"]` config (upstream) with it, as `git branch -D` does.
  for (const n of Object.keys(current.refs)) {
    if (!(n in state.refs) && n.startsWith('refs/heads/')) await run(cwd, ['config', '--remove-section', `branch.${n.slice(11)}`], { env }).catch(() => {});
  }
  // A branch brought back (redo, timeline jump) gets the config it had when the state was taken.
  for (const [n, entries] of Object.entries(state.config || {})) {
    if (n in current.refs) continue;
    await run(cwd, ['config', '--remove-section', `branch.${n.slice(11)}`], { env }).catch(() => {});
    for (const [k, v] of entries) await run(cwd, ['config', '--add', k, v], { env });
  }
  if (state.head) await run(cwd, ['symbolic-ref', 'HEAD', state.head], { env });
  else if (state.headOid) await run(cwd, ['update-ref', '--no-deref', 'HEAD', state.headOid], { env });
}

// `write` stores the blobs; without it the snapshot is only used for comparison. `indexOnly`
// records just the index entries (staging steps), so later edits to the files don't block undo.
export async function snapshotWork(cwd: string, paths: Iterable<string>, { write = true, indexOnly = false }: { write?: boolean; indexOnly?: boolean } = {}): Promise<WorkSnapshot> {
  const files = [...new Set(paths)].sort().map((p): SnapshotFile => ({ path: p, index: [], wt: indexOnly ? { mode: 'keep' } : null }));
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const part of chunk(files.map((f) => f.path))) {
    const out = await run(cwd, ['ls-files', '-s', '-z', '--', ...part], { env: W_ENV });
    for (const rec of out.split('\0')) {
      const tab = rec.indexOf('\t');
      const f = tab === -1 ? null : byPath.get(rec.slice(tab + 1));
      if (!f) continue;
      const [mode = '', oid = '', stage] = rec.slice(0, tab).split(' ');
      f.index.push({ mode, oid, stage: Number(stage) });
    }
  }
  if (indexOnly) return { files, indexOnly };
  const w = write ? ['-w'] : [];
  const regular: SnapshotFile[] = [];
  for (const f of files) {
    const abs = path.join(cwd, f.path);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code === 'ENOENT' || code === 'ENOTDIR') continue; throw e; }
    if (st.isSymbolicLink()) {
      f.wt = { mode: '120000', oid: (await run(cwd, ['hash-object', ...w, '--stdin'], { input: fs.readlinkSync(abs) })).trim() };
    } else if (st.isFile()) {
      f.wt = { mode: st.mode & 0o100 ? '100755' : '100644', oid: null };
      regular.push(f);
    } else {
      f.wt = { mode: 'dir' }; // a folder or submodule; restore leaves it alone
    }
  }
  // --no-filters keeps the raw bytes (no CRLF or LFS conversion), which is what we write back.
  for (const part of chunk(regular)) {
    const out = await run(cwd, ['hash-object', ...w, '--no-filters', '--stdin-paths'], { input: part.map((f) => f.path).join('\n') + '\n' });
    out.trim().split('\n').forEach((oid, i) => { const wt = part[i]?.wt; if (wt) wt.oid = oid; });
  }
  return { files };
}

// Paths whose index entries or working-tree content differ between two snapshots.
export function workChanges(a: WorkSnapshot, b: WorkSnapshot): string[] {
  const key = (f: SnapshotFile) => JSON.stringify([f.index, f.wt]);
  const other = new Map(b.files.map((f) => [f.path, key(f)]));
  return a.files.filter((f) => other.get(f.path) !== key(f)).map((f) => f.path);
}

export function snapshotBlobs(snap: WorkSnapshot | null | undefined): string[] {
  const out: string[] = [];
  for (const f of snap?.files || []) {
    for (const e of f.index) if (e.mode !== '160000') out.push(e.oid);
    if (f.wt?.oid) out.push(f.wt.oid);
  }
  return out;
}

export async function restoreWork(cwd: string, snap: WorkSnapshot): Promise<void> {
  for (const f of snap.files) {
    if (f.wt?.mode === 'dir' || f.wt?.mode === 'keep') continue;
    const abs = path.join(cwd, f.path);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* absent */ }
    if (st?.isDirectory()) throw new GitError(`Cannot restore ${f.path}: a folder is in the way.`);
    if (!f.wt) { if (st) fs.unlinkSync(abs); continue; }
    const data = await run(cwd, ['cat-file', 'blob', f.wt.oid ?? ''], { encoding: 'buffer' });
    if (st) fs.unlinkSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (f.wt.mode === '120000') fs.symlinkSync(data.toString(), abs);
    else fs.writeFileSync(abs, data, { mode: f.wt.mode === '100755' ? 0o777 : 0o666 });
  }
  // Replace every index entry of each path, conflict stages included.
  const format = (await run(cwd, ['rev-parse', '--show-object-format']).catch(() => '')).trim();
  const zero = '0'.repeat(format === 'sha256' ? 64 : 40);
  const recs: string[] = [];
  for (const f of snap.files) {
    recs.push(`0 ${zero}\t${f.path}`);
    for (const e of f.index) recs.push(`${e.mode} ${e.oid} ${e.stage}\t${f.path}`);
  }
  if (recs.length) await run(cwd, ['update-index', '-z', '--index-info'], { input: recs.join('\0') + '\0', env: W_ENV });
  await run(cwd, ['update-index', '-q', '--refresh'], { env: W_ENV, allowCodes: [0, 1] });
}

export async function dirtyPaths(cwd: string): Promise<string[]> {
  const { staged, unstaged, conflicts } = await getStatus(cwd);
  return [...staged.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])), ...unstaged.map((f) => f.path), ...conflicts.map((f) => f.path)];
}

const treeNames = async (cwd: string, a: string, b: string): Promise<string[]> => (await run(cwd, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', a, b])).split('\0').filter(Boolean);

// Paths `git reset --hard <target>` can change: everything dirty, plus what differs between HEAD and target.
export async function resetHardPaths(cwd: string, target?: string | null): Promise<string[]> {
  const paths = await dirtyPaths(cwd);
  const head = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim();
  if (head && target) paths.push(...(await treeNames(cwd, head, target)));
  return paths;
}

// Paths applying a stash can change: everything dirty, plus every path the stash records.
export async function stashPaths(cwd: string, ref: string): Promise<string[]> {
  const paths = await dirtyPaths(cwd);
  paths.push(...(await treeNames(cwd, `${ref}^1`, ref)), ...(await treeNames(cwd, `${ref}^1`, `${ref}^2`)));
  const untracked = (await run(cwd, ['rev-parse', '-q', '--verify', `${ref}^3`], { allowCodes: [0, 1] })).trim();
  if (untracked) paths.push(...(await run(cwd, ['ls-tree', '-r', '-z', '--name-only', untracked])).split('\0').filter(Boolean));
  return paths;
}

// Paths a stash push can change: the files it's limited to, or everything dirty.
// Takes the stash step's arguments (message, untracked, { paths }).
export const stashPushPaths = async (cwd: string, _message?: string | null, _untracked?: boolean, { paths }: { paths?: readonly string[] } = {}): Promise<readonly string[]> => (paths?.length ? paths : dirtyPaths(cwd));

// Pins: refs under refs/since/ that keep the undo journal's objects
// reachable, so `git gc` never collects them. Blobs are gathered in one tree
// (a tree ref stays out of `git log --all`); commits and tags get a ref each.

const listRefs = async (cwd: string, prefix: string): Promise<string[]> => (await run(cwd, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(Boolean);

export async function pinObjects(cwd: string, base: string, { blobs = [], objects = [] }: PinnedObjects = {}): Promise<void> {
  const want = new Map<string, string>();
  const uniq = [...new Set(blobs.filter(present))];
  if (uniq.length) {
    const input = uniq.map((oid, i) => `100644 blob ${oid}\t${i}`).join('\0') + '\0';
    want.set(`${base}/blobs`, (await run(cwd, ['mktree', '-z'], { input })).trim());
  }
  [...new Set(objects.filter(present))].forEach((oid, i) => want.set(`${base}/${i}`, oid));
  const lines = [...want].map(([ref, oid]) => `update ${ref} ${oid}`);
  for (const ref of await listRefs(cwd, base)) if (!want.has(ref)) lines.push(`delete ${ref}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', env: W_ENV });
}

export const pinUndo = (cwd: string, id: string | number, objs?: PinnedObjects): Promise<void> => pinObjects(cwd, `${UNDO_REFS}/${id}`, objs);

// Remove the pins under `ns` (one worktree's journal) whose keys it no longer
// keeps. Other worktrees' pins are left alone.
export async function pruneUndoPins(cwd: string, ns: string, keepKeys: readonly (string | number)[]): Promise<void> {
  const base = `${UNDO_REFS}/${ns}`;
  const keep = new Set(keepKeys.map(String));
  const lines = (await listRefs(cwd, base))
    .filter((ref) => !keep.has(ref.slice(base.length + 1).split('/')[0] ?? ''))
    .map((ref) => `delete ${ref}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', env: W_ENV });
}

// Move the pins of `keys` from the shared top level (the format before pins
// were namespaced per worktree) into `ns`, in one transaction.
export async function moveUndoPins(cwd: string, ns: string, keys: readonly (string | number)[]): Promise<void> {
  if (!keys.length) return;
  const out = await run(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', ...keys.map((k) => `${UNDO_REFS}/${k}`)]);
  const lines: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [oid = '', ref = ''] = line.split(' ');
    lines.push(`update ${UNDO_REFS}/${ns}/${ref.slice(UNDO_REFS.length + 1)} ${oid}`, `delete ${ref} ${oid}`);
  }
  if (lines.length) await run(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', env: W_ENV });
}

// Pins from before the rename to Since lived under refs/gitlanes/: move them all (every worktree's
// journal) under refs/since/, in one transaction.
export async function moveOldPins(cwd: string): Promise<void> {
  const out = await run(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/gitlanes/']);
  const lines: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [oid = '', ref = ''] = line.split(' ');
    lines.push(`update refs/since/${ref.slice('refs/gitlanes/'.length)} ${oid}`, `delete ${ref} ${oid}`);
  }
  if (lines.length) await run(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', env: W_ENV });
}

