'use strict';
// Thin, dependency-free wrapper around the git CLI. Every read uses
// GIT_OPTIONAL_LOCKS=0 so the file watcher never fights over index.lock.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE_ENV = {
  ...process.env,
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
};

class GitError extends Error {
  constructor(message, { code, stderr, stdout, args } = {}) {
    super(message);
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
    this.args = args;
  }
}

function run(cwd, args, { input, env, allowCodes = [0], maxBuffer = 512 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: { ...BASE_ENV, ...env }, maxBuffer, encoding },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        if (err && !allowCodes.includes(code)) {
          stderr = String(stderr || ''); stdout = String(stdout || '');
          const msg = (stderr || stdout || err.message).trim().split('\n').slice(-6).join('\n');
          reject(new GitError(msg || `git ${args[0]} failed`, { code, stderr, stdout, args }));
        } else {
          resolve(stdout);
        }
      },
    );
    if (input != null) child.stdin.end(input);
  });
}

// ---------------------------------------------------------------------------
// Repository discovery

// gitDir is this worktree's own admin dir; commonDir holds the refs and objects
// every worktree of the repository shares (the same dir for the main worktree).
async function openRepo(dir) {
  const out = await run(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  const [root, gitDir, commonDir] = out.trim().split('\n');
  return { root, gitDir, commonDir: path.resolve(commonDir), name: path.basename(root) };
}

async function initRepo(dir) {
  await run(dir, ['init']);
  return openRepo(dir);
}

function cloneRepo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', url, dest], { env: BASE_ENV });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      err += d;
      const line = d.split(/[\r\n]/).filter(Boolean).pop();
      if (line && onProgress) onProgress(line);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(openRepo(dest));
      else reject(new GitError(err.trim().split('\n').slice(-4).join('\n') || 'Clone failed'));
    });
  });
}

// ---------------------------------------------------------------------------
// History + refs

const SEP = '\x00';
const REC = '\x1e';

async function getRefs(cwd) {
  const out = await run(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)',
  ]);
  const refs = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [name, oid, peeled, upstream, track, date] = line.split(SEP);
    if (name === 'refs/stash') continue;
    let kind, short;
    if (name.startsWith('refs/heads/')) { kind = 'branch'; short = name.slice(11); }
    else if (name.startsWith('refs/remotes/')) {
      kind = 'remote'; short = name.slice(13);
      if (short.endsWith('/HEAD')) continue;
    } else if (name.startsWith('refs/tags/')) { kind = 'tag'; short = name.slice(10); }
    else continue;
    let ahead = 0, behind = 0;
    if (track) {
      const a = /ahead (\d+)/.exec(track); if (a) ahead = +a[1];
      const b = /behind (\d+)/.exec(track); if (b) behind = +b[1];
    }
    refs.push({ name, short, kind, target: peeled || oid, upstream: upstream || null, ahead, behind, gone: track === 'gone', date: +date || 0 });
  }
  let head = { detached: false, branch: null, oid: null };
  try {
    const sym = (await run(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] })).trim();
    head.branch = sym ? sym.replace(/^refs\/heads\//, '') : null;
    head.detached = !sym;
    head.oid = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim() || null;
  } catch { /* empty repo */ }
  return { refs, head };
}

// `heads`: extra commits to include, such as other worktrees' detached HEADs.
function logArgs({ remotes = true, tags = true, heads = [] } = {}) {
  return ['log', '--branches', ...(tags ? ['--tags'] : []), ...(remotes ? ['--remotes'] : []), 'HEAD', ...heads, '--date-order'];
}

// Log formats. Records end in REC; git adds a newline after each, which parsers skip.
// TOPO is read from git's commit-graph without opening commit objects, so it is several times
// faster than DETAILS, which needs every commit inflated.
const LOG_FORMATS = {
  topo: `--format=%H%x00%P${REC}`,
  details: `--format=%H%x00%an%x00%ae%x00%at%x00%s${REC}`,
  full: `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s${REC}`,
};

// History reads never go to the network: in a partial clone, a tag pointing at a missing tree
// would otherwise make every log wait on a fetch.
const LOG_ENV = { ...BASE_ENV, GIT_NO_LAZY_FETCH: '1' };

async function getLog(cwd, { limit, ...opts } = {}) {
  const args = [...logArgs(opts), ...(limit ? [`--max-count=${limit}`] : []), LOG_FORMATS.full];
  const out = await run(cwd, args, { allowCodes: [0, 128], env: LOG_ENV }).catch(() => '');
  const commits = [];
  for (const rec of out.split(REC)) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const [sha, parents, author, email, time, subject] = r.split(SEP);
    commits.push({ sha, parents: parents ? parents.split(' ') : [], author, email, time: +time, subject });
  }
  return commits;
}

