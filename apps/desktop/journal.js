'use strict';
// Undo journal: unlimited undo/redo for every recorded operation.
// Each entry stores the refs before and after an operation. Operations that
// destroy uncommitted work also store an exact snapshot of the paths they touch
// (and the stash they drop), so undo and redo restore those too. Every object
// an entry needs is pinned under refs/gitlanes/undo/<id> until the entry
// leaves the journal, so `git gc` can't collect it.

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');

const LIMIT = 200;
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

class Journal {
  constructor(repo) {
    this.root = repo.root;
    this.file = path.join(repo.gitDir, 'gitlanes-history.json');
    this.undo = [];
    this.redo = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.undo = saved.undo || [];
      this.redo = saved.redo || [];
    } catch { /* no history yet */ }
    for (const e of [...this.undo, ...this.redo]) nextId = Math.max(nextId, e.id);
  }

  list() {
    const strip = (e, i) => ({ id: e.id, label: e.label, time: e.time, index: i, movesRefs: !e.worktree && !same(e.before, e.after) });
    return { undo: this.undo.map(strip), redo: this.redo.map(strip) };
  }

  persist() {
    this.undo = this.undo.slice(-LIMIT);
    this.redo = this.redo.slice(-LIMIT);
    try { fs.writeFileSync(this.file, JSON.stringify({ undo: this.undo, redo: this.redo })); } catch { /* read-only repo */ }
  }

  // Drop the pins of entries that have left the journal.
  prune() {
    return git.pruneUndoPins(this.root, [...this.undo, ...this.redo].map((e) => e.id)).catch((err) => console.warn('prune failed', err.message));
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
    this.undo.push(entry);
    this.redo = [];
    this.persist();
    await this.prune();
  }

  async step(dir) {
    const from = dir === 'undo' ? this.undo : this.redo;
    const to = dir === 'undo' ? this.redo : this.undo;
    const entry = from[from.length - 1];
    if (!entry) return null;
    if (entry.worktree) await this.restoreWorktree(entry, dir);
    else if (entry.work || entry.stash) await this.restoreWork(entry, dir);
    else await git.restoreRefState(this.root, dir === 'undo' ? entry.before : entry.after, { soft: entry.method === 'createCommit' });
    from.pop();
    to.push(entry);
    this.persist();
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
    const entry = this.undo.find((e) => e.id === id) || this.redo.find((e) => e.id === id);
    if (!entry) throw new git.GitError('Snapshot not found');
    await this.record(`Restore “${entry.label}”`, 'restoreHistory', () => git.restoreRefState(this.root, entry.before));
  }
}

module.exports = { Journal, workOps, worktreeOps, LIMIT };
