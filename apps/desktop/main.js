'use strict';
const { app, BaseWindow, WebContentsView, ipcMain, dialog, Menu, shell, clipboard, nativeTheme, nativeImage, protocol, screen, session: electronSession } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const git = require('./git');
const tabOrder = require('./tab-order');
const { Journal, workOps, worktreeOps, laneOps, remoteOps } = require('./journal');
const { LogStreams } = require('./log-streams');
const { Licensing } = require('./licence');
const { loadConfig } = require('./licence/config');
const { createStore } = require('./licence/stores');
const updater = require('./updater');
const pkg = require('./package.json');
const check = require('./ipc');
const catchupStore = require('./catchup-store');
const recentStore = require('./recent-store');
const windowState = require('./window-state');
const ai = require('./ai');
const github = require('./github');
const changeFacts = require('./change-facts');
const prMedia = require('./pr-media');

const isMac = process.platform === 'darwin';
const bench = process.env.SINCE_BENCH ? require('./bench/harness')(app) : null;
// The app was called GitLanes before: carry its settings, recent repositories and local storage over
// once (not Chromium's caches or locks). Never overwrites anything already there, and never into an
// explicit --user-data-dir (e2e sandboxes).
const oldUserData = path.join(app.getPath('appData'), 'GitLanes');
if (!app.commandLine.hasSwitch('user-data-dir') && !['settings.json', 'recent.json'].some((f) => fs.existsSync(path.join(app.getPath('userData'), f))) && fs.existsSync(oldUserData)) {
  const keep = (src) => { const top = path.relative(oldUserData, src).split(path.sep)[0]; return !top || top.endsWith('.json') || top === 'Local Storage'; };
  try { fs.cpSync(oldUserData, app.getPath('userData'), { recursive: true, force: false, filter: keep }); } catch (err) { console.warn('could not copy the old app data', err.message); }
}
const sessions = new Map(); // webContents.id -> RepoSession
// Bumped on every repository change any window sees (watcher events, our own git commands): a lanes
// run started before it is never shared with a later caller (git.sharedLanes).
let repoGen = 0;

// ---------------------------------------------------------------------------
// Recent repositories

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
const readRecent = () => recentStore.readRecent(recentFile());
function addRecent(repo) {
  recentStore.addRecent(recentFile(), repo);
  if (isMac) app.addRecentDocument(repo.root);
}
// macOS keeps its own Open Recent list, which Electron can only clear as a whole; it is left as is.
const removeRecent = (root) => recentStore.removeRecent(recentFile(), root);
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// ---------------------------------------------------------------------------
// Theme: System / Light / Dark. nativeTheme.themeSource drives both native UI
// (menus, title bar, dialogs) and prefers-color-scheme in every renderer.

const THEMES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}
const currentTheme = () => (THEMES.includes(nativeTheme.themeSource) ? nativeTheme.themeSource : 'system');
// Window chrome colours, matching --bg in styles.css.
const windowColors = () => (nativeTheme.shouldUseDarkColors
  ? { bg: '#080707', symbol: '#a19e9b' }
  : { bg: '#faf7f4', symbol: '#6b5e54' });

function setTheme(mode, { announce = false } = {}) {
  if (!THEMES.includes(mode)) return currentTheme();
  nativeTheme.themeSource = mode;
  try { writeSettings({ theme: mode }); } catch (e) { console.warn('could not save theme', e.message); }
  buildMenu();
  const front = activeTab();
  for (const t of tabs.values()) if (!t.isDestroyed()) t.webContents.send('theme', mode, { announce: announce && t === front });
  return mode;
}
const cycleTheme = () => setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length], { announce: true });

nativeTheme.on('updated', () => {
  const c = windowColors();
  for (const { win } of hosts) {
    win.setBackgroundColor(c.bg);
    if (!isMac) win.setTitleBarOverlay?.({ color: c.bg, symbolColor: c.symbol });
  }
  for (const t of tabs.values()) t.view.setBackgroundColor(c.bg);
});

// ---------------------------------------------------------------------------
// Per-window repository session: watcher + undo/redo history

class RepoSession {
  constructor(win, repo) {
    this.win = win;
    this.repo = repo;
    this.journal = new Journal(repo);
    this.journal.prune();
    this.watchers = [];
    this.pending = { refs: false, workdir: false };
    this.timer = null;
    this.busy = 0;
    this.graphChecked = false;
    // Aborted when the repository closes: the loads still running stop their gh calls and return null.
    this.closed = new AbortController();
    this.logs = new LogStreams(repo.root, { onEnd: (l) => { if (!l.fast && !l.opts.preview && !this.graphChecked) this.writeCommitGraph(); } });
    this.watch();
  }

  watch() {
    // A linked worktree's refs live in the shared commonDir, outside its own gitDir.
    const { root, gitDir, commonDir = gitDir } = this.repo;
    const inside = (abs, dir) => abs === dir || abs.startsWith(dir + path.sep);
    const onEvent = (base) => (_type, file) => {
      if (!file) { this.pending.refs = this.pending.workdir = true; return this.schedule(); }
      const abs = path.join(base, file.toString());
      if (inside(abs, gitDir) || inside(abs, commonDir)) {
        const rel = path.relative(inside(abs, gitDir) ? gitDir : commonDir, abs);
        if (rel.startsWith('objects') || rel.endsWith('.lock') || rel.startsWith('since') || rel.startsWith(path.join('refs', 'since')) || rel.startsWith('logs')) return;
        // Another worktree's admin dir: only its HEAD and the dir itself (added/removed) matter here.
        const parts = rel.split(path.sep);
        if (parts[0] === 'worktrees' && parts.length > 2 && parts[2] !== 'HEAD' && parts[2] !== 'locked') return;
        this.pending.refs = true;
        if (rel === 'index') this.pending.workdir = true;
      } else {
        this.pending.workdir = true;
      }
      this.schedule();
    };
    const add = (dir) => {
      try { this.watchers.push(fs.watch(dir, { recursive: true }, onEvent(dir))); } catch (e) { console.warn('watch failed', dir, e.message); }
    };
    add(root);
    if (!inside(commonDir, root)) add(commonDir);
    if (!inside(gitDir, root) && !inside(gitDir, commonDir)) add(gitDir);
  }

  schedule() {
    repoGen++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.busy) return this.schedule(); // wait until our own git command finishes
      const p = this.pending;
      this.pending = { refs: false, workdir: false };
      if (!this.win.isDestroyed()) this.win.webContents.send('repo:changed', p);
    }, 120);
  }

  // Once per session, after a full log without git's commit-graph cache, write it in the
  // background so the next load streams immediately.
  async writeCommitGraph() {
    this.graphChecked = true;
    try { if (!(await git.hasCommitGraph(this.repo.root))) await git.writeCommitGraph(this.repo.root); } catch (e) { console.warn('commit-graph write failed', e.message); }
  }

  dispose() {
    this.closed.abort();
    this.forecast?.abort();
    this.logs.dispose();
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

// ---------------------------------------------------------------------------
// Git API exposed to the renderer. Mutations that move refs or destroy
// uncommitted work are recorded in the journal, giving unlimited undo/redo.

async function detachedHeads(s) {
  return (await git.getWorktrees(s.repo.root).catch(() => [])).filter((w) => !w.current && w.detached && w.head).map((w) => w.head);
}

const reads = {
  refs: (s) => git.getRefs(s.repo.root),
  // Other worktrees' detached HEADs are on no branch; include them so the graph can show them.
  log: async (s, opts) => git.getLog(s.repo.root, { ...opts, heads: await detachedHeads(s) }),
  logOpen: async (s, opts) => s.logs.open({ ...opts, heads: await detachedHeads(s) }),
  logRead: (s, id) => s.logs.read(id),
  logClose: (s, id) => s.logs.close(id),
  logDetails: (s, shas) => git.getLogDetails(s.repo.root, shas),
  commit: (s, sha) => git.getCommit(s.repo.root, sha),
  commitFileDiff: (s, sha, file, parent) => git.commitFileDiff(s.repo.root, sha, file, parent),
  commitDiffs: (s, sha) => git.commitDiffs(s.repo.root, sha),
  // Whether a commit is on HEAD, and the local branches containing it (rewriting it there, AK-581).
  commitBranches: (s, sha) => git.commitBranches(s.repo.root, sha),
  // Throws the reason a commit can't be split on `tip` (merge, not on that branch, merges above it).
  checkSplit: (s, sha, tip) => git.rewriteRange(s.repo.root, 'split', sha, tip || 'HEAD').then(() => true),
  compare: (s, from, to) => git.compareDiff(s.repo.root, from, to),
  branchReview: (s, branch, base) => git.branchReview(s.repo.root, branch, base),
  // Plain facts about a branch's diff against base (change-facts.js): git only, cached per SHA pair.
  changeFacts: (s, base, head) => changeFacts.changeFacts(s.repo.root, base, head),
  // Review (AK-305): the files and hunks that conflict when `head` merges into `base` (merge-tree, read-only).
  mergeConflicts: (s, base, head) => git.mergeConflictHunks(s.repo.root, base, head),
  // Merge and tidy: the plan, with the squash commit message drafted from the branch's commits.
  mergeLanePlan: async (s, branch, base, opts) => {
    const plan = await git.mergeLanePlan(s.repo.root, branch, base, opts || {});
    const d = github.prDraft(plan.commits);
    return { ...plan, message: [d.title, d.body].filter(Boolean).join('\n\n') };
  },
  status: async (s) => git.markLfs(s.repo.root, await git.getStatus(s.repo.root)),
  lfs: (s) => git.getLfs(s.repo.root),
  submodules: (s) => git.getSubmodules(s.repo.root),
  submoduleChanges: (s, p) => git.submoduleChanges(s.repo.root, p),
  externalTools: (s) => git.getExternalTools(s.repo.root),
  // Read-only: the tool gets temporary copies; for the working tree it may edit the real file.
  difftool: (s, file, staged, commit, parent) => git.difftool(s.repo.root, file, { staged, commit, parent }),
  opState: (s) => git.getOperationState(s.repo.gitDir),
  opInfo: (s) => git.getOperationInfo(s.repo.root, s.repo.gitDir),
  divergence: (s, fetch) => git.divergence(s.repo.root, { fetch }),
  conflict: (s, p) => git.getConflict(s.repo.root, p),
  fileHistory: (s, p, page) => git.fileHistory(s.repo.root, page?.path || p, page),
  trackedFiles: (s) => git.trackedFiles(s.repo.root),
  blame: (s, p, rev) => git.blame(s.repo.root, p, rev),
  workingDiff: (s, file, staged) => git.workingDiff(s.repo.root, file, { staged }),
  combinedDiff: (s, file, hunks) => git.combinedDiff(s.repo.root, file, { hunks: hunks || undefined }),
  stashes: (s) => git.getStashes(s.repo.root),
  reflog: (s) => git.getReflog(s.repo.root),
  config: (s) => git.getConfig(s.repo.root),
  remotes: (s) => git.getRemotes(s.repo.root),
  identity: (s) => git.getIdentity(s.repo.root),
  history: (s, limit) => s.journal.list(limit),
  previewRestore: (s, id) => s.journal.previewRestore(id),
  // `elsewhere`: open in another window, which has to be brought forward to work on it.
  worktrees: async (s) => (await git.getWorktrees(s.repo.root)).map((w) => ({ ...w, elsewhere: ![undefined, s.win].includes(windowFor(w.path)) })),
  worktreeChanges: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    return wt.missing ? null : git.worktreeChanges(wt.path);
  },
  // Why that worktree can't give up its branch to this one (see freeCheckout), or null.
  freeBlocker: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    return ![undefined, s.win].includes(windowFor(wt.path)) ? 'It’s open in another window.' : git.freeBlocker(wt);
  },
  // Whether that worktree can hand its branch and changes to this one (see moveCheckout).
  worktreeHold: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    return ![undefined, s.win].includes(windowFor(wt.path)) ? { blocker: 'It’s open in another window.' } : git.worktreeHold(wt);
  },
  // What removing that worktree stashes ({ changes }) and would abort ({ op }).
  removalFacts: async (s, dir) => git.removalFacts(await git.findWorktree(s.repo.root, dir)),
  worktreeOp: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    return wt.missing ? null : git.worktreeOp(wt.path);
  },
  // The same, named (AK-584): what it's merging, picking or rebasing, and how far it got.
  worktreeOpInfo: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    if (wt.missing) return null;
    const info = await git.getOperationInfo(wt.path, (await git.run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
    // Conflicted files go with the abort, so they aren't changes to stash (cleanup).
    if (info) info.conflicts = (await git.run(wt.path, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean).length;
    return info;
  },
  baseTouches: (s, head, base, files) => git.baseTouches(s.repo.root, head, base, files),
};

const W = { GIT_OPTIONAL_LOCKS: '1' };
const r = (s, args, opts = {}) => git.run(s.repo.root, args, { ...opts, env: { ...W, ...opts.env } });

// Mutations that can move refs (snapshotted for undo).
const refMutations = {
  checkout: (s, target) => r(s, ['checkout', target]),
  checkoutTracking: (s, remoteShort) => r(s, ['checkout', '--track', remoteShort]),
  createBranch: (s, name, at, checkout) => r(s, checkout ? ['checkout', '-b', name, at] : ['branch', name, at]),
  deleteBranch: (s, name) => r(s, ['branch', '-D', name]),
  renameBranch: (s, from, to) => r(s, ['branch', '-m', from, to]),
  setBranchTip: async (s, name, sha) => {
    const { head } = await git.getRefs(s.repo.root);
    if (head.branch === name) return r(s, ['reset', '--keep', sha]);
    return r(s, ['branch', '-f', name, sha]);
  },
  createTag: (s, name, at, message) => r(s, message ? ['tag', '-a', name, '-m', message, at] : ['tag', name, at]),
  deleteTag: (s, name) => r(s, ['tag', '-d', name]),
  cherryPick: (s, sha, keepEmpty) => git.cherryPick(s.repo.root, sha, keepEmpty),
  revert: (s, sha) => r(s, ['revert', '--no-edit', sha]),
  merge: (s, ref, ffOnly) => r(s, ['merge', '--no-edit', ...(ffOnly ? ['--ff-only'] : []), ref]),
  rebaseOnto: (s, sha) => r(s, ['rebase', '--autostash', sha]),
  // A lane's branch from Lanes: checks it out here, then rebases. No autostash: this window's changes stay put.
  rebaseBranch: (s, base, branch) => r(s, ['rebase', base, branch]),
  rewrite: (s, op, sha, extra) => git.rewrite(s.repo.root, op, sha, extra),
  createCommit: (s, message, amend) => r(s, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message }),
  pull: (s, mode) => git.pull(s.repo.root, mode),
  // Push rejected because the remote moved on: pull (one undo step), then push again.
  pullAndPush: async (s, mode) => { await git.pull(s.repo.root, mode); return plainMutations.push(s); },
  continueOp: async (s) => {
    const op = await git.getOperationState(s.repo.gitDir);
    if (!op) return;
    return r(s, ['-c', 'core.editor=true', op, '--continue'], { env: { GIT_EDITOR: 'true' } });
  },
  // Files already resolved are saved first (git.saveResolved), for Restore: returns { op, saved }.
  abortOp: async (s) => {
    const op = await git.getOperationState(s.repo.gitDir);
    if (!op) return;
    const saved = await git.saveResolved(s.repo.root, s.repo.gitDir).catch(() => null);
    await r(s, [op, '--abort']);
    return { op, saved };
  },
};

