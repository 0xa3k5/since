// Argument checks for every IPC call from the renderer. The renderer is sandboxed and only
// loads our own files, but if it were ever compromised (a malicious repository's commit
// message reaching innerHTML, say), these checks keep it from turning a git call into
// something else: an option smuggled in as a ref name (`--upload-pack=…`), a path outside the
// repository, or a URL handed to the OS. Anything that doesn't match the expected shape is
// rejected before it reaches git, the shell or the file system.
//
// Every check takes the untrusted value as `unknown` and returns it typed once it passes.

import fs from 'node:fs';
import path from 'node:path';

export class IpcArgError extends Error {}

/** A check for one argument: returns the value when it has the expected shape, else throws IpcArgError. */
export type Check<T = unknown> = ((v: unknown, what: string) => T) & {
  /** The argument may be left out (or null). */
  optional?: boolean;
  /** Another worktree's folder, which main.js resolves against `git worktree list`. */
  worktree?: boolean;
};
/** A checked plain object (obj): its fields are only known to have passed their checks. */
export type Checked = Record<string, unknown>;

const MAX_STR = 64 * 1024;
const MAX_TEXT = 1024 * 1024; // commit messages, config values
const MAX_LIST = 100_000;

function fail(what: string, why: string): never { throw new IpcArgError(`Invalid ${what}: ${why}`); }

// ---------------------------------------------------------------------------
// Primitive checks. Each returns the value or throws.

export function str(v: unknown, what: string, { max = MAX_STR, empty = false }: { max?: number; empty?: boolean } = {}): string {
  if (typeof v !== 'string') fail(what, 'expected a string');
  if (!empty && !v.length) fail(what, 'empty');
  if (v.length > max) fail(what, 'too long');
  if (v.includes('\0')) fail(what, 'contains a NUL byte');
  return v;
}

const text = (v: unknown, what: string): string => str(v, what, { max: MAX_TEXT, empty: true });
export const bool = (v: unknown, what: string): boolean => { if (typeof v !== 'boolean') fail(what, 'expected a boolean'); return v; };
// A PR media item's id from the evidence call (pr-media.ts): 32 hex characters.
export const mediaId = (v: unknown, what = 'media id'): string => { if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) fail(what, 'expected a media id'); return v; };
export const prNumber = (v: unknown, what = 'pull request number'): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) fail(what, 'expected a positive integer'); return v; };
// A remote name the renderer sends must be one of this repository's remotes (git.getRemotes).
export function knownRemote<R extends { name: string }>(remotes: readonly R[] | null | undefined, name: unknown, what = 'remote'): R {
  const n = str(name, what, { max: 256 });
  const r = (remotes || []).find((x) => x.name === n);
  if (!r) fail(what, 'not a remote of this repository');
  return r;
}
export const int = (v: unknown, what: string): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(what, 'expected a non-negative integer'); return v; };

function list(v: unknown, what: string, each: (x: unknown, what: string) => unknown): unknown[] {
  if (!Array.isArray(v)) fail(what, 'expected a list');
  if (v.length > MAX_LIST) fail(what, 'too many items');
  v.forEach((x: unknown, i) => each(x, `${what}[${i}]`));
  return v;
}

export function obj(v: unknown, what: string, keys: Record<string, (x: unknown, what: string) => unknown>): Checked {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(what, 'expected an object');
  const o = v as Checked;
  for (const k of Object.keys(o)) {
    const check = keys[k];
    if (!check) fail(what, `unexpected field "${k}"`);
    if (o[k] !== undefined) check(o[k], `${what}.${k}`);
  }
  return o;
}

const optional = <T>(check: (v: unknown, what: string) => T): Check<T | null | undefined> =>
  Object.assign((v: unknown, what: string) => (v == null ? v : check(v, what)), { optional: true });
