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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
  if (entry.worktree) objects.push(entry.worktree.head);
  for (const w of entry.cleanup || []) objects.push(w.head);
  return { blobs: [...git.snapshotBlobs(entry.work?.before), ...git.snapshotBlobs(entry.work?.after)], objects };
}

// Adding and removing worktrees. Removal is only allowed on a clean worktree,
// so its branch (or commit, when detached) is all undo needs to recreate it.
const worktreeOps = {
  addWorktree: { op: 'add', run: async (cwd, opts) => git.findWorktree(cwd, await git.addWorktree(cwd, opts)) },
  removeWorktree: { op: 'remove', run: git.removeWorktree },
};

// Operations that destroy uncommitted work or stashes, with the paths each may
// change; the journal snapshots those paths (and a dropped stash) around them.
const workOps = {
  discardFiles: { run: git.discardFiles, paths: (cwd, files) => files.map((f) => f.path) },
  discardLines: { run: git.discardLines, paths: (cwd, file) => [file.path] },
  resetHard: { run: git.resetHard, paths: (cwd, sha) => git.resetHardPaths(cwd, sha || 'HEAD') },
  chooseSide: { run: git.chooseSide, paths: (cwd, p) => [p] },
  resolveConflict: { run: git.resolveConflict, paths: (cwd, p) => [p] },
  stashApply: { run: git.stashApply, paths: git.stashPaths, stash: true },
  stashDrop: { run: git.stashDrop, stash: true },
};

