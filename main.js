'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const git = require('./git');

const isMac = process.platform === 'darwin';
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
// Per-window repository session: watcher + undo/redo history

class RepoSession {
  constructor(win, repo) {
    this.win = win;
    this.repo = repo;
    this.undo = [];
    this.redo = [];
    this.watchers = [];
    this.pending = { refs: false, workdir: false };
    this.timer = null;
    this.busy = 0;
    this.historyFile = path.join(repo.gitDir, 'gitlanes-history.json');
    const legacy = path.join(repo.gitDir, 'gitup-electron-history.json');
    try { if (!fs.existsSync(this.historyFile) && fs.existsSync(legacy)) fs.renameSync(legacy, this.historyFile); } catch { /* keep going */ }
    try {
      const saved = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      this.undo = saved.undo || [];
      this.redo = saved.redo || [];
    } catch { /* no history yet */ }
    this.watch();
  }

  persist() {
    try { fs.writeFileSync(this.historyFile, JSON.stringify({ undo: this.undo.slice(-200), redo: this.redo.slice(-200) })); } catch { /* read-only repo */ }
  }

  watch() {
    const { root, gitDir } = this.repo;
    const onEvent = (base) => (_type, file) => {
      if (!file) { this.pending.refs = this.pending.workdir = true; return this.schedule(); }
      const abs = path.join(base, file.toString());
      if (abs.startsWith(gitDir + path.sep) || abs === gitDir) {
        const rel = path.relative(gitDir, abs);
        if (rel.startsWith('objects') || rel.endsWith('.lock') || rel.startsWith('gitlanes') || rel.startsWith('gitup-electron') || rel.startsWith('logs')) return;
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
    if (!gitDir.startsWith(root + path.sep)) add(gitDir);
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

  dispose() {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

// ---------------------------------------------------------------------------
// Git API exposed to the renderer. Mutations that move refs are recorded
// as undoable snapshots, mirroring GitUp's unlimited undo/redo.

const reads = {
  refs: (s) => git.getRefs(s.repo.root),
  log: (s, opts) => git.getLog(s.repo.root, opts),
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
  history: (s) => ({ undo: s.undo.map(strip), redo: s.redo.map(strip) }),
};
const strip = (e, i) => ({ id: e.id, label: e.label, time: e.time, index: i });

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
  resetHard: (s, sha) => r(s, ['reset', '--hard', sha || 'HEAD']),
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
  stashApply: (s, ref, pop) => r(s, ['stash', pop ? 'pop' : 'apply', '--index', ref]),
};

// Mutations that only touch the index / working copy / remotes.
const plainMutations = {
  stageFiles: (s, paths) => r(s, ['add', '-A', '--', ...paths]),
  unstageFiles: async (s, paths) => {
    const hasHead = await r(s, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] });
    return hasHead.trim() ? r(s, ['reset', '-q', 'HEAD', '--', ...paths]) : r(s, ['rm', '--cached', '-q', '-r', '--', ...paths]);
  },
  discardFiles: async (s, files) => {
    const tracked = files.filter((f) => f.status !== '?').map((f) => f.path);
    const untracked = files.filter((f) => f.status === '?').map((f) => f.path);
    if (tracked.length) await r(s, ['checkout', '--', ...tracked]);
    if (untracked.length) await r(s, ['clean', '-f', '-q', '--', ...untracked]);
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
  discardLines: async (s, file, selected) => {
    const d = await git.workingDiff(s.repo.root, file, { staged: false });
    const p = d && git.buildPartialPatch(d, selected, 'reverse');
    if (p) await git.applyPatch(s.repo.root, p, { reverse: true });
  },
  stashSave: (s, message, untracked) => r(s, ['stash', 'push', ...(untracked ? ['-u'] : []), ...(message ? ['-m', message] : [])]),
  stashDrop: (s, ref) => r(s, ['stash', 'drop', ref]),
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
  chooseSide: async (s, p, side) => { await r(s, ['checkout', `--${side}`, '--', p]); await r(s, ['add', '--', p]); },
};

let nextId = Date.now();
async function withSnapshot(s, label, fn, method) {
  const before = await git.captureRefState(s.repo.root);
  try {
    return await fn();
  } finally {
    const after = await git.captureRefState(s.repo.root).catch(() => null);
    if (after && JSON.stringify(after) !== JSON.stringify(before)) {
      s.undo.push({ id: ++nextId, label, method, time: Date.now(), before, after });
      s.redo = [];
      s.persist();
    }
  }
}

async function undoRedo(s, dir) {
  const from = dir === 'undo' ? s.undo : s.redo;
  const to = dir === 'undo' ? s.redo : s.undo;
  const entry = from[from.length - 1];
  if (!entry) return null;
  await git.restoreRefState(s.repo.root, dir === 'undo' ? entry.before : entry.after, { soft: entry.method === 'createCommit' });
  from.pop();
  to.push(entry);
  s.persist();
  return entry.label;
}

async function restoreHistory(s, id) {
  const entry = s.undo.find((e) => e.id === id) || s.redo.find((e) => e.id === id);
  if (!entry) throw new git.GitError('Snapshot not found');
  await withSnapshot(s, `Restore “${entry.label}”`, () => git.restoreRefState(s.repo.root, entry.before));
}

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
      if (refMutations[method]) return { ok: await withSnapshot(s, label || method, () => refMutations[method](s, ...realArgs), method) };
      if (plainMutations[method]) return { ok: await plainMutations[method](s, ...realArgs) };
      if (method === 'undo' || method === 'redo') return { ok: await undoRedo(s, method) };
      if (method === 'restoreHistory') return { ok: await restoreHistory(s, ...realArgs) };
    } finally {
      s.busy--;
      s.pending.refs = s.pending.workdir = true;
      s.schedule();
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

ipcMain.handle('app:reveal', (e, rel) => {
  const s = session(e);
  if (rel) shell.showItemInFolder(path.join(s.repo.root, rel));
  else shell.openPath(s.repo.root);
});
ipcMain.handle('app:terminal', (e) => {
  const s = session(e);
  if (isMac) spawn('open', ['-a', 'Terminal', s.repo.root], { detached: true });
  else shell.openPath(s.repo.root);
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

// ---------------------------------------------------------------------------
// Windows & menu

function createWindow(repoDir) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#fcfcfd',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay: isMac ? undefined : { color: '#0b0b0d', symbolColor: '#8a8f98', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), repoDir ? { query: { repo: repoDir } } : undefined);
  win.once('ready-to-show', () => win.show());
  const id = win.webContents.id;
  win.on('closed', () => { sessions.get(id)?.dispose(); sessions.delete(id); buildMenu(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
  return win;
}

const send = (cmd, ...args) => () => BrowserWindow.getFocusedWindow()?.webContents.send('command', cmd, ...args);

function buildMenu() {
  const item = (label, accelerator, cmd, ...args) => ({ label, accelerator, click: send(cmd, ...args) });
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
        item('Undo', 'CmdOrCtrl+Z', 'undo'),
        item('Redo', 'CmdOrCtrl+Shift+Z', 'redo'),
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
        { type: 'separator' },
        item('Toggle Sidebar', 'CmdOrCtrl+\\', 'sidebar'),
        item('Show Tags', 'CmdOrCtrl+Alt+T', 'toggle', 'tags'),
        item('Show Remote Branches', 'CmdOrCtrl+Alt+R', 'toggle', 'remotes'),
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
  buildMenu();
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  createWindow(arg && fs.existsSync(arg) ? path.resolve(arg) : undefined);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