export const oneOf = <const V extends readonly string[]>(...values: V) => (v: unknown, what: string): V[number] => {
  if (!(values as readonly unknown[]).includes(v)) fail(what, `expected one of ${values.join(', ')}`);
  return v as V[number];
};
// A revision or ref name as git sees it on the command line: a sha, a branch, `HEAD`,
// `abc123^1`, `stash@{2}`, `origin/main`. It may never start with "-", which git would read as an
// option, and never contains whitespace or control characters (git refuses those in ref names).
export function rev(v: unknown, what = 'revision'): string {
  const s = str(v, what, { max: 1024 });
  if (s.startsWith('-')) fail(what, 'must not start with "-"');
  if (/[\s\x00-\x1f\x7f]/.test(s)) fail(what, 'contains whitespace or control characters');
  return s;
}
// A full or abbreviated object id.
export function oid(v: unknown, what = 'commit id'): string {
  const s = str(v, what, { max: 64 });
  if (!/^[0-9a-f]{4,64}$/i.test(s)) fail(what, 'expected a hex object id');
  return s;
}
// A path relative to the repository root, as git prints it. Always passed to git after "--",
// but also used for diffs of untracked files and for opening files, so it must stay inside the
// repository: no absolute paths, no ".." segments.
export function repoPath(v: unknown, what = 'path'): string {
  const s = str(v, what, { max: 4096 });
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) fail(what, 'must be relative to the repository');
  if (s.split(/[\\/]/).includes('..')) fail(what, 'must not contain ".."');
  return s;
}
// A config key such as "user.email" or "remote.origin.url" (section.[subsection.]name).
function configKey(v: unknown, what = 'config key'): string {
  const s = str(v, what, { max: 1024 });
  if (!/^[a-zA-Z][a-zA-Z0-9-]*(\.[^\n\0]+)?\.[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) fail(what, 'expected section.name');
  return s;
}
// Config keys whose value git runs as a command, loads code or config from, or that open new
// transports. Setting one from the renderer would turn a config edit into code execution on the
// next git call, so the config editor refuses them; change them in a terminal instead.
const COMMAND_KEYS = [
  /^core\.(fsmonitor|sshcommand|hookspath|editor|pager|askpass|gitproxy|alternaterefscommand|worktree)$/,
  /^(sequence\.editor|diff\.external|web\.browser|uploadpack\.packobjectshook)$/,
  /^(alias|filter|protocol|url|pager|include|includeif)\./,
  /^credential\.(.+\.)?helper$/, /^gpg\.(.+\.)?program$/,
  /^diff\..+\.(textconv|command)$/, /^merge\..+\.driver$/,
  /^(difftool|mergetool|man)\..+\.(cmd|path)$/, /^remote\..+\.(uploadpack|receivepack|vcs)$/,
];
function safeConfigKey(v: unknown, what: string): string {
  const s = configKey(v, what);
  if (COMMAND_KEYS.some((re) => re.test(s.toLowerCase()))) fail(what || 'config key', `${s} runs commands; set it in a terminal`);
  return s;
}
// Files that macOS would run rather than show when opened (apps, scripts, installers, and any
// file with an execute bit). *Open file* reveals these in Finder instead.
const RUNNABLE_EXT = /\.(app|command|tool|sh|bash|zsh|csh|ksh|terminal|workflow|action|scpt|scptd|applescript|jar|pkg|mpkg|prefpane|webloc|inetloc|fileloc|url)$/i;
export function runnable(abs: string, fsMod: Pick<typeof fs, 'statSync'> = fs): boolean {
  if (RUNNABLE_EXT.test(abs.replace(/[\\/]+$/, ''))) return true;
  try { const st = fsMod.statSync(abs); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; }
}
// The status entries the renderer hands back for working-tree operations.
const fileEntry = (v: unknown, what: string) => obj(v, what, { path: repoPath, oldPath: optional(repoPath), status: optional((s, w) => str(s, w, { max: 8 })), xy: optional((s, w) => str(s, w, { max: 8 })) });
const lineKeys = (v: unknown, what: string) => list(v, what, (k, w) => { if (typeof k !== 'string' || !/^\d+:\d+$/.test(k)) fail(w, 'expected "hunk:line"'); });
const repoPaths = (v: unknown, what: string) => list(v, what, repoPath);
// Unified changes: 'all', or "hunk:line" / "hunk:*" keys of a combined diff.
const changeSelection = (v: unknown, what: string) => (v === 'all' ? v : list(v, what, (k, w) => { if (typeof k !== 'string' || !/^\d+:(\d+|\*)$/.test(k)) fail(w, 'expected "hunk:line" or "hunk:*"'); }));
const logOptions = (v: unknown, what: string) => obj(v, what, { remotes: bool, tags: bool, limit: int, kind: oneOf('topo', 'details', 'full'), preview: bool });
// The split dialog's choice: per path, 'all' or the "hunk:line" keys that go into the first commit.
const rewriteExtra = (v: unknown, what: string) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(what, 'expected an object');
  const files = (v as Checked).files ?? {};
  if (files === null || typeof files !== 'object' || Array.isArray(files)) fail(`${what}.files`, 'expected an object');
  for (const [p, sel] of Object.entries(files)) {
    repoPath(p, `${what}.files path`);
    if (sel !== 'all') lineKeys(sel, `${what}.files[${p}]`);
  }
  return obj(v, what, { files: () => {}, messages: (m, w) => list(m, w, text), message: text });
};
const label = (v: Checked) => ({ __label: str(v.__label, 'label', { max: 1024 }) });
// Another worktree's folder (as `git worktree list` prints it). The schema only checks the shape;
// main.js then requires it to be one of the open repository's worktrees (see knownWorktree), so a
// renderer can't point lock/remove/terminal/reveal/open-window at an arbitrary folder.
const worktreeDir: Check<string> = Object.assign((v: unknown, what: string) => absDir(v, what), { worktree: true });
const worktreeSpec = (v: unknown, what: string) => obj(v, what, { dir: optional((d, w) => str(d, w, { max: 4096 })), branch: optional(rev), base: optional(rev) });
// One lane to clean up: its branch (with the tip the user saw) and/or its worktree folder.
const cleanupItem = (v: unknown, what: string) => {
  const o = obj(v, what, { branch: optional(rev), head: optional(oid), worktree: optional(absDir), force: optional(bool), stash: optional(bool), abort: optional(bool) });
  if (!o.branch && !o.worktree) fail(what, 'expected a branch or a worktree');
  return o;
};
// A name for `git remote add`/`rename`: one path component git accepts in refs/remotes/<name>/.
export const remoteName = (v: unknown, w = 'remote name'): string => {
  const s = str(v, w, { max: 256 });
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s) || s.includes('..') || s.endsWith('.lock') || s.endsWith('.')) fail(w, 'letters, digits, ".", "_" and "-" only');
  return s;
};
const remoteBranch = (v: unknown, w: string): string => { const s = rev(v, w); if (!/^[^/]+\/.+/.test(s)) fail(w, 'expected remote/branch'); if (/\/-/.test(s)) fail(w, 'must not start with -'); return s; };
// The worktree in `worktrees` (from git.getWorktrees) at `dir`, or throws. `same` compares paths
// (git.samePath, which follows symlinks such as /tmp -> /private/tmp).
export function knownWorktree(worktrees: readonly { path: string }[], dir: unknown, same: (a: string, b: string) => boolean = (a, b) => a === b, what = 'worktree'): string {
  const d = absDir(dir, what);
  const wt = worktrees.find((w) => same(w.path, d));
  if (!wt) fail(what, 'not a worktree of this repository');
  return wt.path;
}

