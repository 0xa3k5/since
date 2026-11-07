'use strict';
// Per-window repository sessions, and the per-window state other modules hand each other.
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git/index.ts');
const { Journal } = require('./journal');
const { LogStreams } = require('./log-streams');

const sessions = new Map(); // webContents.id -> RepoSession
// Bumped on every repository change any window sees (watcher events, our own git commands): a lanes
// run started before it is never shared with a later caller (git.sharedLanes).
let repoGen = 0;
const currentRepoGen = () => repoGen;

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

// The tab showing a repository root, if any.
const windowFor = (root) => [...sessions.values()].find((x) => !x.win.isDestroyed() && git.samePath(x.repo.root, root))?.win;
// Which worktrees are open in another window changes when a window opens, closes or switches
// worktree: every window refreshes, not only the one whose refs moved.
const notifyWindows = () => { for (const [, x] of sessions) if (!x.win.isDestroyed()) { x.pending.refs = true; x.schedule(); } };

function session(e) {
  const s = sessions.get(e.sender.id);
  if (!s) throw new Error('No repository open in this window');
  return s;
}

// The last folder each window was asked to open that isn't a repository: the only folder
// app:init-here will run `git init` in.
const notRepoDirs = new Map();

// Hand a step to the window showing another worktree of this repository (AK-581), opening one if
// none does: remove a worktree from there, or merge and tidy into the base checked out there. The
// window takes it (app:take-handoff) when the command arrives, or once a new window has opened.
const handoffs = new Map(); // webContents.id -> handoff

module.exports = { windowFor, sessions, session, currentRepoGen, RepoSession, notifyWindows, notRepoDirs, handoffs };
