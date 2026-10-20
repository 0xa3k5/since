'use strict';
// Undo journal: unlimited undo/redo for every recorded operation.
// Each entry stores the refs before and after an operation. Operations that
// destroy uncommitted work also store an exact snapshot of the paths they touch
// (and the stash they drop), so undo and redo restore those too. Every object
// an entry needs is pinned under refs/gitlanes/undo/<worktree>/<key> until the
// entry leaves the journal (only redo entries ever do), so `git gc` can't
// collect it. Each worktree has its own journal, so each gets its own pin
// namespace (`main`, or `wt/<admin dir name>`) and only ever prunes that one.
//
// History has no cap. Only the newest entries of each stack are kept in memory
// and in gitlanes-history.json; older ones are archived to page files under
// gitlanes-history/ and read back only when undo or redo reaches them, so
// memory and the cost of each save stay flat. Archiving also compacts a page's
// pins into one set under refs/gitlanes/undo/<worktree>/p<n>.

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');

const PAGE = 100; // entries per archived page; up to 2 × PAGE stay in memory per stack
let nextId = Date.now();

// Ref states compare by refs and HEAD only: the branch config they carry (for redo) isn't a move.
const bare = (s) => { if (!s) return s; const { config, ...rest } = s; return rest; };
const same = (a, b) => JSON.stringify(bare(a)) === JSON.stringify(bare(b));

// Stash in `cwd` (git.stashPush options) and return the new stash's sha, or null when there was
// nothing to stash. The stash list is shared by every worktree; `stashRef` finds a stash in it.
const stashTop = (cwd) => git.run(cwd, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowCodes: [0, 1] }).then((o) => o.trim());
async function newStash(cwd, opts) {
  const prev = await stashTop(cwd);
  await git.stashPush(cwd, opts);
  const sha = await stashTop(cwd);
  return sha && sha !== prev ? sha : null;
}
async function stashRef(cwd, sha) {
  const i = (await git.getStashes(cwd)).findIndex((x) => x.sha === sha);
  if (i === -1) throw new git.GitError('That stash no longer exists.');
  return `stash@{${i}}`;
}

// What restoring ref state `target` over `current` would change: where HEAD
// points (a branch name, or a commit when detached), then each branch and tag.
// [{ ref, kind: 'head' | 'move' | 'create' | 'delete', from, to }]
function refChanges(current, target) {
  const out = [];
  const detachedMove = !target.head && !current.head && target.headOid && target.headOid !== current.headOid;
  if ((target.head && target.head !== current.head) || (!target.head && current.head) || detachedMove) {
    out.push({ ref: 'HEAD', kind: 'head', from: current.head || current.headOid, to: target.head || target.headOid });
  }
  const names = [...new Set([...Object.keys(target.refs), ...Object.keys(current.refs)])].sort();
  for (const ref of names) {
    const from = current.refs[ref] ?? null, to = target.refs[ref] ?? null;
    if (from === to) continue;
    out.push({ ref, kind: !from ? 'create' : !to ? 'delete' : 'move', from, to });
  }
  return out;
}

function pins(entry) {
  const objects = [];
  const { before, after } = entry;
  if (!same(before, after)) {
    for (const n of new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])) {
      if (before.refs[n] !== after.refs[n]) objects.push(before.refs[n], after.refs[n]);
    }
    objects.push(before.headOid, after.headOid);
  }
  if (entry.stash) objects.push(entry.stash.sha);
  if (entry.autostash) objects.push(entry.autostash.sha);
  if (entry.discarded) objects.push(entry.discarded.sha);
  if (entry.resolved) objects.push(entry.resolved.sha);
  if (entry.worktree) objects.push(entry.worktree.head, entry.worktree.stash, entry.worktree.saved?.sha);
  for (const w of entry.cleanup || []) objects.push(w.head, w.saved?.sha);
  for (const [, oid, sym] of entry.remote?.saved?.refs || []) if (!sym) objects.push(oid);
  return { blobs: [...git.snapshotBlobs(entry.work?.before), ...git.snapshotBlobs(entry.work?.after)], objects };
}

// Adding and removing worktrees. Removal is only allowed on a clean worktree (its changes can
// be stashed first), so its branch (or commit, when detached) and that stash are all undo needs.
const worktreeOps = {
  addWorktree: { op: 'add', run: async (cwd, opts) => git.findWorktree(cwd, await git.addWorktree(cwd, opts)) },
  removeWorktree: { op: 'remove', run: git.removeWorktree },
};

// Operations that destroy uncommitted work or stashes, or move work into a new
// stash, with the paths each may change; the journal snapshots those paths (and
// a dropped or added stash) around them.
const workOps = {
  discardFiles: { run: git.discardFiles, paths: (cwd, files) => files.map((f) => f.path), mustChange: true },
  discardLines: { run: git.discardLines, paths: (cwd, file) => [file.path], mustChange: true },
  resetHard: { run: git.resetHard, paths: (cwd, sha) => git.resetHardPaths(cwd, sha || 'HEAD') },
  chooseSide: { run: git.chooseSide, paths: (cwd, p) => [p] },
  resolveConflict: { run: git.resolveConflict, paths: (cwd, p) => [p] },
  stashApply: { run: git.stashApply, paths: git.stashPaths, stash: true },
  stashDrop: { run: git.stashDrop, stash: true },
  stashSave: { run: (cwd, message, untracked, opts = {}) => git.stashPush(cwd, { message, untracked, ...opts }), paths: git.stashPushPaths, stash: true },
  // Unified changes: stage or unstage a file, hunk or lines. Only the index changes.
  stageChanges: { run: (cwd, file, sel) => git.setStaged(cwd, file, sel, true), paths: git.changePaths, indexOnly: true },
  unstageChanges: { run: (cwd, file, sel) => git.setStaged(cwd, file, sel, false), paths: git.changePaths, indexOnly: true },
  stashLines: { run: git.stashLines, paths: (cwd, file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])], stash: true },
};

// Managing remotes (git.changeRemote): the git op for each journal method.
const remoteOps = { addRemote: 'add', setRemoteUrl: 'url', renameRemote: 'rename', removeRemote: 'remove' };

// Lane steps (runLane) that can also remove a worktree.
const laneOps = new Set(['mergeLane', 'tidyLane']);

// Git refusing to move the working copy over uncommitted changes.
const DIRTY = /not uptodate|would be overwritten|commit your changes or stash them|you have unstaged changes|your index contains uncommitted changes/i;