// ---------------------------------------------------------------------------
// Schemas: one checker per argument, in order. Trailing arguments may be omitted.

// Methods stashAnd may run again after stashing (refMutations in main.js).
const STASH_AND = ['merge', 'pull', 'pullAndPush', 'cherryPick', 'revert', 'setBranchTip'] as const;
// Methods abortAnd may run after aborting a stopped rebase, merge, cherry-pick or revert.
const ABORT_AND = ['merge', 'pull', 'pullAndPush', 'cherryPick', 'revert', 'rebaseOnto', 'rebaseBranch'] as const;
// How pull settles a branch that diverged from its upstream.
const pullMode = oneOf('rebase', 'merge');
// `{ abort }`: abort an operation stopped in the way first (git.mergeLane).
const abortOpt = (v: unknown, w: string) => obj(v, w, { abort: optional(bool) });
const laneOpt = (v: unknown, w: string) => obj(v, w, { close: optional(bool), abort: optional(bool) });
const stashOpt = (v: unknown, w: string) => obj(v, w, { message: text, untracked: optional(bool) });
const historyOpt = (v: unknown, w: string) => obj(v, w, { stash: optional(bool), force: optional(bool), skip: optional(bool), discard: optional(bool) });
const anArray = (v: unknown, w: string): unknown[] => { if (!Array.isArray(v)) fail(w, 'expected an array'); return v; };
const REWRITE_OPS = ['drop', 'reword', 'squash', 'fixup', 'swapParent', 'split'] as const;

