'use strict';
// Undo journal: unlimited undo/redo for every recorded operation.
// Each entry stores the refs before and after an operation. Operations that
// destroy uncommitted work also store an exact snapshot of the paths they touch
// (and the stash they drop), so undo and redo restore those too. Every object
// an entry needs is pinned under refs/gitlanes/undo/<key> until the entry
// leaves the journal (only redo entries ever do), so `git gc` can't collect it.
//
// History has no cap. Only the newest entries of each stack are kept in memory
// and in gitlanes-history.json; older ones are archived to page files under
// gitlanes-history/ and read back only when undo or redo reaches them, so
// memory and the cost of each save stay flat. Archiving also compacts a page's
// pins into one set under refs/gitlanes/undo/p<n>.

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');

const PAGE = 100; // entries per archived page; up to 2 × PAGE stay in memory per stack
let nextId = Date.now();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
    this.file = path.join(repo.gitDir, 'gitlanes-history.json');
    this.dir = path.join(repo.gitDir, 'gitlanes-history');
    this.pageSize = pageSize;
    this.nextPage = 1;
    this.undo = new Stack();
    this.redo = new Stack();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version === 2) {
        this.nextPage = saved.nextPage;
        this.undo = new Stack(saved.undo);
        this.redo = new Stack(saved.redo);
      } else {
        // The first format: two flat arrays. They are archived on the next save.
        this.undo = new Stack({ hot: saved.undo || [] });
        this.redo = new Stack({ hot: saved.redo || [] });
      }
    } catch { /* no history yet */ }
    for (const s of [this.undo, this.redo]) {
      for (const e of s.hot) nextId = Math.max(nextId, e.id);
      for (const p of s.pages) nextId = Math.max(nextId, p.last);
    }
    this.removeOrphanPages();
  }

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
    const data = JSON.stringify({ version: 2, nextPage: this.nextPage, undo: this.undo, redo: this.redo });
    try { writeAtomic(this.file, data); } catch { /* read-only repo */ }
  }

  // Drop the pins of entries that have left the journal.
  prune() {
    return git.pruneUndoPins(this.root, [...this.undo.pinKeys(), ...this.redo.pinKeys()]).catch((err) => console.warn('prune failed', err.message));
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
        await git.pinUndo(this.root, key, objs);
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
  async record(label, method, fn, { paths, stash = false } = {}) {
    const cwd = this.root;
    const id = ++nextId;
    const before = await git.captureRefState(cwd);
    let workBefore = null, stashesBefore = null;
    try {
      if (paths) {
        workBefore = await git.snapshotWork(cwd, await paths());
        await git.pinUndo(cwd, id, { blobs: git.snapshotBlobs(workBefore) });
      }
      if (stash) stashesBefore = await git.getStashes(cwd);
    } catch (err) {
      await git.pinUndo(cwd, id).catch(() => {});
      throw new git.GitError(`Nothing was changed: the undo snapshot could not be saved. ${err.message}`);
    }
    try {
      return await fn();
    } finally {
      // Record whatever changed, even if fn failed part-way.
      await this.finish({ id, label, method, before, workBefore, stashesBefore }).catch((err) => console.warn('journal failed', err.message));
    }
  }

  // Run one of `workOps` as an undoable step.
  runWork(method, label, args) {
    const op = workOps[method];
    const cwd = this.root;
    return this.record(label, method, () => op.run(cwd, ...args), { paths: op.paths && (() => op.paths(cwd, ...args)), stash: op.stash });
  }

  // Add or remove a worktree as an undoable step. Adding can also create a branch.
  async runWorktree(method, label, args) {
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

  async finish({ id, label, method, before, workBefore, stashesBefore, worktree }) {
    const cwd = this.root;
    const after = await git.captureRefState(cwd).catch(() => null);
    const entry = { id, label, method, time: Date.now(), before, after: after || before };
    if (worktree) entry.worktree = worktree;
    let changed = !same(entry.before, entry.after) || !!worktree;
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
    if (!changed) return git.pinUndo(cwd, id);
    await git.pinUndo(cwd, id, pins(entry));
    this.undo.hot.push(entry);
    const dropped = this.redo;
    this.redo = new Stack();
    const archived = await this.archive(this.undo);
    this.persist();
    this.removePages(dropped.pages);
    if (dropped.length || archived) await this.prune();
  }

  async step(dir) {
    const from = dir === 'undo' ? this.undo : this.redo;
    const to = dir === 'undo' ? this.redo : this.undo;
    const entry = from.top;
    if (!entry) return null;
    if (entry.worktree) await this.restoreWorktree(entry, dir);
    else if (entry.work || entry.stash) await this.restoreWork(entry, dir);
    else await git.restoreRefState(this.root, dir === 'undo' ? entry.before : entry.after, { soft: entry.method === 'createCommit' });
    from.hot.pop();
    to.hot.push(entry);
    const loaded = this.unarchive(from);
    const archived = await this.archive(to);
    this.persist();
    this.removePages(loaded);
    if (archived) await this.prune();
    return entry.label;
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
        await git.pinUndo(cwd, entry.id, pins(entry));
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

  // Move refs back to the state before an entry (the Snapshots view's "Restore before").
  async restore(id) {
    const entry = this.find(id);
    if (!entry) throw new git.GitError('Snapshot not found');
    await this.record(`Restore “${entry.label}”`, 'restoreHistory', () => git.restoreRefState(this.root, entry.before));
  }
}

module.exports = { Journal, workOps, worktreeOps, PAGE };