// Mutations that touch only the index, config or remotes, and lose no local work.
const plainMutations = {
  stageFiles: (s, paths) => r(s, ['add', '-A', '--', ...paths]),
  unstageFiles: async (s, paths) => {
    const hasHead = await r(s, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] });
    return hasHead.trim() ? r(s, ['reset', '-q', 'HEAD', '--', ...paths]) : r(s, ['rm', '--cached', '-q', '-r', '--', ...paths]);
  },
  stageLines: async (s, file, selected) => {
    const d = await git.workingDiff(s.repo.root, file, { staged: false });
    const p = d && git.buildPartialPatch(d, selected, 'stage');
    if (p) await git.applyPatch(s.repo.root, p, { cached: true });
  },
  unstageLines: async (s, file, selected) => {
    const d = await git.workingDiff(s.repo.root, file, { staged: true });
    const p = d && git.buildPartialPatch(d, selected, 'reverse');
    if (p) await git.applyPatch(s.repo.root, p, { cached: true, reverse: true });
  },
  fetch: (s) => r(s, ['fetch', '--all', '--prune', '--tags']),
  push: async (s, { force, all } = {}) => {
    if (all) return r(s, ['push', '--all', ...(force ? ['--force-with-lease'] : [])]);
    const { head, refs } = await git.getRefs(s.repo.root);
    if (!head.branch) throw new git.GitError('HEAD is detached. Check out a branch to push.');
    const b = refs.find((x) => x.kind === 'branch' && x.short === head.branch);
    const args = ['push', ...(force ? ['--force-with-lease'] : [])];
    if (!b || !b.upstream) {
      const remotes = await git.getRemotes(s.repo.root);
      if (!remotes.length) throw new git.GitError('This repository has no remotes.');
      const remote = remotes.find((x) => x.name === 'origin') ? 'origin' : remotes[0].name;
      args.push('-u', remote, head.branch);
    }
    return r(s, args);
  },
  pushTags: (s) => r(s, ['push', '--tags']),
  deleteRemoteBranch: (s, short) => {
    const i = short.indexOf('/');
    return r(s, ['push', short.slice(0, i), '--delete', '--', short.slice(i + 1)]);
  },
  setConfig: (s, key, value) => r(s, ['config', '--local', key, value]),
  unsetConfig: (s, key) => r(s, ['config', '--local', '--unset-all', key]),
  markResolved: (s, p) => r(s, ['add', '--', p]),
  mergetool: (s, paths) => git.mergetool(s.repo.root, paths),
  lockWorktree: (s, dir, reason) => git.lockWorktree(s.repo.root, dir, reason),
  unlockWorktree: (s, dir) => git.unlockWorktree(s.repo.root, dir),
  pruneWorktrees: (s) => git.pruneWorktrees(s.repo.root),
  // Not undoable: the renderer asks for an explicit confirmation that says so.
  deleteRemoteBranches: (s, shorts) => git.deleteRemoteBranches(s.repo.root, shorts),
};

// Lanes → Clean up: one journal step for the whole batch, with progress sent to the window.
async function cleanupLanes(s, items, label) {
  const list = await git.getWorktrees(s.repo.root);
  for (const i of items) {
    if (!i.worktree) continue;
    i.worktree = check.knownWorktree(list, i.worktree, git.samePath);
    if (![undefined, s.win].includes(windowFor(i.worktree))) throw new git.GitError(`${path.basename(i.worktree)} is open in another tab. Close that tab first.`);
  }
  const onProgress = (p) => { if (!s.win.isDestroyed()) s.win.webContents.send('cleanup:progress', p); };
  return s.journal.runCleanup(label || `Clean up ${items.length} branch${items.length === 1 ? '' : 'es'}`, items, { onProgress });
}

// The tab showing a repository root, if any.
const windowFor = (root) => [...sessions.values()].find((x) => !x.win.isDestroyed() && git.samePath(x.repo.root, root))?.win;
// Which worktrees are open in another window changes when a window opens, closes or switches
// worktree: every window refreshes, not only the one whose refs moved.
const notifyWindows = () => { for (const [, x] of sessions) if (!x.win.isDestroyed()) { x.pending.refs = true; x.schedule(); } };
// Close another tab (it shows a worktree about to be removed), once it's not running a git step.
function closeWindow(win, name) {
  if (sessions.get(win.webContents.id)?.busy) throw new git.GitError(`“${name}” is busy in its tab. Try again when it’s done.`);
  return new Promise((resolve) => { win.once('closed', resolve); win.destroy(); });
}

// After the trial (or an unverified licence) the app stays usable read-only: reads and fetch
// still work, anything that changes the repository is refused until a licence is added.
// Undo, redo, restoring history and aborting a stuck rebase/merge stay available so nothing is
// trapped by the trial ending mid-way.
const READ_ONLY_ALLOWED = new Set(['fetch', 'undo', 'redo', 'restoreHistory', 'abortOp']);

// Every IPC channel goes through here: calls are only accepted from our own renderer page,
// loaded from the app bundle into a window's main frame. Arguments are checked by ipc.js.
const RENDERER_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
function trustedSender(e) {
  const frame = e.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const u = new URL(frame.url);
    u.search = ''; u.hash = '';
    return u.href === RENDERER_URL;
  } catch { return false; }
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trustedSender(e)) throw new Error(`Blocked IPC "${channel}" from ${e.senderFrame?.url || 'unknown frame'}`);
    return fn(e, ...args);
  });
}

function session(e) {
  const s = sessions.get(e.sender.id);
  if (!s) throw new Error('No repository open in this window');
  return s;
}

// Calls whose push, pull or fetch failures get a fix offered (git.remoteFailure).
const REMOTE_CALLS = new Set(['push', 'pull', 'pullAndPush', 'fetch', 'pushTags', 'stashAnd', 'abortAnd']);

function serializeError(err) {
  return { message: err.message || String(err), stderr: err.stderr || null, code: err.code || err.kind || null, ...(err.moved ? { moved: err.moved } : {}), ...(err.step ? { step: err.step } : {}) };
}
// Wraps a handler so it returns { ok } or { error } instead of throwing across IPC.
const okCall = (fn) => async (e, ...args) => {
  try { return { ok: await fn(e, ...args) }; } catch (err) { return { error: serializeError(err) }; }
};

handle('git', async (e, method, ...args) => {
  try {
    const { args: realArgs, label, worktreeArgs } = check.checkGit(method, args);
    const s = session(e);
    // Worktree folders must be worktrees of this repository (in its `git worktree list`).
    if (worktreeArgs.length) {
      const list = await git.getWorktrees(s.repo.root);
      for (const i of worktreeArgs) realArgs[i] = check.knownWorktree(list, realArgs[i], git.samePath);
    }
    if (reads[method]) return { ok: await reads[method](s, ...realArgs) };
    if (!READ_ONLY_ALLOWED.has(method) && !(await licensing.ensureCanMutate())) {
      return { error: { message: 'Since is read-only until you add a licence.', code: 'READ_ONLY' } };
    }
    s.busy++;
    try {
      // Aborting isn't a step of its own: the stopped sequence it ends is dropped (Journal.abortOp).
      if (method === 'abortOp') return { ok: await s.journal.abortOp(() => refMutations.abortOp(s)) };
      if (refMutations[method]) return { ok: await s.journal.record(label || method, method, () => refMutations[method](s, ...realArgs)) };
      if (workOps[method]) return { ok: await s.journal.runWork(method, label || method, realArgs) };
      if (remoteOps[method]) return { ok: await s.journal.runRemote(method, label || method, realArgs) };
      if (method === 'stashAnd') {
        const [inner, innerArgs] = realArgs;
        return { ok: await s.journal.stashAnd(label || inner, inner, () => refMutations[inner](s, ...innerArgs)) };
      }
      if (method === 'abortAnd') {
        const [inner, innerArgs] = realArgs;
        return { ok: await s.journal.abortAnd(label || inner, inner, () => refMutations[inner](s, ...innerArgs)) };
      }
      if (method === 'restoreResolved') return { ok: await s.journal.restoreResolved(label || method, ...realArgs) };
      if (method === 'autostashCheckout') return { ok: await s.journal.autostash(label || method, ...realArgs) };
      if (method === 'switchDelete') return { ok: await s.journal.switchDelete(label || method, ...realArgs) };
      if (method === 'switchRewrite') {
        const [to, op, sha, extra, stash] = realArgs;
        return { ok: await s.journal.switchRewrite(label || method, to, { op, sha, extra }, stash) };
      }
      if (method === 'switchMerge') {
        const [to, branch, base, message, stash] = realArgs;
        return { ok: await s.journal.switchMerge(label || method, to, { branch, base, message }, stash) };
      }
      if (method === 'freeCheckout') {
        if (![undefined, s.win].includes(windowFor(realArgs[1]))) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
        return { ok: await s.journal.freeCheckout(label || method, ...realArgs) };
      }
      if (method === 'moveCheckout') {
        if (![undefined, s.win].includes(windowFor(realArgs[1]))) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
        return { ok: await s.journal.moveCheckout(label || method, ...realArgs) };
      }
      if (method === 'removeWorktree') {
        // Open in another window: close that window first when asked (`close`), else refuse.
        const [dir, { close, stash, abort } = {}] = realArgs;
        const other = windowFor(dir);
        if (![undefined, s.win].includes(other)) {
          if (!close) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
          await closeWindow(other, path.basename(dir));
        }
        return { ok: await s.journal.runWorktree(method, label || method, [dir, { stash: !!stash, abort: !!abort }]) };
      }
      if (worktreeOps[method]) return { ok: await s.journal.runWorktree(method, label || method, realArgs) };
      if (laneOps.has(method)) {
        // Merge and tidy (git.mergeLane); tidyLane only removes the worktree and branch, after a GitHub merge.
        const [branch, base, message] = realArgs;
        const { close = false, abort = false } = (method === 'mergeLane' ? realArgs[3] : realArgs[1]) || {};
        const wt = (await git.getWorktrees(s.repo.root)).find((w) => w.branch === branch);
        const other = wt && windowFor(wt.path);
        if (![undefined, s.win].includes(other)) {
          if (!close) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
          await closeWindow(other, wt.name);
        }
        const opts = method === 'mergeLane' ? { branch, base, message, abort } : { branch, merge: false, abort };
        return { ok: await s.journal.runLane(label || method, method, (done) => git.mergeLane(s.repo.root, opts, done)) };
      }
      if (method === 'cleanupLanes') return { ok: await cleanupLanes(s, realArgs[0], label) };
      if (method === 'submoduleWork') return { ok: await s.journal.runSubmoduleWork(label || 'Discard changes in submodule', ...realArgs) };
      if (method === 'updateSubmodules') return { ok: await s.journal.runSubmodules(label || 'Update submodules', ...realArgs) };
      if (plainMutations[method]) return { ok: await plainMutations[method](s, ...realArgs) };
      if (method === 'undo' || method === 'redo') return { ok: await s.journal.step(method, realArgs[0] || {}) };
      if (method === 'restoreHistory') return { ok: await s.journal.restore(...realArgs) };
    } finally {
      s.busy--;
      s.pending.refs = s.pending.workdir = true;
      s.schedule();
      buildMenu();
    }
    throw new Error(`Unknown method ${method}`);
  } catch (err) {
    if (REMOTE_CALLS.has(method) && err instanceof git.GitError) git.remoteFailure(err);
    return { error: serializeError(err) };
  }
});

// ---------------------------------------------------------------------------
// Window / app level IPC

handle('app:recent', () => readRecent());
handle('app:remove-recent', (e, root) => {
  removeRecent(check.absDir(root, 'repository folder'));
  buildMenu();
});
handle('app:repo', (e) => sessions.get(e.sender.id)?.repo || null);
handle('app:platform', () => process.platform);
handle('app:theme', () => currentTheme());

// The git in use, and Use another git… (AK-586): pick a git program, which must run and say its
// version, and keep using it in every window. The path comes from the open dialog, not the renderer.
function useGit(p) {
  const ok = typeof p === 'string' && path.isAbsolute(p) && (() => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } })();
  git.setGitPath(ok ? p : null);
}
handle('app:git-info', okCall(() => git.gitInfo()));
handle('app:git-choose', okCall(async (e) => {
  const res = await dialog.showOpenDialog(windowOf(e), { properties: ['openFile', 'treatPackageAsDirectory'], defaultPath: '/opt/homebrew/bin', message: 'Choose a git program' });
  if (res.canceled || !res.filePaths[0]) return null;
  chosenGit = await git.gitInfo(res.filePaths[0]);
  return chosenGit;
}));
// Keep using the git just chosen (once the renderer has checked its version), or go back to the
// system git ('system').
let chosenGit = null;
handle('app:git-use', okCall(async (_e, which) => {
  check.oneOf('chosen', 'system')(which, 'git');
  if (which === 'chosen' && !chosenGit) throw new Error('No git chosen.');
  const p = which === 'chosen' ? chosenGit.path : null;
  git.setGitPath(p);
  writeSettings({ gitPath: p });
  chosenGit = null;
  const info = await git.gitInfo();
  broadcast('git', info);
  return info;
}));
handle('app:set-theme', (_e, mode) => setTheme(check.oneOf(...THEMES)(mode, 'theme')));
handle('app:cycle-theme', () => cycleTheme());
handle('app:update-state', () => ({ ...updater.getState(), page: updater.page() }));
handle('app:check-updates', () => updater.check({ manual: true }));
handle('app:install-update', () => updater.install());
handle('app:set-auto-update', (_e, on) => setAutoUpdate(check.bool(on, 'auto-update')));

// "Automatically check for updates" (on unless turned off). Manual checks always work.
function setAutoUpdate(on) {
  writeSettings({ autoUpdate: Boolean(on) });
  return updater.refresh();
}