export const gitSchemas = {
  // reads
  refs: [],
  log: [optional(logOptions)],
  logOpen: [optional(logOptions)],
  logRead: [int],
  logClose: [int],
  logDetails: [(v, w) => list(v, w, oid)],
  commit: [rev],
  commitFileDiff: [rev, fileEntry, optional(rev)],
  commitDiffs: [rev],
  checkSplit: [rev, optional(rev)],
  commitBranches: [oid],
  compare: [rev, rev],
  branchReview: [rev, optional(rev)],
  changeFacts: [rev, rev],
  mergeConflicts: [rev, rev],
  mergeLanePlan: [rev, optional(rev), optional(abortOpt)],
  status: [],
  opInfo: [],
  divergence: [optional(bool)],
  lfs: [],
  submodules: [],
  submoduleChanges: [repoPath],
  difftool: [fileEntry, optional(bool), optional(rev), optional(rev)],
  workingDiff: [fileEntry, optional(bool)],
  combinedDiff: [fileEntry, optional((v, what) => list(v, what, int))],
  stashes: [],
  reflog: [],
  config: [],
  remotes: [],
  identity: [],
  history: [optional(int)],
  previewRestore: [int],
  worktrees: [],
  worktreeChanges: [worktreeDir],
  worktreeHold: [worktreeDir],
  removalFacts: [worktreeDir],
  worktreeOpInfo: [worktreeDir],
  baseTouches: [rev, rev, repoPaths],
  conflict: [repoPath],
  fileHistory: [repoPath, optional((v, w) => obj(v, w, { from: rev, skip: int, limit: int, path: repoPath }))],
  blame: [repoPath, optional(rev)],
  trackedFiles: [],
  // ref mutations
  checkout: [rev],
  checkoutTracking: [rev],
  autostashCheckout: [rev, text, optional(bool)],
  freeCheckout: [rev, worktreeDir],
  moveCheckout: [rev, worktreeDir, optional(stashOpt)],
  switchDelete: [rev, optional(stashOpt)],
  switchMerge: [rev, rev, rev, text, optional(stashOpt)],
  createBranch: [rev, rev, optional(bool)],
  deleteBranch: [rev],
  renameBranch: [rev, rev],
  setBranchTip: [rev, rev],
  createTag: [rev, rev, optional(text)],
  deleteTag: [rev],
  cherryPick: [rev, optional(bool)],
  revert: [rev],
  merge: [rev, optional(bool)],
  rebaseOnto: [rev],
  rebaseBranch: [rev, rev],
  rewrite: [oneOf(...REWRITE_OPS), oid, optional(rewriteExtra)],
  // Switch to a branch containing the commit (stashing first), then rewrite it there: one undo step.
  switchRewrite: [rev, oneOf(...REWRITE_OPS), oid, optional(rewriteExtra), optional(stashOpt)],
  createCommit: [text, optional(bool)],
  pull: [optional(pullMode)],
  pullAndPush: [optional(pullMode)],
  continueOp: [],
  abortOp: [],
  // index, config and remote mutations
  stageFiles: [repoPaths],
  unstageFiles: [repoPaths],
  stageLines: [fileEntry, lineKeys],
  stageChanges: [fileEntry, changeSelection],
  unstageChanges: [fileEntry, changeSelection],
  unstageLines: [fileEntry, lineKeys],
  stashSave: [optional(text), optional(bool), optional((v, w) => obj(v, w, { staged: optional(bool), paths: optional(repoPaths) }))],
  stashLines: [fileEntry, lineKeys, optional(text)],
  fetch: [],
  push: [optional((v, w) => obj(v, w, { force: optional(bool), all: optional(bool) }))],
  pushTags: [],
  deleteRemoteBranch: [remoteBranch],
  deleteRemoteBranches: [(v, w) => list(v, w, remoteBranch)],
  setConfig: [safeConfigKey, text],
  // undoable remote changes (journal.runRemote)
  addRemote: [remoteName, cloneUrl],
  setRemoteUrl: [remoteName, cloneUrl],
  renameRemote: [remoteName, remoteName],
  removeRemote: [remoteName],
  mergetool: [optional(repoPaths)],
  unsetConfig: [configKey],
  markResolved: [repoPath],
  lockWorktree: [worktreeDir, optional((v, w) => str(v, w, { max: 4096, empty: true }))],
  unlockWorktree: [worktreeDir],
  pruneWorktrees: [],
  // undoable worktree operations (journal.worktreeOps)
  addWorktree: [worktreeSpec],
  // `close`: close the window showing it first; `stash` its changes; `abort` a stopped operation there.
  removeWorktree: [worktreeDir, optional((v, w) => obj(v, w, { close: optional(bool), stash: optional(bool), abort: optional(bool) }))],
  // bulk cleanup from Lanes (journal.runCleanup); worktree paths are resolved in main.js
  cleanupLanes: [(v, w) => list(v, w, cleanupItem)],
  // undoable working-tree operations (journal.workOps)
  discardFiles: [(v, w) => list(v, w, fileEntry)],
  discardLines: [fileEntry, lineKeys],
  resetHard: [optional(rev)],
  chooseSide: [repoPath, oneOf('ours', 'theirs')],
  resolveConflict: [repoPath, (v, w) => str(v, w, { max: 4 * MAX_TEXT, empty: true })],
  stashApply: [rev, optional(bool)],
  stashDrop: [rev],
  // undoable merge and tidy of a lane (journal.runLane): branch, base, commit message; branch
  // `close`: close the window showing the lane's worktree first (a merge handed over from it).
  // `abort`: abort an operation stopped in the lane's worktree first.
  mergeLane: [rev, rev, text, optional(laneOpt)],
  tidyLane: [rev, optional(laneOpt)],
  // undoable submodule init/update (journal.runSubmodules); no paths = all submodules
  updateSubmodules: [optional(repoPaths), optional((v, w) => obj(v, w, { stash: optional(bool) }))],
  // undoable stash or discard of the changes inside one submodule (journal.runSubmoduleWork)
  submoduleWork: [repoPath, oneOf('stash', 'discard')],
  // history
  undo: [optional(historyOpt)],
  redo: [optional(historyOpt)],
  // A ref mutation git refused over uncommitted changes, run again after stashing them (journal.stashAnd).
  stashAnd: [oneOf(...STASH_AND), anArray],
  restoreHistory: [int],
  // A ref mutation git refused mid-operation, run again after aborting it (journal.abortAnd).
  abortAnd: [oneOf(...ABORT_AND), anArray],
  // Put back the files abortAnd saved before aborting (journal.restoreResolved): the saved commit.
  restoreResolved: [oid],
} satisfies Record<string, readonly Check[]>;
export type GitSchemaMethod = keyof typeof gitSchemas;

