'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeTheme, session: electronSession } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const git = require('./git');
const { Journal, workOps, worktreeOps } = require('./journal');
const { LogStreams } = require('./log-streams');
const { Licensing } = require('./licence');
const { loadConfig } = require('./licence/config');
const { createStore } = require('./licence/stores');
const updater = require('./updater');
const pkg = require('./package.json');
const check = require('./ipc');
const ai = require('./ai');

const isMac = process.platform === 'darwin';
const bench = process.env.GITLANES_BENCH ? require('./bench/harness')(app) : null;
const sessions = new Map(); // webContents.id -> RepoSession

// ---------------------------------------------------------------------------
// Recent repositories

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function readRecent() {
  try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((r) => fs.existsSync(r.root)); } catch { return []; }
}
function addRecent(repo) {
  const list = readRecent().filter((r) => r.root !== repo.root);
  list.unshift({ root: repo.root, name: repo.name, opened: Date.now() });
  fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
  fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 20)));
  if (isMac) app.addRecentDocument(repo.root);
}

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
  ? { bg: '#0e0b09', symbol: '#a59689' }
  : { bg: '#faf7f4', symbol: '#6b5e54' });

function setTheme(mode, { announce = false } = {}) {
  if (!THEMES.includes(mode)) return currentTheme();
  nativeTheme.themeSource = mode;
  try { writeSettings({ theme: mode }); } catch (e) { console.warn('could not save theme', e.message); }
  buildMenu();
  const focused = BrowserWindow.getFocusedWindow();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme', mode, { announce: announce && w === focused });
  return mode;
}
const cycleTheme = () => setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length], { announce: true });

nativeTheme.on('updated', () => {
  const c = windowColors();
  for (const w of BrowserWindow.getAllWindows()) {
    w.setBackgroundColor(c.bg);
    if (!isMac) w.setTitleBarOverlay?.({ color: c.bg, symbolColor: c.symbol });
  }
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
        if (rel.startsWith('objects') || rel.endsWith('.lock') || rel.startsWith('gitlanes') || rel.startsWith(path.join('refs', 'gitlanes')) || rel.startsWith('logs')) return;
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
  // Throws the reason a commit can't be split (merge, not on this branch, merges above it).
  checkSplit: (s, sha) => git.rewriteRange(s.repo.root, 'split', sha).then(() => true),
  compare: (s, from, to) => git.compareDiff(s.repo.root, from, to),
  status: async (s) => git.markLfs(s.repo.root, await git.getStatus(s.repo.root)),
  lfs: (s) => git.getLfs(s.repo.root),
  submodules: (s) => git.getSubmodules(s.repo.root),
  externalTools: (s) => git.getExternalTools(s.repo.root),
  // Read-only: the tool gets temporary copies; for the working tree it may edit the real file.
  difftool: (s, file, staged, commit, parent) => git.difftool(s.repo.root, file, { staged, commit, parent }),
  opState: (s) => git.getOperationState(s.repo.gitDir),
  conflict: (s, p) => git.getConflict(s.repo.root, p),
  fileHistory: (s, p, page) => git.fileHistory(s.repo.root, page?.path || p, page),
  trackedFiles: (s) => git.trackedFiles(s.repo.root),
  blame: (s, p, rev) => git.blame(s.repo.root, p, rev),
  workingDiff: (s, file, staged) => git.workingDiff(s.repo.root, file, { staged }),
  stashes: (s) => git.getStashes(s.repo.root),
  reflog: (s) => git.getReflog(s.repo.root),
  config: (s) => git.getConfig(s.repo.root),
  remotes: (s) => git.getRemotes(s.repo.root),
  identity: (s) => git.getIdentity(s.repo.root),
  history: (s, limit) => s.journal.list(limit),
  previewRestore: (s, id) => s.journal.previewRestore(id),
  worktrees: (s) => git.getWorktrees(s.repo.root),
  worktreeChanges: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    return wt.missing ? null : git.worktreeChanges(wt.path);
  },
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
  cherryPick: (s, sha) => r(s, ['cherry-pick', sha]),
  revert: (s, sha) => r(s, ['revert', '--no-edit', sha]),
  merge: (s, ref, ffOnly) => r(s, ['merge', '--no-edit', ...(ffOnly ? ['--ff-only'] : []), ref]),
  rebaseOnto: (s, sha) => r(s, ['rebase', '--autostash', sha]),
  rewrite: (s, op, sha, extra) => git.rewrite(s.repo.root, op, sha, extra),
  createCommit: (s, message, amend) => r(s, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message }),
  pull: (s) => r(s, ['pull', '--no-edit']),
  continueOp: async (s) => {
    const op = await git.getOperationState(s.repo.gitDir);
    if (!op) return;
    return r(s, ['-c', 'core.editor=true', op, '--continue'], { env: { GIT_EDITOR: 'true' } });
  },
  abortOp: async (s) => {
    const op = await git.getOperationState(s.repo.gitDir);
    if (op) return r(s, [op, '--abort']);
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
  stashSave: (s, message, untracked, { staged, paths } = {}) => git.stashPush(s.repo.root, { message, untracked, staged, paths }),
  stashLines: (s, file, selected, message) => git.stashLines(s.repo.root, file, selected, message),
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
    return r(s, ['push', short.slice(0, i), '--delete', short.slice(i + 1)]);
  },
  setConfig: (s, key, value) => r(s, ['config', '--local', key, value]),
  unsetConfig: (s, key) => r(s, ['config', '--local', '--unset-all', key]),
  markResolved: (s, p) => r(s, ['add', '--', p]),
  mergetool: (s, paths) => git.mergetool(s.repo.root, paths),
  lockWorktree: (s, dir, reason) => git.lockWorktree(s.repo.root, dir, reason),
  unlockWorktree: (s, dir) => git.unlockWorktree(s.repo.root, dir),
  pruneWorktrees: (s) => git.pruneWorktrees(s.repo.root),
};

