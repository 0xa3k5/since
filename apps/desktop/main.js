'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const git = require('./git');
const { Journal, workOps, worktreeOps } = require('./journal');
const { LogStreams } = require('./log-streams');

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
  compare: (s, from, to) => git.compareDiff(s.repo.root, from, to),
  status: (s) => git.getStatus(s.repo.root),
  opState: (s) => git.getOperationState(s.repo.gitDir),
  workingDiff: (s, file, staged) => git.workingDiff(s.repo.root, file, { staged }),
  stashes: (s) => git.getStashes(s.repo.root),
  reflog: (s) => git.getReflog(s.repo.root),
  config: (s) => git.getConfig(s.repo.root),
  remotes: (s) => git.getRemotes(s.repo.root),
  history: (s) => s.journal.list(),
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
  stashSave: (s, message, untracked) => r(s, ['stash', 'push', ...(untracked ? ['-u'] : []), ...(message ? ['-m', message] : [])]),
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
  lockWorktree: (s, dir, reason) => git.lockWorktree(s.repo.root, dir, reason),
  unlockWorktree: (s, dir) => git.unlockWorktree(s.repo.root, dir),
  pruneWorktrees: (s) => git.pruneWorktrees(s.repo.root),
};

// The window showing a repository root, if any.
const windowFor = (root) => [...sessions.values()].find((x) => !x.win.isDestroyed() && git.samePath(x.repo.root, root))?.win;

function session(e) {
  const s = sessions.get(e.sender.id);
  if (!s) throw new Error('No repository open in this window');
  return s;
}

function serializeError(err) {
  return { message: err.message || String(err), stderr: err.stderr || null };
}