/** A checked `git` IPC call: its arguments (label split off) and which of them are worktree folders. */
export interface CheckedGitCall { args: unknown[]; label: string | null; worktreeArgs: number[] }

// Validate a `git` IPC call. Returns { args, label } with the optional trailing
// `{ __label }` split off, or throws IpcArgError.
export function checkGit(method: unknown, args: readonly unknown[]): CheckedGitCall {
  if (typeof method !== 'string' || !Object.hasOwn(gitSchemas, method)) throw new IpcArgError(`Unknown method ${String(method).slice(0, 64)}`);
  let lbl: string | null = null;
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !Array.isArray(last) && Object.hasOwn(last, '__label')) {
    lbl = label(last as Checked).__label;
    args = args.slice(0, -1);
  }
  const schema: readonly Check[] = gitSchemas[method as GitSchemaMethod];
  if (args.length > schema.length) throw new IpcArgError(`Too many arguments for ${method}`);
  schema.forEach((check, i) => {
    // Absent trailing arguments are only fine for optional checks; required ones throw on undefined.
    if (i < args.length || !check.optional) check(args[i], `${method} argument ${i + 1}`);
  });
  // stashAnd carries another method's arguments (checked to be an array above): check them with that method's schema.
  if (method === 'stashAnd' || method === 'abortAnd') return { args: [args[0], checkGit(args[0], args[1] as unknown[]).args], label: lbl, worktreeArgs: [] };
  // Arguments main.js must still resolve against the repository's worktree list.
  const worktreeArgs = schema.flatMap((check, i) => (check.worktree && i < args.length ? [i] : []));
  return { args: [...args], label: lbl, worktreeArgs };
}