// Stream `git log` as raw text. read() resolves with the next run of complete records (one
// string, so it crosses IPC cheaply) or null at the end. The first read returns as soon as
// anything arrives; later reads gather at least `batch` characters or wait `linger` ms, so a
// slow trickle from git doesn't turn into thousands of tiny IPC round trips. Output is buffered
// up to `highWater` characters before git is paused, so a slow reader applies backpressure.
// `preview` skips --date-order: without a commit-graph, git must walk the whole history before
// a date-ordered log prints anything, but plain commit-date order streams at once.
function streamLog(cwd, { kind = 'topo', preview = false, limit, batch = 256 << 10, linger = 25, highWater = 8 << 20, ...opts } = {}) {
  const args = logArgs(opts).filter((a) => !(preview && a === '--date-order'));
  if (limit) args.push(`--max-count=${limit}`);
  args.push(LOG_FORMATS[kind]);
  const child = spawn('git', args, { cwd, env: LOG_ENV });
  const chunks = [];
  let size = 0, tail = '', ended = false, waiting = null, first = true;
  const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    const s = tail + d;
    const cut = s.lastIndexOf(REC) + 1;
    tail = s.slice(cut);
    if (cut) { chunks.push(s.slice(0, cut)); size += cut; }
    if (size > highWater) child.stdout.pause();
    wake();
  });
  child.stderr.resume(); // empty repos and unborn HEADs just end the log
  child.on('close', () => { ended = true; wake(); });
  child.on('error', () => { ended = true; wake(); });
  const arrival = (ms) => new Promise((r) => {
    const t = ms == null ? null : setTimeout(() => { waiting = null; r(); }, ms);
    waiting = () => { clearTimeout(t); r(); };
  });
  return {
    async read() {
      while (!chunks.length && !ended) await arrival();
      if (!first) {
        const until = Date.now() + linger;
        while (size < batch && !ended && Date.now() < until) await arrival(until - Date.now());
      }
      first = false;
      if (!chunks.length) return null;
      const text = chunks.length === 1 ? chunks[0] : chunks.join('');
      chunks.length = 0; size = 0;
      child.stdout.resume();
      return text;
    },
    close() { ended = true; chunks.length = 0; if (child.exitCode === null) child.kill(); wake(); },
  };
}

// Details (DETAILS format) for specific commits, in the order given.
async function getLogDetails(cwd, shas) {
  if (!shas.length) return '';
  return run(cwd, ['log', '--no-walk=unsorted', '--stdin', LOG_FORMATS.details], { input: shas.join('\n') + '\n', allowCodes: [0, 128], env: LOG_ENV });
}

async function hasCommitGraph(cwd) {
  const info = path.resolve(cwd, (await run(cwd, ['rev-parse', '--git-path', 'objects/info'])).trim());
  return fs.existsSync(path.join(info, 'commit-graph')) || fs.existsSync(path.join(info, 'commit-graphs', 'commit-graph-chain'));
}

