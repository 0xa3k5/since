'use strict';
// Argument checks for every IPC call from the renderer. The renderer is sandboxed and only
// loads our own files, but if it were ever compromised (a malicious repository's commit
// message reaching innerHTML, say), these checks keep it from turning a git call into
// something else: an option smuggled in as a ref name (`--upload-pack=…`), a path outside the
// repository, or a URL handed to the OS. Anything that doesn't match the expected shape is
// rejected before it reaches git, the shell or the file system.

const path = require('node:path');

class IpcArgError extends Error {}

const MAX_STR = 64 * 1024;
const MAX_TEXT = 1024 * 1024; // commit messages, config values
const MAX_LIST = 100_000;

function fail(what, why) { throw new IpcArgError(`Invalid ${what}: ${why}`); }

// ---------------------------------------------------------------------------
// Primitive checks. Each returns the value or throws.

function str(v, what, { max = MAX_STR, empty = false } = {}) {
  if (typeof v !== 'string') fail(what, 'expected a string');
  if (!empty && !v.length) fail(what, 'empty');
  if (v.length > max) fail(what, 'too long');
  if (v.includes('\0')) fail(what, 'contains a NUL byte');
  return v;
}

const text = (v, what) => str(v, what, { max: MAX_TEXT, empty: true });
const bool = (v, what) => { if (typeof v !== 'boolean') fail(what, 'expected a boolean'); return v; };
// A PR media item's id from the evidence call (pr-media.js): 32 hex characters.
const mediaId = (v, what = 'media id') => { if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) fail(what, 'expected a media id'); return v; };
const prNumber = (v, what = 'pull request number') => { if (!Number.isSafeInteger(v) || v <= 0) fail(what, 'expected a positive integer'); return v; };
// A remote name the renderer sends must be one of this repository's remotes (git.getRemotes).
function knownRemote(remotes, name, what = 'remote') {
  str(name, what, { max: 256 });
  const r = (remotes || []).find((x) => x.name === name);
  if (!r) fail(what, 'not a remote of this repository');
  return r;
}
const int = (v, what) => { if (!Number.isSafeInteger(v) || v < 0) fail(what, 'expected a non-negative integer'); return v; };

function list(v, what, each) {
  if (!Array.isArray(v)) fail(what, 'expected a list');
  if (v.length > MAX_LIST) fail(what, 'too many items');
  v.forEach((x, i) => each(x, `${what}[${i}]`));
  return v;
}

function obj(v, what, keys) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(what, 'expected an object');
  for (const k of Object.keys(v)) {
    if (!(k in keys)) fail(what, `unexpected field "${k}"`);
    if (v[k] !== undefined) keys[k](v[k], `${what}.${k}`);
  }
  return v;
}

const optional = (check) => Object.assign((v, what) => (v == null ? v : check(v, what)), { optional: true });
const oneOf = (...values) => (v, what) => { if (!values.includes(v)) fail(what, `expected one of ${values.join(', ')}`); return v; };

// A revision or ref name as git sees it on the command line: a sha, a branch, `HEAD`,
// `abc123^1`, `stash@{2}`, `origin/main`. It may never start with "-", which git would read as an
// option, and never contains whitespace or control characters (git refuses those in ref names).
function rev(v, what = 'revision') {
  str(v, what, { max: 1024 });
  if (v.startsWith('-')) fail(what, 'must not start with "-"');
  if (/[\s\x00-\x1f\x7f]/.test(v)) fail(what, 'contains whitespace or control characters');
  return v;
}

// A full or abbreviated object id.
function oid(v, what = 'commit id') {
  str(v, what, { max: 64 });
  if (!/^[0-9a-f]{4,64}$/i.test(v)) fail(what, 'expected a hex object id');
  return v;
}

// A path relative to the repository root, as git prints it. Always passed to git after "--",
// but also used for diffs of untracked files and for opening files, so it must stay inside the
// repository: no absolute paths, no ".." segments.
function repoPath(v, what = 'path') {
  str(v, what, { max: 4096 });
  if (path.isAbsolute(v) || /^[a-zA-Z]:/.test(v)) fail(what, 'must be relative to the repository');
  if (v.split(/[\\/]/).includes('..')) fail(what, 'must not contain ".."');
  return v;
}