// The window showing a repository root, if any.
const windowFor = (root) => [...sessions.values()].find((x) => !x.win.isDestroyed() && git.samePath(x.repo.root, root))?.win;

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

function serializeError(err) {
  return { message: err.message || String(err), stderr: err.stderr || null, code: err.code || err.kind || null };
}

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
      return { error: { message: 'GitLanes is read-only until you add a licence.', code: 'READ_ONLY' } };
    }
    s.busy++;
    try {
      if (refMutations[method]) return { ok: await s.journal.record(label || method, method, () => refMutations[method](s, ...realArgs)) };
      if (workOps[method]) return { ok: await s.journal.runWork(method, label || method, realArgs) };
      if (worktreeOps[method]) {
        if (method === 'removeWorktree' && ![undefined, s.win].includes(windowFor(realArgs[0]))) throw new git.GitError('That worktree is open in another window. Close the window first.');
        return { ok: await s.journal.runWorktree(method, label || method, realArgs) };
      }
      if (method === 'updateSubmodules') return { ok: await s.journal.runSubmodules(label || 'Update submodules', ...realArgs) };
      if (plainMutations[method]) return { ok: await plainMutations[method](s, ...realArgs) };
      if (method === 'undo' || method === 'redo') return { ok: await s.journal.step(method) };
      if (method === 'restoreHistory') return { ok: await s.journal.restore(...realArgs) };
    } finally {
      s.busy--;
      s.pending.refs = s.pending.workdir = true;
      s.schedule();
      buildMenu();
    }
    throw new Error(`Unknown method ${method}`);
  } catch (err) {
    return { error: serializeError(err) };
  }
});

// ---------------------------------------------------------------------------
// Window / app level IPC

handle('app:recent', () => readRecent());
handle('app:repo', (e) => sessions.get(e.sender.id)?.repo || null);
handle('app:platform', () => process.platform);
handle('app:theme', () => currentTheme());
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
const aiCall = (fn) => async (e, ...args) => {
  try { return { ok: await fn(e, ...args) }; } catch (err) { return { error: serializeError(err) }; }
};
handle('app:ai-settings', () => aiState());
handle('app:ai-configure', (_e, provider, model) => {
  check.oneOf('off', ...ai.PROVIDER_IDS)(provider, 'AI provider');
  writeSettings({ ai: { ...aiSettings(), provider, model: check.str(model ?? '', 'model', { max: 200, empty: true }).trim() } });
  return aiState();
});
handle('app:ai-preview', aiCall(async (e) => ({ ...aiState(), prompt: await aiPrompt(e) })));
handle('app:ai-generate', aiCall(async (e, consent) => {
  const a = aiSettings();
  if (a.provider === 'off') throw new Error('AI commit messages are off.');
  if (!a.consent.includes(a.provider)) {
    if (check.bool(consent, 'consent') !== true) throw new Error('Review what will be sent first.');
    writeSettings({ ai: { ...a, consent: [...a.consent, a.provider] } });
  }
  return ai.generate(a, await aiPrompt(e));
}));