// ---------------------------------------------------------------------------
// Opt-in AI commit messages (ai.js). The prompt is always built here from the staged diff, never
// taken from the renderer, and nothing is sent to a provider the user hasn't agreed to.

const aiSettings = () => ai.normalize(readSettings().ai);
const aiState = () => {
  const a = aiSettings();
  return { ...a, consented: a.consent.includes(a.provider), providers: ai.PROVIDER_IDS.map((id) => ({ id, label: ai.PROVIDERS[id].label, defaultModel: ai.PROVIDERS[id].defaultModel || null })) };
};
async function aiPrompt(e) {
  const root = session(e).repo.root;
  const branch = (await git.run(root, ['branch', '--show-current']).catch(() => '')).trim();
  return ai.stagedChanges(git.run, root, branch);
}
handle('app:ai-settings', () => aiState());
handle('app:ai-configure', (_e, provider, model) => {
  check.oneOf('off', ...ai.PROVIDER_IDS)(provider, 'AI provider');
  writeSettings({ ai: { ...aiSettings(), provider, model: check.str(model ?? '', 'model', { max: 200, empty: true }).trim() } });
  return aiState();
});
handle('app:ai-preview', okCall(async (e) => {
  const prompt = await aiPrompt(e);
  return { ...aiState(), prompt, hash: ai.promptHash(prompt) };
}));
// The first send to a provider carries the hash of the previewed text; if staging changed while
// the preview was open, nothing is sent and the renderer shows the new text instead.
handle('app:ai-generate', okCall(async (e, consent, hash) => {
  const a = aiSettings();
  if (a.provider === 'off') throw new Error('AI commit messages are off.');
  const prompt = await aiPrompt(e);
  if (!a.consent.includes(a.provider)) {
    if (check.bool(consent, 'consent') !== true) throw new Error('Review what will be sent first.');
    if (check.str(hash, 'hash', { max: 64 }) !== ai.promptHash(prompt)) {
      throw Object.assign(new Error('Your staged changes changed while you were reviewing them.'), { code: 'ai-prompt-changed' });
    }
    writeSettings({ ai: { ...a, consent: [...a.consent, a.provider] } });
  }
  return ai.generate(a, prompt);
}));

// ---------------------------------------------------------------------------
// Pull request status through the user's GitHub CLI (github.js). One user-wide flag, plus a
// per-repository hide. The first time it's needed, a fresh install turns it on if `gh` is installed
// and logged in, and an upgrade turns it on if any repository had it on (the old per-repository
// keys are dropped). Otherwise `gh` only runs when the user fetches or refreshes PRs.

let prInit = null;
const prSettings = () => (prInit ||= (async () => {
  const saved = readSettings().github;
  let s = github.normalize(saved);
  if (s.on === null) s = { ...s, on: (await github.ghStatus()) === 'ready' };
  if (JSON.stringify(saved) !== JSON.stringify(s)) writeSettings({ github: s });
})().catch(() => { prInit = null; }));
const prEnabled = async (root) => { await prSettings(); return github.isEnabled(readSettings().github, root); };
// The repository's remotes with the one chosen for PRs (Preferences → Pull requests) marked `pr: true`,
// which github.pickRemote prefers. Every PR path reads remotes through here (AK-461).
async function prRemotes(root) {
  const chosen = github.chosenRemote(readSettings().github, root);
  return (await git.getRemotes(root)).map((r) => (r.name === chosen ? { ...r, pr: true } : r));
}
// The user-wide switch works before a repository is open (the welcome screen's setup step).
async function prState(e) {
  const root = sessions.get(e.sender.id)?.repo?.root;
  await prSettings();
  const saved = readSettings().github;
  const remotes = root ? await prRemotes(root).catch(() => []) : [];
  const remote = github.pickRemote(remotes);
  const choices = github.prCandidates(remotes);
  const chosen = root ? github.chosenRemote(saved, root) : null;
  const enabled = github.normalize(saved).on === true;
  const hidden = root ? github.isHidden(saved, root) : false;
  return { enabled, hidden, active: enabled && !hidden && Boolean(remote), remote, choices, chosen: choices.some((c) => c.name === chosen) ? chosen : null, gh: github.ghInstalled() ? 'installed' : 'missing', installUrl: github.INSTALL_URL };
}
handle('app:pr-state', (e) => prState(e));
handle('app:pr-detect', okCall(async (e) => {
  const s = sessions.get(e.sender.id);
  return github.detect({ remotes: s ? await prRemotes(s.repo.root) : null });
}));
// gh is logged out (AK-588): Terminal opens running `gh auth login` for this repo's GitHub host
// (github.com without a repo). No arguments from the renderer: the host comes from the remote.
handle('app:gh-login', okCall(async (e) => {
  const s = sessions.get(e.sender.id);
  const remote = s ? github.pickRemote(await prRemotes(s.repo.root)) : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-gh-'));
  const file = path.join(dir, 'gh-login.command');
  fs.writeFileSync(file, github.loginScript(remote ? remote.host : 'github.com'), { mode: 0o700 });
  spawn('open', ['-a', 'Terminal', file], { detached: true });
  return true;
}));
handle('app:pr-enable', async (e, on) => {
  const v = check.bool(on, 'pull requests on');
  await prSettings();
  writeSettings({ github: github.setEnabled(readSettings().github, v) });
  return prState(e);
});
handle('app:pr-hide', async (e, hide) => {
  const v = check.bool(hide, 'hide pull requests');
  await prSettings();
  writeSettings({ github: github.setHidden(readSettings().github, session(e).repo.root, v) });
  return prState(e);
});
// The remote the PR features use in this repository; null goes back to the default.
handle('app:pr-remote', async (e, name) => {
  const root = session(e).repo.root;
  if (name !== null) {
    check.str(name, 'remote');
    if (!github.prCandidates(await git.getRemotes(root)).some((r) => r.name === name)) throw new check.IpcArgError('Unknown remote');
  }
  await prSettings();
  writeSettings({ github: github.setChosenRemote(readSettings().github, root, name) });
  return prState(e);
});
handle('app:pr-list', okCall(async (e) => {
  const s = session(e);
  const root = s.repo.root;
  // Checked before anything else, so nothing runs while it's off or hidden here.
  if (!(await prEnabled(root))) return null;
  const remotes = await prRemotes(root);
  // No GitHub remote: no PRs, quietly.
  if (!github.pickRemote(remotes)) return null;
  const { signal } = s.closed;
  return github.listPrs({ enabled: true, remotes, signal }).catch((err) => { if (signal.aborted) return null; throw err; });
}));

// Lanes overview: every local branch and worktree (git.lanes), with open PRs joined on by head
// branch. Local only unless the caller asks for PRs ({ prs: true }) and pull requests are on
// here; then it's the same single `gh pr list` as app:pr-list. A gh failure leaves `pr: null`
// on every lane and comes back as `prError`, so the local data still shows. The PR inbox tab
// adds { inbox: true }: every open PR (`prs`), plus github.inbox (review requests, your login).
handle('app:lanes-list', async (e, opts) => {
  if (opts != null && (typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).some((k) => !['base', 'prs', 'inbox'].includes(k)))) throw new check.IpcArgError('Invalid lanes options');
  const base = opts?.base == null ? undefined : check.rev(opts.base, 'base');
  const withPrs = opts?.prs == null ? false : check.bool(opts.prs, 'prs');
  const withInbox = opts?.inbox == null ? false : check.bool(opts.inbox, 'inbox');
  // Closing the repository cancels this load: its gh calls stop, nothing runs after them, and
  // the page that asked (gone with the repository) gets null.
  const s = session(e);
  const root = s.repo.root;
  const { signal } = s.closed;
  // The local lanes don't wait for `gh` (AK-639): both run at once, and every caller that asks while a
  // run is in flight shares it (git.sharedLanes). Merged PRs add the "shipped" check after (prShipped).
  const gh = async () => {
    const out = { listed: null, prError: null, inbox: null, inboxError: null, prHeads: [] };
    if (!(await prEnabled(root))) return out;
    const remotes = await prRemotes(root);
    if (!github.pickRemote(remotes)) return out;
    // A failed inbox or merged-PR lookup (token scope, Enterprise) keeps the PR list and the
    // lane badges; merged PRs only add the "shipped" check.
    const [l, i, m] = await Promise.allSettled([
      github.listPrs({ enabled: true, remotes, signal }),
      withInbox ? github.inbox({ enabled: true, remotes, signal }) : null,
      github.mergedPrs({ enabled: true, remotes, signal }),
    ]);
    if (l.status === 'fulfilled') out.listed = l.value;
    else out.prError = serializeError(l.reason);
    if (i.status === 'fulfilled') out.inbox = i.value;
    else if (!out.prError) out.inboxError = serializeError(i.reason);
    if (m.status === 'fulfilled') out.prHeads = m.value;
    return out;
  };
  const [res, { listed, prError, inbox, inboxError, prHeads }] = await Promise.all([
    git.sharedLanes(root, { base, gen: repoGen }),
    withPrs ? gh() : { listed: null, prError: null, inbox: null, inboxError: null, prHeads: [] },
  ]);
  if (signal.aborted) return null;
  const rest = { base: res.base, baseRef: res.baseRef, baseSha: res.baseSha };
  const lanes = git.prShipped(res, prHeads);
  s.lanes = { root, baseSha: rest.baseSha, lanes };
  const joined = github.joinLanes(lanes, listed);
  if (!withInbox) return { ...rest, lanes: joined, prError };
  return { ...rest, lanes: joined, prError, prs: listed?.prs || null, remote: listed?.remote.name || null, viewer: listed?.viewer || null, inbox, inboxError };
});

