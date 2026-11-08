// Commit history as it streams in from git (see streamLog in git.js).
//
// The main process sends raw `git log` text; parsing it here is far cheaper than cloning
// millions of objects across IPC. Records are NUL-separated fields ending in \x1e, and git
// puts a newline after each record.
//   topo     sha, parents                         (from git's commit-graph, fast)
//   details  sha, author, email, time, subject, co-authors    (needs every commit object, slow)
//   full     sha, parents, author, email, time, subject, co-authors
// Co-authors are Co-authored-by trailer values separated by \x1f.
// Commits from the topo stream start with `subject: null` until their details arrive.

import { createGraph, type Graph } from './graph.ts';
import type { CoAuthor } from '../../shared/git-types.ts';

/** A commit on the map. One from the topo stream has `subject: null` (and no co-authors) until its details arrive. */
export interface LogCommit {
  sha: string; parents: string[]; author: string; email: string; time: number; subject: string | null;
  coAuthors?: readonly CoAuthor[];
}
type Details = Pick<LogCommit, 'author' | 'email' | 'time' | 'subject'> & { coAuthors: readonly CoAuthor[] };
/** The commits, their index by sha and the incremental graph, kept in step (see createHistory). */
export interface History {
  commits: LogCommit[]; index: Map<string, number>; graph: Graph; complete: boolean;
  readonly length: number;
  add(list: readonly LogCommit[]): History;
  seed(c: LogCommit): void;
  fill(text: string): number;
  fork(m: number, head?: string | null): History;
  missingDetails(from?: number, max?: number): string[];
}
/** Replays a fresh log against a history (see createMerge). */
export interface Merge { readonly next: History | null; readonly matched: number; push(list: readonly LogCommit[]): Merge; finish(): History | null }

const REC = '\x1e';
const SEP = '\0';

function records(text: string, fn: (record: string) => void): void {
  let i = 0;
  while (i < text.length) {
    const end = text.indexOf(REC, i);
    if (end === -1) break;
    if (text.charCodeAt(i) === 10) i++;
    if (end > i) fn(text.slice(i, end));
    i = end + 1;
  }
}

const splitParents = (p: string | undefined): string[] => (p ? p.split(' ') : []);
const NONE: readonly CoAuthor[] = Object.freeze([]); // shared by the many commits without co-authors

// `Name <email>` trailer values (\x1f-separated) to [{ name, email }], deduped by email
// (case-insensitive) and without the author. Lines that aren't `Name <email>` are skipped.
export function parseCoAuthors(raw: string | null | undefined, author: string | null | undefined): readonly CoAuthor[] {
  if (!raw) return NONE;
  const seen = new Set([(author || '').toLowerCase()]), out: CoAuthor[] = [];
  for (const v of raw.split('\x1f')) {
    const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(v);
    const email = m?.[2];
    if (!m || !email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ name: m[1] || email, email });
  }
  return out.length ? out : NONE;
}

export function parseLog(text: string, kind: string): LogCommit[] {
  const out: LogCommit[] = [];
  records(text, (r) => {
    const f = r.split(SEP);
    const sha = f[0] ?? '';
    if (kind === 'topo') out.push({ sha, parents: splitParents(f[1]), author: '', email: '', time: 0, subject: null });
    else out.push({ sha, parents: splitParents(f[1]), author: f[2] ?? '', email: f[3] ?? '', time: +(f[4] ?? ''), subject: f[5] ?? '', coAuthors: parseCoAuthors(f[6], f[3]) });
  });
  return out;
}

// Calls fn(sha, author, email, time, subject, coAuthors) for each DETAILS record.
export function parseDetails(text: string, fn: (sha: string, author: string, email: string, time: number, subject: string, coAuthors: readonly CoAuthor[]) => void): void {
  records(text, (r) => {
    const f = r.split(SEP);
    fn(f[0] ?? '', f[1] ?? '', f[2] ?? '', +(f[3] ?? ''), f[4] ?? '', parseCoAuthors(f[5], f[2]));
  });
}