// ---------------------------------------------------------------------------
// Trial & licence

let licensing = null;

function initLicensing() {
  // Packaged builds use only the store profile baked in at build time; the environment can't change it.
  const config = loadConfig(process.env, { packaged: app.isPackaged });
  // Development only: shift the clock to see the trial's later days (GITLANES_CLOCK_OFFSET_DAYS=15).
  const offset = app.isPackaged ? 0 : Number(process.env.GITLANES_CLOCK_OFFSET_DAYS || 0) * 86400000;
  // Development only: keep the trial mirror elsewhere (e2e gives every launch its own).
  const mirrorOverride = !app.isPackaged && process.env.GITLANES_TRIAL_MIRROR;
  const suffix = config.profile === 'production' ? '' : `-${config.profile}`;
  licensing = new Licensing({
    config,
    store: createStore(config),
    stateFile: path.join(app.getPath('userData'), `licence${suffix}.json`),
    // A second copy of the trial clock outside the app's folder, so deleting one doesn't restart the trial.
    mirrorFile: mirrorOverride || path.join(os.homedir(), 'Library', 'Preferences', `.app.gitlanes.desktop${suffix}.trial`),
    now: () => Date.now() + offset,
    onChange: (status) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('licence', status);
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

async function bindRepo(win, dir) {
  const repo = await git.openRepo(dir);
  // Reuse an existing window already showing this repository.
  for (const [, s] of sessions) {
    if (s.repo.root === repo.root && s.win !== win && !s.win.isDestroyed()) { s.win.focus(); return { focused: true }; }
  }
  sessions.get(win.webContents.id)?.dispose();
  sessions.set(win.webContents.id, new RepoSession(win, repo));
  addRecent(repo);
  win.setTitle(repo.name);
  win.setRepresentedFilename?.(repo.root);
  buildMenu();
  return repo;
}

handle('app:open', async (e, dir) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    if (dir != null) check.absDir(dir);
    if (!dir) {
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Open a Git repository' });
      if (res.canceled) return { ok: null };
      dir = res.filePaths[0];
    }
    return { ok: await bindRepo(win, dir) };
  } catch (err) {
    return { error: serializeError(err) };
  }
});

handle('app:init', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a folder for the new repository' });
  if (res.canceled) return { ok: null };
  try { await git.initRepo(res.filePaths[0]); return { ok: await bindRepo(win, res.filePaths[0]) }; } catch (err) { return { error: serializeError(err) }; }
});

handle('app:clone', async (e, url) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try { url = check.cloneUrl(url); } catch (err) { return { error: serializeError(err) }; }
  const name = (url.split('/').pop() || 'repo').replace(/\.git$/, '');
  const res = await dialog.showSaveDialog(win, { defaultPath: name, buttonLabel: 'Clone', message: 'Clone repository to…' });
  if (res.canceled) return { ok: null };
  try {
    await git.cloneRepo(url, res.filePath, (line) => win.webContents.send('clone:progress', line));
    return { ok: await bindRepo(win, res.filePath) };
  } catch (err) { return { error: serializeError(err) }; }
});

handle('app:close-repo', (e) => {
  sessions.get(e.sender.id)?.dispose();
  sessions.delete(e.sender.id);
  BrowserWindow.fromWebContents(e.sender).setTitle('GitLanes');
  buildMenu();
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
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showMessageBox(win, { type: destructive ? 'warning' : 'question', message, detail, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1 });
  return res.response === 0;
});
handle('app:new-window', () => { createWindow(); });
// Open another worktree of this window's repository in a new window, or focus the window already showing it.
handle('app:open-window', async (e, dir) => {
  const target = await worktreeFolder(session(e), dir);
  const win = windowFor(target);
  if (win) win.focus(); else createWindow(target);
});

// Open a checked-out submodule of this window's repository as its own repository.
handle('app:open-submodule', async (e, p) => {
  const s = session(e);
  const sub = (await git.getSubmodules(s.repo.root)).find((x) => x.path === check.repoPath(p, 'submodule'));
  if (!sub) throw new Error('Not a submodule of this repository');
  if (!sub.head) throw new Error('That submodule isn’t checked out yet. Update it first.');
  const target = path.join(s.repo.root, sub.path);
  const win = windowFor(target);
  if (win) win.focus(); else createWindow(target);
});