// Conflict forecast for the lanes app:lanes-list last returned in this window (git-only, no
// network). A new request cancels the one still running; the cancelled one resolves to null.
handle('app:lanes-forecast', async (e) => {
  const s = session(e);
  if (!s.lanes || s.lanes.root !== s.repo.root) return { supported: true, pairs: [] };
  s.forecast?.abort();
  const ctrl = new AbortController();
  s.forecast = ctrl;
  try {
    return await git.forecastConflicts(s.lanes.root, s.lanes.lanes, { baseSha: s.lanes.baseSha, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  } finally {
    if (s.forecast === ctrl) s.forecast = null;
  }
});

// Review's catch-up card (AK-281): what landed on the base since the checkpoint (or since
// yesterday, last week or a tag), from git log. With { prs: true } and pull requests on here, the
// merged PRs (the same `gh pr list --state merged` call as app:lanes-list) are joined on by merge
// commit, plus the base's CI (`gh run list --branch <base>`); with pull requests off, no gh calls.
// { base } (AK-374) reads another branch instead: a full ref name, refs/heads/… or refs/remotes/…
// (the `name` of a branch or remote ref from `refs`). The checkpoint belongs to the default base,
// so another branch has none (checkpoint: null, Mark caught up doesn't apply) and a checkpoint
// read falls back to last week (kind: 'week').
const catchupFile = () => path.join(app.getPath('userData'), 'catchup.json');
const tipOf = async (root) => {
  const r = await git.landed(root, {});
  return r && { sha: r.baseSha, base: r.base, date: r.baseDate };
};
handle('app:catchup', async (e, opts) => {
  const s = session(e);
  const root = s.repo.root;
  const { signal } = s.closed; // closing the repository stops the gh calls (→ null)
  const { kind, tag, withPrs, base, isDefault, cp, since } = await catchupStore.catchupOptions(opts, {
    defaultRef: async () => (await git.laneBase(root))?.ref,
    checkpoint: () => catchupStore.checkpoint(catchupFile(), root),
  });
  const res = await git.landed(root, { base, since });
  if (!res) return null;
  let merged = null;
  let ci = null;
  let prError = null;
  if (withPrs && (await prEnabled(root))) {
    const remotes = await prRemotes(root);
    if (github.pickRemote(remotes)) {
      const remote = remotes.find((r) => res.base.startsWith(`${r.name}/`));
      const branch = remote ? res.base.slice(remote.name.length + 1) : res.base;
      const [m, c] = await Promise.allSettled([github.mergedPrs({ enabled: true, remotes, signal }), github.baseCi({ enabled: true, remotes, branch, signal })]);
      if (signal.aborted) return null;
      if (m.status === 'fulfilled') merged = m.value; else prError = serializeError(m.reason);
      if (c.status === 'fulfilled') ci = c.value;
      // Merged stacks (AK-616): which merged PRs in range were parts of a GitHub stack. If that
      // lookup fails, Catch up lists them one by one, without an error.
      const landed = new Set(res.commits.map((x) => x.sha));
      const numbers = (merged || []).filter((p) => p.merge && landed.has(p.merge)).map((p) => p.number);
      if (numbers.length) {
        const facts = await github.mergedStacks({ enabled: true, remotes, numbers, signal }).catch((err) => { console.warn('could not read merged stacks', err.message); return null; });
        if (signal.aborted) return null;
        merged = github.joinStacks(merged, facts);
      }
    }
  }
  return { ...res, kind, tag, checkpoint: cp, defaultBase: isDefault, merged, ci, prError };
});
// Mark caught up: the checkpoint becomes the base tip the card showed. → the checkpoint it replaced,
// which the renderer sends back to undo.
handle('app:catchup-mark', (e, to) => {
  check.obj(to, 'checkpoint', { sha: (v, w) => (v === null ? v : check.oid(v, w)), base: (v, w) => (v === null ? v : check.rev(v, w)), date: (v, w) => { if (!Number.isFinite(v)) throw new check.IpcArgError(`Invalid ${w}`); }, source: check.oneOf('mark', 'opened', 'week'), at: () => {} });
  if (!Number.isFinite(to.date)) throw new check.IpcArgError('Invalid checkpoint.date');
  return catchupStore.mark(catchupFile(), session(e).repo.root, to);
});

// Approve, merge, close and update branch: remote actions on GitHub, not journaled (⌘Z can't undo them). The
// renderer names the PR and the remote it came from; both are checked before `gh` runs.
const prAction = (fn) => okCall(async (e, remoteName, number, opts) => {
  const root = session(e).repo.root;
  check.prNumber(number);
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  return fn({ enabled: await prEnabled(root), remotes: [remote], number }, opts);
});
handle('app:pr-merge-info', prAction((t) => github.mergeInfo(t)));
handle('app:pr-approve', prAction((t, o) => github.approvePr({ ...t, body: check.str(o?.body ?? '', 'review comment', { empty: true }) })));
handle('app:pr-request-changes', prAction((t, o) => github.requestChangesPr({ ...t, body: check.str(o?.body ?? '', 'review comment') })));
handle('app:pr-merge', prAction((t, o) => github.mergePr({
  ...t,
  method: check.oneOf(...github.MERGE_METHODS)(o?.method, 'merge method'),
  deleteBranch: check.bool(o?.deleteBranch, 'delete branch'),
  admin: check.bool(o?.admin, 'merge as admin'),
})));
handle('app:pr-close', prAction((t, o) => github.closePr({ ...t, body: check.str(o?.body ?? '', 'close comment', { empty: true }) })));
// Merge plan fixes (AK-550): mark a draft ready, re-run failed Actions jobs. Opt-in like every
// PR action: target() refuses while pull requests are off.
handle('app:pr-ready', prAction((t) => github.markReady(t)));
// Back to draft (AK-610): the PR's author or anyone with write access; GitHub decides.
handle('app:pr-draft', prAction((t) => github.markDraft(t)));
handle('app:pr-rerun-failed', prAction((t) => github.rerunFailed(t)));
handle('app:pr-update-branch', prAction((t, o) => github.updatePrBranch({ ...t, rebase: check.bool(o?.rebase ?? false, 'rebase') })));
// Review's re-check (AK-625): GitHub's merge state for the open PRs it was still working out on
// the last PR load (github.mergeStates, read-only). Only while pull requests are on (target() checks).
handle('app:pr-merge-states', okCall(async (e, remoteName, numbers) => {
  const root = session(e).repo.root;
  if (!Array.isArray(numbers) || numbers.length > github.LIMIT) throw new check.IpcArgError('Invalid pull request numbers');
  const ns = numbers.map((n) => check.prNumber(n));
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  return github.mergeStates({ enabled: await prEnabled(root), remotes: [remote], numbers: ns });
}));
// Send back: the failed CI log's last lines, and posting the prompt as a PR comment. Both only on
// an explicit click in the sheet, and only while pull requests are on (target() checks).
handle('app:pr-failed-log', prAction((t) => github.failedLog(t)));
// PR evidence (AK-519): checks, failed CI log lines, annotations, media, approvals and open thread
// counts for the PR reader, from `gh` (github.evidence), cached per head commit. Only while pull
// requests are on. Media come back with ids; the main process loads them (pr-media.js).
const media = prMedia.createMedia({ token: (host) => github.authToken({ host }) });
const CI_FILES = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/.+)$/;
async function ciConfigured(root, head) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head || '')) return false;
  const out = await git.run(root, ['ls-tree', '-r', '--name-only', head, '--', '.github/workflows', '.gitlab-ci.yml', '.circleci']).catch(() => '');
  return out.split('\n').some((f) => CI_FILES.test(f));
}
handle('app:pr-evidence', okCall(async (e, remoteName, number, opts) => {
  const root = session(e).repo.root;
  check.prNumber(number);
  check.obj(opts ?? {}, 'evidence options', { head: (v, w) => (v == null ? v : check.oid(v, w)) });
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  const ev = await github.evidence({ enabled: await prEnabled(root), remotes: [remote], number, head: opts?.head ?? null, ciConfigured: (head) => ciConfigured(root, head) });
  return ev.media ? { ...ev, media: media.register(ev.media, github.parseRemote(remote).host) } : ev;
}));
handle('app:pr-media-image', okCall((_e, id) => media.image(check.mediaId(id))));
handle('app:pr-comment', prAction((t, o) => github.commentPr({ ...t, body: check.str(o?.body ?? '', 'comment') })));
// Merge plan (renderer/merge-plan.js, Review's Ready to merge). Planning: `gh pr view` for each
// ready PR (is it still ready, and where is its head), then git fetches the base and any PR heads
// missing here into FETCH_HEAD only (no ref moves) and simulates the merges locally with
// merge-tree. Merging: before each PR, `gh pr view` and `git ls-remote` check nothing changed since
// the plan, then `gh pr merge` with the chosen method (`gh stack merge` for a stack, AK-545), then
// `gh pr view` for the commit the base should be at next. Only while pull requests are on, and
// remote merges can't be undone.
const mergePlan = require('./renderer/merge-plan.js');
const planErr = (message, code = 'gh-failed') => Object.assign(new Error(message), { code });
const oidArg = (v, w) => check.oid(v, w);
async function planTarget(e, remoteName, base) {
  const s = session(e);
  if (!(await prEnabled(s.repo.root))) throw planErr('Pull requests are off for this repository.', 'gh-off');
  if (!(await git.canForecast(s.repo.root))) throw planErr('Merge plan needs git 2.38 or later.', 'git-version');
  const remote = check.knownRemote(await git.getRemotes(s.repo.root), remoteName);
  return { s, remote, base: check.rev(base, 'base branch'), t: { enabled: true, remotes: [remote] } };
}
async function remoteBase(s, remote, base) {
  const out = await r(s, ['ls-remote', '--', remote.name, `refs/heads/${base}`]);
  const oid = out.split(/\s/)[0];
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw planErr(`${base} isn’t on ${remote.name}.`);
  return oid;
}
// opts (AK-545): { method: squash | merge | rebase (squash when absent), stacks: plan native
// stacks as one unit each }. → the plan plus { methods: { allowed, default, saved, used }, stacks:
// [{ id, prs, linear, blocker, native }] }.
handle('app:merge-plan', okCall(async (e, remoteName, baseName, ready, others, opts) => {
  const { s, remote, base, t } = await planTarget(e, remoteName, baseName);
  if (!Array.isArray(ready) || !Array.isArray(others)) throw new check.IpcArgError('Invalid merge plan');
  const flag = (v, w) => (v == null ? v : check.bool(v, w));
  check.obj(opts ?? {}, 'merge plan options', { method: (v, w) => (v == null ? v : check.oneOf(...mergePlan.METHODS)(v, w)), stacks: flag, anyway: flag });
  const anyway = opts?.anyway === true;
  const method = opts?.method || 'squash';
  const numbers = ready.slice(0, mergePlan.MAX_READY).map((n) => check.prNumber(n));
  let rest = others.slice(0, mergePlan.MAX_OTHERS).map((o) => check.obj(o, 'open pull request', { number: check.prNumber, head: oidArg }));
  const repoMethods = await github.repoMergeMethods(t);
  if (!repoMethods.allowed.includes(method)) throw planErr(`${methodName(method)} is off in this repo’s settings.`);
  const methods = { ...repoMethods, saved: savedMethod(s.repo.root), used: method };
  // Native stacks (AK-545): found among every open PR, then each member is checked like a ready PR.
  let found = [];
  let chainFacts = new Map();
  const openList = await github.openPrBranches(t).catch(() => []);
  if (opts?.stacks) {
    let total = 0;
    found = mergePlan.findStacks(openList, base).filter((st) => (total += st.prs.length) <= mergePlan.MAX_STACKED);
    // AK-555: which of them GitHub has as a stack (merged with `gh stack merge`; the rest one by one).
    if (found.length) chainFacts = await github.stackFacts({ ...t, numbers: found.flatMap((st) => st.prs) }).catch(() => new Map());
    // Plan each chain's bottom part only, cut where GitHub's stacks begin or end (AK-541): a mix of
    // a GitHub stack and plain PRs can't merge as one unit. What's above waits for it.
    found = found.map((st) => mergePlan.bottomPart(st, chainFacts)).filter(Boolean);
  }
  const inStack = new Set(found.flatMap((st) => st.prs));
  const singles = numbers.filter((n) => !inStack.has(n));
  rest = rest.filter((o) => !inStack.has(o.number));
  const asked = [...singles, ...inStack];
  // GitHub's own merge rules decide (AK-550): blockers per PR, each marked required or not.
  const infos = new Map(await Promise.all(asked.map(async (number) => [number, await github.planFacts({ ...t, number }).catch((err) => ({ error: err.message }))])));
  const snapOf = (info) => ({ head: info.headOid, checks: info.checks, review: info.review });
  const prs = [], skipped = [], reasons = new Map(), blockers = {};
  const leaveOut = (n, list) => { blockers[n] = list; reasons.set(n, mergePlan.blockerText(mergePlan.mainBlocker(list))); };
  for (const n of asked) {
    const info = infos.get(n);
    const list = info.headOid || info.error ? mergePlan.blockersOf(info) : [{ kind: 'error', required: true, detail: 'GitHub didn’t name its head commit.' }];
    if (list.length) blockers[n] = list;
    if (mergePlan.waits(list, anyway)) leaveOut(n, list);
  }
  // Never merge a PR into another PR's branch (AK-541): one that targets a branch other than the
  // plan's waits for the PR below it, whatever planFacts said.
  const baseOf = new Map(openList.map((p) => [p.number, p.baseBranch]));
  const prOn = new Map(openList.map((p) => [p.branch, p.number]));
  for (const n of singles) {
    const b = baseOf.get(n);
    if (b && b !== base) leaveOut(n, [{ kind: 'other', required: true, detail: prOn.has(b) ? `Waits for #${prOn.get(b)} below it` : `Targets ${b}` }]);
  }
  for (const n of singles) {
    if (reasons.has(n)) skipped.push({ number: n, reason: reasons.get(n) });
    else prs.push({ number: n, head: infos.get(n).headOid, snap: snapOf(infos.get(n)) });
  }
  await r(s, ['fetch', '--no-tags', '--', remote.name, `refs/heads/${base}`]);
  const baseSha = (await r(s, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  const has = async (oid) => Boolean((await r(s, ['cat-file', '-t', oid], { allowCodes: [0, 1, 128] }).catch(() => '')).trim() === 'commit');
  const heads = [...prs, ...rest, ...[...inStack].filter((n) => infos.get(n).headOid).map((n) => ({ number: n, head: infos.get(n).headOid }))];
  const missing = [];
  // PRs GitHub says conflict with the base: fetched too, to name the files.
  const dirty = singles.filter((n) => infos.get(n).conflicts && infos.get(n).headOid).map((n) => ({ number: n, head: infos.get(n).headOid }));
  for (const p of [...heads, ...dirty]) if (!(await has(p.head))) missing.push(`refs/pull/${p.number}/head`);
  if (missing.length) await r(s, ['fetch', '--no-tags', '--', remote.name, ...new Set(missing)]);
  const sim = method === 'rebase' ? git.simulateRebase : git.simulateSquash;
  for (const p of dirty) {
    if (!(await has(p.head))) continue;
    const files = (await sim(s.repo.root, baseSha, p.head)).files;
    const b = blockers[p.number].find((x) => x.kind === 'conflicts-base');
    if (!b || !files.length) continue;
    b.files = files;
    leaveOut(p.number, blockers[p.number]);
    const sk = skipped.find((x) => x.number === p.number);
    if (sk) sk.reason = reasons.get(p.number);
  }
  const known = [];
  for (const o of rest) if (await has(o.head)) known.push(o);
  for (const p of prs.splice(0)) { if (await has(p.head)) prs.push(p); else { blockers[p.number] = [{ kind: 'error', required: true, detail: 'Couldn’t fetch its head commit.' }]; skipped.push({ number: p.number, reason: 'Couldn’t fetch its head commit.' }); } }
  // A stack plans whole, at its bottom PR's place in Review's order (else after the single PRs),
  // only when every PR in it is ready.
  const stacks = [];
  for (const st of found) {
    const stHeads = st.prs.map((n) => infos.get(n).headOid);
    const blocker = mergePlan.stackBlocker(st, reasons);
    if (blocker) for (const n of st.prs) if (n !== blocker.number) (blockers[n] ||= []).push({ kind: 'stack', required: true, number: blocker.number });
    // No history check of our own: GitHub merges a stack with merge commits in it (checked on a
    // throwaway repo, 2026-10-18), and it evaluates its own rules when the merge runs.
    const linear = !blocker && stHeads.every(Boolean);
    // The whole stack, or the longest bottom part that merges with the base (maybe just one PR).
    const part = !blocker && linear ? await mergePlan.cleanPart(st, stHeads, (head) => sim(s.repo.root, baseSha, head)) : null;
    const unit = { stack: st.id, prs: part?.prs || st.prs, head: part?.head || stHeads[stHeads.length - 1] };
    const partial = part?.partial || null;
    stacks.push({ id: st.id, prs: st.prs, linear, blocker, partial, native: mergePlan.isNative(st, chainFacts) });
    if (blocker || !linear) continue;
    const at = numbers.indexOf(st.prs[0]);
    const i = at < 0 ? -1 : prs.findIndex((p) => (p.stack ? numbers.indexOf(p.prs[0]) : numbers.indexOf(p.number)) > at);
    prs.splice(i < 0 ? prs.length : i, 0, unit);
  }
  const plan = await mergePlan.planOrder({ prs, others: known, baseSha, merge: (tip, head) => sim(s.repo.root, tip, head) });
  for (const b of plan.blocked) if (b.number) (blockers[b.number] ||= []).push({ kind: 'conflicts-pr', required: true, with: b.with, files: b.files });
  const snapshots = Object.fromEntries([...prs.filter((p) => !p.stack).map((p) => [p.number, p.snap]), ...[...inStack].filter((n) => !reasons.has(n)).map((n) => [n, snapOf(infos.get(n))])]);
  // anyway: the PRs only Merge anyway takes (just checks GitHub doesn't require failing or running).
  const anywayable = asked.filter((n) => blockers[n] && mergePlan.anywayOnly(blockers[n]));
  // The repo's default branch as this clone knows it (local, no network): the sheet starts there.
  const defaultBranch = (await r(s, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote.name}/HEAD`], { allowCodes: [0, 1, 128] }).catch(() => '')).trim().replace(`${remote.name}/`, '') || null;
  return { ...plan, base, baseSha, skipped, snapshots, methods, stacks, blockers, anyway: anywayable, defaultBranch };
}));
// Chains vs GitHub stacks (AK-555): the open PR chains on `base`, whether each is a GitHub stack
// already and, if not, whether it can be linked as one (why not, when it can't), plus whether
// GitHub CLI's stack extension is installed. → { extension, chains: [{ id, prs, native, linkable,
// why }] }.
async function chainTarget(e, remoteName, base) {
  const s = session(e);
  if (!(await prEnabled(s.repo.root))) throw planErr('Pull requests are off for this repository.', 'gh-off');
  const remote = check.knownRemote(await git.getRemotes(s.repo.root), remoteName);
  return { remote, base: base == null ? null : check.rev(base, 'base branch'), t: { enabled: true, remotes: [remote] } };
}
handle('app:pr-chains', okCall(async (e, remoteName, baseName) => {
  const { base, t } = await chainTarget(e, remoteName, baseName);
  if (!base) throw new check.IpcArgError('Invalid base branch');
  const host = github.pickRemote(t.remotes)?.host;
  const [open, ext] = await Promise.all([github.openPrBranches(t), github.stackExtension(t).catch(() => ({ installed: false }))]);
  let total = 0;
  const chains = mergePlan.findChains(open, base).filter((c) => (total += c.prs.length) <= mergePlan.MAX_STACKED);
  const facts = chains.length ? await github.stackFacts({ ...t, numbers: chains.flatMap((c) => c.prs) }).catch(() => new Map()) : new Map();
  return {
    extension: ext.installed,
    chains: chains.map((c) => {
      const native = !c.branch && mergePlan.isNative(c, facts);
      // A chain that's partly a GitHub stack already can't be linked: GitHub refuses PRs in two stacks.
      const why = native ? null : c.prs.some((n) => facts.get(n)?.stack) ? 'Part of it is already a GitHub stack' : mergePlan.chainWhy(c, { host });
      return { id: c.id, prs: c.prs, native, linkable: !native && !why, why, ...(c.branch ? { branch: c.branch } : {}) };
    }),
  };
}));
// Installs GitHub CLI's stack extension (`gh extension install github/gh-stack`), on a click.
handle('app:pr-stack-install', okCall(async (e, remoteName) => github.installStackExtension((await chainTarget(e, remoteName, null)).t)));
// Links a chain as a GitHub stack, bottom to top, all or nothing (github.linkStack). Remote, and
// not undoable with ⌘Z. → { linked: true, stack } | { failed: { number, reason } }.
handle('app:pr-stack-link', okCall(async (e, remoteName, baseName, numbers) => {
  const { base, t } = await chainTarget(e, remoteName, baseName);
  if (!base || !Array.isArray(numbers) || numbers.length < 2 || numbers.length > mergePlan.MAX_STACK) throw new check.IpcArgError('Invalid stack');
  const ns = numbers.map((n) => check.prNumber(n));
  if (new Set(ns).size !== ns.length) throw new check.IpcArgError('Invalid stack');
  return github.linkStack({ ...t, base, numbers: ns });
}));
// Rebases a stack onto its base (AK-559), so GitHub can merge it: merge commits out, each PR on
// the one below it. All or nothing, like linking: every PR is checked first (open, its base the one
// below it, you can push to it), the new commits are built as objects only (git.rebaseStack), and
// the first conflict stops it with nothing changed. Then one atomic push, each branch leased to the
// head GitHub named, so a push someone made meanwhile fails it whole. Remote, and not undoable
// with ⌘Z. → { rebased: [numbers] } ([] when it was already linear) | { failed: { number, reason } }
// | { conflict: { number, files } }.
handle('app:pr-stack-rebase', okCall(async (e, remoteName, baseName, numbers) => {
  const { s, remote, base, t } = await planTarget(e, remoteName, baseName);
  if (!Array.isArray(numbers) || numbers.length < 2 || numbers.length > mergePlan.MAX_STACK) throw new check.IpcArgError('Invalid stack');
  const ns = numbers.map((n) => check.prNumber(n));
  if (new Set(ns).size !== ns.length) throw new check.IpcArgError('Invalid stack');
  const facts = await github.stackFacts({ ...t, numbers: ns });
  const stop = mergePlan.linkBlocker(ns, facts, base) || ns.map((n) => (facts.get(n).head ? null : { number: n, reason: 'GitHub didn’t name its head commit.' })).find(Boolean);
  if (stop) return { failed: stop };
  const heads = ns.map((n) => facts.get(n).head);
  await r(s, ['fetch', '--no-tags', '--', remote.name, `refs/heads/${base}`, ...ns.map((n) => `refs/pull/${n}/head`)]);
  const baseSha = (await r(s, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  for (const [i, h] of heads.entries()) {
    if ((await r(s, ['cat-file', '-t', h], { allowCodes: [0, 1, 128] }).catch(() => '')).trim() !== 'commit') return { failed: { number: ns[i], reason: 'Couldn’t fetch its head commit.' } };
  }
  const res = await git.rebaseStack(s.repo.root, baseSha, heads);
  if (res.conflict) return { conflict: { number: ns[res.conflict.index], files: res.conflict.files } };
  const moved = ns.map((n, i) => ({ number: n, branch: check.rev(facts.get(n).branch, 'branch'), old: heads[i], now: res.heads[i] })).filter((_, i) => res.changed[i]);
  if (!moved.length) return { rebased: [] };
  const refspecs = moved.map((m) => `${m.now}:refs/heads/${m.branch}`);
  const leases = moved.map((m) => `--force-with-lease=refs/heads/${m.branch}:${m.old}`);
  try {
    await r(s, ['push', '--atomic', ...leases, '--', remote.name, ...refspecs]);
  } catch (err) {
    const why = /stale info|fetch first|rejected/i.test(err.message) ? 'It changed on GitHub meanwhile. Nothing was pushed.' : String(err.message).split('\n').filter(Boolean).pop()?.slice(0, 200) || 'Push failed. Nothing was pushed.';
    return { failed: { number: moved[0].number, reason: why } };
  }
  return { rebased: moved.map((m) => m.number) };
}));
// One step of a plan: { snap, baseSha, method } from the plan (or the previous merge's commit), or
// for a stack (AK-545) { stack: [{ number, snap }] bottom…top, baseSha, method } with `number` its
// top PR (just the bottom PR when only it merges clean, AK-619). Every PR is checked before the
// merge. → { stop: reason } when something changed, else { merged: true, commit } (commit null
// when a merge queue took it, so the plan stops there), plus `cleaned` (cleanupMerged) when
// o.cleanup is true: only the sheet asks for it.
const nullable = (v, w) => (v === null ? v : check.str(v, w, { max: 32 }));
const snapArg = (v, w) => check.obj(v, w, { head: oidArg, checks: nullable, review: nullable });
handle('app:merge-plan-merge', okCall(async (e, remoteName, baseName, number, o) => {
  const { s, remote, base, t } = await planTarget(e, remoteName, baseName);
  check.prNumber(number);
  const stackArg = (v, w) => {
    if (v == null) return v;
    if (!Array.isArray(v) || v.length > mergePlan.MAX_STACK) throw new check.IpcArgError(`Invalid ${w}`);
    v.forEach((x) => { check.obj(x, w, { number: check.prNumber, snap: snapArg }); if (!x.snap) throw new check.IpcArgError(`Invalid ${w}`); });
    if (!mergePlan.stackStepOk(v.map((x) => x.number), number)) throw new check.IpcArgError(`Invalid ${w}`);
    return v;
  };
  check.obj(o, 'merge step', { baseSha: oidArg, snap: (v, w) => (o?.stack ? v : snapArg(v, w)), method: (v, w) => (v == null ? v : check.oneOf(...mergePlan.METHODS)(v, w)), stack: stackArg, cleanup: (v, w) => (v == null ? v : check.bool(v, w)) });
  if (!o.stack && !o.snap) throw new check.IpcArgError('Invalid merge step');
  const method = o.method || 'squash';
  const steps = o.stack || [{ number, snap: o.snap }];
  const now = await Promise.all(steps.map((x) => github.mergeInfo({ ...t, number: x.number }).catch(() => null)));
  for (let i = 0; i < steps.length; i++) {
    const why = mergePlan.changedSince(steps[i].snap, now[i]);
    if (why) return { stop: `#${steps[i].number}: ${why}` };
  }
  if ((await remoteBase(s, remote, base)) !== o.baseSha) return { stop: `${base} moved on GitHub since the plan` };
  // A chain GitHub has as a stack merges with `gh stack merge`; a plain chain (AK-555) one PR at a
  // time, bottom up, each one after the bottom retargeted to the base first. A step of one PR
  // (AK-619) is `gh stack merge <bottom>` or that PR's own merge.
  const facts = o.stack ? await github.stackFacts({ ...t, numbers: steps.map((x) => x.number) }) : null;
  if (o.stack && mergePlan.isNative({ prs: steps.map((x) => x.number) }, facts)) await github.mergeStack({ ...t, number, method });
  else if (o.stack) {
    const done = [];
    const stopAt = (n, why) => ({ stop: `#${n}: ${why}${done.length ? ` (${done.map((d) => `#${d}`).join(', ')} merged)` : ''}` });
    for (let i = 0; i < steps.length; i++) {
      const n = steps[i].number;
      try {
        if (i > 0 && facts.get(n)?.baseBranch !== base) await github.retargetPr({ ...t, number: n, base });
        await mergeSoon({ ...t, number: n, method, matchHead: steps[i].snap.head }); } catch (err) {
        if (github.headMoved(err)) return stopAt(n, 'new commits were pushed since the plan');
        if (!done.length) throw err;
        return stopAt(n, err.message);
      }
      done.push(n);
    }
  } else {
    try { await github.mergePr({ ...t, number, method, matchHead: o.snap.head }); } catch (err) {
      if (github.headMoved(err)) return { stop: `#${number}: new commits were pushed since the plan` };
      throw err;
    }
  }
  const m = await github.mergedCommit({ ...t, number }).catch(() => ({ commit: null }));
  const res = { merged: true, commit: m.state === 'merged' ? m.commit : null };
  if (o.cleanup === true) {
    // Only PRs GitHub confirms merged; in a stack, each one is asked on its own.
    const states = await Promise.all(steps.map((x) => (x.number === number ? m : github.mergedCommit({ ...t, number: x.number }).catch(() => null))));
    const merged = steps.map((x, i) => ({ number: x.number, branch: now[i]?.branch, head: x.snap.head })).filter((x, i) => states[i]?.state === 'merged');
    res.cleaned = await cleanupMerged(s, merged);
  }
  return res;
}));
// Right after a retarget GitHub may still be working out whether the PR merges: try again twice.
async function mergeSoon(args) {
  for (let k = 0; ; k++) {
    try { return await github.mergePr(args); } catch (err) {
      if (k >= 2 || github.headMoved(err) || !/not mergeable|mergeab(?:le|ility) (?:state|status)|base branch was modified/i.test(err.message)) throw err;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
}
// Clean up after merging (AK-543): remove the merged PRs' local worktrees and branches through
// Lanes → Clean up's path (git.cleanupLanes), as one undoable journal step. Never throws: the
// merge already happened. → { worktrees, branches, skipped: [{ name, message }], error? }
async function cleanupMerged(s, prs) {
  if (!prs.length) return { worktrees: 0, branches: 0, skipped: [] };
  s.busy++;
  try {
    const worktrees = (await git.getWorktrees(s.repo.root)).map((w) => ({ ...w, elsewhere: ![undefined, s.win].includes(windowFor(w.path)) }));
    const local = new Set((await git.run(s.repo.root, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads'])).split('\n').filter(Boolean));
    const { items, skipped } = mergePlan.cleanupItems(prs, local, worktrees);
    if (!items.length) return mergePlan.cleanupSummary({ removed: [], deleted: [], failed: [] }, skipped);
    const label = `Clean up after merging ${prs.map((p) => `#${p.number}`).join(', ')}`;
    return mergePlan.cleanupSummary(await s.journal.runCleanup(label, items), skipped);
  } catch (err) {
    return { worktrees: 0, branches: 0, skipped: [], error: err.message };
  } finally {
    s.busy--;
    s.pending.refs = s.pending.workdir = true;
    s.schedule();
    buildMenu();
  }
}
// The merge method last used in this repo (AK-545), remembered per repo in settings.
const methodName = (m) => ({ squash: 'Squash and merge', merge: 'Merge commits', rebase: 'Rebase and merge' }[m]);
const MAX_SAVED_METHODS = 200;
function savedMethod(root) {
  const m = root ? readSettings().mergeMethods?.[root] : null;
  return mergePlan.METHODS.includes(m) ? m : null;
}
handle('app:merge-method', (e) => ({ saved: savedMethod(session(e).repo?.root || null) }));
handle('app:merge-method-save', (e, method) => {
  const root = session(e).repo?.root;
  const m = check.oneOf(...mergePlan.METHODS)(method, 'merge method');
  if (!root) return { saved: null };
  const all = { ...(readSettings().mergeMethods || {}) };
  delete all[root];
  all[root] = m;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_METHODS))) delete all[k];
  writeSettings({ mergeMethods: all });
  return { saved: m };
});
// Send back's templates (renderer/send-back.js): this repository's, the user-wide default, and
// the built-in ones, resolved. Saving one with empty text resets it to the next level.
const sendBack = require('./renderer/send-back.js');
handle('app:sendback-templates', (e) => sendBack.resolveTemplates(readSettings().sendBack, session(e).repo?.root || null));
handle('app:sendback-template-save', (e, id, text, scope) => {
  const next = sendBack.saveTemplate(readSettings().sendBack, {
    root: session(e).repo?.root || null,
    id: check.oneOf(...sendBack.TEMPLATE_IDS)(id, 'template'),
    text: check.str(text ?? '', 'template', { max: sendBack.MAX_TEMPLATE, empty: true }),
    scope: check.oneOf('repo', 'default')(scope, 'template scope'),
  });
  writeSettings({ sendBack: next });
  return sendBack.resolveTemplates(next, session(e).repo?.root || null);
});

// Review a PR in the inbox: fetch its head into FETCH_HEAD only (no ref moves, so nothing to
// journal) and diff it locally against the base's remote-tracking branch. Plain `git fetch`, no
// `gh`, and only while pull requests are on here.
handle('app:pr-review-head', okCall(async (e, remoteName, number, base) => {
  const s = session(e);
  const root = s.repo.root;
  check.prNumber(number);
  if (!(await prEnabled(root))) throw Object.assign(new Error('Pull requests are off for this repository.'), { code: 'gh-off' });
  const remote = check.knownRemote(await git.getRemotes(root), remoteName);
  const sha = await github.fetchPrHead((args, o) => r(s, args, o), remote.name, number);
  const ref = base ? `refs/remotes/${remote.name}/${check.rev(base, 'base branch')}` : null;
  const has = ref && (await r(s, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowCodes: [0, 1] })).trim();
  return { sha, base: has ? `${remote.name}/${base}` : null };
}));

// Check out a PR as a branch here, or as a branch in a new worktree (a new lane). `gh` says where
// the PR's head is; git fetches it and makes the ref changes, each one journaled so ⌘Z undoes it.
// A local branch that already points elsewhere only moves once the user has confirmed (`update`).
const prCheckoutOpts = (v) => {
  const o = v ?? {};
  if (typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => !['worktree', 'dir', 'update', 'free', 'move', 'stash'].includes(k))) throw new check.IpcArgError('Invalid checkout options');
  const stash = o.stash == null ? null : check.obj(o.stash, 'stash', { message: (v, w) => check.str(v, w, { max: 4096 }), untracked: (v, w) => v == null || check.bool(v, w) });
  return { worktree: o.worktree == null ? false : check.bool(o.worktree, 'worktree'), dir: o.dir ? check.str(o.dir, 'worktree folder', { max: 4096 }) : null, update: o.update == null ? false : check.bool(o.update, 'update'), free: o.free ? check.absDir(o.free, 'worktree folder') : null, move: o.move == null ? false : check.bool(o.move, 'move'), stash };
};
handle('app:pr-checkout', okCall(async (e, number, opts) => {
  check.prNumber(number);
  const { worktree, dir, update, free, move, stash } = prCheckoutOpts(opts);
  const s = session(e);
  const root = s.repo.root;
  if (!(await licensing.ensureCanMutate())) throw Object.assign(new Error('Since is read-only until you add a licence.'), { code: 'READ_ONLY' });
  const { remote, head } = await github.viewPr({ enabled: await prEnabled(root), remotes: await prRemotes(root), number });
  const local = head.local;
  s.busy++;
  try {
    // No destination: only FETCH_HEAD changes, so there's nothing to journal yet.
    await r(s, ['fetch', '--no-tags', '--', remote.name, `refs/pull/${number}/head`]);
    const sha = (await r(s, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
    const tip = (await r(s, ['rev-parse', '-q', '--verify', `refs/heads/${local}`], { allowCodes: [0, 1] })).trim();
    if (tip && tip !== sha && !update) return { confirm: { branch: local, from: tip, to: sha } };
    const track = async () => {
      await r(s, ['config', `branch.${local}.remote`, remote.name]);
      await r(s, ['config', `branch.${local}.merge`, github.prUpstream(head)]);
    };
    if (!worktree) {
      const args = !tip ? ['checkout', '-b', local, sha] : tip !== sha ? ['checkout', '-B', local, sha] : ['checkout', local];
      // The branch is checked out in another worktree: the renderer offers to free it there (`free`).
      const held = tip && (await git.getWorktrees(root)).find((w) => !w.current && w.branch === local);
      if (held && !(free && git.samePath(held.path, free))) return { inUse: { branch: local, worktree: { name: held.name, path: held.path, missing: held.missing, elsewhere: ![undefined, s.win].includes(windowFor(held.path)) } } };
      if (held) {
        if (![undefined, s.win].includes(windowFor(held.path))) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
        // Bringing that worktree's changes along needs the branch where they were made.
        if (move && args.length > 2) throw new git.GitError(`${local} has to move to the pull request first. Commit or stash the changes in “${held.name}”.`);
        if (move) await s.journal.moveCheckout(`Check out #${number}`, local, held.path, stash);
        else await s.journal.freeCheckout(`Check out #${number}`, local, held.path, args);
      } else await s.journal.record(`Check out #${number}`, 'checkout', () => r(s, args));
      await track();
      return { branch: local, sha };
    }
    // Moving an existing branch and adding its worktree are one journal step, so one ⌘Z undoes both.
    const wt = await s.journal.runWorktree('addWorktree', `New worktree for #${number}`, [{ dir, branch: local, base: tip === sha ? null : sha, force: Boolean(tip) && tip !== sha }]);
    await track();
    return { branch: local, sha, worktree: wt };
  } finally {
    s.busy--;
    s.pending.refs = s.pending.workdir = true;
    s.schedule();
    buildMenu();
  }
}));

// Create a PR from a local branch. Main works out what the branch needs (its GitHub head, whether
// it's pushed) itself, so the renderer only names the branch; a push happens only when the user
// ticked the confirm in the sheet, and `gh pr create` runs only on an up-to-date remote branch.
async function prBranch(s, branch) {
  check.rev(branch, 'branch');
  const root = s.repo.root;
  const remotes = await prRemotes(root);
  const enabled = await prEnabled(root);
  const target = github.pickRemote(remotes);
  if (!enabled) throw Object.assign(new Error('Pull requests are off.'), { code: 'gh-off' });
  if (!target) throw Object.assign(new Error('This repository has no GitHub remote.'), { code: 'gh-no-remote' });
  const line = (await r(s, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)', `refs/heads/${branch}`])).trim();
  if (!line) throw new git.GitError(`${branch} isn’t a local branch.`);
  const [upRemote, upRef, track] = line.split('\0');
  const { dest, head, push, pushArgs } = github.prPushPlan({ branch, upRemote, upRef, track, remotes, target });
  return { enabled, remotes, target, dest, head, push, pushArgs };
}
handle('app:pr-create-info', okCall(async (e, branch) => {
  const s = session(e);
  const b = await prBranch(s, branch);
  const base = await github.defaultBranch({ enabled: b.enabled, remotes: b.remotes });
  // Commits not on the remote's base yet; without a remote base, just the branch tip.
  const baseRef = `refs/remotes/${b.target.name}/${base}`;
  const hasBase = (await r(s, ['rev-parse', '-q', '--verify', baseRef], { allowCodes: [0, 1] })).trim();
  const log = await r(s, ['log', '--format=%s%x00%b%x1e', '-n', hasBase ? '50' : '1', hasBase ? `${baseRef}..refs/heads/${branch}` : `refs/heads/${branch}`, '--']);
  return { branch, base, remote: b.target.name, head: b.head, push: b.push, ...github.prDraft(github.parseCommits(log)) };
}));
// "Draft with AI": the provider set up for commit messages, and only once the user has agreed
// to send it diffs (the commit composer asks); this sheet never widens that consent.
handle('app:pr-ai-draft', okCall(async (e, branch, base) => {
  const a = aiSettings();
  if (a.provider === 'off' || !a.consent.includes(a.provider)) throw Object.assign(new Error('Set up AI commit messages first.'), { code: 'ai-off' });
  const s = session(e);
  const b = await prBranch(s, branch);
  check.rev(base, 'base');
  const baseRef = `refs/remotes/${b.target.name}/${base}`;
  const range = (await r(s, ['rev-parse', '-q', '--verify', baseRef], { allowCodes: [0, 1] })).trim() ? `${baseRef}...refs/heads/${branch}` : `refs/heads/${branch}^!`;
  const env = { GIT_OPTIONAL_LOCKS: '1' };
  const [log, stat, diff] = await Promise.all([
    r(s, ['log', '--format=- %s', '-n', '50', range.replace('...', '..'), '--'], { env }),
    r(s, ['diff', '--stat=100', '--no-color', range, '--'], { env }),
    r(s, ['diff', '--no-color', '--no-ext-diff', '-M', range, '--'], { env }),
  ]);
  return ai.splitPr(await ai.generate(a, ai.buildPrPrompt({ branch, base, log, stat, diff })));
}));
const prCreateOpts = (v) => check.obj(v, 'pull request', {
  base: (x, w) => check.rev(x, w),
  title: (x, w) => check.str(x, w, { max: 1024 }),
  body: (x, w) => check.str(x, w, { empty: true }),
  draft: check.bool,
  push: check.bool,
});
handle('app:pr-create', okCall(async (e, branch, opts) => {
  const o = prCreateOpts(opts);
  const s = session(e);
  const b = await prBranch(s, branch);
  if (b.push) {
    if (!o.push) throw Object.assign(new Error(`${branch} has commits that aren’t on GitHub yet. Push it first.`), { code: 'needs-push' });
    if (!(await licensing.ensureCanMutate())) throw Object.assign(new Error('Since is read-only until you add a licence.'), { code: 'READ_ONLY' });
    s.busy++;
    try {
      // A current branch already tracking GitHub takes the usual push path; anything else pushes
      // explicitly to the PR's remote, since the usual path would pick origin.
      if (!b.push.isNew && branch === (await git.getRefs(s.repo.root)).head.branch) await plainMutations.push(s);
      else await r(s, b.pushArgs);
    } finally {
      s.busy--;
      s.pending.refs = true;
      s.schedule();
    }
  }
  return github.createPr({ enabled: b.enabled, remotes: b.remotes, base: o.base, head: b.head, title: o.title, body: o.body, draft: o.draft });
}));

// ---------------------------------------------------------------------------
// Trial & licence

let licensing = null;

function initLicensing() {
  // Packaged builds use only the store profile baked in at build time; the environment can't change it.
  const config = loadConfig(process.env, { packaged: app.isPackaged });
  // Development only: shift the clock to see the trial's later days (SINCE_CLOCK_OFFSET_DAYS=15).
  const offset = app.isPackaged ? 0 : Number(process.env.SINCE_CLOCK_OFFSET_DAYS || 0) * 86400000;
  // Development only: keep the trial mirror elsewhere (e2e gives every launch its own).
  const mirrorOverride = !app.isPackaged && process.env.SINCE_TRIAL_MIRROR;
  const suffix = config.profile === 'production' ? '' : `-${config.profile}`;
  licensing = new Licensing({
    config,
    store: createStore(config),
    stateFile: path.join(app.getPath('userData'), `licence${suffix}.json`),
    // A second copy of the trial clock outside the app's folder, so deleting one doesn't restart the trial.
    mirrorFile: mirrorOverride || path.join(os.homedir(), 'Library', 'Preferences', `.app.gitlanes.desktop${suffix}.trial`),
    now: () => Date.now() + offset,
    onChange: (status) => {
      broadcast('licence', status);
      buildMenu();
    },
  });
}

function revalidate() {
  licensing?.maybeRefresh()?.catch((e) => console.warn('licence check failed', e.message));
}

const licenceCall = (fn) => async (_e, ...args) => {
  try { return { ok: await fn(...args) }; } catch (err) { return { error: serializeError(err) }; }
};
handle('app:licence', () => licensing.status());
handle('app:licence-activate', licenceCall((key) => licensing.activate(check.str(key, 'licence key', { max: 1024, empty: true }))));
handle('app:licence-refresh', licenceCall(() => licensing.refresh()));
handle('app:licence-deactivate', licenceCall(() => licensing.deactivate()));
handle('app:licence-dismiss', () => licensing.dismissNotice());
handle('app:licence-buy', () => { const u = licensing.config.checkoutUrl; if (u) shell.openExternal(u); return Boolean(u); });
handle('app:licence-portal', () => { const u = licensing.config.portalUrl; if (u) shell.openExternal(u); return Boolean(u); });

// `win`: the tab asking (see Tab).
async function bindRepo(win, dir) {
  const repo = await git.openRepo(dir);
  const opening = win.opening;
  win.opening = false;
  // Reuse the tab already showing this repository, in this window or another. A tab opened only for it closes.
  for (const [, s] of sessions) {
    if (s.repo.root === repo.root && s.win !== win && !s.win.isDestroyed()) {
      s.win.focus();
      if (opening) win.destroy();
      return { focused: true };
    }
  }
  // A tab showing another repository opens this one in a new tab; another worktree of its own repository
  // replaces it in place, as before tabs (AK-634).
  const cur = sessions.get(win.webContents.id)?.repo;
  if (cur && !git.samePath(cur.commonDir || cur.gitDir, repo.commonDir || repo.gitDir)) { win.host.add(repo.root); return { focused: true }; }
  sessions.get(win.webContents.id)?.dispose();
  sessions.set(win.webContents.id, new RepoSession(win, repo));
  addRecent(repo);
  // The base tip as of this open: where catch-up starts the first time (AK-281).
  tipOf(repo.root).then((tip) => catchupStore.noteOpen(catchupFile(), repo.root, tip)).catch((err) => console.warn('could not note the base tip', err.message));
  win.setTitle(repo.name);
  win.setRepresentedFilename?.(repo.root);
  buildMenu();
  notifyWindows();
  return repo;
}

handle('app:open', async (e, dir) => {
  const win = tabOf(e);
  try {
    if (dir != null) check.absDir(dir);
    if (!dir) {
      const res = await dialog.showOpenDialog(win.host.win, { properties: ['openDirectory', 'createDirectory'], message: 'Open a Git repository' });
      if (res.canceled) return { ok: null };
      dir = res.filePaths[0];
    }
    return { ok: await bindRepo(win, dir) };
  } catch (err) {
    if (err.code === 'not-repo') return { notRepo: await notRepo(e.sender.id, dir) };
    return { error: serializeError(err) };
  }
});

// The last folder each window was asked to open that isn't a repository: the only folder
// app:init-here will run `git init` in.
const notRepoDirs = new Map();
async function notRepo(id, dir) {
  notRepoDirs.set(id, dir);
  const repos = await git.findRepos(dir);
  return { dir, name: path.basename(dir), repos: repos.map((r) => ({ root: r.root, name: r.name, commonDir: r.commonDir, main: r.main })) };
}

handle('app:init-here', async (e, dir) => {
  const win = tabOf(e);
  try {
    check.absDir(dir);
    if (notRepoDirs.get(e.sender.id) !== dir) throw new Error('That folder wasn’t offered for a new repository.');
    notRepoDirs.delete(e.sender.id);
    await git.initRepo(dir);
    return { ok: await bindRepo(win, dir) };
  } catch (err) { return { error: serializeError(err) }; }
});

handle('app:init', async (e) => {
  const win = tabOf(e);
  const res = await dialog.showOpenDialog(win.host.win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a folder for the new repository' });
  if (res.canceled) return { ok: null };
  try { await git.initRepo(res.filePaths[0]); return { ok: await bindRepo(win, res.filePaths[0]) }; } catch (err) { return { error: serializeError(err) }; }
});

handle('app:clone', async (e, url) => {
  const win = tabOf(e);
  try { url = check.cloneUrl(url); } catch (err) { return { error: serializeError(err) }; }
  const name = (url.split('/').pop() || 'repo').replace(/\.git$/, '');
  const res = await dialog.showSaveDialog(win.host.win, { defaultPath: name, buttonLabel: 'Clone', message: 'Clone repository to…' });
  if (res.canceled) return { ok: null };
  try {
    await git.cloneRepo(url, res.filePath, (line) => win.webContents.send('clone:progress', line));
    return { ok: await bindRepo(win, res.filePath) };
  } catch (err) { return { error: serializeError(err) }; }
});

// Closing a repository also takes it off the recent list.
handle('app:close-repo', (e) => {
  const root = sessions.get(e.sender.id)?.repo?.root;
  if (root) removeRecent(root);
  sessions.get(e.sender.id)?.dispose();
  sessions.delete(e.sender.id);
  tabOf(e)?.setTitle('Since');
  tabOf(e)?.setRepresentedFilename('');
  buildMenu();
  notifyWindows();
});

// A folder another worktree of this repository lives in, or throws.
const worktreeFolder = async (s, dir) => check.knownWorktree(await git.getWorktrees(s.repo.root), dir, git.samePath);
// `target` is relative to the repository root, or an absolute worktree folder of this repository.
const revealTarget = (s, target) => (path.isAbsolute(target) ? worktreeFolder(s, target) : check.insideRepo(s.repo.root, target));

handle('app:reveal', async (e, target) => {
  const s = session(e);
  if (target) shell.showItemInFolder(await revealTarget(s, target));
  else shell.openPath(s.repo.root);
});
handle('app:terminal', async (e, dir) => {
  const s = session(e);
  const target = dir ? await worktreeFolder(s, dir) : s.repo.root;
  if (isMac) spawn('open', ['-a', 'Terminal', target], { detached: true });
  else shell.openPath(target);
});
handle('app:open-file', (e, rel) => {
  const abs = check.insideRepo(session(e).repo.root, rel);
  // Apps, scripts and executables would run, not open: show them in Finder instead.
  if (check.runnable(abs)) { shell.showItemInFolder(abs); return 'revealed'; }
  return shell.openPath(abs);
});
handle('app:external', (_e, url) => shell.openExternal(check.webUrl(url)));
handle('app:copy', (_e, text) => clipboard.writeText(check.str(text, 'clipboard text', { max: 16 * 1024 * 1024, empty: true })));
handle('app:confirm', async (e, opts) => {
  const { message, detail, ok = 'OK', destructive } = check.confirmOptions(opts);
  const res = await dialog.showMessageBox(windowOf(e), { type: destructive ? 'warning' : 'question', message, detail, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1 });
  return res.response === 0;
});
handle('app:new-window', () => { createWindow(); });
handle('app:tabs', (e) => [tabOf(e)?.host.list() || [], closedTabs.length > 0]);
// The tab strip and ⌘K: only this window's tabs.
handle('app:tab', (e, action, id) => {
  const tab = tabOf(e);
  if (!tab) return;
  const host = tab.host;
  const target = id == null ? tab : host.tabs.find((t) => t.id === check.int(id, 'tab'));
  switch (check.tabAction(action)) {
    case 'new': host.add(); break;
    case 'close': if (target) closeTab(target); break;
    case 'select': if (target) host.select(target); break;
    case 'reopen': reopenClosed(); break;
    default: host.step(action === 'next' ? 1 : -1);
  }
});
// Open another worktree of this tab's repository in a new tab, or focus the tab already showing it.
handle('app:open-window', async (e, dir) => {
  const target = await worktreeFolder(session(e), dir);
  const win = windowFor(target);
  if (win) win.focus(); else tabOf(e).host.add(target);
});

// Hand a step to the window showing another worktree of this repository (AK-581), opening one if
// none does: remove a worktree from there, or merge and tidy into the base checked out there. The
// window takes it (app:take-handoff) when the command arrives, or once a new window has opened.
const handoffs = new Map(); // webContents.id -> handoff
handle('app:handoff', async (e, payload) => {
  const s = session(e);
  const h = { ...check.handoff(payload) };
  const list = await git.getWorktrees(s.repo.root);
  h.dir = check.knownWorktree(list, h.dir, git.samePath);
  if (h.path) h.path = check.knownWorktree(list, h.path, git.samePath);
  let win = windowFor(h.dir);
  if (win === s.win) throw new Error('That worktree is open in this window.');
  if (!win) win = s.win.host.add(h.dir);
  handoffs.set(win.webContents.id, h);
  win.focus();
  win.webContents.send('command', 'handoff');
});
handle('app:take-handoff', (e) => {
  const h = handoffs.get(e.sender.id) || null;
  handoffs.delete(e.sender.id);
  return h;
});

// Open a checked-out submodule of this window's repository as its own repository.
handle('app:open-submodule', async (e, p) => {
  const s = session(e);
  const sub = (await git.getSubmodules(s.repo.root)).find((x) => x.path === check.repoPath(p, 'submodule'));
  if (!sub) throw new Error('Not a submodule of this repository');
  if (!sub.head) throw new Error('That submodule isn’t checked out yet. Update it first.');
  const target = path.join(s.repo.root, sub.path);
  const win = windowFor(target);
  if (win) win.focus(); else tabOf(e).host.add(target);
});

// ---------------------------------------------------------------------------
// Windows, tabs & menu

// A window holds one tab per repository (AK-634). Each tab is its own page (a WebContentsView), so it keeps its
// own session, watcher and undo, all torn down when the tab closes; only the tab showing is visible. Every tab
// draws the window's tab strip from the list `changed()` sends it.
const WEB_PREFERENCES = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  spellcheck: false,
  devTools: !app.isPackaged || Boolean(process.env.SINCE_DEVTOOLS),
};
// The traffic lights: beside the sidebar, or in the 36px tab strip once there are two tabs.
const LIGHTS = { x: 16, y: 16 }, TABBED_LIGHTS = { x: 16, y: 11 };
const TAB_KEYS = ['tab.n1', 'tab.n2', 'tab.n3', 'tab.n4', 'tab.n5', 'tab.n6', 'tab.n7', 'tab.n8'];
const hosts = new Set(); // TabHost
const tabs = new Map(); // webContents.id -> Tab
let windowFocus = () => {};

const tabOf = (e) => tabs.get(e.sender.id);
const windowOf = (e) => tabOf(e)?.host.win;
const focusedHost = () => { const w = BaseWindow.getFocusedWindow(); return [...hosts].find((h) => h.win === w); };
const activeTab = () => focusedHost()?.active;
function broadcast(channel, ...args) { for (const t of tabs.values()) if (!t.isDestroyed()) t.webContents.send(channel, ...args); }

// What RepoSession, windowFor and the handoffs call a window: a tab, focused, titled and closed like one.
class Tab extends EventEmitter {
  // `dir`: the folder it opens (none: the welcome screen).
  constructor(host, dir) {
    super();
    this.host = host;
    this.view = new WebContentsView({ webPreferences: WEB_PREFERENCES });
    this.view.setBackgroundColor(windowColors().bg);
    this.webContents = this.view.webContents;
    this.id = this.webContents.id;
    this.title = 'Since';
    this.root = '';
    tabs.set(this.id, this);
    // Taken before the page sees them, so they work wherever the focus is; the Window menu only shows them.
    this.webContents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      const id = keymap.match('menu', { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }, null, isMac);
      if (id === 'tab.next' || id === 'tab.prev') { ev.preventDefault(); this.host.step(id === 'tab.next' ? 1 : -1); }
    });
    this.webContents.once('destroyed', () => this.gone());
    this.load(dir);
  }

  load(dir) {
    this.opening = Boolean(dir);
    // Development only: SINCE_START_VIEW=map opens repositories on the Map instead of Review (e2e).
    const view = !app.isPackaged && process.env.SINCE_START_VIEW === 'map' ? { view: 'map' } : {};
    const query = { ...(dir ? { repo: dir } : {}), ...view };
    this.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html'), Object.keys(query).length ? { query } : undefined);
  }

  isDestroyed() { return this.webContents.isDestroyed(); }
  focus() { this.host.select(this); this.host.win.show(); this.host.win.focus(); }
  setTitle(title) { this.title = title; this.host.changed(); }
  setRepresentedFilename(root) { this.root = root; this.host.changed(); }
  destroy() { this.host.remove(this); }

  // The last tab's ⌘W: the repository closes and the welcome screen shows (it stays on the recent list).
  reset() {
    sessions.get(this.id)?.dispose();
    sessions.delete(this.id);
    this.title = 'Since';
    this.setRepresentedFilename('');
    this.load();
    notifyWindows();
  }

  gone() {
    sessions.get(this.id)?.dispose();
    sessions.delete(this.id);
    handoffs.delete(this.id);
    notRepoDirs.delete(this.id);
    tabs.delete(this.id);
    this.emit('closed');
    buildMenu();
    notifyWindows();
  }
}

class TabHost {
  // `restore`: the launch window, which takes the size and place of the window closed last (AK-633).
  constructor(restore = false) {
    const colors = windowColors();
    const last = restore ? windowState.fitState(windowState.readState(windowStateFile()), screen.getAllDisplays().map((d) => d.workArea)) : null;
    const win = this.win = new BaseWindow({
      width: 1360,
      height: 860,
      ...last?.bounds,
      minWidth: 900,
      minHeight: 560,
      show: false,
      backgroundColor: colors.bg,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: LIGHTS,
      titleBarOverlay: isMac ? undefined : { color: colors.bg, symbolColor: colors.symbol, height: 40 },
    });
    this.maximized = Boolean(last?.maximized);
    this.tabs = [];
    this.active = null;
    hosts.add(this);
    win.on('resize', () => this.layout());
    win.on('focus', () => windowFocus());
    win.on('close', () => {
      const roots = this.roots();
      windowState.saveState(windowStateFile(), { bounds: win.getNormalBounds(), maximized: win.isMaximized(), ...roots });
      rememberClosed(roots.tabs, { active: roots.active, window: true });
    });
    // Back and forward from the mouse's side buttons (Windows, Linux) and the trackpad swipe (macOS, when set to swipe between pages).
    const toActive = (cmd) => this.active?.webContents.send('command', cmd);
    win.on('app-command', (e, cmd) => { if (cmd === 'browser-backward') toActive('back'); else if (cmd === 'browser-forward') toActive('forward'); });
    win.on('swipe', (e, dir) => { if (dir === 'left' || dir === 'right') toActive(dir === 'left' ? 'back' : 'forward'); });
    // Closing a window doesn't close its tabs' pages: close them, which ends their sessions.
    win.on('closed', () => {
      hosts.delete(this);
      for (const t of this.tabs) if (!t.isDestroyed()) t.webContents.close();
      this.tabs = [];
      buildMenu();
    });
  }

  // What launch reopens: the repositories' roots, in tab order, and the one showing.
  roots() {
    const root = (t) => sessions.get(t.id)?.repo.root;
    return { tabs: this.tabs.map(root).filter(Boolean), active: (this.active && root(this.active)) || null };
  }

  list() { return this.tabs.map((t) => ({ id: t.id, title: t.title, active: t === this.active })); }

  // A new last tab, shown unless `show` is false.
  add(dir, { show = true } = {}) {
    const tab = new Tab(this, dir);
    this.tabs.push(tab);
    this.win.contentView.addChildView(tab.view);
    this.layout();
    // A new window shows once its first page has loaded.
    if (!this.win.isVisible()) {
      tab.webContents.once('did-finish-load', () => {
        if (this.win.isDestroyed() || this.win.isVisible()) return;
        if (this.maximized) this.win.maximize();
        this.win.show();
      });
    }
    if (show || !this.active) this.select(tab);
    else { tab.view.setVisible(false); this.changed(); }
    return tab;
  }

  select(tab) {
    if (!this.tabs.includes(tab)) return;
    this.active = tab;
    for (const t of this.tabs) t.view.setVisible(t === tab);
    tab.webContents.focus();
    this.changed();
  }

  step(by) { const i = tabOrder.step(this.tabs.length, this.tabs.indexOf(this.active), by); if (i >= 0) this.select(this.tabs[i]); }
  pick(n) { const i = tabOrder.byNumber(this.tabs.length, n); if (i >= 0) this.select(this.tabs[i]); }

  // Closes a tab; the window closes with its last one.
  remove(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (this.tabs.length === 1) { this.win.close(); return; }
    const next = tabOrder.afterClose(this.tabs.length, i);
    this.tabs.splice(i, 1);
    this.win.contentView.removeChildView(tab.view);
    tab.webContents.close();
    if (this.active === tab) this.select(this.tabs[next]); else this.changed();
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: 0, width, height });
  }

  // The window's title, traffic lights, menu and every tab's strip follow the tabs and the one showing.
  changed() {
    if (this.win.isDestroyed()) return;
    const a = this.active;
    this.win.setTitle(a?.title || 'Since');
    if (isMac) {
      this.win.setRepresentedFilename(a?.root || '');
      this.win.setWindowButtonPosition(this.tabs.length > 1 ? TABBED_LIGHTS : LIGHTS);
    }
    const list = this.list();
    for (const t of this.tabs) if (!t.isDestroyed()) t.webContents.send('tabs', list, closedTabs.length > 0);
    buildMenu();
  }
}

// A new window with a tab for each folder in `dirs` (none: the welcome screen), showing the tab at `active`.
function createWindow(dirs, { restore = false, active = 0 } = {}) {
  const host = new TabHost(restore);
  const list = [].concat(dirs ?? []);
  if (!list.length) list.push(undefined);
  list.forEach((d, i) => host.add(d, { show: i === active }));
  bench?.attach({ setBounds: (b) => host.win.setBounds(b), webContents: host.tabs[0].webContents });
  return host.active;
}

const newTab = () => { const h = focusedHost(); if (h) h.add(); else createWindow(); };
// ⌘W: closes the tab. The last tab closes its repository instead (the welcome screen shows), and on the
// welcome screen the window.
function closeTab(tab = activeTab()) {
  if (!tab) return BaseWindow.getFocusedWindow()?.close();
  const root = sessions.get(tab.id)?.repo.root;
  if (root) rememberClosed([root]);
  if (tab.host.tabs.length > 1) return tab.destroy();
  if (sessions.has(tab.id)) return tab.reset();
  return tab.host.win.close();
}

// Tabs and windows closed, newest last, for Reopen Closed Tab (⇧⌘T): their repositories' roots.
let closedTabs = [];
function rememberClosed(roots, { active = null, window = false } = {}) {
  closedTabs = tabOrder.remember(closedTabs, { roots, active, window });
  for (const h of hosts) h.changed();
}
// ⇧⌘T: the tab closed last comes back in the front window (filling a welcome-screen tab), or the window closed
// last comes back with its tabs. Folders deleted since or already open in a tab are skipped.
function reopenClosed() {
  const { entry, rest } = tabOrder.takeClosed(closedTabs, (d) => fs.existsSync(d) && !windowFor(d));
  closedTabs = rest;
  const host = entry && !entry.window && (focusedHost() || [...hosts].at(-1));
  if (entry && !host) createWindow(entry.roots, { active: tabOrder.reopenActive(entry.roots, entry.active) });
  else if (entry) {
    const blank = host.active && !sessions.has(host.active.id) && !host.active.opening ? host.active : null;
    if (blank) blank.load(entry.roots[0]); else host.add(entry.roots[0]);
    host.win.focus();
  }
  for (const h of hosts) h.changed();
}

// A folder from Finder, the Dock or `open`: the tab already showing it, else a new tab in the front window.
function openFolder(dir) {
  const shown = windowFor(dir);
  if (shown) return shown.focus();
  const host = focusedHost() || [...hosts].at(-1);
  if (!host) return createWindow(dir);
  host.add(dir);
  return host.win.focus();
}

// With no folder to open (launch, or the Dock icon with no windows left), reopen the tabs of the window closed
// last that are still recent repositories, else show the welcome screen (AK-633). Calls made while one is under
// way share it; a folder dropped on the Dock icon may have opened a window meanwhile.
let openingLast = null;
function openLastWindow() {
  openingLast ||= (async () => {
    const state = windowState.readState(windowStateFile());
    // Saved before tabs: `repo`, one root or null.
    const wanted = !state ? undefined : Array.isArray(state.tabs) ? state.tabs : state.repo ? [state.repo] : [];
    const roots = await recentStore.lastTabs(recentFile(), git.openRepo, wanted);
    if (!hosts.size) createWindow(roots, { restore: true, active: tabOrder.reopenActive(roots, state?.active ?? state?.repo) });
  })().finally(() => { openingLast = null; });
  return openingLast;
}

// Menu accelerators come from the keymap (renderer/keymap.js), the one list of every shortcut.
const keymap = require('./renderer/keymap.js');
const acc = (id) => keymap.accelerator(id, isMac);

// Custom key bindings: overrides only, under `keymap` in settings.json. A change rebuilds the menu and reaches
// every window, so menus, ⌘K and the rest show the new keys without a restart.
function setKeymap(o) {
  keymap.setOverrides(o);
  const next = keymap.getOverrides();
  writeSettings({ keymap: next });
  buildMenu();
  broadcast('keymap', next);
  return next;
}
handle('app:keymap', () => keymap.getOverrides());
// While the Keyboard Shortcuts window records new keys, the menu must not run the keys being pressed.
// A reload or crash mid-record must not leave the menu shortcuts off for that window.
const recordWatched = new WeakSet();
handle('app:keymap-recording', (e, on) => {
  const wc = e.sender;
  wc.setIgnoreMenuShortcuts(check.bool(on, 'recording'));
  if (!on || recordWatched.has(wc)) return;
  recordWatched.add(wc);
  const off = () => { if (!wc.isDestroyed()) wc.setIgnoreMenuShortcuts(false); };
  wc.on('did-navigate', off);
  wc.on('render-process-gone', off);
});
handle('app:set-keymap', (_e, o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new check.IpcArgError('key bindings: expected an object');
  return setKeymap(o); // sanitize() drops unknown commands, reserved keys and bad bindings
});
handle('app:keymap-export', async (e) => {
  const res = await dialog.showSaveDialog(windowOf(e), { defaultPath: 'since-shortcuts.json', message: 'Export your custom shortcuts' });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, JSON.stringify({ since: 'keymap', version: 1, keymap: keymap.getOverrides() }, null, 2));
  return res.filePath;
});
handle('app:keymap-import', async (e) => {
  const res = await dialog.showOpenDialog(windowOf(e), { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }], message: 'Import shortcuts' });
  if (res.canceled || !res.filePaths[0]) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')); } catch { throw new Error('That file isn\u2019t a shortcuts file.'); }
  const o = data?.since === 'keymap' || data?.gitlanes === 'keymap' ? data.keymap : data; // gitlanes: exports from before the rename
  return setKeymap({ ...keymap.getOverrides(), ...keymap.sanitize(o) });
});
const send = (cmd, ...args) => () => activeTab()?.webContents.send('command', cmd, ...args);