// A config key such as "user.email" or "remote.origin.url" (section.[subsection.]name).
function configKey(v, what = 'config key') {
  str(v, what, { max: 1024 });
  if (!/^[a-zA-Z][a-zA-Z0-9-]*(\.[^\n\0]+)?\.[a-zA-Z][a-zA-Z0-9-]*$/.test(v)) fail(what, 'expected section.name');
  return v;
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
function safeConfigKey(v, what) {
  configKey(v, what);
  if (COMMAND_KEYS.some((re) => re.test(v.toLowerCase()))) fail(what || 'config key', `${v} runs commands; set it in a terminal`);
  return v;
}

// Files that macOS would run rather than show when opened (apps, scripts, installers, and any
// file with an execute bit). *Open file* reveals these in Finder instead.
const RUNNABLE_EXT = /\.(app|command|tool|sh|bash|zsh|csh|ksh|terminal|workflow|action|scpt|scptd|applescript|jar|pkg|mpkg|prefpane|webloc|inetloc|fileloc|url)$/i;
function runnable(abs, fsMod = require('node:fs')) {
  if (RUNNABLE_EXT.test(abs.replace(/[\\/]+$/, ''))) return true;
  try { const st = fsMod.statSync(abs); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; }
}

// The status entries the renderer hands back for working-tree operations.
const fileEntry = (v, what) => obj(v, what, { path: repoPath, oldPath: optional(repoPath), status: optional((s, w) => str(s, w, { max: 8 })), xy: optional((s, w) => str(s, w, { max: 8 })) });
const lineKeys = (v, what) => list(v, what, (k, w) => { if (typeof k !== 'string' || !/^\d+:\d+$/.test(k)) fail(w, 'expected "hunk:line"'); });
const repoPaths = (v, what) => list(v, what, repoPath);
// Unified changes: 'all', or "hunk:line" / "hunk:*" keys of a combined diff.
const changeSelection = (v, what) => (v === 'all' ? v : list(v, what, (k, w) => { if (typeof k !== 'string' || !/^\d+:(\d+|\*)$/.test(k)) fail(w, 'expected "hunk:line" or "hunk:*"'); }));
const logOptions = (v, what) => obj(v, what, { remotes: bool, tags: bool, limit: int, kind: oneOf('topo', 'details', 'full'), preview: bool });
// The split dialog's choice: per path, 'all' or the "hunk:line" keys that go into the first commit.
const rewriteExtra = (v, what) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(what, 'expected an object');
  const files = v.files ?? {};
  if (files === null || typeof files !== 'object' || Array.isArray(files)) fail(`${what}.files`, 'expected an object');
  for (const [p, sel] of Object.entries(files)) {
    repoPath(p, `${what}.files path`);
    if (sel !== 'all') lineKeys(sel, `${what}.files[${p}]`);
  }
  return obj(v, what, { files: () => {}, messages: (m, w) => list(m, w, text), message: text });
};
const label = (v) => ({ __label: str(v.__label, 'label', { max: 1024 }) });

// Another worktree's folder (as `git worktree list` prints it). The schema only checks the shape;
// main.js then requires it to be one of the open repository's worktrees (see knownWorktree), so a
// renderer can't point lock/remove/terminal/reveal/open-window at an arbitrary folder.
const worktreeDir = Object.assign((v, what) => absDir(v, what), { worktree: true });
const worktreeSpec = (v, what) => obj(v, what, { dir: optional((d, w) => str(d, w, { max: 4096 })), branch: optional(rev), base: optional(rev) });

// One lane to clean up: its branch (with the tip the user saw) and/or its worktree folder.
const cleanupItem = (v, what) => {
  obj(v, what, { branch: optional(rev), head: optional(oid), worktree: optional(absDir), force: optional(bool) });
  if (!v.branch && !v.worktree) fail(what, 'expected a branch or a worktree');
  return v;
};
// A name for `git remote add`/`rename`: one path component git accepts in refs/remotes/<name>/.
const remoteName = (v, w = 'remote name') => {
  str(v, w, { max: 256 });
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(v) || v.includes('..') || v.endsWith('.lock') || v.endsWith('.')) fail(w, 'letters, digits, ".", "_" and "-" only');
  return v;
};
const remoteBranch = (v, w) => { rev(v, w); if (!/^[^/]+\/.+/.test(v)) fail(w, 'expected remote/branch'); if (/\/-/.test(v)) fail(w, 'must not start with -'); return v; };

// The worktree in `worktrees` (from git.getWorktrees) at `dir`, or throws. `same` compares paths
// (git.samePath, which follows symlinks such as /tmp -> /private/tmp).
function knownWorktree(worktrees, dir, same = (a, b) => a === b, what = 'worktree') {
  absDir(dir, what);
  const wt = worktrees.find((w) => same(w.path, dir));
  if (!wt) fail(what, 'not a worktree of this repository');
  return wt.path;
}

// ---------------------------------------------------------------------------
// Schemas: one checker per argument, in order. Trailing arguments may be omitted.