// ---------------------------------------------------------------------------
// Windows & menu

function createWindow(repoDir) {
  const colors = windowColors();
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: colors.bg,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay: isMac ? undefined : { color: colors.bg, symbolColor: colors.symbol, height: 40 },
    webPreferences: {
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
      devTools: !app.isPackaged || Boolean(process.env.GITLANES_DEVTOOLS),
    },
  });
  bench?.attach(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), repoDir ? { query: { repo: repoDir } } : undefined);
  win.once('ready-to-show', () => win.show());
  const id = win.webContents.id;
  win.on('closed', () => { sessions.get(id)?.dispose(); sessions.delete(id); buildMenu(); });
  return win;
}

// ⌃⌘T on macOS ("T" for Theme); ⌘⇧T and ⌥⌘T are already taken.
const THEME_ACCELERATOR = isMac ? 'Cmd+Ctrl+T' : 'Ctrl+Alt+Shift+T';
const send = (cmd, ...args) => () => BrowserWindow.getFocusedWindow()?.webContents.send('command', cmd, ...args);

// ⌥⌘L ("L" for Licence) opens the licence window from anywhere, including the welcome screen.
const LICENCE_ACCELERATOR = 'CmdOrCtrl+Alt+L';

function licenceItems() {
  const licensed = licensing?.status().mode === 'licensed';
  return [
    { label: licensed ? 'Licence…' : 'Enter Licence Key…', accelerator: LICENCE_ACCELERATOR, click: send('licence') },
    ...(licensed ? [] : [{ label: 'Buy GitLanes…', click: send('buy') }]),
  ];
}