function licenceItems() {
  if (licensing?.disabled) return [];
  const licensed = licensing?.status().mode === 'licensed';
  return [
    { label: licensed ? 'Licence…' : 'Enter Licence Key…', accelerator: acc('app.licence'), click: send('licence') },
    ...(licensed ? [] : [{ label: 'Buy Since…', click: send('buy') }]),
  ];
}

function buildMenu() {
  const item = (label, accelerator, cmd, ...args) => ({ label, accelerator, click: send(cmd, ...args) });
  const journal = sessions.get(activeTab()?.id)?.journal;
  const front = focusedHost();
  const open = front?.tabs || [];
  const nextUndo = journal?.undo.top, nextRedo = journal?.redo.top;
  const update = updater.getState();
  const updateItem = update.status === 'ready'
    ? { label: `Restart to Update to ${update.version}`, click: () => updater.install() }
    : { label: 'Check for Updates…', enabled: update.status !== 'checking', click: () => updater.check({ manual: true }) };
  const autoItem = { label: 'Automatically Check for Updates', type: 'checkbox', checked: update.auto !== false, click: (mi) => setAutoUpdate(mi.checked) };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [{ role: 'about' }, updateItem, autoItem, { type: 'separator' }, ...licenceItems(), ...(licensing?.disabled ? [] : [{ type: 'separator' }]), item('Settings…', acc('app.settings'), 'preferences'), { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: acc('file.newTab'), click: newTab },
        { label: 'New Window', accelerator: acc('file.newWindow'), click: () => createWindow() },
        { label: 'Reopen Closed Tab', accelerator: acc('file.reopenTab'), enabled: closedTabs.length > 0, click: reopenClosed },
        item('New Repository…', acc('file.init'), 'init'),
        item('Open Repository…', acc('file.open'), 'open'),
        item('Clone Repository…', acc('file.clone'), 'clone'),
        item('Switch Repository…', acc('file.repoSwitch'), 'repoSwitch'),
        {
          label: 'Open Recent',
          submenu: readRecent().slice(0, 10).map((rr) => ({ label: rr.name, sublabel: rr.root, click: send('open', rr.root) })),
        },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: acc('file.close'), click: () => closeTab() },
        { label: 'Close Window', accelerator: acc('file.closeWindow'), click: () => BaseWindow.getFocusedWindow()?.close() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item(nextUndo ? `Undo ${nextUndo.label}` : 'Undo', acc('edit.undo'), 'undo'),
        item(nextRedo ? `Redo ${nextRedo.label}` : 'Redo', acc('edit.redo'), 'redo'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', acc('edit.find'), 'search'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Command Menu', acc('view.palette'), 'palette'),
        { type: 'separator' },
        item('Back', acc('view.back'), 'back'),
        item('Forward', acc('view.forward'), 'forward'),
        { type: 'separator' },
        item('Since', acc('view.catchup'), 'view', 'catchup'),
        item('Review', acc('view.lanes'), 'view', 'lanes'),
        item('Map', acc('view.map'), 'view', 'map'),
        item('Commit', acc('view.commit'), 'view', 'commit'),
        { type: 'separator' },
        item('Branches', acc('view.branches'), 'view', 'branches'),
        item('Remotes', acc('view.remoteList'), 'view', 'remoteList'),
        item('Tags', acc('view.tagList'), 'view', 'tagList'),
        item('Worktrees', acc('view.worktrees'), 'view', 'worktrees'),
        item('Stashes', acc('view.stashes'), 'view', 'stashes'),
        item('Submodules', acc('view.submoduleList'), 'view', 'submoduleList'),
        { type: 'separator' },
        item('Repository Settings…', acc('view.config'), 'preferences', 'repository'),
        { type: 'separator' },
        item('Toggle Sidebar', acc('view.sidebar'), 'sidebar'),
        item('Show Tags', acc('view.tags'), 'toggle', 'tags'),
        item('Show Remote Branches', acc('view.remotes'), 'toggle', 'remotes'),
        item('Show Colour Swatches in Diffs', acc('view.swatches'), 'toggle', 'swatches'),
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            ...THEMES.map((mode) => ({ label: THEME_LABELS[mode], type: 'radio', checked: currentTheme() === mode, click: () => setTheme(mode) })),
            { type: 'separator' },
            { label: 'Cycle Theme', accelerator: acc('view.cycleTheme'), click: cycleTheme },
          ],
        },
        { type: 'separator' },
        // No window reload in packaged builds: ⌘R stays free for Review's reload, and a window reload drops
        // in-memory state (AK-362). Dev builds keep it on F5.
        ...(app.isPackaged ? [] : [{ role: 'reload', accelerator: 'F5' }, { role: 'toggleDevTools' }]), { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        item('History & Recovery', acc('view.snapshots'), 'view', 'snapshots'),
        item('Reflog', acc('view.reflog'), 'view', 'reflog'),
      ],
    },
    {
      label: 'Repository',
      submenu: [
        item('Fetch All', acc('repo.fetch'), 'fetch'),
        item('Pull Current Branch', acc('repo.pull'), 'pull'),
        item('Push Current Branch', acc('repo.push'), 'push'),
        item('Push All Tags', undefined, 'pushTags'),
        { type: 'separator' },
        item('Stash Changes…', acc('repo.stash'), 'stashSave'),
        item('Stash Staged Changes…', acc('repo.stashStaged'), 'stashStaged'),
        item('Reset Hard to HEAD…', undefined, 'resetHard'),
        { type: 'separator' },
        item('New Worktree…', acc('repo.worktreeAdd'), 'worktreeAdd'),
        item('Switch Branch…', acc('repo.branchSwitch'), 'branchSwitch'),
        item('Switch Worktree…', acc('repo.worktreeSwitch'), 'worktreeSwitch'),
        { type: 'separator' },
        item('Open Submodule…', acc('repo.submodules'), 'submodules'),
        item('Update Submodules', acc('repo.submoduleUpdate'), 'submoduleUpdate'),
        { type: 'separator' },
        item('Git LFS Files…', acc('repo.lfs'), 'lfs'),
        item('Open in Difftool', acc('repo.difftool'), 'difftool'),
        item('Resolve Conflicts', acc('repo.conflicts'), 'conflicts'),
        item('Open in Mergetool', acc('repo.mergetool'), 'mergetool'),
        item('File History & Blame…', acc('repo.fileHistory'), 'fileHistory'),
        item('Review Branch…', acc('repo.review'), 'review'),
        item('Commit Identity…', acc('repo.identity'), 'identity'),
        item('Remotes…', acc('repo.remotes'), 'remotes'),
        item('Write Commit Message with AI', acc('repo.aiMessage'), 'aiMessage'),
        item('AI Commit Messages…', undefined, 'aiSetup'),
        { type: 'separator' },
        item('Pull Requests…', acc('repo.prs'), 'prs'),
        item('Refresh Pull Requests', acc('repo.prRefresh'), 'prRefresh'),
        item('New Pull Request…', acc('repo.prCreate'), 'prCreate'),
        item('Check Out Pull Request…', acc('repo.prCheckout'), 'prCheckout'),
        item('Check Out Pull Request in New Worktree…', acc('repo.prWorktree'), 'prWorktree'),
        item('Approve Pull Request…', acc('repo.prApprove'), 'prApprove'),
        item('Merge Pull Request…', acc('repo.prMerge'), 'prMerge'),
        item('Request Changes on Pull Request…', acc('repo.prChanges'), 'prChanges'),
        item('Close Pull Request…', acc('repo.prClose'), 'prClose'),
        { type: 'separator' },
        item('Open in Finder', acc('repo.reveal'), 'reveal'),
        item('Open in Terminal', acc('repo.terminal'), 'terminal'),
        item('Open in Hosting Service', undefined, 'hosting'),
        item('Open Origin in Browser', acc('repo.origin'), 'origin'),
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        // ⌃Tab and ⌃⇧Tab are taken by each tab's page (Tab), so the menu only shows them.
        { label: 'Show Previous Tab', accelerator: acc('tab.prev'), registerAccelerator: false, enabled: open.length > 1, click: () => front?.step(-1) },
        { label: 'Show Next Tab', accelerator: acc('tab.next'), registerAccelerator: false, enabled: open.length > 1, click: () => front?.step(1) },
        ...(open.length > 1 ? [
          { type: 'separator' },
          ...open.slice(0, TAB_KEYS.length).map((t, i) => ({ label: t.title, type: 'checkbox', checked: t === front.active, accelerator: acc(TAB_KEYS[i]), click: () => front.select(t) })),
          { label: 'Last Tab', accelerator: acc('tab.last'), click: () => front.pick(9) },
        ] : []),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    { role: 'help', submenu: [item('Keyboard Shortcuts', acc('help.shortcuts'), 'shortcuts')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lockdown. Since talks to the network only through the git processes it starts; the
// renderer never does. See docs/security.md.

app.enableSandbox();

// No page in any webContents (including ones we never meant to create) may navigate,
// redirect, open windows or attach <webview>s. Web links open in the user's browser.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.on('will-redirect', (ev) => ev.preventDefault());
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(check.webUrl(url)); } catch { /* not a web link: drop it */ }
    return { action: 'deny' };
  });
});