// commits + sha index + incremental graph, always kept in step.
// `head` is HEAD's sha: the graph keeps its first-parent chain in lane 0.
export function createHistory(head: string | null = null, commits: LogCommit[] = [], index = new Map<string, number>(), from: Graph | null = null): History {
  const graph = from || createGraph(commits, head);
  const early = new Map<string, Details>(); // details that arrived before their commit did
  const hist: History = {
    commits,
    index,
    graph,
    complete: false,
    get length() { return commits.length; },
    add(list) {
      for (const c of list) {
        if (index.has(c.sha)) continue;
        if (c.subject === null && early.size) {
          const d = early.get(c.sha);
          if (d) { Object.assign(c, d); early.delete(c.sha); }
        }
        index.set(c.sha, commits.length);
        commits.push(c);
      }
      graph.sync();
      return hist;
    },
    // Remember c's details for when the same commit arrives without them.
    seed(c) {
      if (c.subject !== null) early.set(c.sha, { author: c.author, email: c.email, time: c.time, subject: c.subject, coAuthors: c.coAuthors ?? NONE });
    },
    // Fill in subjects/authors from DETAILS text. Returns how many commits changed.
    fill(text) {
      let n = 0;
      parseDetails(text, (sha, author, email, time, subject, coAuthors) => {
        const i = index.get(sha);
        const c = i === undefined ? null : commits[i];
        if (!c) { if (early.size < 200000) early.set(sha, { author, email, time, subject, coAuthors }); return; }
        if (c.subject !== null) return;
        c.author = author; c.email = email; c.time = time; c.subject = subject; c.coAuthors = coAuthors;
        n++;
      });
      return n;
    },
    // A new history holding our first `m` commits (shared objects, details included), laid out
    // for `head`.
    fork(m, head = graph.head) {
      const list = commits.slice(0, m);
      const idx = new Map<string, number>();
      for (let i = 0; i < m; i++) idx.set(list[i]!.sha, i);
      return createHistory(head, list, idx, graph.fork(list, m, head));
    },
    missingDetails(from = 0, max = Infinity) {
      const out: string[] = [];
      for (let i = from; i < commits.length && out.length < max; i++) if (commits[i]!.subject === null) out.push(commits[i]!.sha);
      return out;
    },
  };
  return hist;
}

// Replays a fresh log against `current` without disturbing it: commits that match the current
// prefix are skipped, and only from the first difference on is a new history built (forked from
// the shared prefix, so that part is not laid out again). Commit objects are reused throughout,
// so only commits that are new to us need their details fetched.
// `next` stays null while the stream matches; finish() returns null if nothing changed.
// If HEAD moved, every row may be laid out differently, so the layout is redone (the commit
// objects are still reused).
export function createMerge(current: History, head: string | null = current.graph.head): Merge {
  head ||= null;
  const moved = head !== current.graph.head;
  let i = 0;
  let next: History | null = null;
  const m: Merge = {
    get next() { return next; },
    get matched() { return i; },
    push(list) {
      let k = 0;
      if (!next) {
        for (; k < list.length; k++) {
          const o = current.commits[i];
          if (!o || o.sha !== list[k]!.sha) break;
          i++;
        }
        if (k === list.length) return m;
        next = current.fork(i, head);
      }
      // Commits we already have (just at another position) keep their loaded details.
      const add: LogCommit[] = [];
      for (; k < list.length; k++) {
        const c = list[k]!;
        const o = current.index.get(c.sha);
        add.push(o === undefined ? c : current.commits[o]!);
      }
      next.add(add);
      return m;
    },
    finish() {
      if (!next && (moved || i < current.length)) next = current.fork(i, head);
      if (next) next.complete = true;
      return next;
    },
  };
  return m;
}