// ---------------------------------------------------------------------------
// Values for `app:*` channels.

// Only plain web links go to the OS. file:, javascript:, custom app schemes and anything with
// credentials embedded are refused.
export function webUrl(v: unknown, what = 'URL'): string {
  const s = str(v, what, { max: 8192 });
  let u: URL;
  try { u = new URL(s); } catch { fail(what, 'not a URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(what, 'only http(s) links can be opened');
  if (u.username || u.password) fail(what, 'must not contain credentials');
  return u.href;
}
// A repository URL for `git clone`. Allows https, ssh, git and scp-style "user@host:path",
// plus local paths and file: URLs. Refuses anything git would read as an option and git's
// transport helpers ("ext::", "fd::"), which can run commands.
export function cloneUrl(v: unknown, what = 'repository URL'): string {
  const s = str(v, what, { max: 4096 }).trim();
  if (s.startsWith('-')) fail(what, 'must not start with "-"');
  if (/[\x00-\x1f\x7f]/.test(s)) fail(what, 'contains control characters');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*::/.test(s)) fail(what, 'transport helpers are not allowed');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s)?.[1];
  if (scheme && !['https', 'http', 'ssh', 'git', 'file'].includes(scheme.toLowerCase())) fail(what, `unsupported scheme ${scheme}`);
  return s;
}
// An absolute directory chosen by the user (from argv, a recent list or the open dialog).
export function absDir(v: unknown, what = 'directory'): string {
  const s = str(v, what, { max: 4096 });
  if (!path.isAbsolute(s)) fail(what, 'must be an absolute path');
  return s;
}
// The network requests a session may make: its own files and inline data, plus exactly the
// https origins in `allow` (the update feed, for the updater's private session).
// since-media: is served by the main process (pr-media.ts), not the network.
const LOCAL_SCHEMES = new Set(['file:', 'data:', 'devtools:', 'chrome-extension:', 'since-media:']);
export function requestAllowed(url: string, allow: readonly string[] = []): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (LOCAL_SCHEMES.has(u.protocol)) return true;
  return allow.includes(u.origin) && (u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
}
// Resolve a repository-relative path, refusing anything that ends up outside the root.
export function insideRepo(root: string, rel: unknown): string {
  const abs = path.resolve(root, repoPath(rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) fail('path', 'outside the repository');
  return abs;
}
/** A step handed to another window of this repository: remove a worktree, or merge and tidy or rebase a branch there. */
export interface Handoff { kind: 'removeWorktree' | 'mergeLane' | 'rebaseLane'; dir: string; path?: string; branch?: string; base?: string }
// A step handed to another window of this repository (AK-581): remove a worktree, or merge and tidy
// or rebase (AK-601) a branch there.
export const handoff = (v: unknown): Handoff => {
  const h = obj(v, 'handoff', { kind: oneOf('removeWorktree', 'mergeLane', 'rebaseLane'), dir: absDir, path: absDir, branch: rev, base: rev });
  const need = h.kind === 'removeWorktree' ? ['path'] : ['branch', 'base'];
  for (const k of ['kind', 'dir', ...need]) if (h[k] == null) fail(`handoff.${k}`, 'is required');
  return h as unknown as Handoff; // every field passed its check above
};
export const tabAction = oneOf('new', 'close', 'select', 'next', 'prev', 'reopen');
export interface ConfirmOptions { message: string; detail?: string | null; ok?: string | null; destructive?: boolean | null }
export const confirmOptions = (v: unknown): ConfirmOptions =>
  obj(v, 'dialog', { message: (s, w) => str(s, w, { max: 4096 }), detail: optional(text), ok: optional((s, w) => str(s, w, { max: 128 })), destructive: optional(bool) }) as unknown as ConfirmOptions; // fields checked by obj