ipcMain.handle('git', async (e, method, ...args) => {
  try {
    const s = session(e);
    if (reads[method]) return { ok: await reads[method](s, ...args) };
    const label = args.length && args[args.length - 1] && args[args.length - 1].__label;
    const realArgs = label ? args.slice(0, -1) : args;
    s.busy++;
    try {
      if (refMutations[method]) return { ok: await s.journal.record(label || method, method, () => refMutations[method](s, ...realArgs)) };
      if (workOps[method]) return { ok: await s.journal.runWork(method, label || method, realArgs) };
      if (worktreeOps[method]) {
        if (method === 'removeWorktree' && ![undefined, s.win].includes(windowFor(realArgs[0]))) throw new git.GitError('That worktree is open in another window. Close the window first.');
        return { ok: await s.journal.runWorktree(method, label || method, realArgs) };
      }
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

ipcMain.handle('app:recent', () => readRecent());
ipcMain.handle('app:repo', (e) => sessions.get(e.sender.id)?.repo || null);
ipcMain.handle('app:platform', () => process.platform);
ipcMain.handle('app:theme', () => currentTheme());
ipcMain.handle('app:set-theme', (_e, mode) => setTheme(mode));
ipcMain.handle('app:cycle-theme', () => cycleTheme());

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

ipcMain.handle('app:open', async (e, dir) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
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

ipcMain.handle('app:init', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a folder for the new repository' });
  if (res.canceled) return { ok: null };
  try { await git.initRepo(res.filePaths[0]); return { ok: await bindRepo(win, res.filePaths[0]) }; } catch (err) { return { error: serializeError(err) }; }
});

ipcMain.handle('app:clone', async (e, url) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const name = (url.split('/').pop() || 'repo').replace(/\.git$/, '');
  const res = await dialog.showSaveDialog(win, { defaultPath: name, buttonLabel: 'Clone', message: 'Clone repository to…' });
  if (res.canceled) return { ok: null };
  try {
    await git.cloneRepo(url, res.filePath, (line) => win.webContents.send('clone:progress', line));
    return { ok: await bindRepo(win, res.filePath) };
  } catch (err) { return { error: serializeError(err) }; }
});

ipcMain.handle('app:close-repo', (e) => {
  sessions.get(e.sender.id)?.dispose();
  sessions.delete(e.sender.id);
  BrowserWindow.fromWebContents(e.sender).setTitle('GitLanes');
  buildMenu();
});

// `rel` is relative to the repository root, or absolute (another worktree's folder).
ipcMain.handle('app:reveal', (e, rel) => {
  const s = session(e);
  if (rel) shell.showItemInFolder(path.resolve(s.repo.root, rel));
  else shell.openPath(s.repo.root);
});
ipcMain.handle('app:terminal', (e, dir) => {
  const target = path.resolve(session(e).repo.root, dir || '');
  if (isMac) spawn('open', ['-a', 'Terminal', target], { detached: true });
  else shell.openPath(target);
});
ipcMain.handle('app:open-file', (e, rel) => shell.openPath(path.join(session(e).repo.root, rel)));
ipcMain.handle('app:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('app:copy', (_e, text) => clipboard.writeText(text));
ipcMain.handle('app:confirm', async (e, { message, detail, ok = 'OK', destructive }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showMessageBox(win, { type: destructive ? 'warning' : 'question', message, detail, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1 });
  return res.response === 0;
});
ipcMain.handle('app:new-window', () => { createWindow(); });
// Open a repository (e.g. another worktree) in a new window, or focus the window already showing it.
ipcMain.handle('app:open-window', (_e, dir) => {
  const win = windowFor(dir);
  if (win) win.focus(); else createWindow(dir);
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
      spellcheck: false,
    },
  });
  bench?.attach(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), repoDir ? { query: { repo: repoDir } } : undefined);
  win.once('ready-to-show', () => win.show());
  const id = win.webContents.id;
  win.on('closed', () => { sessions.get(id)?.dispose(); sessions.delete(id); buildMenu(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
  return win;
}

// ⌃⌘T on macOS ("T" for Theme); ⌘⇧T and ⌥⌘T are already taken.
const THEME_ACCELERATOR = isMac ? 'Cmd+Ctrl+T' : 'Ctrl+Alt+Shift+T';
const send = (cmd, ...args) => () => BrowserWindow.getFocusedWindow()?.webContents.send('command', cmd, ...args);

function buildMenu() {
  const item = (label, accelerator, cmd, ...args) => ({ label, accelerator, click: send(cmd, ...args) });
  const journal = sessions.get(BrowserWindow.getFocusedWindow()?.webContents.id)?.journal;
  const nextUndo = journal?.undo.at(-1), nextRedo = journal?.redo.at(-1);
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, item('Settings…', 'CmdOrCtrl+,', 'view', 'config'), { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
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
        { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
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
        item('Reset Hard to HEAD…', undefined, 'resetHard'),
        { type: 'separator' },
        item('New Worktree…', 'CmdOrCtrl+Alt+N', 'worktreeAdd'),
        item('Switch Worktree…', 'CmdOrCtrl+Alt+W', 'worktreeSwitch'),
        { type: 'separator' },
        item('Open in Finder', 'CmdOrCtrl+Shift+R', 'reveal'),
        item('Open in Terminal', 'CmdOrCtrl+Shift+T', 'terminal'),
        item('Open in Hosting Service', undefined, 'hosting'),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('open-file', (ev, p) => {
  ev.preventDefault();
  if (app.isReady()) createWindow(p); else app.once('ready', () => createWindow(p));
});

app.whenReady().then(() => {
  app.setName('GitLanes');
  const saved = readSettings().theme;
  nativeTheme.themeSource = THEMES.includes(saved) ? saved : 'system';
  buildMenu();
  app.on('browser-window-focus', buildMenu);
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  // npm runs workspace scripts inside apps/desktop; resolve relative paths against where the user ran npm.
  const repoPath = arg && path.resolve(process.env.INIT_CWD || process.cwd(), arg);
  createWindow(repoPath && fs.existsSync(repoPath) ? repoPath : undefined);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