// git's commit-graph cache makes ordered logs stream immediately and topology reads ~5x faster.
// Fresh clones often lack it; `git gc` and `git maintenance` would write the same file.
function writeCommitGraph(cwd) {
  return run(cwd, ['commit-graph', 'write', '--reachable'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
}

async function getCommit(cwd, sha) {
  const out = await run(cwd, ['show', '-s', `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B`, sha]);
  const [h, parents, author, email, atime, committer, cemail, ctime, body] = out.split(SEP);
  const ps = parents ? parents.split(' ') : [];
  const files = await diffTreeFiles(cwd, ps[0] || null, h);
  return { sha: h, parents: ps, author, email, time: +atime, committer, committerEmail: cemail, commitTime: +ctime, message: body.replace(/\n+$/, ''), files };
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function diffTreeFiles(cwd, from, to) {
  const out = await run(cwd, ['diff-tree', '-r', '-z', '-M', '--numstat', '--no-commit-id', from || EMPTY_TREE, to]);
  const status = await run(cwd, ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', from || EMPTY_TREE, to]);
  const st = parseNameStatusZ(status);
  const stats = parseNumstatZ(out);
  return st.map((f) => ({ ...f, ...(stats.get(f.path) || { add: 0, del: 0, binary: false }) }));
}

function parseNameStatusZ(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const s = code[0];
    if (s === 'R' || s === 'C') {
      files.push({ status: s, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status: s, path: parts[i + 1] });
      i += 1;
    }
  }
  return files;
}

function parseNumstatZ(out) {
  const map = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!m) continue;
    let file = m[3];
    if (file === '') { file = parts[i + 2]; i += 2; } // rename: old, new follow
    map.set(file, { add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' });
  }
  return map;
}

async function commitFileDiff(cwd, sha, file, parent) {
  const base = parent || (await run(cwd, ['rev-parse', '-q', '--verify', `${sha}^`], { allowCodes: [0, 1] })).trim() || EMPTY_TREE;
  const out = await run(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, sha, '--', file.oldPath || file.path, file.path]);
  return parseDiff(out)[0] || null;
}

async function compareDiff(cwd, from, to) {
  const out = await run(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', from, to]);
  return parseDiff(out);
}

// ---------------------------------------------------------------------------
// Working copy

async function getStatus(cwd) {
  const out = await run(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  const staged = [], unstaged = [], conflicts = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    const t = line[0];
    if (t === '1') {
      const f = line.split(' ');
      const xy = f[1];
      const p = f.slice(8).join(' ');
      if (xy[0] !== '.') staged.push({ path: p, status: xy[0] });
      if (xy[1] !== '.') unstaged.push({ path: p, status: xy[1] });
    } else if (t === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const p = f.slice(9).join(' ');
      const orig = parts[++i];
      if (xy[0] !== '.') staged.push({ path: p, oldPath: orig, status: xy[0] });
      if (xy[1] !== '.') unstaged.push({ path: p, status: xy[1] });
    } else if (t === 'u') {
      const f = line.split(' ');
      conflicts.push({ path: f.slice(10).join(' '), status: 'U', xy: f[1] });
    } else if (t === '?') {
      unstaged.push({ path: line.slice(2), status: '?' });
    }
  }
  return { staged, unstaged, conflicts };
}

async function getOperationState(gitDir) {
  const exists = (p) => fs.existsSync(path.join(gitDir, p));
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  return null;
}

async function workingDiff(cwd, file, { staged }) {
  if (file.status === '?') {
    const out = await run(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path], { allowCodes: [0, 1] });
    return parseDiff(out)[0] || null;
  }
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) args.push('--cached', '-M');
  args.push('--', file.path);
  if (file.oldPath) args.push(file.oldPath);
  const out = await run(cwd, args);
  return parseDiff(out)[0] || null;
}

function parseDiff(text) {
  const files = [];
  let cur = null, hunk = null, oldNo = 0, newNo = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      cur = { header: [l], hunks: [], binary: false, oldPath: null, newPath: null };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (!hunk) {
      if (l.startsWith('--- ')) cur.oldPath = l.slice(4).replace(/^a\//, '');
      else if (l.startsWith('+++ ')) cur.newPath = l.slice(4).replace(/^b\//, '');
      else if (l.startsWith('Binary files')) cur.binary = true;
      if (!l.startsWith('@@')) { cur.header.push(l); continue; }
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(l);
      if (!m) continue;
      hunk = { header: l, oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], context: m[5].trim(), lines: [] };
      oldNo = hunk.oldStart; newNo = hunk.newStart;
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = l[0];
    if (c === ' ') hunk.lines.push({ t: ' ', s: l.slice(1), o: oldNo++, n: newNo++ });
    else if (c === '-') hunk.lines.push({ t: '-', s: l.slice(1), o: oldNo++, n: null });
    else if (c === '+') hunk.lines.push({ t: '+', s: l.slice(1), o: null, n: newNo++ });
    else if (c === '\\') { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.noEol = true; }
  }
  return files;
}

// Build a patch containing only the selected lines of a file diff.
// mode 'stage': applied forward to the index. Unselected '-' become context; unselected '+' vanish.
// mode 'reverse': applied with -R (unstage / discard). Unselected '+' become context; unselected '-' vanish.
function buildPartialPatch(fileDiff, selected, mode) {
  const sel = new Set(selected); // keys "h:i"
  const out = [];
  for (const h of fileDiff.header) {
    if (h.startsWith('diff --git') || h.startsWith('---') || h.startsWith('+++') || h.startsWith('new file') || h.startsWith('deleted file') || h.startsWith('index ') || h.startsWith('old mode') || h.startsWith('new mode')) out.push(h);
  }
  // Ensure ---/+++ present (always true for text diffs).
  let any = false;
  fileDiff.hunks.forEach((h, hi) => {
    const body = [];
    let oldCount = 0, newCount = 0, changed = false;
    h.lines.forEach((ln, li) => {
      const isSel = sel.has(`${hi}:${li}`);
      const push = (t, s, noEol) => {
        body.push(t + s);
        if (noEol) body.push('\\ No newline at end of file');
        if (t !== '+') oldCount++;
        if (t !== '-') newCount++;
      };
      if (ln.t === ' ') push(' ', ln.s, ln.noEol);
      else if (ln.t === '-') {
        if (isSel) { push('-', ln.s, ln.noEol); changed = true; }
        else if (mode === 'stage') push(' ', ln.s, ln.noEol);
      } else if (ln.t === '+') {
        if (isSel) { push('+', ln.s, ln.noEol); changed = true; }
        else if (mode === 'reverse') push(' ', ln.s, ln.noEol);
      }
    });
    if (!changed) return;
    any = true;
    out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`);
    out.push(...body);
  });
  return any ? out.join('\n') + '\n' : null;
}

async function applyPatch(cwd, patch, { cached, reverse }) {
  const args = ['apply', '--recount', '--whitespace=nowarn'];
  if (cached) args.push('--cached');
  if (reverse) args.push('-R');
  args.push('-');
  await run(cwd, args, { input: patch, env: { GIT_OPTIONAL_LOCKS: '1' } });
}

// ---------------------------------------------------------------------------
// Stashes, reflog, config

async function getStashes(cwd) {
  const out = await run(cwd, ['stash', 'list', '--format=%gd%x00%H%x00%at%x00%gs'], { allowCodes: [0, 1, 128] });
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, sha, time, msg] = l.split(SEP);
    return { ref, sha, time: +time, message: msg };
  });
}

async function getReflog(cwd, limit = 500) {
  const out = await run(cwd, ['log', '-g', `--max-count=${limit}`, '--format=%H%x00%gD%x00%gs%x00%ct%x00%s', '--all'], { allowCodes: [0, 128] }).catch(() => '');
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, selector, action, time, subject] = l.split(SEP);
    return { sha, selector, action, time: +time, subject };
  }).sort((a, b) => b.time - a.time);
}

async function getConfig(cwd) {
  // With -z every entry is "scope\0key\nvalue\0" (no newline when a key has no value).
  const out = await run(cwd, ['config', '--list', '--show-scope', '-z']);
  const parts = out.split('\0');
  const list = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [scope, kv] = [parts[i], parts[i + 1]];
    const nl = kv.indexOf('\n');
    list.push({ scope, key: nl === -1 ? kv : kv.slice(0, nl), value: nl === -1 ? '' : kv.slice(nl + 1) });
  }
  return list;
}

async function getRemotes(cwd) {
  const out = await run(cwd, ['remote', '-v']);
  const map = new Map();
  for (const l of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(l);
    if (m && !map.has(m[1])) map.set(m[1], m[2]);
  }
  return [...map].map(([name, url]) => ({ name, url, web: remoteWebUrl(url) }));
}

function remoteWebUrl(url) {
  let m = /^git@([^:]+):(.+?)(\.git)?$/.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)(\.git)?$/.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@]+@)?(.+?)(\.git)?$/.exec(url);
  if (m) return `https://${m[1]}`;
  return null;
}

// ---------------------------------------------------------------------------
// History rewriting (in-place commit editing), implemented as a
// non-interactive `git rebase -i` with a generated todo list.

async function rewrite(cwd, op, sha, extra = {}) {
  const onBranch = await run(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']).then(() => true, () => false);
  if (!onBranch) throw new GitError('This commit is not on the current branch. Check out a branch containing it first.');
  const parents = (await run(cwd, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').slice(1);
  if (parents.length > 1) throw new GitError('Rewriting merge commits is not supported.');

  // Where does the rebase start? swap/squash/fixup need the grandparent.
  const needsGrandparent = op === 'swapParent' || op === 'squash' || op === 'fixup';
  if (needsGrandparent && parents.length === 0) throw new GitError('The root commit has no parent to combine with.');
  let base = parents[0] || null;
  if (needsGrandparent) {
    const gp = (await run(cwd, ['rev-list', '--parents', '-n', '1', parents[0]])).trim().split(' ').slice(1);
    if (gp.length > 1) throw new GitError('The parent is a merge commit; cannot rewrite across it.');
    base = gp[0] || null;
  }
  const range = base ? `${base}..HEAD` : 'HEAD';
  const merges = (await run(cwd, ['rev-list', '--merges', range])).trim();
  if (merges) throw new GitError('There are merge commits between this commit and HEAD; rewriting would flatten them.');
  const list = (await run(cwd, ['rev-list', '--reverse', range])).trim().split('\n').filter(Boolean);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-'));
  const todo = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === sha) {
      if (op === 'drop') todo.push(`drop ${c}`);
      else if (op === 'reword') {
        const f = path.join(tmp, 'msg');
        fs.writeFileSync(f, extra.message);
        todo.push(`pick ${c}`, `exec git commit --amend --allow-empty --no-verify -q -F ${JSON.stringify(f)}`);
      } else if (op === 'squash') todo.push(`squash ${c}`);
      else if (op === 'fixup') todo.push(`fixup ${c}`);
      else if (op === 'swapParent') {
        // previous todo line is the parent; swap the two
        const prev = todo.pop();
        todo.push(`pick ${c}`, prev);
      } else todo.push(`pick ${c}`);
    } else todo.push(`pick ${c}`);
  }
  const todoFile = path.join(tmp, 'todo');
  fs.writeFileSync(todoFile, todo.join('\n') + '\n');
  const args = ['-c', 'rebase.instructionFormat=%s', 'rebase', '-i', '--autostash', '--empty=keep'];
  args.push(base ? base : '--root');
  try {
    await run(cwd, args, {
      env: {
        GIT_SEQUENCE_EDITOR: `cp ${JSON.stringify(todoFile)}`,
        GIT_EDITOR: 'true',
        GIT_OPTIONAL_LOCKS: '1',
      },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Snapshot of refs, used for unlimited undo/redo.

async function captureRefState(cwd) {
  const out = await run(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags']);
  const refs = {};
  for (const l of out.split('\n')) { if (!l) continue; const [n, o] = l.split(SEP); refs[n] = o; }
  const sym = (await run(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] })).trim();
  const oid = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim();
  return { refs, head: sym || null, headOid: oid || null };
}

async function restoreRefState(cwd, state, { soft = false, refsOnly = false } = {}) {
  const current = await captureRefState(cwd);
  const env = { GIT_OPTIONAL_LOCKS: '1' };
  // Move the working copy first so a dirty tree blocks the restore before any ref changes.
  // `soft` keeps the undone commit's changes staged (undoing a commit). `refsOnly` leaves
  // the index and working tree alone; the caller restores them from a work snapshot.
  if (!refsOnly && state.headOid && state.headOid !== current.headOid) {
    await run(cwd, ['reset', soft ? '--soft' : '--keep', state.headOid], { env });
  }
  const lines = [];
  for (const [n, o] of Object.entries(state.refs)) if (current.refs[n] !== o) lines.push(`update ${n} ${o}`);
  for (const n of Object.keys(current.refs)) if (!(n in state.refs)) lines.push(`delete ${n}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin', '-m', 'gitlanes: undo'], { input: lines.join('\n') + '\n', env });
  if (state.head) await run(cwd, ['symbolic-ref', 'HEAD', state.head], { env });
  else if (state.headOid) await run(cwd, ['update-ref', '--no-deref', 'HEAD', state.headOid], { env });
}

// ---------------------------------------------------------------------------
// Work snapshots: the exact index entries and working-tree bytes of a set of
// paths. Destructive working-copy operations record one before and one after
// they run, so undo and redo can put either state back byte for byte.

const W_ENV = { GIT_OPTIONAL_LOCKS: '1', GIT_LITERAL_PATHSPECS: '1' };
const UNDO_REFS = 'refs/gitlanes/undo';

function chunk(list, n = 500) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// `write` stores the blobs; without it the snapshot is only used for comparison.
async function snapshotWork(cwd, paths, { write = true } = {}) {
  const files = [...new Set(paths)].sort().map((p) => ({ path: p, index: [], wt: null }));
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const part of chunk(files.map((f) => f.path))) {
    const out = await run(cwd, ['ls-files', '-s', '-z', '--', ...part], { env: W_ENV });
    for (const rec of out.split('\0')) {
      const tab = rec.indexOf('\t');
      const f = tab === -1 ? null : byPath.get(rec.slice(tab + 1));
      if (!f) continue;
      const [mode, oid, stage] = rec.slice(0, tab).split(' ');
      f.index.push({ mode, oid, stage: +stage });
    }
  }
  const w = write ? ['-w'] : [];
  const regular = [];
  for (const f of files) {
    const abs = path.join(cwd, f.path);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
    if (st.isSymbolicLink()) {
      f.wt = { mode: '120000', oid: (await run(cwd, ['hash-object', ...w, '--stdin'], { input: fs.readlinkSync(abs) })).trim() };
    } else if (st.isFile()) {
      f.wt = { mode: st.mode & 0o100 ? '100755' : '100644', oid: null };
      regular.push(f);
    } else {
      f.wt = { mode: 'dir' }; // a folder or submodule; restore leaves it alone
    }
  }
  // --no-filters keeps the raw bytes (no CRLF or LFS conversion), which is what we write back.
  for (const part of chunk(regular)) {
    const out = await run(cwd, ['hash-object', ...w, '--no-filters', '--stdin-paths'], { input: part.map((f) => f.path).join('\n') + '\n' });
    out.trim().split('\n').forEach((oid, i) => { part[i].wt.oid = oid; });
  }
  return { files };
}

// Paths whose index entries or working-tree content differ between two snapshots.
function workChanges(a, b) {
  const key = (f) => JSON.stringify([f.index, f.wt]);
  const other = new Map(b.files.map((f) => [f.path, key(f)]));
  return a.files.filter((f) => other.get(f.path) !== key(f)).map((f) => f.path);
}

function snapshotBlobs(snap) {
  const out = [];
  for (const f of snap?.files || []) {
    for (const e of f.index) if (e.mode !== '160000') out.push(e.oid);
    if (f.wt?.oid) out.push(f.wt.oid);
  }
  return out;
}

async function restoreWork(cwd, snap) {
  for (const f of snap.files) {
    if (f.wt?.mode === 'dir') continue;
    const abs = path.join(cwd, f.path);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* absent */ }
    if (st?.isDirectory()) throw new GitError(`Cannot restore ${f.path}: a folder is in the way.`);
    if (!f.wt) { if (st) fs.unlinkSync(abs); continue; }
    const data = await run(cwd, ['cat-file', 'blob', f.wt.oid], { encoding: 'buffer' });
    if (st) fs.unlinkSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (f.wt.mode === '120000') fs.symlinkSync(data.toString(), abs);
    else fs.writeFileSync(abs, data, { mode: f.wt.mode === '100755' ? 0o777 : 0o666 });
  }
  // Replace every index entry of each path, conflict stages included.
  const format = (await run(cwd, ['rev-parse', '--show-object-format']).catch(() => '')).trim();
  const zero = '0'.repeat(format === 'sha256' ? 64 : 40);
  const recs = [];
  for (const f of snap.files) {
    recs.push(`0 ${zero}\t${f.path}`);
    for (const e of f.index) recs.push(`${e.mode} ${e.oid} ${e.stage}\t${f.path}`);
  }
  if (recs.length) await run(cwd, ['update-index', '-z', '--index-info'], { input: recs.join('\0') + '\0', env: W_ENV });
  await run(cwd, ['update-index', '-q', '--refresh'], { env: W_ENV, allowCodes: [0, 1] });
}

async function dirtyPaths(cwd) {
  const { staged, unstaged, conflicts } = await getStatus(cwd);
  return [...staged.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])), ...unstaged.map((f) => f.path), ...conflicts.map((f) => f.path)];
}

const treeNames = async (cwd, a, b) => (await run(cwd, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', a, b])).split('\0').filter(Boolean);

// Paths `git reset --hard <target>` can change: everything dirty, plus what differs between HEAD and target.
async function resetHardPaths(cwd, target) {
  const paths = await dirtyPaths(cwd);
  const head = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim();
  if (head && target) paths.push(...(await treeNames(cwd, head, target)));
  return paths;
}

// Paths applying a stash can change: everything dirty, plus every path the stash records.
async function stashPaths(cwd, ref) {
  const paths = await dirtyPaths(cwd);
  paths.push(...(await treeNames(cwd, `${ref}^1`, ref)), ...(await treeNames(cwd, `${ref}^1`, `${ref}^2`)));
  const untracked = (await run(cwd, ['rev-parse', '-q', '--verify', `${ref}^3`], { allowCodes: [0, 1] })).trim();
  if (untracked) paths.push(...(await run(cwd, ['ls-tree', '-r', '-z', '--name-only', untracked])).split('\0').filter(Boolean));
  return paths;
}

// ---------------------------------------------------------------------------
// Pins: refs under refs/gitlanes/ that keep the undo journal's objects
// reachable, so `git gc` never collects them. Blobs are gathered in one tree
// (a tree ref stays out of `git log --all`); commits and tags get a ref each.

const listRefs = async (cwd, prefix) => (await run(cwd, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(Boolean);

async function pinObjects(cwd, base, { blobs = [], objects = [] } = {}) {
  const want = new Map();
  const uniq = [...new Set(blobs.filter(Boolean))];
  if (uniq.length) {
    const input = uniq.map((oid, i) => `100644 blob ${oid}\t${i}`).join('\0') + '\0';
    want.set(`${base}/blobs`, (await run(cwd, ['mktree', '-z'], { input })).trim());
  }
  [...new Set(objects.filter(Boolean))].forEach((oid, i) => want.set(`${base}/${i}`, oid));
  const lines = [...want].map(([ref, oid]) => `update ${ref} ${oid}`);
  for (const ref of await listRefs(cwd, base)) if (!want.has(ref)) lines.push(`delete ${ref}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', env: W_ENV });
}

const pinUndo = (cwd, id, objs) => pinObjects(cwd, `${UNDO_REFS}/${id}`, objs);

// Remove the pins of journal entries that are gone.
async function pruneUndoPins(cwd, keepIds) {
  const keep = new Set(keepIds.map(String));
  const lines = (await listRefs(cwd, UNDO_REFS))
    .filter((ref) => !keep.has(ref.slice(UNDO_REFS.length + 1).split('/')[0]))
    .map((ref) => `delete ${ref}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', env: W_ENV });
}

// ---------------------------------------------------------------------------
// Stash list edits used to undo and redo a dropped stash.

async function dropStashCommit(cwd, sha) {
  const i = (await getStashes(cwd)).findIndex((x) => x.sha === sha);
  if (i === -1) throw new GitError('That stash no longer exists.');
  await run(cwd, ['stash', 'drop', '-q', `stash@{${i}}`], { env: W_ENV });
}

// Put a dropped stash back at its old position, with its old message.
async function restoreStash(cwd, { sha, message, index }) {
  const list = await getStashes(cwd);
  if (list.some((x) => x.sha === sha)) return;
  const above = list.slice(0, index);
  // Entries lifted off the top are pinned first, so a failure part-way loses nothing.
  const lift = 'refs/gitlanes/stash-lift';
  await pinObjects(cwd, lift, { objects: above.map((x) => x.sha) });
  for (let i = 0; i < above.length; i++) await run(cwd, ['stash', 'drop', '-q', 'stash@{0}'], { env: W_ENV });
  for (const e of [{ sha, message }, ...above.reverse()]) await run(cwd, ['stash', 'store', '-q', '-m', e.message, e.sha], { env: W_ENV });
  await pinObjects(cwd, lift);
}

// ---------------------------------------------------------------------------
// Destructive working-copy operations. Run them through the journal
// (journal.js), which snapshots what they destroy.

async function discardFiles(cwd, files) {
  const tracked = files.filter((f) => f.status !== '?').map((f) => f.path);
  const untracked = files.filter((f) => f.status === '?').map((f) => f.path);
  if (tracked.length) await run(cwd, ['checkout', '--', ...tracked], { env: W_ENV });
  if (untracked.length) await run(cwd, ['clean', '-f', '-q', '--', ...untracked], { env: W_ENV });
}

async function discardLines(cwd, file, selected) {
  const d = await workingDiff(cwd, file, { staged: false });
  const p = d && buildPartialPatch(d, selected, 'reverse');
  if (p) await applyPatch(cwd, p, { reverse: true });
}

const resetHard = (cwd, sha) => run(cwd, ['reset', '--hard', sha || 'HEAD'], { env: W_ENV });

async function chooseSide(cwd, p, side) {
  await run(cwd, ['checkout', `--${side}`, '--', p], { env: W_ENV });
  await run(cwd, ['add', '--', p], { env: W_ENV });
}

const stashApply = (cwd, ref, pop) => run(cwd, ['stash', pop ? 'pop' : 'apply', '--index', ref], { env: W_ENV });
const stashDrop = (cwd, ref) => run(cwd, ['stash', 'drop', ref], { env: W_ENV });

// ---------------------------------------------------------------------------
// Worktrees. Each one is a plain record, so later features (per-agent lanes)
// can hang more fields off it without changing the callers.

const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const samePath = (a, b) => realpath(a) === realpath(b);
const NULL_OID = /^0+$/;

async function getWorktrees(cwd) {
  const out = await run(cwd, ['worktree', 'list', '--porcelain', '-z']);
  const here = realpath(cwd);
  const list = [];
  let cur = null;
  for (const field of out.split('\0')) {
    if (!field) { cur = null; continue; }
    const sp = field.indexOf(' ');
    const key = sp === -1 ? field : field.slice(0, sp);
    const val = sp === -1 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      cur = { path: val, name: path.basename(val), head: null, branch: null, detached: false, bare: false, main: !list.length, current: realpath(val) === here, locked: false, lockReason: '', missing: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (key === 'HEAD') cur.head = NULL_OID.test(val) ? null : val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') { cur.locked = true; cur.lockReason = val; }
    else if (key === 'prunable') cur.missing = true;
  }
  return list.filter((w) => !w.bare);
}

async function findWorktree(cwd, dir) {
  const wt = (await getWorktrees(cwd)).find((w) => samePath(w.path, dir));
  if (!wt) throw new GitError('That worktree no longer exists.');
  return wt;
}

// Number of changed, untracked or conflicted paths in a worktree.
async function worktreeChanges(dir) {
  return new Set(await dirtyPaths(dir)).size;
}

// Where a new worktree goes when the user gives no location: next to the main
// worktree, named "<repo>-<branch>", with a number added if that is taken.
function defaultWorktreePath(mainPath, label) {
  const slug = label.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'worktree';
  const base = path.join(path.dirname(mainPath), `${path.basename(mainPath)}-${slug}`);
  let dir = base;
  for (let i = 2; fs.existsSync(dir); i++) dir = `${base}-${i}`;
  return dir;
}

function resolveWorktreePath(mainPath, dir) {
  if (dir.startsWith('~/') || dir === '~') dir = path.join(os.homedir(), dir.slice(1));
  return path.resolve(path.dirname(mainPath), dir);
}

// Add a worktree. `branch`: an existing local branch is checked out, a new name
// is created at `base`; no branch gives a detached HEAD at `base`. Returns the path.
async function addWorktree(cwd, { dir, branch, base } = {}) {
  const main = (await getWorktrees(cwd)).find((w) => w.main);
  const at = base || 'HEAD';
  dir = dir ? resolveWorktreePath(main.path, dir) : defaultWorktreePath(main.path, branch || (await run(cwd, ['rev-parse', '--short', at])).trim());
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new GitError(`${dir} already exists and is not an empty folder.`);
  const local = branch && (await run(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { allowCodes: [0, 1] })).trim();
  const args = ['worktree', 'add', '-q'];
  if (!branch) args.push('--detach', dir, at);
  else if (local) args.push(dir, branch);
  else args.push('-b', branch, dir, at);
  await run(cwd, args, { env: W_ENV });
  return realpath(dir);
}

// Remove a worktree's folder. Refused unless the worktree is clean: there is
// nothing to snapshot then, and undo can recreate it from its branch or commit.
// Ignored files (build output, dependencies) are deleted with the folder.
async function removeWorktree(cwd, dir) {
  const wt = await findWorktree(cwd, dir);
  if (wt.main) throw new GitError('The main worktree can’t be removed.');
  if (wt.current) throw new GitError('This window is showing that worktree. Switch to another one first.');
  if (wt.locked) throw new GitError(`“${wt.name}” is locked${wt.lockReason ? ` (${wt.lockReason})` : ''}. Unlock it first.`);
  if (wt.missing) throw new GitError(`“${wt.name}” no longer exists on disk. Use Prune Missing Worktrees instead.`);
  const n = await worktreeChanges(wt.path);
  if (n) throw new GitError(`“${wt.name}” has ${n} uncommitted change${n > 1 ? 's' : ''}. Commit, stash or discard ${n > 1 ? 'them' : 'it'} first.`);
  const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
  if (op) throw new GitError(`“${wt.name}” has a ${op} in progress. Finish or abort it first.`);
  await run(cwd, ['worktree', 'remove', wt.path], { env: W_ENV });
  return wt;
}

// Put a removed worktree back at the same path, on the same branch or commit.
async function restoreWorktree(cwd, { path: dir, branch, head }) {
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new GitError(`${dir} is in the way.`);
  await run(cwd, ['worktree', 'add', '-q', ...(branch ? [dir, branch] : ['--detach', dir, head])], { env: W_ENV });
}

const lockWorktree = async (cwd, dir, reason) => run(cwd, ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), (await findWorktree(cwd, dir)).path], { env: W_ENV });
const unlockWorktree = async (cwd, dir) => run(cwd, ['worktree', 'unlock', (await findWorktree(cwd, dir)).path], { env: W_ENV });
const pruneWorktrees = (cwd) => run(cwd, ['worktree', 'prune'], { env: W_ENV });

module.exports = {
  GitError, run, openRepo, initRepo, cloneRepo, getRefs, getLog, streamLog, getLogDetails, hasCommitGraph, writeCommitGraph, getCommit, commitFileDiff, compareDiff,
  getStatus, getOperationState, workingDiff, parseDiff, buildPartialPatch, applyPatch,
  getStashes, getReflog, getConfig, getRemotes, remoteWebUrl, rewrite, captureRefState, restoreRefState,
  snapshotWork, workChanges, snapshotBlobs, restoreWork, resetHardPaths, stashPaths,
  pinUndo, pruneUndoPins, dropStashCommit, restoreStash,
  discardFiles, discardLines, resetHard, chooseSide, stashApply, stashDrop,
  samePath, getWorktrees, findWorktree, worktreeChanges, defaultWorktreePath, addWorktree, removeWorktree,
  restoreWorktree, lockWorktree, unlockWorktree, pruneWorktrees,
};

