'use strict';
const { run } = require('./run');

// File history & blame

// One page of the commits that touched a file, newest first, following renames. Each entry has
// the file's path at that commit (and the previous path when the commit renamed it). The next
// page starts at the last entry's commit under its old path (`next`), so paging never re-walks
// the history already shown. `next` is null once the history is complete.
async function fileHistory(cwd, file, { from = 'HEAD', skip = 0, limit = 200 } = {}) {
  const fields = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');
  const out = await run(cwd, ['log', '-z', '--follow', '-M', `--format=%x1e${fields}`, '--name-status', `--skip=${skip}`, `-n${Math.min(limit, 1000)}`, from, '--', file]);
  const entries = parseFileHistory(out);
  const last = entries[entries.length - 1];
  const next = entries.length === Math.min(limit, 1000) ? { from: last.sha, skip: 1, path: last.oldPath || last.path } : null;
  return { entries, next };
}

function parseFileHistory(out) {
  const entries = [];
  for (const rec of out.split('\x1e')) {
    if (!rec) continue;
    const [head, ...rest] = rec.split('\0');
    const [sha, parents, author, email, time, subject] = head.split('\x1f');
    const [status = '', a, b] = rest.map((x) => x.replace(/^\n/, ''));
    const renamed = /^[RC]/.test(status);
    entries.push({
      sha, parents: parents ? parents.split(' ') : [], author, email, time: Number(time), subject,
      status: status.slice(0, 1) || 'M', path: renamed ? b : a, oldPath: renamed ? a : null,
    });
  }
  return entries;
}

// Paths of the files in the index (tracked files), for picking a file to show the history of.
async function trackedFiles(cwd) {
  const out = await run(cwd, ['ls-files', '-z']);
  return out.split('\0').filter(Boolean);
}

// `git blame --porcelain` of a file at a commit (or of the working tree file when `rev` is
// empty). Lines carry the commit index into `commits`, so a 100k-line file doesn't repeat the
// commit details on every line.
async function blame(cwd, file, rev) {
  const out = await run(cwd, ['blame', '--porcelain', ...(rev ? [rev] : []), '--', file]);
  return parseBlame(out);
}

const UNCOMMITTED = /^0{40}$|^0{64}$/;

function parseBlame(out) {
  const commits = [], index = new Map(), lines = [];
  let cur = null, line = 0;
  for (const l of out.split('\n')) {
    if (cur === null) {
      const m = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(l);
      if (!m) continue;
      if (!index.has(m[1])) {
        index.set(m[1], commits.length);
        commits.push({ sha: m[1], uncommitted: UNCOMMITTED.test(m[1]), author: '', email: '', time: 0, summary: '', path: '', boundary: false });
      }
      cur = commits[index.get(m[1])];
      line = Number(m[2]);
    } else if (l.startsWith('\t')) {
      lines.push({ line, commit: index.get(cur.sha), text: l.slice(1) });
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

module.exports = { fileHistory, parseFileHistory, trackedFiles, blame, parseBlame };
