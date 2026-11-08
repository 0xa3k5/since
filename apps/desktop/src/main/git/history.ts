import { run } from './run.ts';
import type { Blame, BlameCommit, BlameLine, FileHistoryEntry, FileHistoryPage } from '../../shared/git-types.ts';

// File history & blame

// One page of the commits that touched a file, newest first, following renames. Each entry has
// the file's path at that commit (and the previous path when the commit renamed it). The next
// page starts at the last entry's commit under its old path (`next`), so paging never re-walks
// the history already shown. `next` is null once the history is complete.
export async function fileHistory(cwd: string, file: string, { from = 'HEAD', skip = 0, limit = 200 }: { from?: string; skip?: number; limit?: number } = {}): Promise<FileHistoryPage> {
  const fields = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');
  const out = await run(cwd, ['log', '-z', '--follow', '-M', `--format=%x1e${fields}`, '--name-status', `--skip=${skip}`, `-n${Math.min(limit, 1000)}`, from, '--', file]);
  const entries = parseFileHistory(out);
  const last = entries[entries.length - 1];
  const next = last && entries.length === Math.min(limit, 1000) ? { from: last.sha, skip: 1, path: last.oldPath || last.path } : null;
  return { entries, next };
}

export function parseFileHistory(out: string): FileHistoryEntry[] {
  const entries: FileHistoryEntry[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec) continue;
    const [head = '', ...rest] = rec.split('\0');
    const [sha = '', parents, author = '', email = '', time, subject = ''] = head.split('\x1f');
    const [status = '', a = '', b = ''] = rest.map((x) => x.replace(/^\n/, ''));
    const renamed = /^[RC]/.test(status);
    entries.push({
      sha, parents: parents ? parents.split(' ') : [], author, email, time: Number(time), subject,
      status: status.slice(0, 1) || 'M', path: renamed ? b : a, oldPath: renamed ? a : null,
    });
  }
  return entries;
}

// Paths of the files in the index (tracked files), for picking a file to show the history of.
export async function trackedFiles(cwd: string): Promise<string[]> {
  const out = await run(cwd, ['ls-files', '-z']);
  return out.split('\0').filter(Boolean);
}

// `git blame --porcelain` of a file at a commit (or of the working tree file when `rev` is
// empty). Lines carry the commit index into `commits`, so a 100k-line file doesn't repeat the
// commit details on every line.
export async function blame(cwd: string, file: string, rev?: string | null): Promise<Blame> {
  const out = await run(cwd, ['blame', '--porcelain', ...(rev ? [rev] : []), '--', file]);
  return parseBlame(out);
}

const UNCOMMITTED = /^0{40}$|^0{64}$/;

export function parseBlame(out: string): Blame {
  const commits: BlameCommit[] = [], index = new Map<string, number>(), lines: BlameLine[] = [];
  let cur: BlameCommit | null = null, curIndex = 0, line = 0;
  for (const l of out.split('\n')) {
    if (cur === null) {
      const m = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(l);
      if (!m) continue;
      const sha = m[1] ?? '';
      let i = index.get(sha);
      if (i === undefined) {
        i = commits.length;
        index.set(sha, i);
        commits.push({ sha, uncommitted: UNCOMMITTED.test(sha), author: '', email: '', time: 0, summary: '', path: '', boundary: false });
      }
      cur = commits[i] ?? null;
      curIndex = i;
      line = Number(m[2]);
    } else if (l.startsWith('\t')) {
      lines.push({ line, commit: curIndex, text: l.slice(1) });
      cur = null;
    } else {
      const sp = l.indexOf(' ');
      const key = sp < 0 ? l : l.slice(0, sp), val = sp < 0 ? '' : l.slice(sp + 1);
      if (key === 'author') cur.author = val;
      else if (key === 'author-mail') cur.email = val.replace(/^<|>$/g, '');
      else if (key === 'author-time') cur.time = Number(val);
      else if (key === 'summary') cur.summary = val;
      else if (key === 'filename') cur.path = val;
      else if (key === 'boundary') cur.boundary = true;
    }
  }
  return { commits, lines };
}