// What a session may load: its own files, inline data: images and DevTools in development
// (ipc.requestAllowed), plus the https origins in `allow`. Only the updater's private
// "since-updates" session gets any: the update feed's host.
function lockDownSession(ses, allow = []) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = check.requestAllowed(details.url, allow);
    if (!allowed) console.warn('blocked request', details.url.slice(0, 200));
    callback({ cancel: !allowed });
  });
}

app.on('session-created', (ses) => lockDownSession(ses));
// PR videos stream through the main process (pr-media.js); registered before ready, as Electron requires.
protocol.registerSchemesAsPrivileged([{ scheme: prMedia.SCHEME, privileges: { stream: true, secure: true } }]);

app.on('open-file', (ev, p) => {
  ev.preventDefault();
  if (app.isReady()) openFolder(p); else app.once('ready', () => openFolder(p));
});

app.whenReady().then(() => {
  app.setName('Since');
  // Packaged builds carry build/icon.icns; `pnpm start` would show Electron's icon in the Dock.
  if (!app.isPackaged && isMac) {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.icns'));
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  }
  lockDownSession(electronSession.defaultSession);
  electronSession.defaultSession.protocol.handle(prMedia.SCHEME, (req) => media.video(req));
  useGit(readSettings().gitPath);
  const saved = readSettings().theme;
  nativeTheme.themeSource = THEMES.includes(saved) ? saved : 'system';
  keymap.setOverrides(readSettings().keymap);
  initLicensing();
  updater.init({
    auto: () => readSettings().autoUpdate !== false,
    // The beta profile carries its own feed (the beta bucket); every other build uses package.json's.
    feed: licensing.config.updates?.feed || pkg.updates?.feed,
    page: licensing.config.updates?.page || pkg.updates?.page,
    devFeed: app.isPackaged ? null : process.env.SINCE_UPDATE_FEED,
    onChange: (state) => {
      buildMenu();
      broadcast('update', { ...state, page: updater.page() });
    },
  });
  lockDownSession(electronSession.fromPartition(updater.PARTITION, { cache: false }), updater.allowedOrigins());
  buildMenu();
  windowFocus = () => { buildMenu(); revalidate(); };
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  // pnpm runs workspace scripts inside apps/desktop; resolve relative paths against where the user ran pnpm.
  const repoPath = arg && path.resolve(process.env.INIT_CWD || process.cwd(), arg);
  if (repoPath && fs.existsSync(repoPath)) createWindow(repoPath, { restore: true }); else openLastWindow();
  app.on('activate', () => { if (!hosts.size) openLastWindow(); });
  // Validate the licence at launch, then about daily while running (on focus and hourly ticks);
  // offline is fine, the cached validation carries on.
  licensing.refresh().catch((e) => console.warn('licence check failed', e.message));
  setInterval(revalidate, 60 * 60 * 1000).unref();
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