const gitSchemas = {
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
  checkSplit: [rev],
  compare: [rev, rev],
  branchReview: [rev, optional(rev)],
  changeFacts: [rev, rev],
  mergeConflicts: [rev, rev],
  mergeLanePlan: [rev, optional(rev)],
  status: [],
  opState: [],
  lfs: [],
  submodules: [],
  externalTools: [],
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
  freeBlocker: [worktreeDir],
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
  switchDelete: [rev, optional((v, w) => obj(v, w, { message: text, untracked: optional(bool) }))],
  switchMerge: [rev, rev, rev, text, optional((v, w) => obj(v, w, { message: text, untracked: optional(bool) }))],
  createBranch: [rev, rev, optional(bool)],
  deleteBranch: [rev],
  renameBranch: [rev, rev],
  setBranchTip: [rev, rev],
  createTag: [rev, rev, optional(text)],
  deleteTag: [rev],
  cherryPick: [rev],
  revert: [rev],
  merge: [rev, optional(bool)],
  rebaseOnto: [rev],
  rebaseBranch: [rev, rev],
  rewrite: [oneOf('drop', 'reword', 'squash', 'fixup', 'swapParent', 'split'), oid, optional(rewriteExtra)],
  createCommit: [text, optional(bool)],
  pull: [],
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
  removeWorktree: [worktreeDir],
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
  mergeLane: [rev, rev, text],
  tidyLane: [rev],
  // undoable submodule init/update (journal.runSubmodules); no paths = all submodules
  updateSubmodules: [optional(repoPaths)],
  // history
  undo: [],
  redo: [],
  restoreHistory: [int],
};

// Validate a `git` IPC call. Returns { args, label } with the optional trailing
// `{ __label }` split off, or throws IpcArgError.
function checkGit(method, args) {
  if (typeof method !== 'string' || !Object.hasOwn(gitSchemas, method)) throw new IpcArgError(`Unknown method ${String(method).slice(0, 64)}`);
  let lbl = null;
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !Array.isArray(last) && Object.hasOwn(last, '__label')) {
    lbl = label(last).__label;
    args = args.slice(0, -1);
  }
  const schema = gitSchemas[method];
  if (args.length > schema.length) throw new IpcArgError(`Too many arguments for ${method}`);
  schema.forEach((check, i) => {
    // Absent trailing arguments are only fine for optional checks; required ones throw on undefined.
    if (i < args.length || !check.optional) check(args[i], `${method} argument ${i + 1}`);
  });
  // Arguments main.js must still resolve against the repository's worktree list.
  const worktreeArgs = schema.flatMap((check, i) => (check.worktree && i < args.length ? [i] : []));
  return { args, label: lbl, worktreeArgs };
}

// ---------------------------------------------------------------------------
// Values for `app:*` channels.

// Only plain web links go to the OS. file:, javascript:, custom app schemes and anything with
// credentials embedded are refused.
function webUrl(v, what = 'URL') {
  str(v, what, { max: 8192 });
  let u;
  try { u = new URL(v); } catch { fail(what, 'not a URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(what, 'only http(s) links can be opened');
  if (u.username || u.password) fail(what, 'must not contain credentials');
  return u.href;
}

// A repository URL for `git clone`. Allows https, ssh, git and scp-style "user@host:path",
// plus local paths and file: URLs. Refuses anything git would read as an option and git's
// transport helpers ("ext::", "fd::"), which can run commands.
function cloneUrl(v, what = 'repository URL') {
  str(v, what, { max: 4096 });
  const s = v.trim();
  if (s.startsWith('-')) fail(what, 'must not start with "-"');
  if (/[\x00-\x1f\x7f]/.test(s)) fail(what, 'contains control characters');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*::/.test(s)) fail(what, 'transport helpers are not allowed');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s);
  if (scheme && !['https', 'http', 'ssh', 'git', 'file'].includes(scheme[1].toLowerCase())) fail(what, `unsupported scheme ${scheme[1]}`);
  return s;
}

// An absolute directory chosen by the user (from argv, a recent list or the open dialog).
function absDir(v, what = 'directory') {
  str(v, what, { max: 4096 });
  if (!path.isAbsolute(v)) fail(what, 'must be an absolute path');
  return v;
}

// The network requests a session may make: its own files and inline data, plus exactly the
// https origins in `allow` (the update feed, for the updater's private session).
// gitlanes-media: is served by the main process (pr-media.js), not the network.
const LOCAL_SCHEMES = new Set(['file:', 'data:', 'devtools:', 'chrome-extension:', 'gitlanes-media:']);
function requestAllowed(url, allow = []) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (LOCAL_SCHEMES.has(u.protocol)) return true;
  return allow.includes(u.origin) && (u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
}

// Resolve a repository-relative path, refusing anything that ends up outside the root.
function insideRepo(root, rel) {
  repoPath(rel);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) fail('path', 'outside the repository');
  return abs;
}

const confirmOptions = (v) => obj(v, 'dialog', { message: (s, w) => str(s, w, { max: 4096 }), detail: optional(text), ok: optional((s, w) => str(s, w, { max: 128 })), destructive: optional(bool) });

module.exports = { IpcArgError, checkGit, gitSchemas, knownWorktree, requestAllowed, rev, oid, repoPath, configKey, safeConfigKey, runnable, webUrl, cloneUrl, absDir, insideRepo, confirmOptions, str, bool, oneOf, prNumber, mediaId, knownRemote, remoteName, obj };