const listPaths = (paths) => (paths.length > 3 ? `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more` : paths.join(', '));
const shortRef = (r) => r.replace(/^refs\/(heads|tags)\//, '');

// "Can't undo X: branches or HEAD have moved since", with what moved (code 'moved', `moved`:
// [{ ref, from, to }], short names and SHAs, null when created or deleted). The renderer
// offers "Undo anyway" (step with `force`).
function movedError(fail, expected, now) {
  const short = (v) => (v ? (/^[0-9a-f]{40,64}$/.test(v) ? v.slice(0, 7) : shortRef(v)) : null);
  const moved = refChanges(expected, now).map((c) => ({ ref: shortRef(c.ref), from: short(c.from), to: short(c.to) }));
  return Object.assign(fail(`${listPaths(moved.map((m) => m.ref))} moved since.`), { code: 'moved', moved });
}

// One side of the journal. `hot` holds the newest entries (top of the stack
// last); `pages` describes archived pages, oldest first.
class Stack {
  constructor({ hot = [], pages = [] } = {}) {
    this.hot = hot;
    this.pages = pages;
  }

  get length() { return this.pages.reduce((n, p) => n + p.count, 0) + this.hot.length; }
  get top() { return this.hot.at(-1); }
  // Pin keys still needed by this stack.
  pinKeys() { return [...this.pages.flatMap((p) => p.pins), ...this.hot.map((e) => e.pin || e.id)]; }
}

const writeAtomic = (file, data) => {
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
};

class Journal {
  constructor(repo, { pageSize = PAGE } = {}) {
    this.root = repo.root;
    this.gitDir = repo.gitDir;
    this.file = path.join(repo.gitDir, 'gitlanes-history.json');
    this.dir = path.join(repo.gitDir, 'gitlanes-history');
    this.ns = repo.gitDir === (repo.commonDir || repo.gitDir) ? 'main' : `wt/${path.basename(repo.gitDir)}`;
    this.pageSize = pageSize;
    this.nextPage = 1;
    this.undo = new Stack();
    this.redo = new Stack();
    this.legacyPins = false; // pins still at the top level, from before namespaces
    this.damaged = false; // the index was unreadable: keep every page and pin
    this.queue = Promise.resolve();
    let text = null;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { /* no history yet */ }
    if (text != null) try {
      const saved = JSON.parse(text);
      this.legacyPins = saved.legacyPins !== false;
      if (saved.version === 2) {
        this.nextPage = saved.nextPage;
        this.undo = new Stack(saved.undo);
        this.redo = new Stack(saved.redo);
      } else {
        // The first format: two flat arrays. They are archived on the next save.
        this.undo = new Stack({ hot: saved.undo || [] });
        this.redo = new Stack({ hot: saved.redo || [] });
      }
    } catch (err) {
      // Start empty but leave the old index, its pages and pins untouched.
      console.warn('history index unreadable', err.message);
      try { fs.copyFileSync(this.file, `${this.file}.bad`); } catch { /* best effort */ }
      this.undo = new Stack();
      this.redo = new Stack();
      this.damaged = true;
    }
    for (const s of [this.undo, this.redo]) {
      for (const e of s.hot) nextId = Math.max(nextId, e.id);
      for (const p of s.pages) nextId = Math.max(nextId, p.last);
    }
    if (!this.damaged) this.removeOrphanPages();
  }

  // Run journal mutations one at a time, so overlapping steps (a held ⌘Z) can't
  // pop the same entry or archive the same page twice.
  lock(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  pin(key, objs) { return git.pinUndo(this.root, `${this.ns}/${key}`, objs); }

  // Newest `limit` entries of each stack, plus the full sizes.
  list(limit = 100) {
    const strip = (e) => ({ id: e.id, label: e.label, time: e.time, movesRefs: (!e.worktree || laneOps.has(e.method)) && !same(e.before, e.after) });
    const newest = (s) => {
      let out = s.hot.slice(-limit);
      for (let i = s.pages.length - 1; i >= 0 && out.length < limit; i--) out = [...this.readPage(s.pages[i]).slice(out.length - limit), ...out];
      return out.map(strip);
    };
    return { undo: newest(this.undo), redo: newest(this.redo), undoCount: this.undo.length, redoCount: this.redo.length };
  }

  persist() {
    const data = JSON.stringify({ version: 2, legacyPins: this.legacyPins, nextPage: this.nextPage, undo: this.undo, redo: this.redo });
    try { writeAtomic(this.file, data); return true; } catch { return false; /* read-only repo */ }
  }

  // Drop the pins of entries that have left the journal (run once per session).
  prune() {
    return this.lock(() => this.prunePins()).catch((err) => console.warn('prune failed', err.message));
  }

  async prunePins() {
    if (this.damaged) return;
    const keys = [...this.undo.pinKeys(), ...this.redo.pinKeys()];
    if (this.legacyPins) {
      await git.moveUndoPins(this.root, this.ns, keys);
      this.legacyPins = false;
      if (!this.persist()) return;
    }
    await git.pruneUndoPins(this.root, this.ns, keys);
  }

  pagePath(page) { return path.join(this.dir, `${page.n}.json`); }

  readPage(page) {
    try { return JSON.parse(fs.readFileSync(this.pagePath(page), 'utf8')); } catch (err) {
      console.warn('history page unreadable', page.n, err.message);
      return [];
    }
  }

  removePages(pages) {
    for (const p of pages) fs.rmSync(this.pagePath(p), { force: true });
  }

  // Page files left behind by a save that never completed.
  removeOrphanPages() {
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    const live = new Set([...this.undo.pages, ...this.redo.pages].map((p) => `${p.n}.json`));
    for (const f of files) if (!live.has(f)) fs.rmSync(path.join(this.dir, f), { force: true });
  }

  // Move the oldest hot entries of `stack` into page files until at most
  // 2 × pageSize remain. Each page's objects are pinned under one key before
  // the page is written, so the entries stay restorable throughout. Returns
  // whether anything was archived (the old pins are then pruned).
  async archive(stack) {
    let moved = false;
    while (stack.hot.length > 2 * this.pageSize) {
      const entries = stack.hot.slice(0, this.pageSize);
      const n = this.nextPage;
      const key = `p${n}`;
      try {
        const objs = { blobs: [], objects: [] };
        for (const e of entries) {
          const p = pins(e);
          objs.blobs.push(...p.blobs);
          objs.objects.push(...p.objects);
        }
        await this.pin(key, objs);
        fs.mkdirSync(this.dir, { recursive: true });
        writeAtomic(path.join(this.dir, `${n}.json`), JSON.stringify(entries.map((e) => ({ ...e, pin: key }))));
      } catch (err) {
        console.warn('archive failed', err.message);
        break;
      }
      const ids = entries.map((e) => e.id);
      stack.pages.push({ n, count: entries.length, first: Math.min(...ids), last: Math.max(...ids), pins: [key] });
      stack.hot = stack.hot.slice(this.pageSize);
      this.nextPage++;
      moved = true;
    }
    return moved;
  }

  // Read the newest page back once the hot entries run out. Returns the pages
  // read, whose files are removed after the next save.
  unarchive(stack) {
    const read = [];
    while (!stack.hot.length && stack.pages.length) {
      read.push(stack.pages.pop());
      stack.hot = this.readPage(read.at(-1));
    }
    return read;
  }

  // Find an entry anywhere in the journal, reading archived pages if needed.
  find(id) {
    for (const s of [this.undo, this.redo]) {
      const hit = s.hot.find((e) => e.id === id);
      if (hit) return hit;
      for (const p of s.pages) {
        if (id < p.first || id > p.last) continue;
        const e = this.readPage(p).find((x) => x.id === id);
        if (e) return e;
      }
    }
    return null;
  }

  // Run `fn` and record it as one undoable step. `paths` (returns the paths fn
  // may change) turns on work snapshots; `stash` records a stash that fn drops or adds.
  // If the snapshot can't be saved, fn never runs.
  record(label, method, fn, opts) {
    return this.lock(() => this.recordNow(label, method, fn, opts));
  }

  async recordNow(label, method, fn, { paths, stash = false, indexOnly = false, resolved = null } = {}) {
    const cwd = this.root;
    const id = ++nextId;
    const before = await git.captureRefState(cwd);
    // A step taken while a rebase, cherry-pick or revert is stopped on a conflict.
    const midSequence = !before.head && !!(await git.getOperationState(this.gitDir));
    let workBefore = null, stashesBefore = null;
    try {
      if (paths) {
        workBefore = await git.snapshotWork(cwd, await paths(), { indexOnly });
        await this.pin(id, { blobs: git.snapshotBlobs(workBefore) });
      }
      if (stash) stashesBefore = await git.getStashes(cwd);
    } catch (err) {
      await this.pin(id).catch(() => {});
      const why = `${err.stderr || ''}\n${err.message || ''}`.split('\n').map((l) => l.replace(/^(fatal|error): /, '').trim()).filter(Boolean).pop();
      throw new git.GitError(`Nothing was changed: the undo snapshot could not be saved${why ? ` (${why.replace(/\.$/, '')})` : ''}.`);
    }
    try {
      return await fn();
    } finally {
      // Record whatever changed, even if fn failed part-way.
      await this.finish({ id, label, method, before, workBefore, stashesBefore, midSequence, resolved }).catch((err) => console.warn('journal failed', err.message));
    }
  }

  // Run one of `workOps` as an undoable step.
  // A discard that changed nothing fails, so the app never reports it as done.
  runWork(method, label, args) {
    const op = workOps[method];
    const cwd = this.root;
    return this.lock(async () => {
      const top = this.undo.top;
      const res = await this.recordNow(label, method, () => op.run(cwd, ...args), { paths: op.paths && (() => op.paths(cwd, ...args)), stash: op.stash, indexOnly: op.indexOnly });
      if (op.mustChange && this.undo.top === top) throw new git.GitError('Nothing changed.');
      return res;
    });
  }

  // Stash the changes that block switching to `branch`, then switch, as one undoable step.
  // Undo switches back and pops that stash; redo stashes again and switches. If the switch
  // still fails, the stash is popped right away and nothing is recorded.
  autostash(label, branch, message, untracked) {
    return this.lock(() => this.switchNow(label, 'autostashCheckout', branch, { stash: { message, untracked } }));
  }

  // Switch to `branch`, then delete the branch that was checked out, as one undoable step.
  // `stash` ({ message, untracked }) stashes uncommitted changes first. Undo brings the branch
  // (and its upstream config) back, checks it out and pops the stash; redo does it all again.
  switchDelete(label, branch, stash) {
    return this.lock(() => this.switchNow(label, 'switchDelete', branch, { stash, del: true }));
  }

  // Switch to `branch`, then merge and tidy the branch that was checked out (git.mergeLane onto
  // `merge.base` with `merge.message`), as one undoable step. `stash` as for switchDelete.
  switchMerge(label, branch, merge, stash) {
    return this.lock(() => this.switchNow(label, 'switchMerge', branch, { stash, del: true, merge }));
  }

  // Switch to `branch`, then rewrite a commit on it (git.rewrite: `rw` is { op, sha, extra }), as
  // one undoable step. `stash` as for switchDelete. Undo puts the branch back where it was, switches
  // back and pops the stash; redo does it all again. If the rewrite fails, nothing is kept.
  switchRewrite(label, branch, rw, stash) {
    return this.lock(() => this.switchNow(label, 'switchRewrite', branch, { stash, rewrite: rw }));
  }

  async switchNow(label, method, branch, { stash, del = false, merge = null, rewrite = null }) {
    const cwd = this.root;
    const id = ++nextId;
    const before = await git.captureRefState(cwd);
    const from = before.head?.replace(/^refs\/heads\//, '') || null;
    if (del && !from) throw new git.GitError('HEAD is detached: there is no branch to delete.');
    if (del && from === branch) throw new git.GitError(`${branch} is the branch being deleted. Pick another branch.`);
    if (merge) {
      if (merge.branch !== from) throw new git.GitError(`${merge.branch} is no longer checked out here.`);
      // Check everything the merge needs before anything changes.
      const plan = await git.mergeLanePlan(cwd, from, merge.base);
      if (plan.blocker) throw new git.GitError(plan.blocker);
      if (plan.commits.length && plan.mergeBlocker) throw new git.GitError(plan.mergeBlocker);
      if (plan.commits.length && !String(merge.message || '').trim()) throw new git.GitError('The commit message is empty.');
    }
    if (rewrite) {
      if (from === branch) throw new git.GitError(`${branch} is already checked out.`);
      await git.rewriteRange(cwd, rewrite.op, rewrite.sha, branch);
    }
    const env = { GIT_OPTIONAL_LOCKS: '1' };
    let sha = null, made = false;
    if (stash) {
      const prev = await stashTop(cwd);
      await git.stashPush(cwd, { message: stash.message, untracked: stash.untracked });
      sha = await stashTop(cwd);
      made = !!sha && sha !== prev;
    }
    try {
      await git.run(cwd, ['checkout', branch], { env });
    } catch (err) {
      if (made) await git.stashApply(cwd, 'stash@{0}', true).catch(() => {});
      throw err;
    }
    const autostash = made ? { sha, message: stash.message, untracked: !!stash.untracked, branch: del ? null : from } : null;
    if (rewrite) {
      try {
        await git.rewrite(cwd, rewrite.op, rewrite.sha, rewrite.extra || {});
      } catch (err) {
        // Put everything back as it was: no half-done rebase on a branch the user didn't pick.
        if (await git.getOperationState(this.gitDir)) await git.run(cwd, ['rebase', '--abort'], { env }).catch(() => {});
        await git.run(cwd, ['checkout', before.head ? from : before.headOid], { env }).catch(() => {});
        if (made) await git.stashApply(cwd, 'stash@{0}', true).catch(() => {});
        throw err;
      }
      await this.finish({ id, label, method, before, autostash });
      return autostash;
    }
    try {
      if (merge) await git.mergeLane(cwd, { branch: from, base: merge.base, message: merge.message });
      else if (del) await git.run(cwd, ['branch', '-D', from], { env });
    } finally {
      // Record the switch even if the delete failed, so it can be undone.
      await this.finish({ id, label, method, before, autostash }).catch((err) => console.warn('journal failed', err.message));
    }
    return autostash;
  }

  // Check out `branch` here while worktree `dir` has it checked out: detach HEAD there, then run
  // `args` here (default `checkout <branch>`), as one undoable step. Undo switches back here and
  // re-attaches the branch there; redo detaches it again and switches. Refused (git.freeBlocker)
  // when that worktree has changes or an operation in progress.
  freeCheckout(label, branch, dir, args = ['checkout', branch]) {
    return this.lock(async () => {
      const cwd = this.root;
      const id = ++nextId;
      const wt = (await git.getWorktrees(cwd)).find((w) => !w.current && git.samePath(w.path, dir));
      if (!wt || wt.branch !== branch) throw new git.GitError(`${branch} isn’t checked out in that worktree any more.`);
      const why = await git.freeBlocker(wt);
      if (why) throw new git.GitError(`Can’t free ${branch} in “${wt.name}”. ${why}`);
      const before = await git.captureRefState(cwd);
      const env = { GIT_OPTIONAL_LOCKS: '1' };
      await git.run(wt.path, ['checkout', '-q', '--detach'], { env });
      try {
        await git.run(cwd, args, { env });
      } catch (err) {
        await git.run(wt.path, ['checkout', '-q', branch], { env }).catch(() => {});
        throw err;
      }
      await this.finish({ id, label, method: 'freeCheckout', before, freed: { path: wt.path, branch } });
      return true;
    });
  }

  // Check out `branch` here while worktree `dir` has it checked out with uncommitted changes, and
  // bring those changes along: stash them there, detach HEAD there, check out `branch` here and pop
  // that stash here, as one undoable step. `stash` ({ message, untracked }) first stashes this
  // worktree's own changes, kept as a stash (as autostash does). If popping conflicts, the step is
  // still recorded and their stash kept; the result says `conflicts`. If git refuses to pop (the
  // changes overlap ones here) or anything else fails, both worktrees go back as they were. Undo
  // moves the changes here back there, re-attaches the branch there, switches back here and pops
  // this worktree's own stash; redo moves them again.
  moveCheckout(label, branch, dir, stash) {
    return this.lock(async () => {
      const cwd = this.root;
      const id = ++nextId;
      const wt = (await git.getWorktrees(cwd)).find((w) => !w.current && git.samePath(w.path, dir));
      if (!wt || wt.branch !== branch) throw new git.GitError(`${branch} isn’t checked out in that worktree any more.`);
      const { blocker } = await git.worktreeHold(wt);
      if (blocker) throw new git.GitError(`Can’t free ${branch} in “${wt.name}”. ${blocker}`);
      const before = await git.captureRefState(cwd);
      const moved = { path: wt.path, name: wt.name, branch, stash: stash || null, mine: null, theirs: null };
      await this.moveNow(moved, before.head?.replace(/^refs\/heads\//, '') || before.headOid);
      await this.finish({ id, label, method: 'moveCheckout', before, moved });
      return { conflicts: !!moved.theirs };
    });
  }

  // Do (or redo) a moveCheckout. `from` is what is checked out here, for the stash messages. Sets
  // `m.mine` (this worktree's stash) and `m.theirs` (their stash, kept only when popping conflicted).
  async moveNow(m, from) {
    const cwd = this.root;
    const env = { GIT_OPTIONAL_LOCKS: '1' };
    m.mine = m.stash ? await newStash(cwd, m.stash) : null;
    const theirs = await newStash(m.path, { message: `Moved from ${m.name} to ${path.basename(cwd)} (${m.branch})`, untracked: true }).catch(async (err) => {
      if (m.mine) await git.stashApply(cwd, await stashRef(cwd, m.mine), true).catch(() => {});
      throw err;
    });
    const back = async () => {
      await git.run(m.path, ['checkout', '-q', m.branch], { env }).catch(() => {});
      if (theirs) await git.stashApply(m.path, await stashRef(m.path, theirs), true).catch(() => {});
      if (m.mine) await git.stashApply(cwd, await stashRef(cwd, m.mine), true).catch(() => {});
    };
    try {
      await git.run(m.path, ['checkout', '-q', '--detach'], { env });
      await git.run(cwd, ['checkout', '-q', m.branch], { env });
    } catch (err) {
      await back();
      throw err;
    }
    m.theirs = null;
    if (!theirs) return;
    try {
      await git.stashApply(cwd, await stashRef(cwd, theirs), true);
    } catch (err) {
      // Conflicts stay for the user to resolve; anything else (nothing applied) puts both sides back.
      if ((await git.run(cwd, ['ls-files', '-u'])).trim()) { m.theirs = theirs; return; }
      await git.run(cwd, ['checkout', '-q', from], { env }).catch(() => {});
      await back();
      if (/would be overwritten|already exists/.test(err.stderr || '')) throw new git.GitError(`The changes from “${m.name}” overlap the changes here. Nothing changed.`);
      throw err;
    }
  }

  // Undo or redo a moveCheckout. Branches and HEAD here must be where the step left them, and the
  // other worktree still detached (undo) or back on the branch (redo).
  async restoreMoved(entry, dir) {
    const cwd = this.root;
    const m = entry.moved;
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    if (!same(await git.captureRefState(cwd), dir === 'undo' ? entry.after : entry.before)) throw fail('branches or HEAD have moved since.');
    const there = await git.run(m.path, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] }).then((o) => o.trim(), () => null);
    if (there === null) throw fail(`${m.name} no longer exists.`);
    if (there !== (dir === 'undo' ? '' : `refs/heads/${m.branch}`)) throw fail(`${m.name} has switched branch since.`);
    if (dir === 'redo') {
      try { await this.moveNow(m, entry.before.head?.replace(/^refs\/heads\//, '') || entry.before.headOid); } catch (err) { throw fail(err.message); }
      return;
    }
    const env = { GIT_OPTIONAL_LOCKS: '1' };
    const stashes = await git.getStashes(cwd);
    if (m.mine && !stashes.some((x) => x.sha === m.mine)) throw fail('its stash was applied or dropped since.');
    if (m.theirs && !stashes.some((x) => x.sha === m.theirs)) throw fail(`the stash from ${m.name} was applied or dropped since.`);
    try {
      let back = m.theirs;
      if (back) {
        // Popping conflicted: drop the half-applied changes; their stash still has all of them.
        await git.run(cwd, ['reset', '-q', '--hard'], { env });
        const added = await git.run(cwd, ['ls-tree', '-r', '-z', '--name-only', `${back}^3`], { allowCodes: [0, 128] }).catch(() => '');
        for (const f of added.split('\0').filter(Boolean)) fs.rmSync(path.join(cwd, f), { force: true });
      } else {
        back = await newStash(cwd, { message: `Moved back to ${m.name} (${m.branch})`, untracked: true });
      }
      await git.restoreRefState(cwd, entry.before);
      if (m.mine) await git.stashApply(cwd, await stashRef(cwd, m.mine), true);
      await git.run(m.path, ['checkout', '-q', m.branch], { env });
      if (back) await git.stashApply(m.path, await stashRef(m.path, back), true);
      m.mine = m.theirs = null;
    } catch (err) {
      throw fail(err.message);
    }
  }

  // Stash every uncommitted change, then run `fn` (a ref mutation git refused over them), as one
  // undoable step like autostash: undo moves the refs back and pops the stash, redo stashes again
  // and moves them forward. If fn fails without moving anything, the stash is popped right away.
  stashAnd(label, method, fn) {
    return this.lock(async () => {
      const cwd = this.root;
      const id = ++nextId;
      const before = await git.captureRefState(cwd);
      const message = `Set aside for “${label}”`;
      const prev = await stashTop(cwd);
      await git.stashPush(cwd, { message, untracked: true });
      const sha = await stashTop(cwd);
      const made = !!sha && sha !== prev;
      const autostash = made ? { sha, message, untracked: true, branch: null } : null;
      try {
        return await fn();
      } catch (err) {
        if (made && same(await git.captureRefState(cwd), before)) await git.stashApply(cwd, 'stash@{0}', true).catch(() => {});
        throw err;
      } finally {
        // The stash is part of the step only if refs moved (a failed merge leaves it listed, unrecorded).
        const keep = made && !same(await git.captureRefState(cwd), before) && (await git.getStashes(cwd)).some((x) => x.sha === sha);
        await this.finish({ id, label, method, before, autostash: keep ? autostash : null }).catch((err) => console.warn('journal failed', err.message));
      }
    });
  }

  // Abort the rebase, merge, cherry-pick or revert stopped here, then run `fn` (a ref mutation git
  // refused mid-operation) as one undoable step. The abort itself can't be undone: git has no way
  // back into a stopped operation, so undo returns to the state right after the abort. Files
  // already resolved are saved first (git.saveResolved) and pinned with the step, for
  // restoreResolved. Returns { result, op, saved: { sha, paths } | null }.
  abortAnd(label, method, fn) {
    return this.lock(async () => {
      const op = await git.getOperationState(this.gitDir);
      const saved = op ? await git.saveResolved(this.root, this.gitDir) : null;
      if (op) {
        await git.run(this.root, [op, '--abort'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
        await this.dropAborted();
      }
      const result = await this.recordNow(label, method, fn, { resolved: saved?.sha ? { sha: saved.sha } : null });
      return { result, op, saved };
    });
  }

  // Abort the operation stopped here (`fn`) without making the abort a step (AK-577): it put HEAD
  // back, so the steps that started the stopped sequence are dropped and the next ⌘Z undoes the
  // step before them, never landing on a detached HEAD.
  abortOp(fn) {
    return this.lock(async () => {
      const res = await fn();
      await this.dropAborted();
      return res;
    });
  }

  // After an abort: drop the step that stopped on a detached HEAD and any taken while it was
  // stopped, when the repository is back exactly where that step started.
  async dropAborted() {
    const hot = this.undo.hot;
    let i = hot.length - 1;
    while (i >= 0 && !hot[i].before.head && !hot[i].after.head) i--;
    const start = hot[i];
    if (!start || !start.before.head || start.after.head) return;
    if (hot.slice(i).some((e) => e.work || e.stash || e.worktree || e.cleanup || e.submodules || e.autostash || e.freed || e.moved || e.remote)) return;
    const now = await git.captureRefState(this.root).catch(() => null);
    if (!now || !same(start.before, now)) return;
    hot.splice(i);
    const loaded = this.unarchive(this.undo);
    if (this.persist()) this.removePages(loaded);
    await this.prunePins().catch(() => {});
  }

  // Put back the files abortAnd saved (git.restoreResolved), as an undoable work step.
  restoreResolved(label, sha) {
    return this.lock(async () => this.recordNow(label, 'restoreResolved', () => git.restoreResolved(this.root, this.gitDir, sha), { paths: () => git.resolvedPaths(this.root, sha) }));
  }

  // Add or remove a worktree as an undoable step. Adding can also create a branch.
  runWorktree(method, label, args) {
    return this.lock(() => this.runWorktreeNow(method, label, args));
  }

  async runWorktreeNow(method, label, args) {
    const cwd = this.root;
    const id = ++nextId;
    const before = await git.captureRefState(cwd);
    let wt;
    try {
      wt = await worktreeOps[method].run(cwd, ...args);
    } catch (err) {
      // A failed add can still have created the branch; record that so it can be undone.
      await this.finish({ id, label, method, before }).catch(() => {});
      throw err;
    }
    const worktree = { op: worktreeOps[method].op, path: wt.path, branch: wt.branch, head: wt.head, ...(wt.stash ? { stash: wt.stash } : {}) };
    await this.finish({ id, label, method, before, worktree });
    return worktree;
  }

  // Merge and tidy a lane (git.mergeLane) as one undoable step: the base moved, the worktree
  // removed and the branch deleted all come back with one undo. `fn(done)` fills `done`; resolved
  // files it saved before aborting an operation stopped here (`done.saved`) are pinned with the step
  // and returned with the result as { op, saved }, for restoreResolved.
  runLane(label, method, fn) {
    return this.lock(async () => {
      const id = ++nextId;
      const before = await git.captureRefState(this.root);
      const done = {};
      try {
        const res = await fn(done);
        return done.saved ? { ...res, op: done.op, saved: done.saved } : res;
      } finally {
        const wt = done.worktree;
        const worktree = wt && { op: 'remove', path: wt.path, branch: wt.branch, head: wt.head };
        const resolved = done.saved ? { sha: done.saved.sha } : null;
        await this.finish({ id, label, method, before, worktree, resolved }).catch((err) => console.warn('journal failed', err.message));
      }
    });
  }

  // Lanes → Clean up (git.cleanupLanes): every worktree removed and branch deleted is one
  // undoable step. Returns git.cleanupLanes' result; `onProgress` is passed through.
  runCleanup(label, items, opts) {
    return this.lock(async () => {
      const id = ++nextId;
      const before = await git.captureRefState(this.root);
      let res = { removed: [], deleted: [], failed: [] };
      try {
        res = await git.cleanupLanes(this.root, items, opts);
      } finally {
        const cleanup = res.removed.map(({ path: p, branch, head, pruned, saved }) => ({ path: p, branch, head, pruned, ...(saved ? { saved } : {}) }));
        await this.finish({ id, label, method: 'cleanupLanes', before, cleanup }).catch((err) => console.warn('journal failed', err.message));
      }
      return res;
    });
  }

  // Initialise or update submodules as an undoable step (see git.updateSubmodules).
  runSubmodules(label, paths, opts) {
    return this.lock(async () => {
      const id = ++nextId;
      const before = await git.captureRefState(this.root);
      const { changes, error } = await git.updateSubmodules(this.root, paths, opts);
      await this.finish({ id, label, method: 'updateSubmodules', before, submodules: changes });
      if (error) throw error;
      return changes.length;
    });
  }

  // Stash or discard the uncommitted changes inside submodule `p` as an undoable step. Undo
  // pops the stash or puts the discarded changes back (see git.restoreSubmodules).
  runSubmoduleWork(label, p, mode) {
    return this.lock(async () => {
      const id = ++nextId;
      const before = await git.captureRefState(this.root);
      const head = await git.submoduleHead(this.root, p);
      if (!head) throw new git.GitError(`${p} isn’t checked out.`);
      const message = `Stashed from ${p}`;
      const sha = await (mode === 'discard' ? git.discardSubmodule(this.root, p) : git.stashSubmodule(this.root, p, message));
      if (!sha) throw new git.GitError(`${p} has no uncommitted changes.`);
      const change = { path: p, before: head, after: head, stash: sha, ...(mode === 'discard' ? { discarded: true } : { message }) };
      await this.finish({ id, label, method: 'submoduleWork', before, submodules: [change] });
      return true;
    });
  }

  // Add, change the URL of, rename or remove a remote as an undoable step (see git.changeRemote).
  runRemote(method, label, args) {
    return this.lock(async () => {
      const id = ++nextId;
      const before = await git.captureRefState(this.root);
      const remote = await git.changeRemote(this.root, remoteOps[method], ...args);
      await this.finish({ id, label, method, before, remote });
      return true;
    });
  }

  async finish({ id, label, method, before, workBefore, stashesBefore, worktree, cleanup, submodules, autostash, freed, moved, remote, midSequence, resolved }) {
    const cwd = this.root;
    const after = await git.captureRefState(cwd).catch(() => null);
    const entry = { id, label, method, time: Date.now(), before, after: after || before };
    if (worktree) entry.worktree = worktree;
    let changed = !same(entry.before, entry.after) || !!worktree;
    if (cleanup) { entry.cleanup = cleanup; changed ||= cleanup.length > 0; }
    if (submodules?.length) { entry.submodules = submodules; changed = true; }
    if (autostash) { entry.autostash = autostash; changed = true; }
    if (freed) { entry.freed = freed; changed = true; }
    if (moved) { entry.moved = moved; changed = true; }
    if (remote) { entry.remote = remote; changed = true; }
    if (resolved) { entry.resolved = resolved; changed = true; } // kept (pinned) for Restore
    if (workBefore) {
      const workAfter = await git.snapshotWork(cwd, workBefore.files.map((f) => f.path), { indexOnly: !!workBefore.indexOnly }).catch(() => null);
      if (!workAfter || git.workChanges(workBefore, workAfter).length) {
        entry.work = { before: workBefore, after: workAfter };
        changed = true;
      }
    }
    if (stashesBefore) {
      const now = await git.getStashes(cwd).catch(() => null);
      const index = now ? stashesBefore.findIndex((x) => !now.some((y) => y.sha === x.sha)) : -1;
      const added = now ? now.findIndex((x) => !stashesBefore.some((y) => y.sha === x.sha)) : -1;
      if (index !== -1) {
        entry.stash = { sha: stashesBefore[index].sha, message: stashesBefore[index].message, time: stashesBefore[index].time, index };
        changed = true;
      } else if (added !== -1) {
        entry.stash = { sha: now[added].sha, message: now[added].message, time: now[added].time, index: added, added: true };
        changed = true;
      }
    }
    if (!changed) return this.pin(id);
    const folded = midSequence && entry.after.head && !entry.work && !entry.stash ? this.foldSequence(entry) : null;
    if (folded) this.undo.hot.splice(-folded.count);
    const added = folded ? folded.entry : entry;
    await this.pin(id, pins(added));
    this.undo.hot.push(added);
    const dropped = this.redo;
    this.redo = new Stack();
    const archived = await this.archive(this.undo);
    if (!this.persist()) return;
    this.removePages(dropped.pages);
    if (dropped.length || archived || folded) await this.prunePins().catch((err) => console.warn('prune failed', err.message));
  }

  // A conflicted rebase (or cherry-pick/revert) is recorded as the step that
  // started it (on a branch → detached, stopped), any steps taken while it was
  // stopped, and the step that finished it (back on the branch). Undoing only the
  // last would leave HEAD detached mid-sequence with the sequence state gone, so
  // fold them into one entry: undo goes back to before the start, redo to the end.
  // Returns the folded entry and how many hot entries it replaces, or null.
  foldSequence(entry) {
    const hot = this.undo.hot;
    if (hot.at(-1)?.after.headOid !== entry.before.headOid) return null; // something moved HEAD outside GitLanes
    for (let i = hot.length - 1; i >= 0; i--) {
      const e = hot[i];
      if (e.worktree || e.cleanup || e.submodules || e.autostash || e.freed || e.moved || e.remote) return null;
      if (e.before.head && !e.after.head) {
        if (e.work || e.stash) return null;
        const merged = { ...e, id: entry.id, time: entry.time, after: entry.after };
        delete merged.pin;
        return { entry: merged, count: hot.length - i };
      }
      if (e.before.head || e.after.head) return null;
    }
    return null;
  }

  // `stash`: stash what blocks the step first (see stashThenStep). `force`: take the step even
  // though branches or HEAD moved since (see adoptMoved).
  // `discard`: the same, but the changes leave the stash list; the opposite step brings them back.
  step(dir, { stash = false, force = false, skip = false, discard = false } = {}) {
    return this.lock(() => (skip ? this.skipStep(dir) : stash || discard ? this.stashThenStep(dir, { force }, discard) : this.stepNow(dir, { force })));
  }

  // "Skip this step": the step can't be taken (its stash is gone), so drop it from the stack
  // without touching the repository. Returns its label.
  async skipStep(dir) {
    const from = dir === 'undo' ? this.undo : this.redo;
    const entry = from.top;
    if (!entry) return null;
    from.hot.pop();
    const loaded = this.unarchive(from);
    if (this.persist()) this.removePages(loaded);
    return entry.label;
  }

  // "Stash and undo" (or redo): stash what blocks the step, then take it. For a work step, the
  // paths that changed since; for a submodule step, the changes in those submodules; otherwise
  // every uncommitted change. The stashes stay in their lists; if the step still fails, they are
  // popped right away.
  // "Discard and undo" (AK-583): the stash is dropped from the list but kept on the entry
  // (`discarded`, pinned), and re-applied when the opposite step is taken.
  async stashThenStep(dir, opts, discard = false) {
    const cwd = this.root;
    const entry = (dir === 'undo' ? this.undo : this.redo).top;
    if (!entry) return null;
    const cur = dir === 'undo' ? 'after' : 'before';
    const message = `Set aside to ${dir} “${entry.label}”`;
    const made = []; // [submodule path or null, sha]
    if (entry.submodules) {
      for (const c of entry.submodules) {
        const sha = c[cur] && !(dir === 'redo' && c.stash) ? await git.stashSubmodule(cwd, c.path, message) : null;
        if (sha) made.push([c.path, sha]);
      }
    } else {
      const snap = entry.work?.[cur];
      const paths = snap ? git.workChanges(snap, await git.snapshotWork(cwd, snap.files.map((f) => f.path), { write: false, indexOnly: !!snap.indexOnly })) : [];
      const prev = await stashTop(cwd);
      await git.stashPush(cwd, { message, untracked: true, paths: paths.length ? paths : undefined });
      const sha = await stashTop(cwd);
      if (sha && sha !== prev) made.push([null, sha]);
    }
    const dropped = discard && !entry.submodules && made[0]?.[1];
    if (dropped) {
      entry.discarded = { sha: dropped, dir };
      await this.pin(entry.id, pins(entry));
      await git.dropStashCommit(cwd, dropped);
    }
    try {
      return await this.stepNow(dir, opts);
    } catch (err) {
      if (dropped) {
        delete entry.discarded;
        await git.stashApply(cwd, dropped).catch(() => {});
      } else for (const [p, sha] of made) await (p ? git.popSubmoduleStash(cwd, p, sha) : git.stashApply(cwd, 'stash@{0}', true)).catch(() => {});
      throw err;
    }
  }

  async stepNow(dir, { force = false } = {}) {
    const from = dir === 'undo' ? this.undo : this.redo;
    const to = dir === 'undo' ? this.redo : this.undo;
    const entry = from.top;
    if (!entry) return null;
    let note = null, adopted = null;
    try {
      if (force) adopted = await this.adoptMoved(entry, dir);
      if (entry.moved) await this.restoreMoved(entry, dir);
      else if (entry.freed) await this.restoreFreed(entry, dir);
      else if (entry.worktree) await this.restoreWorktree(entry, dir);
      else if (entry.cleanup) note = await this.restoreCleanup(entry, dir);
      else if (entry.submodules) await git.restoreSubmodules(this.root, entry.submodules, dir).catch((err) => { throw new git.GitError(`Can't ${dir} “${entry.label}”: ${err.message}`, { code: err.code }); });
      else if (entry.autostash || ['switchDelete', 'switchMerge', 'switchRewrite'].includes(entry.method)) await this.restoreAutostash(entry, dir);
      else if (entry.remote) await this.restoreRemote(entry, dir);
      else if (entry.work || entry.stash) await this.restoreWork(entry, dir);
      else await this.restoreRefs(entry, dir);
    } catch (err) {
      if (adopted) entry[adopted.side] = adopted.state; // refused anyway: the entry stays as it was
      // Uncommitted changes in the way (git's own codes are exit numbers): the renderer offers
      // "Stash and undo" (step with `stash`).
      if (typeof err.code !== 'string' && !entry.worktree && !entry.cleanup && DIRTY.test(`${err.stderr || ''}\n${err.message}`)) err.code = 'dirty';
      throw err;
    }
    // Changes discarded to take this step the other way come back with it.
    if (entry.discarded && entry.discarded.dir !== dir) {
      const { sha } = entry.discarded;
      delete entry.discarded;
      await git.stashApply(this.root, sha).catch(() => { note = 'the discarded changes couldn’t be put back'; });
    }
    from.hot.pop();
    to.hot.push(entry);
    const loaded = this.unarchive(from);
    const archived = await this.archive(to);
    if (this.persist()) {
      this.removePages(loaded);
      if (archived) await this.prunePins().catch((err) => console.warn('prune failed', err.message));
    }
    return note ? `${entry.label} (${note})` : entry.label;
  }

  // A plain ref step (checkout, branch, commit, merge, rewrite…). Branches and HEAD must still be
  // where the step left them, so commits made outside GitLanes since are never reset away.
  async restoreRefs(entry, dir) {
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const expected = dir === 'undo' ? entry.after : entry.before, now = await git.captureRefState(this.root);
    if (!same(now, expected)) throw movedError(fail, expected, now);
    await git.restoreRefState(this.root, dir === 'undo' ? entry.before : entry.after, { soft: entry.method === 'createCommit' });
  }

  // "Undo anyway": branches or HEAD moved since the step. Take where they are now as the step's
  // other side, so the step restores its snapshot and the opposite step brings today's refs back.
  // Only for steps that refuse over moved refs. Returns what it replaced, or null.
  async adoptMoved(entry, dir) {
    if (entry.cleanup || entry.remote || entry.submodules) return null;
    const plain = !entry.freed && !entry.worktree && !entry.work && !entry.stash && !entry.autostash;
    if (!plain && !entry.autostash && entry.method !== 'switchDelete' && same(entry.before, entry.after)) return null;
    const side = dir === 'undo' ? 'after' : 'before';
    const now = await git.captureRefState(this.root);
    if (same(now, entry[side])) return null;
    const state = entry[side];
    entry[side] = now;
    await this.pin(entry.id, pins(entry));
    delete entry.pin; // an archived entry now has its own pins again
    return { side, state };
  }

  // Undo or redo an entry with a work snapshot or a dropped stash. The current
  // state must still match the entry's other side, so nothing newer is overwritten.
  async restoreWork(entry, dir) {
    const cwd = this.root;
    const [cur, next] = dir === 'undo' ? ['after', 'before'] : ['before', 'after'];
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const movesRefs = !same(entry.before, entry.after);
    const now = movesRefs && await git.captureRefState(cwd);
    if (movesRefs && !same(now, entry[cur])) throw movedError(fail, entry[cur], now);
    if (entry.work) {
      const paths = entry.work[next].files.map((f) => f.path);
      const indexOnly = !!entry.work[next].indexOnly;
      if (!entry.work[cur]) {
        // The snapshot after the operation failed; take it now so redo still works.
        entry.work[cur] = await git.snapshotWork(cwd, paths, { indexOnly });
        await this.pin(entry.id, pins(entry));
        delete entry.pin; // an archived entry now has its own pins again
      } else {
        const changed = git.workChanges(entry.work[cur], await git.snapshotWork(cwd, paths, { write: false, indexOnly }));
        if (changed.length) throw Object.assign(fail(`${listPaths(changed)} changed since.`), { code: 'dirty' });
      }
    }
    // A dropped stash comes back on undo; an added one goes away on undo.
    const removing = entry.stash && (dir === 'undo') === !!entry.stash.added;
    if (removing && !(await git.getStashes(cwd)).some((x) => x.sha === entry.stash.sha)) throw Object.assign(fail(`the stash “${entry.stash.message}” no longer exists.`), {
      code: 'stash-gone', step: { label: entry.label, time: entry.time, stash: { message: entry.stash.message, time: entry.stash.time ? entry.stash.time * 1000 : null } },
    });
    if (movesRefs) await git.restoreRefState(cwd, entry[next], { refsOnly: true });
    if (entry.work) await git.restoreWork(cwd, entry.work[next]);
    if (entry.stash) {
      if (removing) await git.dropStashCommit(cwd, entry.stash.sha);
      else await git.restoreStash(cwd, entry.stash);
    }
  }

  // Undo or redo a stash-and-switch (autostash) or a switch-and-delete, with or without a
  // stash. Branches and HEAD must still be where the step left them.
  async restoreAutostash(entry, dir) {
    const cwd = this.root;
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const expected = dir === 'undo' ? entry.after : entry.before, now = await git.captureRefState(cwd);
    if (!same(now, expected)) throw movedError(fail, expected, now);
    const a = entry.autostash;
    if (!a) return git.restoreRefState(cwd, dir === 'undo' ? entry.before : entry.after);
    if (dir === 'undo') {
      const i = (await git.getStashes(cwd)).findIndex((x) => x.sha === a.sha);
      if (i === -1) throw Object.assign(fail(`its stash “${a.message}” was applied or dropped since.`), { code: 'stash-gone' });
      await git.restoreRefState(cwd, entry.before);
      await git.stashApply(cwd, `stash@{${i}}`, true);
    } else {
      // Only adopt refs/stash if this push made it: with nothing to stash it is an older, unrelated stash.
      const prev = await stashTop(cwd);
      await git.stashPush(cwd, { message: a.message, untracked: a.untracked });
      const sha = await stashTop(cwd);
      if (!sha || sha === prev) throw fail('there are no changes to stash again.');
      a.sha = sha;
      await this.pin(entry.id, pins(entry));
      delete entry.pin;
      try { await git.restoreRefState(cwd, entry.after); } catch (err) { await git.stashApply(cwd, 'stash@{0}', true).catch(() => {}); throw err; }
    }
  }

  // Undo or redo a checkout that freed its branch from another worktree (freeCheckout). That
  // worktree must still be detached (undo) or back on the branch (redo).
  async restoreFreed(entry, dir) {
    const cwd = this.root;
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    if (!same(await git.captureRefState(cwd), dir === 'undo' ? entry.after : entry.before)) throw fail('branches or HEAD have moved since.');
    const { path: wtPath, branch } = entry.freed;
    const env = { GIT_OPTIONAL_LOCKS: '1' };
    const there = await git.run(wtPath, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] }).then((o) => o.trim(), () => null);
    if (there === null) throw fail(`${path.basename(wtPath)} no longer exists.`);
    if (there !== (dir === 'undo' ? '' : `refs/heads/${branch}`)) throw fail(`${path.basename(wtPath)} has switched branch since.`);
    try {
      if (dir === 'undo') {
        await git.restoreRefState(cwd, entry.before);
        await git.run(wtPath, ['checkout', '-q', branch], { env });
      } else {
        await git.run(wtPath, ['checkout', '-q', '--detach'], { env });
        await git.restoreRefState(cwd, entry.after);
      }
    } catch (err) {
      throw fail(err.message);
    }
  }

  // Undo or redo a remote change. Redoing a remove saves the remote's refs again, so pin those.
  async restoreRemote(entry, dir) {
    await git.revertRemote(this.root, entry.remote, dir).catch((err) => { throw new git.GitError(`Can't ${dir} “${entry.label}”: ${err.message}`); });
    if (entry.remote.op === 'remove' && dir === 'redo') {
      await this.pin(entry.id, pins(entry));
      delete entry.pin;
    }
  }

  // Undo or redo adding or removing a worktree. Removing again needs the worktree
  // clean and unlocked (git.removeWorktree checks); a branch created with it is
  // deleted only if nothing has moved since. A lane step can also have moved the
  // branch checked out here (its base), so the working copy follows HEAD.
  async restoreWorktree(entry, dir) {
    const cwd = this.root;
    const [cur, next] = dir === 'undo' ? ['after', 'before'] : ['before', 'after'];
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const movesRefs = !same(entry.before, entry.after);
    const now = movesRefs && await git.captureRefState(cwd);
    if (movesRefs && !same(now, entry[cur])) throw movedError(fail, entry[cur], now);
    const wt = entry.worktree;
    const adding = (wt.op === 'add') === (dir === 'redo');
    try {
      if (adding) {
        if (movesRefs) await git.restoreRefState(cwd, entry[next], { refsOnly: !laneOps.has(entry.method) });
        await git.restoreWorktree(cwd, wt);
        // The changes the removal stashed go back into the worktree.
        if (wt.stash) await git.popStash(wt.path, wt.stash);
      } else if (wt.stash) {
        // Stash its changes again (a new SHA) and remove it.
        const sha = (await git.removeWorktree(cwd, wt.path, { stash: true })).stash;
        if (sha) wt.stash = sha; else delete wt.stash;
        await this.pin(entry.id, pins(entry));
        delete entry.pin;
        if (movesRefs) await git.restoreRefState(cwd, entry[next], { refsOnly: !laneOps.has(entry.method) });
      } else {
        // Changes stashed by the removal (`saved`, a lane's tidy) are stashed again, so undo can bring them back once more.
        const res = await git.removeWorktree(cwd, wt.path, wt.saved ? { changes: wt.saved.kept ? 'stash' : 'discard' } : {});
        if (wt.saved) await this.resave(entry, wt, res.saved);
        if (movesRefs) await git.restoreRefState(cwd, entry[next], { refsOnly: !laneOps.has(entry.method) });
      }
    } catch (err) {
      throw fail(err.message);
    }
  }

  // A worktree removed again on redo has a new stash commit (or none, if it had no changes left).
  async resave(entry, w, saved) {
    if (saved) w.saved = saved;
    else delete w.saved;
    await this.pin(entry.id, pins(entry));
    delete entry.pin; // an archived entry now has its own pins again
  }

  // Undo or redo a bulk cleanup. Only the branches it deleted must be where it left them;
  // other refs (agents committing elsewhere) may move freely. Undo puts the branches back,
  // then re-adds each removed worktree at its path where nothing is in the way. Worktrees that
  // were already missing (pruned) aren't re-added; a dirty one comes back with its changes, from
  // the stash taken when it was removed. Redo removes them again (stashing those changes again).
  // Returns a note about worktrees that couldn't be re-added, or null.
  async restoreCleanup(entry, dir) {
    const cwd = this.root;
    const [cur, next] = dir === 'undo' ? ['after', 'before'] : ['before', 'after'];
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const names = [...new Set([...Object.keys(entry.before.refs), ...Object.keys(entry.after.refs)])].filter((n) => entry.before.refs[n] !== entry.after.refs[n]);
    const now = await git.captureRefState(cwd);
    const moved = names.filter((n) => now.refs[n] !== entry[cur].refs[n]);
    if (moved.length) throw fail(`${listPaths(moved.map(shortRef))} changed since.`);
    const refs = { ...now.refs };
    for (const n of names) {
      if (entry[next].refs[n]) refs[n] = entry[next].refs[n];
      else delete refs[n];
    }
    const target = { ...now, refs };
    const worktrees = entry.cleanup.filter((w) => !w.pruned);
    if (dir === 'redo') {
      const list = await git.getWorktrees(cwd);
      const back = worktrees.filter((w) => list.some((x) => !x.missing && git.samePath(x.path, w.path)));
      for (const w of back) {
        const n = w.saved ? 0 : await git.worktreeChanges(w.path);
        if (n) throw fail(`${path.basename(w.path)} has ${n} uncommitted change${n > 1 ? 's' : ''}.`);
      }
      try {
        for (const w of back) {
          const res = await git.removeWorktree(cwd, w.path, { changes: w.saved && (w.saved.kept ? 'stash' : 'discard') });
          if (w.saved) await this.resave(entry, w, res.saved);
        }
        await git.restoreRefState(cwd, target, { refsOnly: true });
      } catch (err) {
        throw fail(err.message);
      }
      return null;
    }
    await git.restoreRefState(cwd, target, { refsOnly: true }).catch((err) => { throw fail(err.message); });
    const skipped = [];
    for (const w of worktrees) {
      try { await git.restoreWorktree(cwd, w); } catch { skipped.push(path.basename(w.path)); }
    }
    return skipped.length ? `couldn't re-add ${listPaths(skipped)}: the folder is in the way` : null;
  }

  // What "Restore before" an entry would change right now, without changing anything.
  async previewRestore(id) {
    const entry = this.find(id);
    if (!entry) throw new git.GitError('Snapshot not found');
    const current = await git.captureRefState(this.root);
    return { label: entry.label, changes: refChanges(current, entry.before), movesHead: !!entry.before.headOid && entry.before.headOid !== current.headOid };
  }

  // Move refs back to the state before an entry (the Snapshots view's "Restore before").
  restore(id) {
    return this.lock(async () => {
      const entry = this.find(id);
      if (!entry) throw new git.GitError('Snapshot not found');
      await this.recordNow(`Restore “${entry.label}”`, 'restoreHistory', () => git.restoreRefState(this.root, entry.before));
    });
  }
}

module.exports = { Journal, workOps, worktreeOps, laneOps, remoteOps, PAGE, refChanges };