const listPaths = (paths) => (paths.length > 3 ? `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more` : paths.join(', '));

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
    const strip = (e) => ({ id: e.id, label: e.label, time: e.time, movesRefs: !e.worktree && !same(e.before, e.after) });
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
  // may change) turns on work snapshots; `stash` records a stash that fn drops.
  // If the snapshot can't be saved, fn never runs.
  record(label, method, fn, opts) {
    return this.lock(() => this.recordNow(label, method, fn, opts));
  }

  async recordNow(label, method, fn, { paths, stash = false } = {}) {
    const cwd = this.root;
    const id = ++nextId;
    const before = await git.captureRefState(cwd);
    // A step taken while a rebase, cherry-pick or revert is stopped on a conflict.
    const midSequence = !before.head && !!(await git.getOperationState(this.gitDir));
    let workBefore = null, stashesBefore = null;
    try {
      if (paths) {
        workBefore = await git.snapshotWork(cwd, await paths());
        await this.pin(id, { blobs: git.snapshotBlobs(workBefore) });
      }
      if (stash) stashesBefore = await git.getStashes(cwd);
    } catch (err) {
      await this.pin(id).catch(() => {});
      throw new git.GitError(`Nothing was changed: the undo snapshot could not be saved. ${err.message}`);
    }
    try {
      return await fn();
    } finally {
      // Record whatever changed, even if fn failed part-way.
      await this.finish({ id, label, method, before, workBefore, stashesBefore, midSequence }).catch((err) => console.warn('journal failed', err.message));
    }
  }

  // Run one of `workOps` as an undoable step.
  runWork(method, label, args) {
    const op = workOps[method];
    const cwd = this.root;
    return this.record(label, method, () => op.run(cwd, ...args), { paths: op.paths && (() => op.paths(cwd, ...args)), stash: op.stash });
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
    const worktree = { op: worktreeOps[method].op, path: wt.path, branch: wt.branch, head: wt.head };
    await this.finish({ id, label, method, before, worktree });
    return worktree;
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
        const cleanup = res.removed.map(({ path: p, branch, head, pruned }) => ({ path: p, branch, head, pruned }));
        await this.finish({ id, label, method: 'cleanupLanes', before, cleanup }).catch((err) => console.warn('journal failed', err.message));
      }
      return res;
    });
  }

  // Initialise or update submodules as an undoable step (see git.updateSubmodules).
  runSubmodules(label, paths) {
    return this.lock(async () => {
      const id = ++nextId;
      const before = await git.captureRefState(this.root);
      const { changes, error } = await git.updateSubmodules(this.root, paths);
      await this.finish({ id, label, method: 'updateSubmodules', before, submodules: changes });
      if (error) throw error;
      return changes.length;
    });
  }

  async finish({ id, label, method, before, workBefore, stashesBefore, worktree, cleanup, submodules, midSequence }) {
    const cwd = this.root;
    const after = await git.captureRefState(cwd).catch(() => null);
    const entry = { id, label, method, time: Date.now(), before, after: after || before };
    if (worktree) entry.worktree = worktree;
    let changed = !same(entry.before, entry.after) || !!worktree;
    if (cleanup) { entry.cleanup = cleanup; changed ||= cleanup.length > 0; }
    if (submodules?.length) { entry.submodules = submodules; changed = true; }
    if (workBefore) {
      const workAfter = await git.snapshotWork(cwd, workBefore.files.map((f) => f.path)).catch(() => null);
      if (!workAfter || git.workChanges(workBefore, workAfter).length) {
        entry.work = { before: workBefore, after: workAfter };
        changed = true;
      }
    }
    if (stashesBefore) {
      const now = await git.getStashes(cwd).catch(() => null);
      const index = now ? stashesBefore.findIndex((x) => !now.some((y) => y.sha === x.sha)) : -1;
      if (index !== -1) {
        entry.stash = { sha: stashesBefore[index].sha, message: stashesBefore[index].message, index };
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
      if (e.worktree || e.cleanup || e.submodules) return null;
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

  step(dir) {
    return this.lock(() => this.stepNow(dir));
  }

  async stepNow(dir) {
    const from = dir === 'undo' ? this.undo : this.redo;
    const to = dir === 'undo' ? this.redo : this.undo;
    const entry = from.top;
    if (!entry) return null;
    let note = null;
    if (entry.worktree) await this.restoreWorktree(entry, dir);
    else if (entry.cleanup) note = await this.restoreCleanup(entry, dir);
    else if (entry.submodules) await git.restoreSubmodules(this.root, entry.submodules, dir).catch((err) => { throw new git.GitError(`Can't ${dir} “${entry.label}”: ${err.message}`); });
    else if (entry.work || entry.stash) await this.restoreWork(entry, dir);
    else await git.restoreRefState(this.root, dir === 'undo' ? entry.before : entry.after, { soft: entry.method === 'createCommit' });
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

  // Undo or redo an entry with a work snapshot or a dropped stash. The current
  // state must still match the entry's other side, so nothing newer is overwritten.
  async restoreWork(entry, dir) {
    const cwd = this.root;
    const [cur, next] = dir === 'undo' ? ['after', 'before'] : ['before', 'after'];
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const movesRefs = !same(entry.before, entry.after);
    if (movesRefs && !same(await git.captureRefState(cwd), entry[cur])) throw fail('branches or HEAD have moved since.');
    if (entry.work) {
      const paths = entry.work[next].files.map((f) => f.path);
      if (!entry.work[cur]) {
        // The snapshot after the operation failed; take it now so redo still works.
        entry.work[cur] = await git.snapshotWork(cwd, paths);
        await this.pin(entry.id, pins(entry));
        delete entry.pin; // an archived entry now has its own pins again
      } else {
        const changed = git.workChanges(entry.work[cur], await git.snapshotWork(cwd, paths, { write: false }));
        if (changed.length) throw fail(`${listPaths(changed)} changed since. Commit or stash ${changed.length > 1 ? 'those changes' : 'that change'} first.`);
      }
    }
    if (entry.stash && dir === 'redo' && !(await git.getStashes(cwd)).some((x) => x.sha === entry.stash.sha)) throw fail('that stash no longer exists.');
    if (movesRefs) await git.restoreRefState(cwd, entry[next], { refsOnly: true });
    if (entry.work) await git.restoreWork(cwd, entry.work[next]);
    if (entry.stash) {
      if (dir === 'undo') await git.restoreStash(cwd, entry.stash);
      else await git.dropStashCommit(cwd, entry.stash.sha);
    }
  }

  // Undo or redo adding or removing a worktree. Removing again needs the worktree
  // clean and unlocked (git.removeWorktree checks); a branch created with it is
  // deleted only if nothing has moved since.
  async restoreWorktree(entry, dir) {
    const cwd = this.root;
    const [cur, next] = dir === 'undo' ? ['after', 'before'] : ['before', 'after'];
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const movesRefs = !same(entry.before, entry.after);
    if (movesRefs && !same(await git.captureRefState(cwd), entry[cur])) throw fail('branches or HEAD have moved since.');
    const wt = entry.worktree;
    const adding = (wt.op === 'add') === (dir === 'redo');
    try {
      if (adding) {
        if (movesRefs) await git.restoreRefState(cwd, entry[next], { refsOnly: true });
        await git.restoreWorktree(cwd, wt);
      } else {
        await git.removeWorktree(cwd, wt.path);
        if (movesRefs) await git.restoreRefState(cwd, entry[next], { refsOnly: true });
      }
    } catch (err) {
      throw fail(err.message);
    }
  }

  // Undo or redo a bulk cleanup. Only the branches it deleted must be where it left them;
  // other refs (agents committing elsewhere) may move freely. Undo puts the branches back,
  // then re-adds each removed worktree at its path where nothing is in the way. Worktrees that
  // were already missing (pruned) aren't re-added, and a dirty worktree comes back clean: its
  // uncommitted files were deleted with it. Redo removes them again (only if still clean).
  // Returns a note about worktrees that couldn't be re-added, or null.
  async restoreCleanup(entry, dir) {
    const cwd = this.root;
    const [cur, next] = dir === 'undo' ? ['after', 'before'] : ['before', 'after'];
    const fail = (why) => new git.GitError(`Can't ${dir} “${entry.label}”: ${why}`);
    const names = [...new Set([...Object.keys(entry.before.refs), ...Object.keys(entry.after.refs)])].filter((n) => entry.before.refs[n] !== entry.after.refs[n]);
    const now = await git.captureRefState(cwd);
    const moved = names.filter((n) => now.refs[n] !== entry[cur].refs[n]);
    if (moved.length) throw fail(`${listPaths(moved.map((n) => n.replace(/^refs\/(heads|tags)\//, '')))} changed since.`);
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
        const n = await git.worktreeChanges(w.path);
        if (n) throw fail(`${path.basename(w.path)} has ${n} uncommitted change${n > 1 ? 's' : ''}.`);
      }
      try {
        for (const w of back) await git.removeWorktree(cwd, w.path);
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

module.exports = { Journal, workOps, worktreeOps, PAGE, refChanges };