function buildMenu() {
  const item = (label, accelerator, cmd, ...args) => ({ label, accelerator, click: send(cmd, ...args) });
  const journal = sessions.get(BrowserWindow.getFocusedWindow()?.webContents.id)?.journal;
  const nextUndo = journal?.undo.top, nextRedo = journal?.redo.top;
  const update = updater.getState();
  const updateItem = update.status === 'ready'
    ? { label: `Restart to Update to ${update.version}`, click: () => updater.install() }
    : { label: 'Check for Updates…', enabled: update.status !== 'checking', click: () => updater.check({ manual: true }) };
  const autoItem = { label: 'Automatically Check for Updates', type: 'checkbox', checked: update.auto !== false, click: (mi) => setAutoUpdate(mi.checked) };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [{ role: 'about' }, updateItem, autoItem, { type: 'separator' }, ...licenceItems(), { type: 'separator' }, item('Settings…', 'CmdOrCtrl+,', 'view', 'config'), { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        item('New Repository…', 'CmdOrCtrl+N', 'init'),
        item('Open Repository…', 'CmdOrCtrl+O', 'open'),
        item('Clone Repository…', 'CmdOrCtrl+Shift+O', 'clone'),
        {
          label: 'Open Recent',
          submenu: readRecent().slice(0, 10).map((rr) => ({ label: rr.name, sublabel: rr.root, click: send('open', rr.root) })),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item(nextUndo ? `Undo ${nextUndo.label}` : 'Undo', 'CmdOrCtrl+Z', 'undo'),
        item(nextRedo ? `Redo ${nextRedo.label}` : 'Redo', 'CmdOrCtrl+Shift+Z', 'redo'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', 'CmdOrCtrl+F', 'search'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Command Menu', 'CmdOrCtrl+K', 'palette'),
        { type: 'separator' },
        item('Map', 'CmdOrCtrl+1', 'view', 'map'),
        item('Commit', 'CmdOrCtrl+2', 'view', 'commit'),
        item('Stashes', 'CmdOrCtrl+3', 'view', 'stashes'),
        item('Snapshots', 'CmdOrCtrl+4', 'view', 'snapshots'),
        item('Reflog', 'CmdOrCtrl+5', 'view', 'reflog'),
        item('Configuration', 'CmdOrCtrl+6', 'view', 'config'),
        item('Worktrees', 'CmdOrCtrl+7', 'view', 'worktrees'),
        { type: 'separator' },
        item('Toggle Sidebar', 'CmdOrCtrl+\\', 'sidebar'),
        item('Show Tags', 'CmdOrCtrl+Alt+T', 'toggle', 'tags'),
        item('Show Remote Branches', 'CmdOrCtrl+Alt+R', 'toggle', 'remotes'),
        item('Show Colour Swatches in Diffs', 'CmdOrCtrl+Alt+C', 'toggle', 'swatches'),
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            ...THEMES.map((mode) => ({ label: THEME_LABELS[mode], type: 'radio', checked: currentTheme() === mode, click: () => setTheme(mode) })),
            { type: 'separator' },
            { label: 'Cycle Theme', accelerator: THEME_ACCELERATOR, click: cycleTheme },
          ],
        },
        { type: 'separator' },
        { role: 'reload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]), { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Repository',
      submenu: [
        item('Fetch All', 'CmdOrCtrl+Shift+F', 'fetch'),
        item('Pull Current Branch', 'CmdOrCtrl+Shift+L', 'pull'),
        item('Push Current Branch', 'CmdOrCtrl+Shift+P', 'push'),
        item('Push All Tags', undefined, 'pushTags'),
        { type: 'separator' },
        item('Stash Changes…', 'CmdOrCtrl+Shift+S', 'stashSave'),
        item('Stash Staged Changes…', 'CmdOrCtrl+Alt+S', 'stashStaged'),
        item('Reset Hard to HEAD…', undefined, 'resetHard'),
        { type: 'separator' },
        item('New Worktree…', 'CmdOrCtrl+Alt+N', 'worktreeAdd'),
        item('Switch Worktree…', 'CmdOrCtrl+Alt+W', 'worktreeSwitch'),
        { type: 'separator' },
        item('Open Submodule…', 'CmdOrCtrl+Alt+B', 'submodules'),
        item('Update Submodules', 'CmdOrCtrl+Alt+U', 'submoduleUpdate'),
        { type: 'separator' },
        item('Git LFS Files…', 'CmdOrCtrl+Alt+F', 'lfs'),
        item('Open in Difftool', 'CmdOrCtrl+Shift+D', 'difftool'),
        item('Resolve Conflicts', 'CmdOrCtrl+Alt+M', 'conflicts'),
        item('Open in Mergetool', 'CmdOrCtrl+Shift+M', 'mergetool'),
        item('File History & Blame…', 'CmdOrCtrl+Shift+H', 'fileHistory'),
        item('Commit Identity…', 'CmdOrCtrl+Alt+I', 'identity'),
        item('Write Commit Message with AI', 'CmdOrCtrl+Alt+G', 'aiMessage'),
        item('AI Commit Messages…', undefined, 'aiSetup'),
        { type: 'separator' },
        item('Open in Finder', 'CmdOrCtrl+Shift+R', 'reveal'),
        item('Open in Terminal', 'CmdOrCtrl+Shift+T', 'terminal'),
        item('Open in Hosting Service', undefined, 'hosting'),
        item('Open Origin in Browser', 'CmdOrCtrl+Shift+G', 'origin'),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lockdown. GitLanes talks to the network only through the git processes it starts; the
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
// "gitlanes-updates" session gets any: the update feed's host.
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

app.on('open-file', (ev, p) => {
  ev.preventDefault();
  if (app.isReady()) createWindow(p); else app.once('ready', () => createWindow(p));
});

app.whenReady().then(() => {
  app.setName('GitLanes');
  lockDownSession(electronSession.defaultSession);
  const saved = readSettings().theme;
  nativeTheme.themeSource = THEMES.includes(saved) ? saved : 'system';
  initLicensing();
  updater.init({
    auto: () => readSettings().autoUpdate !== false,
    feed: pkg.updates?.feed,
    page: pkg.updates?.page,
    devFeed: app.isPackaged ? null : process.env.GITLANES_UPDATE_FEED,
    onChange: (state) => {
      buildMenu();
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update', { ...state, page: updater.page() });
    },
  });
  lockDownSession(electronSession.fromPartition(updater.PARTITION, { cache: false }), updater.allowedOrigins());
  buildMenu();
  app.on('browser-window-focus', () => { buildMenu(); revalidate(); });
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  // pnpm runs workspace scripts inside apps/desktop; resolve relative paths against where the user ran pnpm.
  const repoPath = arg && path.resolve(process.env.INIT_CWD || process.cwd(), arg);
  createWindow(repoPath && fs.existsSync(repoPath) ? repoPath : undefined);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  // Validate the licence at launch, then about daily while running (on focus and hourly ticks);
  // offline is fine, the cached validation carries on.
  licensing.refresh().catch((e) => console.warn('licence check failed', e.message));
  setInterval(revalidate, 60 * 60 * 1000).unref();
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
