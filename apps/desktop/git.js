'use strict';
// Thin, dependency-free wrapper around the git CLI. Every read uses
// GIT_OPTIONAL_LOCKS=0 so the file watcher never fights over index.lock.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// GPG_TTY is dropped so a terminal pinentry never waits on a terminal the user can't see.
// ssh/ssh-keygen ask through SSH_ASKPASS instead of /dev/tty, so a locked SSH key fails
// fast; a user's own askpass helper is kept.
const { GPG_TTY: _tty, ...PARENT_ENV } = process.env;
const BASE_ENV = {
  ...PARENT_ENV,
  SSH_ASKPASS: PARENT_ENV.SSH_ASKPASS || '/usr/bin/false',
  SSH_ASKPASS_REQUIRE: PARENT_ENV.SSH_ASKPASS_REQUIRE || 'force',
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

// Signing failures (locked GPG key, SSH key not in ssh-agent, missing key) get one
// readable message instead of gpg's or ssh-keygen's raw output.
const SIGN_FAIL = /gpg failed to sign|failed to sign the data|ssh-keygen|signing failed|incorrect passphrase|no (?:secret|private) key|couldn't (?:load|sign)|agent refused/i;
function signingError(stderr) {
  if (!SIGN_FAIL.test(stderr)) return null;
  const detail = stderr.trim().split('\n').map((l) => l.replace(/^(error|fatal): /, '').trim()).find((l) => l && !/failed to write commit object/.test(l)) || '';
  return `Couldn't sign the commit. Unlock your GPG key, or add your SSH signing key to ssh-agent (ssh-add), then try again.${detail ? `\n${detail}` : ''}`;
}

// Push, pull and fetch failures we can offer a fix for, from git's output: 'rejected' (the remote
// has commits this branch doesn't), 'diverged' (pull needs a rebase or merge) or 'auth' (message cut
// to git's one line about it). Anything else keeps git's output.
const AUTH_FAIL = /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|Invalid username or (?:password|token)|The requested URL returned error: 40[13]/i;
function remoteFailure(err) {
  const text = `${err.stderr || ''}\n${err.message}`;
  if (/\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/.test(text)) err.code = 'rejected';
  else if (/divergent branches|Need to specify how to reconcile/i.test(text)) err.code = 'diverged';
  else if (AUTH_FAIL.test(text)) {
    err.code = 'auth';
    err.message = text.split('\n').map((l) => l.replace(/^(?:remote: |fatal: |error: )+/, '').trim()).find((l) => AUTH_FAIL.test(l)) || err.message;
  }
  return err;
}

// Pull the current branch; `mode` 'rebase' or 'merge' settles diverged branches.
const pull = (cwd, mode) => run(cwd, ['pull', '--no-edit', ...(mode === 'rebase' ? ['--rebase'] : mode === 'merge' ? ['--no-rebase'] : [])]);

// The facts behind a diverged pull or a rejected push (AK-585): the commits only on the upstream
// (`theirs`) and only here (`ours`), up to `max` of each with their counts; `conflicts`: files a merge
// would conflict on ([] clean, null when merge-tree can't tell); `shared`: some of ours are on a
// remote already, so rebasing them would rewrite pushed commits. null without an upstream. `fetch`:
// fetch the upstream's remote first.
async function divergence(cwd, { fetch = false, max = 5 } = {}) {
  const up = (await run(cwd, ['rev-parse', '-q', '--verify', '--symbolic-full-name', '@{u}'], { allowCodes: [0, 1, 128] }).catch(() => '')).trim();
  if (!up) return null;
  // A rejected push: the remote has commits this clone hasn't fetched yet.
  if (fetch) await run(cwd, ['fetch', '-q', up.split('/')[2]]).catch(() => {});
  const branch = (await run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] })).trim();
  const [theirsN, oursN] = (await run(cwd, ['rev-list', '--left-right', '--count', `${up}...HEAD`])).trim().split(/\s+/).map(Number);
  const list = async (range) => (await run(cwd, ['log', '-z', `-n${max}`, '--format=%H%x1f%s%x1f%an%x1f%ct', range, '--'])).split('\0').filter(Boolean)
    .map((l) => { const [sha, subject, author, t] = l.replace(/^\n/, '').split('\x1f'); return { sha, subject, author, date: Number(t) * 1000 }; });
  const [theirs, ours, unpushed] = await Promise.all([
    list(`HEAD..${up}`), list(`${up}..HEAD`),
    run(cwd, ['rev-list', '--count', `${up}..HEAD`, '--not', '--remotes']).then((o) => Number(o.trim()), () => oursN),
  ]);
  let conflicts = null;
  if (theirsN && oursN && await canForecast(cwd)) {
    const [a, b] = (await run(cwd, ['rev-parse', 'HEAD', up])).trim().split('\n');
    conflicts = await mergeConflicts(cwd, a, b);
  }
  return { branch, upstream: up.replace(/^refs\/remotes\//, ''), theirs, theirsCount: theirsN, ours, oursCount: oursN, conflicts, shared: unpushed < oursN };
}

// Cherry-pick one commit. One whose changes are already here stops git half-way; leave nothing
// in progress and say so ('empty-pick'). `keepEmpty` commits it anyway.
async function cherryPick(cwd, sha, keepEmpty) {
  if (keepEmpty) return run(cwd, ['cherry-pick', '--allow-empty', '--keep-redundant-commits', sha]);
  try {
    return await run(cwd, ['cherry-pick', sha]);
  } catch (err) {
    if (!/is now empty|nothing to commit/.test(`${err.stderr || ''}\n${err.message}`) || (await getStatus(cwd)).conflicts?.length) throw err;
    await run(cwd, ['cherry-pick', '--abort']).catch(() => {});
    throw new GitError('Its changes are already on this branch.', { code: 'empty-pick' });
  }
}

function run(cwd, args, { input, env, allowCodes = [0], maxBuffer = 512 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      // detached = own session with no controlling terminal, so gpg and ssh-keygen fail
      // fast instead of waiting for a passphrase typed into a terminal.
      { cwd, env: { ...BASE_ENV, ...env }, maxBuffer, encoding, detached: process.platform !== 'win32' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        if (err && !allowCodes.includes(code)) {
          stderr = String(stderr || ''); stdout = String(stdout || '');
          const msg = signingError(stderr) || (stderr || stdout || err.message).trim().split('\n').slice(-6).join('\n');
          reject(new GitError(msg || `git ${args[0]} failed`, { code, stderr, stdout, args }));
        } else {
          resolve(stdout);
        }
      },
    );
    // Always close stdin: with no terminal, ssh-keygen reads a passphrase from it and would wait forever.
    child.stdin.end(input ?? undefined);
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
    const child = spawn('git', ['clone', '--progress', '--', url, dest], { env: { ...BASE_ENV, GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh' } });
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
// CO_AUTHORS is the values of Co-authored-by trailers, \x1f-separated, so bodies aren't fetched.
const CO_AUTHORS = '%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1f)';
const LOG_FORMATS = {
  topo: `--format=%H%x00%P${REC}`,
  details: `--format=%H%x00%an%x00%ae%x00%at%x00%s%x00${CO_AUTHORS}${REC}`,
  full: `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00${CO_AUTHORS}${REC}`,
};

// `Name <email>` trailer values (\x1f-separated) to [{ name, email }], deduped by email and
// without the author. Same as parseCoAuthors in renderer/log.js.
function parseCoAuthors(raw, author) {
  if (!raw) return [];
  const seen = new Set([(author || '').toLowerCase()]), out = [];
  for (const v of raw.split('\x1f')) {
    const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(v);
    if (!m || seen.has(m[2].toLowerCase())) continue;
    seen.add(m[2].toLowerCase());
    out.push({ name: m[1] || m[2], email: m[2] });
  }
  return out;
}

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
    const [sha, parents, author, email, time, subject, co] = r.split(SEP);
    commits.push({ sha, parents: parents ? parents.split(' ') : [], author, email, time: +time, subject, coAuthors: parseCoAuthors(co, email) });
  }
  return commits;
}

// Stream `git log` as raw text. read() resolves with the next run of complete records (one
// string, so it crosses IPC cheaply) or null at the end. The first read returns as soon as
// anything arrives; later reads gather at least `batch` characters or wait `linger` ms, so a
// slow trickle from git doesn't turn into thousands of tiny IPC round trips. If git dies (killed,
// crashed, failed to start) the read after its last output throws, so a cut-short log never
// looks complete; exit 128 (empty repo, unborn HEAD) is a normal end. Output is buffered
// up to `highWater` characters before git is paused, so a slow reader applies backpressure.
// `preview` skips --date-order: without a commit-graph, git must walk the whole history before
// a date-ordered log prints anything, but plain commit-date order streams at once.
function streamLog(cwd, { kind = 'topo', preview = false, limit, batch = 256 << 10, linger = 25, highWater = 8 << 20, ...opts } = {}) {
  const args = logArgs(opts).filter((a) => !(preview && a === '--date-order'));
  if (limit) args.push(`--max-count=${limit}`);
  args.push(LOG_FORMATS[kind]);
  const child = spawn('git', args, { cwd, env: LOG_ENV });
  const chunks = [];
  let size = 0, tail = '', ended = false, waiting = null, first = true, closed = false, failure = null;
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
  child.on('close', (code, signal) => {
    if (!closed && (signal || (code !== 0 && code !== 128))) failure ||= `git log exited with ${signal || code}`;
    ended = true; wake();
  });
  child.on('error', (e) => { failure ||= e.message; ended = true; wake(); });
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
      if (!chunks.length) {
        if (failure && !closed) throw new GitError(failure, { args });
        return null;
      }
      const text = chunks.length === 1 ? chunks[0] : chunks.join('');
      chunks.length = 0; size = 0;
      child.stdout.resume();
      return text;
    },
    close() { closed = ended = true; chunks.length = 0; if (child.exitCode === null) child.kill(); wake(); },
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
  const out = await run(cwd, ['show', '-s', `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%G?%x00%GS%x00${CO_AUTHORS}%x00%B`, sha]);
  const [h, parents, author, email, atime, committer, cemail, ctime, sig, signer, co, body] = out.split(SEP);
  const ps = parents ? parents.split(' ') : [];
  const files = await diffTreeFiles(cwd, ps[0] || null, h);
  // Git reports an SSH signature it can't check (no allowed signers file) as unsigned; read the header instead.
  const signed = sig !== 'N' || /^gpgsig(-sha256)? /m.test((await run(cwd, ['cat-file', 'commit', h])).split('\n\n')[0]);
  return { sha: h, parents: ps, author, email, time: +atime, committer, committerEmail: cemail, commitTime: +ctime, signature: signed ? signatureStatus(sig === 'N' ? 'E' : sig, signer) : null, coAuthors: parseCoAuthors(co, email), message: body.replace(/\n+$/, ''), files };
}

// %G? codes: G good, U good but untrusted key, X/Y expired signature/key, R revoked,
// B bad, E can't be checked (key or allowed-signers file missing), N unsigned.
function signatureStatus(code, signer) {
  const state = { G: 'good', U: 'good', X: 'expired', Y: 'expired', R: 'revoked', B: 'bad', E: 'unverified' }[code];
  return state ? { state, signer: signer || '' } : null;
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

// Every file diff of a commit against its first parent, without rename
// detection: the commit splitter selects lines from these.
async function commitDiffs(cwd, sha) {
  return (await readCommitDiffs(cwd, sha)).map(([d]) => d);
}

// Pairs of [text, raw] for each file: the same diff decoded as UTF-8 for display
// and as latin1, which maps every byte to one char, so patches built from it
// round-trip byte-exactly. Line breaks are the same bytes in both, so hunk and
// line indices (the selection keys) match.
async function readCommitDiffs(cwd, sha) {
  const parent = (await run(cwd, ['rev-parse', '-q', '--verify', `${sha}^`], { allowCodes: [0, 1] })).trim() || EMPTY_TREE;
  const buf = await run(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', parent, sha], { encoding: 'buffer' });
  const raw = parseDiff(buf.toString('latin1'));
  return parseDiff(buf.toString('utf8')).map((d, i) => {
    const r = raw[i];
    r.path = d.path = diffPath(d.header[0]);
    // A submodule bump has no lines to pick; it goes whole into one commit.
    if (d.header.slice(1).some((l) => / 160000$/.test(l))) { d.hunks = []; r.hunks = []; d.gitlink = r.gitlink = true; }
    return [d, r];
  });
}

// Without renames both sides of "diff --git a/<p> b/<p>" are the same path; binary
// and mode-only diffs have no ---/+++ lines, so read it from there. Git C-quotes
// names containing '"', '\\', or control characters even with core.quotePath=false.
function diffPath(line) {
  const rest = line.slice('diff --git '.length);
  if (rest[0] !== '"') return rest.slice(2, 2 + (rest.length - 5) / 2);
  const bytes = [];
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 1; i < rest.length && rest[i] !== '"'; i++) {
    let c = String.fromCodePoint(rest.codePointAt(i));
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); i += c.length - 1; continue; }
    c = rest[++i];
    if (/[0-7]/.test(c)) { bytes.push(parseInt(rest.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(esc[c] ?? c.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8').slice(2);
}

async function compareDiff(cwd, from, to) {
  const out = await run(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', from, to]);
  return parseDiff(out);
}

// ---------------------------------------------------------------------------
// Working copy

// `paths` limits it to those files.
async function getStatus(cwd, paths) {
  const out = await run(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all', ...(paths ? ['--', ...paths] : [])], paths ? { env: W_ENV } : {});
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
      // `inside`: a submodule whose checked-out commit is unchanged, only its own files.
      if (xy[1] !== '.') unstaged.push({ path: p, status: xy[1], ...(f[2][0] === 'S' && f[2][1] === '.' && { inside: true }) });
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

// ---------------------------------------------------------------------------
// Git LFS. Everything here is read-only and works without git-lfs installed: LFS files
// are found through their gitattributes, and a working file that still holds the small
// pointer text hasn't been downloaded.

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';
const LFS_POINTER_MAX = 1024; // git-lfs never writes a pointer larger than this
const LFS_FILE_CAP = 5000;

function parseLfsPointer(text) {
  if (!text || text.length > LFS_POINTER_MAX || !text.startsWith(LFS_POINTER)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text);
  const size = /^size (\d+)$/m.exec(text);
  return oid && size ? { oid: oid[1], size: Number(size[1]) } : null;
}

// Patterns from the top-level .gitattributes that route files through the LFS filter.
function parseLfsPatterns(text) {
  return text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /(^|\s)filter=lfs(\s|$)/.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

async function lfsVersion(cwd) {
  const out = await run(cwd, ['lfs', 'version']).catch(() => null);
  return out ? out.trim().split('\n')[0] : null;
}

async function lfsWorkState(root, p) {
  let fh;
  try { fh = await fs.promises.open(path.join(root, p), 'r'); } catch { return { state: 'missing' }; }
  try {
    const { size } = await fh.stat();
    if (size > LFS_POINTER_MAX) return { state: 'downloaded', size };
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    const ptr = parseLfsPointer(buf.toString('utf8'));
    return ptr ? { state: 'pointer', size: ptr.size, oid: ptr.oid } : { state: 'downloaded', size };
  } finally { await fh.close(); }
}

// used: the repository routes files through LFS. installed: git-lfs runs here.
// files[].state: 'downloaded' | 'pointer' (not fetched) | 'missing' (deleted from the working tree).
// files[].stored: false when the index holds the whole file instead of a pointer, which
// happens when the file was added without git-lfs installed.
async function getLfs(cwd) {
  const [attrs, staged, version] = await Promise.all([
    fs.promises.readFile(path.join(cwd, '.gitattributes'), 'utf8').catch(() => ''),
    run(cwd, ['ls-files', '-s', '-z', '--', ':(attr:filter=lfs)']),
    lfsVersion(cwd),
  ]);
  const patterns = parseLfsPatterns(attrs);
  const entries = new Map();
  for (const rec of staged.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab > 0 && !entries.has(rec.slice(tab + 1))) entries.set(rec.slice(tab + 1), rec.split(' ')[1]);
  }
  const used = patterns.length > 0 || entries.size > 0;
  const list = [...entries].slice(0, LFS_FILE_CAP);
  const sizes = list.length ? (await run(cwd, ['cat-file', '--batch-check=%(objectsize)'], { input: list.map(([, oid]) => oid).join('\n') + '\n' })).split('\n') : [];
  const files = await Promise.all(list.map(async ([p], i) => ({ path: p, stored: !(Number(sizes[i]) > LFS_POINTER_MAX), ...(await lfsWorkState(cwd, p)) })));
  return { used, installed: !!version, version, patterns, files, truncated: entries.size > list.length };
}

// Marks status entries whose path goes through the LFS filter (lfs: true).
async function markLfs(cwd, status) {
  const all = [...status.staged, ...status.unstaged, ...status.conflicts];
  if (!all.length) return status;
  const out = await run(cwd, ['check-attr', '-z', '--stdin', 'filter'], { input: [...new Set(all.map((f) => f.path))].join('\0') + '\0' });
  const parts = out.split('\0');
  const lfs = new Set();
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'lfs') lfs.add(parts[i]);
  for (const f of all) if (lfs.has(f.path)) f.lfs = true;
  return status;
}

// Submodules. The superproject records one commit per submodule (a gitlink entry in the
// index); each submodule's `state` compares its own checkout with that:
//   uninitialized: not cloned or not checked out yet (Update fixes that)
//   outdated: checked out at another commit than the one recorded
//   modified: its work tree has uncommitted changes or untracked files
//   conflict: the recorded commit is in a merge conflict
//   clean: checked out at the recorded commit, nothing changed
const SUBMODULE_CAP = 500;

// .gitmodules as `git config -z --get-regexp` prints it → Map(path → { name, url }).
function parseGitmodules(out) {
  const byName = new Map();
  for (const rec of out.split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl === -1) continue;
    const m = /^submodule\.(.+)\.(path|url)$/.exec(rec.slice(0, nl));
    if (!m) continue;
    const e = byName.get(m[1]) || { name: m[1] };
    e[m[2]] = rec.slice(nl + 1);
    byName.set(m[1], e);
  }
  return new Map([...byName.values()].filter((e) => e.path).map((e) => [e.path, { name: e.name, url: e.url || '' }]));
}

// The submodule's checked-out commit and branch, or null when it isn't checked out.
async function submoduleHead(cwd, p) {
  const abs = path.join(cwd, p);
  if (!fs.existsSync(path.join(abs, '.git'))) return null;
  const sha = (await run(abs, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] }).catch(() => '')).trim();
  if (!sha) return null;
  const branch = (await run(abs, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] }).catch(() => '')).trim();
  return { sha, branch: branch || null };
}

const submoduleDirty = async (cwd, p) => !!(await run(path.join(cwd, p), ['status', '--porcelain', '-z', '--ignore-submodules=none']).catch(() => ''));

async function getSubmodules(cwd) {
  // Runs on every status refresh, so the index is only read at the paths .gitmodules lists.
  if (!fs.existsSync(path.join(cwd, '.gitmodules'))) return [];
  const info = parseGitmodules(await run(cwd, ['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\.'], { allowCodes: [0, 1] }));
  if (!info.size) return [];
  const staged = await run(cwd, ['ls-files', '-s', '-z', '--', ...[...info.keys()].map((p) => `:(literal)${p}`)]);
  const links = new Map(); // path → { recorded, conflict }
  for (const rec of staged.split('\0')) {
    const m = /^160000 ([0-9a-f]+) (\d)\t(.+)$/.exec(rec);
    if (!m) continue;
    const e = links.get(m[3]) || { recorded: null, conflict: false };
    if (m[2] === '0') e.recorded = m[1]; else e.conflict = true;
    links.set(m[3], e);
  }
  const list = [...links].slice(0, SUBMODULE_CAP);
  return Promise.all(list.map(async ([p, l]) => {
    const head = await submoduleHead(cwd, p);
    const dirty = head ? await submoduleDirty(cwd, p) : false;
    const state = l.conflict ? 'conflict' : !head ? 'uninitialized' : dirty ? 'modified' : head.sha !== l.recorded ? 'outdated' : 'clean';
    return { path: p, name: info.get(p)?.name || p, url: info.get(p)?.url || '', recorded: l.recorded, head: head?.sha || null, branch: head?.branch || null, state };
  }));
}

// `git submodule update --init` for `paths` (all when empty). Refuses submodules with local
// changes (code 'dirty-submodule' when that is all that's in the way), so nothing uncommitted is
// lost, unless `stash`: then those changes are stashed in each submodule first. Returns
// [{ path, before, after, stash }] (before/after { sha, branch } or null when not checked out,
// `stash` the sha stashed in it) for undo, plus the error if git failed part-way.
async function updateSubmodules(cwd, paths = [], { stash = false } = {}) {
  const subs = await getSubmodules(cwd);
  const chosen = paths.length ? subs.filter((s) => paths.includes(s.path)) : subs;
  if (!chosen.length) throw new GitError(paths.length ? 'That submodule no longer exists.' : 'This repository has no submodules.');
  const busy = chosen.filter((s) => s.state === 'conflict' || (s.state === 'modified' && !stash));
  if (busy.length) {
    const conflict = busy.some((s) => s.state === 'conflict');
    throw new GitError(`${busy.map((s) => s.path).join(', ')} ${busy.length > 1 ? 'have' : 'has'} ${conflict ? 'local changes or a conflict. Commit or stash them in the submodule first.' : 'local changes.'}`, { code: conflict ? undefined : 'dirty-submodule' });
  }
  const stashed = new Map();
  for (const s of chosen.filter((x) => x.state === 'modified')) stashed.set(s.path, await stashSubmodule(cwd, s.path, 'Set aside to update submodules'));
  const before = await Promise.all(chosen.map((s) => submoduleHead(cwd, s.path)));
  let error = null;
  await run(cwd, ['submodule', 'update', '--init', '--checkout', '--', ...chosen.map((s) => s.path)]).catch((err) => { error = err; });
  const after = await Promise.all(chosen.map((s) => submoduleHead(cwd, s.path)));
  const changes = chosen.map((s, i) => ({ path: s.path, before: before[i], after: after[i], ...(stashed.get(s.path) ? { stash: stashed.get(s.path) } : {}) }))
    .filter((c) => c.stash || !sameHead(c.before, c.after));
  return { changes, error };
}

// Stash every uncommitted change in submodule `p`, untracked files too. Returns the stash sha, or
// null when there was nothing to stash. The stash lives in the submodule's own stash list.
async function stashSubmodule(cwd, p, message) {
  const abs = path.join(cwd, p);
  const top = () => run(abs, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowCodes: [0, 1] }).then((o) => o.trim());
  const prev = await top();
  await stashPush(abs, { message, untracked: true });
  const sha = await top();
  return sha && sha !== prev ? sha : null;
}

// Pop the stash `sha` in submodule `p` (by sha, wherever it now is in its list).
async function popSubmoduleStash(cwd, p, sha) {
  const abs = path.join(cwd, p);
  const i = (await getStashes(abs)).findIndex((x) => x.sha === sha);
  if (i === -1) throw new GitError(`the stash in submodule ${p} was applied or dropped since.`);
  await run(abs, ['stash', 'pop', '-q', '--index', `stash@{${i}}`], { env: W_ENV });
}

// Discard every uncommitted change in submodule `p`, untracked files too. They are kept as a
// stash commit pinned under refs/gitlanes/discarded in the submodule (not in its stash list), so
// undo can bring them back. Returns that commit's sha, or null when there was nothing to discard.
async function discardSubmodule(cwd, p) {
  const sha = await stashSubmodule(cwd, p, `Discarded changes in ${p}`);
  if (!sha) return null;
  const abs = path.join(cwd, p);
  await run(abs, ['update-ref', `refs/gitlanes/discarded/${sha}`, sha], { env: W_ENV });
  await run(abs, ['stash', 'drop', '-q', 'stash@{0}'], { env: W_ENV });
  return sha;
}

// Put changes `discardSubmodule` removed back into submodule `p`.
async function restoreDiscardedSubmodule(cwd, p, sha) {
  await run(path.join(cwd, p), ['stash', 'apply', '-q', '--index', sha], { env: W_ENV });
}

// How many files have uncommitted changes in submodule `p`.
async function submoduleChanges(cwd, p) {
  const out = await run(path.join(cwd, p), ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
  return out.split('\0').filter(Boolean).length;
}

const sameHead = (a, b) => (a?.sha || null) === (b?.sha || null) && (a?.branch || null) === (b?.branch || null);

// Undo or redo `updateSubmodules` changes. Each submodule must still be where the change left
// it (`after` for undo) and clean (code 'dirty-submodule' if not); going back to "not checked
// out" deinitialises it, which keeps its clone under .git/modules so redo needs no network.
// Changes the update stashed (`stash`) are popped on undo and stashed again on redo.
async function restoreSubmodules(cwd, changes, dir) {
  const [cur, next] = dir === 'undo' ? ['after', 'before'] : ['before', 'after'];
  for (const c of changes) {
    if (!sameHead(await submoduleHead(cwd, c.path), c[cur])) throw new GitError(`submodule ${c.path} has moved since.`);
    if (c[cur] && !(dir === 'redo' && c.stash) && (await submoduleDirty(cwd, c.path))) throw new GitError(`submodule ${c.path} has local changes.`, { code: 'dirty-submodule' });
    if (dir === 'undo' && c.stash && !c.discarded && !(await getStashes(path.join(cwd, c.path))).some((x) => x.sha === c.stash)) throw new GitError(`the stash in submodule ${c.path} was applied or dropped since.`);
  }
  for (const c of changes) {
    if (dir === 'redo' && c.stash) c.stash = await (c.discarded ? discardSubmodule(cwd, c.path) : stashSubmodule(cwd, c.path, c.message || 'Set aside to update submodules')) || undefined;
    const want = c[next];
    if (!want) { await run(cwd, ['submodule', 'deinit', '-q', '--', c.path]); continue; }
    if (!c[cur]) await run(cwd, ['submodule', 'update', '--init', '--checkout', '-q', '--', c.path]);
    const abs = path.join(cwd, c.path);
    const onBranch = want.branch && (await run(abs, ['rev-parse', '-q', '--verify', `refs/heads/${want.branch}`], { allowCodes: [0, 1] })).trim() === want.sha;
    await run(abs, onBranch ? ['checkout', '-q', want.branch] : ['checkout', '-q', '--detach', want.sha]);
    if (dir === 'undo' && c.stash) await (c.discarded ? restoreDiscardedSubmodule(cwd, c.path, c.stash) : popSubmoduleStash(cwd, c.path, c.stash));
  }
}

async function getOperationState(gitDir) {
  const exists = (p) => fs.existsSync(path.join(gitDir, p));
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  return null;
}

// What the stopped operation is doing, to name it (AK-584). merge: `from` merging into `branch`;
// cherry-pick/revert: the commit (`sha`, `subject`); rebase: `branch` onto `onto`, at `step` of
// `total`, on `subject`. null when nothing is stopped.
async function getOperationInfo(cwd, gitDir) {
  const op = await getOperationState(gitDir);
  if (!op) return null;
  const read = (p) => { try { return fs.readFileSync(path.join(gitDir, p), 'utf8').trim(); } catch { return ''; } };
  const short = (ref) => ref.replace(/^refs\/(heads|remotes)\//, '');
  const subjectOf = async (sha) => (sha ? (await run(cwd, ['log', '-1', '--format=%s', sha, '--']).catch(() => '')).trim() : '');
  // A branch whose tip is `sha` names it better than the sha itself.
  const nameOf = async (sha) => {
    const out = await run(cwd, ['for-each-ref', '--points-at', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']).catch(() => '');
    const ref = out.split('\n').find((r) => r && !r.endsWith('/HEAD'));
    return ref ? short(ref) : sha.slice(0, 7);
  };
  const branch = (await run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] }).catch(() => '')).trim();
  if (op === 'merge') {
    const sha = read('MERGE_HEAD').split('\n')[0];
    const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(read('MERGE_MSG'));
    return { op, branch, from: m ? m[1] : await nameOf(sha), sha };
  }
  if (op === 'cherry-pick' || op === 'revert') {
    const sha = read(op === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD');
    return { op, branch, sha, subject: await subjectOf(sha) };
  }
  const dir = fs.existsSync(path.join(gitDir, 'rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
  const merge = dir === 'rebase-merge';
  const onto = read(`${dir}/onto`);
  const step = Number(read(merge ? `${dir}/msgnum` : `${dir}/next`)) || 0;
  const total = Number(read(merge ? `${dir}/end` : `${dir}/last`)) || 0;
  const stopped = read(`${dir}/stopped-sha`) || read(`${dir}/original-commit`);
  const subject = (merge ? read(`${dir}/message`).split('\n')[0] : '') || await subjectOf(stopped);
  return { op, branch: short(read(`${dir}/head-name`)) || branch, onto: onto ? await nameOf(onto) : '', step, total, subject };
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
        else if (mode === 'stage' && ln.noEol && h.lines.some((l, j) => j > li && l.t === '+' && sel.has(`${hi}:${j}`))) {
          // The old last line stays but gains a newline, so selected lines added after it don't join onto it.
          push('-', ln.s, true); push('+', ln.s, false); changed = true;
        } else if (mode === 'stage') push(' ', ln.s, ln.noEol);
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
// Unified changes: one diff per file (HEAD → working tree) where every changed line says
// whether it is staged. It is composed from the staged diff (HEAD → index) and the unstaged
// diff (index → working tree) rather than diffed again, so each line maps back to exactly one
// line of one of those diffs, and staging a selection is a partial patch of that diff.

const COMBINED_LINE_CAP = 400; // bigger files come back with hunk headers only; load hunks on demand
const COMBINED_CONTEXT = 3;

// Where the changed lines of one parsed file diff sit. Keys are the "hunk:line" keys
// buildPartialPatch takes. `added`/`removed` are by new/old line number; `addsAt`/`delsAt`
// hold insertions/removals by how many old/new lines come before them. `block` numbers the
// runs of changed lines, so an edit's removed and added lines share one.
function diffSides(fd) {
  const s = { added: new Map(), removed: new Map(), addsAt: new Map(), delsAt: new Map() };
  const at = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  let block = 0;
  (fd?.hunks || []).forEach((h, hi) => {
    let o = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    let n = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    let prev = ' ';
    h.lines.forEach((ln, li) => {
      if (ln.t !== ' ' && prev === ' ') block++;
      prev = ln.t;
      const rec = { key: `${hi}:${li}`, s: ln.s, noEol: !!ln.noEol, block };
      if (ln.t === ' ') { o++; n++; } else if (ln.t === '-') {
        s.removed.set(o, rec);
        at(s.delsAt, n - 1, { ...rec, o });
        o++;
      } else {
        s.added.set(n, rec);
        at(s.addsAt, o - 1, { ...rec, n });
        n++;
      }
    });
  });
  return s;
}

const splitLines = (text) => { const l = text.split('\n'); if (l.at(-1) === '') l.pop(); return l; };

// One file's state for the unified view: its status entry (the staged one carries a rename's
// old path), and whether it is untracked or conflicted.
async function changeEntry(cwd, file) {
  const { staged, unstaged, conflicts } = await getStatus(cwd, [file.path, ...(file.oldPath ? [file.oldPath] : [])]);
  const s = staged.find((f) => f.path === file.path), u = unstaged.find((f) => f.path === file.path);
  return {
    path: file.path, oldPath: s?.oldPath || null, staged: s || null, unstaged: u || null,
    conflict: conflicts.some((f) => f.path === file.path), untracked: u?.status === '?',
  };
}

// The composed lines of one file, every line of the working tree and every removed line in
// file order, plus the staged and unstaged diffs they map to.
async function combine(cwd, file) {
  const e = await changeEntry(cwd, file);
  const out = { entry: e, hi: null, iw: null, seq: [], hidden: 0, binary: false };
  if (e.conflict) return out;
  const fe = { path: e.path, oldPath: e.oldPath || undefined, status: e.untracked ? '?' : 'M' };
  if (e.untracked) out.iw = await workingDiff(cwd, fe, { staged: false });
  else {
    if (e.staged) out.hi = await workingDiff(cwd, fe, { staged: true });
    if (e.unstaged) out.iw = await workingDiff(cwd, { path: e.path, status: 'M' }, { staged: false });
  }
  out.binary = !!(out.hi?.binary || out.iw?.binary);
  if (out.binary) return out;
  const index = e.untracked || e.staged?.status === 'D' ? []
    : splitLines(await run(cwd, ['cat-file', 'blob', `:${e.path}`], { allowCodes: [0, 128] }));
  const hi = diffSides(out.hi), iw = diffSides(out.iw);
  // Removed lines of a run that also removes a staged line: staging them replaces that line.
  const hiddenIn = new Map();
  for (let k = 1; k <= index.length; k++) {
    const r = iw.removed.get(k);
    if (r && hi.added.has(k)) { if (!hiddenIn.has(r.block)) hiddenIn.set(r.block, []); hiddenIn.get(r.block).push(r.key); }
  }
  const unstagedLine = (line, r) => {
    const also = hiddenIn.get(r.block);
    return also ? { ...line, edited: true, _also: also } : line;
  };
  let o = 0, n = 0;
  for (let j = 0; j <= index.length; j++) {
    for (const d of hi.delsAt.get(j) || []) out.seq.push({ t: '-', s: d.s, o: ++o, n: null, staged: true, _hi: d.key });
    for (const a of iw.addsAt.get(j) || []) out.seq.push(unstagedLine({ t: '+', s: a.s, o: null, n: ++n, staged: false, _iw: a.key, ...(a.noEol && { noEol: true }) }, a));
    if (j === index.length) break;
    const k = j + 1, add = hi.added.get(k), rem = iw.removed.get(k);
    if (add && rem) { out.hidden++; continue; } // staged, then changed or removed again
    if (add) out.seq.push({ t: '+', s: index[j], o: null, n: ++n, staged: true, _hi: add.key });
    else if (rem) out.seq.push(unstagedLine({ t: '-', s: index[j], o: ++o, n: null, staged: false, _iw: rem.key }, rem));
    else out.seq.push({ t: ' ', s: index[j], o: ++o, n: ++n });
  }
  return out;
}

// Group composed lines into hunks with a few lines of context, like a unified diff.
function combinedHunks(seq) {
  const hunks = [];
  let i = 0;
  while (i < seq.length) {
    if (seq[i].t === ' ') { i++; continue; }
    let start = Math.max(0, i - COMBINED_CONTEXT), end = i;
    // Extend while the next change is within twice the context.
    for (let j = i; j < seq.length && j <= end + 2 * COMBINED_CONTEXT; j++) if (seq[j].t !== ' ') end = j;
    end = Math.min(seq.length - 1, end + COMBINED_CONTEXT);
    const lines = seq.slice(start, end + 1);
    const first = (k) => lines.find((l) => l[k] != null)?.[k];
    const oldLines = lines.filter((l) => l.t !== '+').length, newLines = lines.filter((l) => l.t !== '-').length;
    // An empty side starts at the line before, as git writes it.
    const before = (k) => { for (let j = start - 1; j >= 0; j--) if (seq[j][k] != null) return seq[j][k]; return 0; };
    const oldStart = oldLines ? first('o') : before('o'), newStart = newLines ? first('n') : before('n');
    const changed = lines.filter((l) => l.t !== ' ');
    hunks.push({
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, oldStart, oldLines, newStart, newLines,
      lines, total: changed.length, staged: changed.filter((l) => l.staged).length, edited: changed.some((l) => l.edited),
    });
    i = end + 1;
  }
  return hunks;
}

const tickState = (staged, total) => (!total || !staged ? 'none' : staged === total ? 'all' : 'partial');

// Why a file can only be staged whole (the UI hides its line boxes), or null.
function wholeFileReason(c) {
  const e = c.entry;
  if (c.binary) return 'binary';
  if (e.oldPath) return 'renamed';
  if (e.staged?.status === 'D' || e.unstaged?.status === 'D') return 'deleted';
  if (e.staged?.status === 'T' || e.unstaged?.status === 'T') return 'typechange';
  if ([c.hi, c.iw].some((d) => d?.header.some((l) => /^(old|new) mode /.test(l) || /^Subproject /.test(l)))) return 'mode';
  return null;
}

// The unified view of one changed file. Every changed line has `staged`; `edited` marks a line
// that replaces a staged one (it changed since staging). Files over COMBINED_LINE_CAP changed
// lines come back `collapsed`, with `lines: null` on every hunk not listed in `opts.hunks`.
async function combinedDiff(cwd, file, { hunks: want } = {}) {
  const c = await combine(cwd, file);
  const e = c.entry;
  const base = { path: e.path, oldPath: e.oldPath, untracked: e.untracked, conflict: e.conflict, binary: c.binary, hidden: c.hidden };
  if (e.conflict) return { ...base, wholeFile: 'conflict', hunks: [], staged: 0, total: 0, state: 'none', collapsed: false };
  const wholeFile = wholeFileReason(c);
  const hunks = combinedHunks(c.seq);
  let staged = hunks.reduce((s, h) => s + h.staged, 0), total = hunks.reduce((s, h) => s + h.total, 0);
  if (c.binary) { total = 1; staged = e.staged && !e.unstaged ? 1 : 0; }
  const collapsed = total > COMBINED_LINE_CAP && !want;
  const keep = want ? new Set(want) : null;
  const strip = (l) => { const { _hi, _iw, _also, ...rest } = l; return rest; };
  return {
    ...base, wholeFile, staged, total, collapsed,
    // A staged change hidden by a later edit or removal leaves the file partly staged, whatever the visible lines say.
    state: (c.binary && e.staged && e.unstaged) || c.hidden ? 'partial' : tickState(staged, total),
    hunks: hunks.map((h, i) => ({ ...h, lines: collapsed || (keep && !keep.has(i)) ? null : h.lines.map(strip) })),
  };
}

// The composed lines a selection names: "hunk:line" keys, or "hunk:*" for a whole hunk.
function pickLines(hunks, sel) {
  const picked = new Set();
  for (const k of sel) {
    const [h, l] = k.split(':');
    const hunk = hunks[+h];
    if (!hunk) continue;
    if (l === '*') hunk.lines.forEach((x) => picked.add(x));
    else if (hunk.lines[+l]) picked.add(hunk.lines[+l]);
  }
  return [...picked].filter((x) => x.t !== ' ');
}

// The paths staging `file` can change in the index (a staged rename's old path too).
async function changePaths(cwd, file) {
  const e = await changeEntry(cwd, file);
  return [e.path, ...(e.oldPath ? [e.oldPath] : file.oldPath ? [file.oldPath] : [])];
}

// Stage (`stage` true) or unstage part of one file in the unified view: 'all', or the
// "hunk:line" / "hunk:*" keys of combinedDiff's hunks. Lines already in the wanted state are
// skipped. Binary, renamed, deleted and conflicted files go whole only.
async function setStaged(cwd, file, sel, stage) {
  if (sel === 'all') {
    const paths = await changePaths(cwd, file);
    if (stage) return run(cwd, ['add', '-A', '--', ...paths], { env: W_ENV });
    const hasHead = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim();
    return run(cwd, hasHead ? ['reset', '-q', 'HEAD', '--', ...paths] : ['rm', '--cached', '-q', '-r', '--ignore-unmatch', '--', ...paths], { env: W_ENV });
  }
  const c = await combine(cwd, file);
  if (c.entry.conflict) throw new GitError(`${file.path} has a conflict. Resolve it first.`);
  const why = wholeFileReason(c);
  if (why) throw new GitError(`${file.path} can only be ${stage ? 'staged' : 'unstaged'} as a whole file.`);
  const lines = pickLines(combinedHunks(c.seq), sel).filter((l) => l.staged !== stage);
  if (!lines.length) return;
  if (stage) {
    const keys = new Set(lines.flatMap((l) => [l._iw, ...(l._also || [])]));
    const patch = buildPartialPatch(c.iw, [...keys], 'stage');
    if (patch) await applyPatch(cwd, patch, { cached: true });
  } else {
    const patch = buildPartialPatch(c.hi, lines.map((l) => l._hi), 'reverse');
    if (patch) await applyPatch(cwd, patch, { cached: true, reverse: true });
  }
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

// Who commits here: the configured user, the identities in HEAD's reflog that made commits
// in this clone (with counts), and the remote URLs, for the wrong-identity check.
async function getIdentity(cwd) {
  const get = async (k) => (await run(cwd, ['config', '--get', k], { allowCodes: [0, 1] })).trim();
  const [name, email, log, remotes] = await Promise.all([
    get('user.name'), get('user.email'),
    run(cwd, ['log', '-g', '--max-count=2000', '--format=%gs%x00%ge%x00%gn', 'HEAD'], { allowCodes: [0, 128] }).catch(() => ''),
    getRemotes(cwd).catch(() => []),
  ]);
  const used = new Map();
  for (const l of log.split('\n')) {
    const [action, e, n] = l.split(SEP);
    if (!/^commit\b/.test(action || '') || !e) continue;
    const k = e.toLowerCase();
    const u = used.get(k) || { email: e, name: n, count: 0 };
    u.count++;
    used.set(k, u);
  }
  return { name, email, used: [...used.values()], remotes: remotes.map((r) => r.url) };
}

async function getRemotes(cwd) {
  const out = await run(cwd, ['remote', '-v']);
  const map = new Map();
  for (const l of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(l);
    if (m && !map.has(m[1])) map.set(m[1], m[2]);
  }
  // `remote -v` shows URLs after url.<base>.insteadOf rewriting; `setUrl` is the value actually configured.
  const set = new Map();
  const cfg = await run(cwd, ['config', '-z', '--get-regexp', '^remote\\..*\\.url$'], { allowCodes: [0, 1] }).catch(() => '');
  for (const e of cfg.split('\0')) {
    const i = e.indexOf('\n');
    const n = i > 0 && e.slice(7, e.lastIndexOf('.', i));
    if (n && !set.has(n)) set.set(n, e.slice(i + 1));
  }
  return [...map].map(([name, url]) => ({ name, url, setUrl: set.get(name) ?? url, web: remoteWebUrl(url), label: remoteLabel(url) }));
}

// A remote URL as https://host/owner/repo, or null when it is not on a web host
// (local paths, file://). Drops credentials, ssh ports and the trailing ".git".
function remoteWebUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '');
  let m = /^(?:ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/i.exec(s);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/i.exec(s);
  if (m) return `https://${m[1]}/${m[2]}`;
  // scp-style "[user@]host:owner/repo" (no slash before the colon, as git reads it).
  m = /^(?:[^@/:]+@)?([^/:]+):\/?(?!\/)(.+?)(?:\.git)?$/.exec(s);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

// Short label for a remote: "host/owner/repo", or the path of a local remote.
// The fallback drops any userinfo, so a token in the URL is never shown.
function remoteLabel(url) {
  const web = remoteWebUrl(url);
  if (web) return web.slice('https://'.length);
  return String(url || '').trim().replace(/^file:\/\//i, '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
}

// Managing remotes (Remotes section, ⌘K): add, change the URL of, rename and remove. journal.runRemote
// records the returned change so it can be undone; removing saves the remote's config, the upstream
// settings of branches that track it and its remote-tracking refs, which undo writes back.
const sub = (key) => key.slice(key.indexOf('.') + 1, key.lastIndexOf('.'));

async function saveRemote(cwd, name) {
  const cfg = await run(cwd, ['config', '--local', '-z', '--get-regexp', '^(remote|branch)\\.'], { allowCodes: [0, 1] });
  const entries = cfg.split(SEP).filter(Boolean).map((e) => { const i = e.indexOf('\n'); return i === -1 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; });
  const tracking = new Set(entries.filter(([k, v]) => /^branch\..+\.(remote|pushremote)$/.test(k) && v === name).map(([k]) => sub(k)));
  const config = entries.filter(([k]) => (k.startsWith('remote.') && sub(k) === name) || (/^branch\..+\.(remote|merge|pushremote)$/.test(k) && tracking.has(sub(k))));
  const out = await run(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', `refs/remotes/${name}/`]);
  const refs = out.split('\n').filter(Boolean).map((l) => l.split(SEP));
  return { config, refs };
}

async function restoreSavedRemote(cwd, { config, refs }) {
  for (const [k, v] of config) await run(cwd, ['config', '--local', ...(k.startsWith('branch.') ? ['--replace-all'] : ['--add']), k, v]);
  const lines = refs.filter(([, , sym]) => !sym).map(([n, o]) => `create ${n} ${o}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin', '-m', 'gitlanes: undo remove remote'], { input: lines.join('\n') + '\n' });
  for (const [n, , sym] of refs) if (sym) await run(cwd, ['symbolic-ref', n, sym]).catch(() => {});
}

// `op` is add (name, url), url (name, url), rename (name, new name) or remove (name).
async function changeRemote(cwd, op, name, value) {
  const remotes = await getRemotes(cwd);
  const has = (n) => remotes.some((r) => r.name === n);
  if (op !== 'add' && !has(name)) throw new GitError(`There is no remote named ${name}.`);
  const taken = op === 'add' ? name : op === 'rename' ? value : null;
  if (taken && has(taken)) throw new GitError(`A remote named ${taken} already exists.`);
  if (op === 'add') { await run(cwd, ['remote', 'add', '--', name, value]); return { op, name, url: value }; }
  if (op === 'url') {
    const from = remotes.find((r) => r.name === name).setUrl;
    await run(cwd, ['remote', 'set-url', '--', name, value]);
    return { op, name, from, url: value };
  }
  if (op === 'rename') { await run(cwd, ['remote', 'rename', '--', name, value]); return { op, name, to: value }; }
  if (op === 'remove') {
    const saved = await saveRemote(cwd, name);
    await run(cwd, ['remote', 'remove', '--', name]);
    return { op, name, saved };
  }
  throw new GitError(`Unknown remote operation ${op}`);
}

// Undo or redo a changeRemote step. Redoing a remove saves the remote again (its refs may have moved).
async function revertRemote(cwd, change, dir) {
  const c = change, undo = dir === 'undo';
  const remotes = await getRemotes(cwd);
  const has = (n) => remotes.some((r) => r.name === n);
  const fail = (why) => { throw new GitError(why); };
  if (c.op === 'add') {
    if (undo) { if (!has(c.name)) fail(`the remote ${c.name} no longer exists.`); await run(cwd, ['remote', 'remove', '--', c.name]); }
    else { if (has(c.name)) fail(`a remote named ${c.name} exists again.`); await run(cwd, ['remote', 'add', '--', c.name, c.url]); }
  } else if (c.op === 'url') {
    const r = remotes.find((x) => x.name === c.name);
    if (!r || r.setUrl !== (undo ? c.url : c.from)) fail(`the URL of ${c.name} has changed since.`);
    await run(cwd, ['remote', 'set-url', '--', c.name, undo ? c.from : c.url]);
  } else if (c.op === 'rename') {
    const [from, to] = undo ? [c.to, c.name] : [c.name, c.to];
    if (!has(from)) fail(`the remote ${from} no longer exists.`);
    if (has(to)) fail(`a remote named ${to} exists again.`);
    await run(cwd, ['remote', 'rename', '--', from, to]);
  } else if (c.op === 'remove') {
    if (undo) { if (has(c.name)) fail(`a remote named ${c.name} exists again.`); await restoreSavedRemote(cwd, c.saved); }
    else { if (!has(c.name)) fail(`the remote ${c.name} no longer exists.`); c.saved = await saveRemote(cwd, c.name); await run(cwd, ['remote', 'remove', '--', c.name]); }
  }
}

// ---------------------------------------------------------------------------
// History rewriting (in-place commit editing), implemented as a
// non-interactive `git rebase -i` with a generated todo list.

// Check that `sha` can be rewritten by `op` on `tip` (HEAD, or the branch about to be checked
// out), and find where the rebase starts (`base`, null for the root) and the commits it replays.
async function rewriteRange(cwd, op, sha, tip = 'HEAD') {
  const onBranch = await run(cwd, ['merge-base', '--is-ancestor', sha, tip]).then(() => true, () => false);
  if (!onBranch) throw new GitError(tip === 'HEAD' ? 'This commit is not on the current branch.' : `This commit is not on ${tip}.`);
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
  const range = base ? `${base}..${tip}` : tip;
  const merges = (await run(cwd, ['rev-list', '--merges', range])).trim();
  if (merges) throw new GitError('There are merge commits between this commit and HEAD; rewriting would flatten them.');
  const list = (await run(cwd, ['rev-list', '--reverse', range])).trim().split('\n').filter(Boolean);
  return { parents, base, list };
}

// Whether `sha` is on HEAD, and the local branches that contain it (to switch to and rewrite it there).
async function commitBranches(cwd, sha) {
  const onHead = await run(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']).then(() => true, () => false);
  const out = await run(cwd, ['branch', '--format=%(refname:short)', '--contains', sha]).catch(() => '');
  return { onHead, branches: out.split('\n').map((b) => b.trim()).filter(Boolean) };
}

async function rewrite(cwd, op, sha, extra = {}) {
  // A merge commit at HEAD can't be replayed by a rebase: reword it in place.
  if (op === 'reword' && (await run(cwd, ['rev-parse', 'HEAD'])).trim() === sha
    && (await run(cwd, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').length > 2) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-'));
    try {
      fs.writeFileSync(path.join(tmp, 'msg'), extra.message);
      await run(cwd, ['commit', '--amend', '--only', '--allow-empty', '--no-verify', '-q', '-F', path.join(tmp, 'msg')], { env: { GIT_OPTIONAL_LOCKS: '1' } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  const { parents, base, list } = await rewriteRange(cwd, op, sha);
  // A split builds its two commits up front; the rebase picks them in place of the original.
  const halves = op === 'split' ? await splitCommits(cwd, sha, parents[0] || null, extra) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-'));
  const todo = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === sha) {
      if (op === 'drop') todo.push(`drop ${c}`);
      else if (op === 'split') todo.push(`pick ${halves[0]}`, `pick ${halves[1]}`);
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
  } catch (e) {
    // A rebase stopped by a signing failure has nothing for the user to resolve; put the branch back.
    if (e.message.startsWith("Couldn't sign")) await run(cwd, ['rebase', '--abort'], { env: { GIT_OPTIONAL_LOCKS: '1' } }).catch(() => {});
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Build the two commits that replace `sha` when it is split. `files` maps each
// path to 'all' or to the selected line keys ("hunk:line") of its commitDiffs
// entry; the selection becomes the first commit, the rest the second. Both keep
// the original author and date. Returns [first, second]; the second has the
// original tree, so the commits on top replay without conflicts.
async function splitCommits(cwd, sha, parent, { files = {}, messages = [] }) {
  const msgs = messages.map((m) => String(m || '').trim());
  if (msgs.length !== 2 || !msgs[0] || !msgs[1]) throw new GitError('Both commits need a message.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-split-'));
  try {
    return await buildSplit(cwd, sha, parent, files, msgs, { GIT_INDEX_FILE: path.join(tmp, 'index') });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The first commit's tree is built in a private index, so the working tree and real index are untouched.
async function buildSplit(cwd, sha, parent, files, msgs, env) {
  const diffs = new Map((await readCommitDiffs(cwd, sha)).map(([, r]) => [r.path, r]));
  await run(cwd, ['read-tree', ...(parent ? [parent] : ['--empty'])], { env });
  // Removals go first, so a file replaced by a folder of the same name (or the
  // reverse) can take its place when both changes are selected.
  const removals = [], edits = [];
  for (const [p, sel] of Object.entries(files)) {
    const d = diffs.get(p);
    if (!d) throw new GitError(`${p} is not changed in this commit.`);
    const keys = sel === 'all' ? null : [...new Set(sel)];
    if (keys && !keys.length) continue;
    const changes = d.hunks.reduce((n, hk) => n + hk.lines.filter((l) => l.t !== ' ').length, 0);
    if (keys && keys.length < changes) { edits.push(() => applyPartial(cwd, d, keys, env)); continue; }
    // The whole file (binary, mode-only and submodule changes have no lines to pick):
    // take its entry from the commit, or remove it if the commit deletes it. Only a
    // file or submodule at exactly this path counts: if a folder replaced the file,
    // ls-tree lists that folder, and the file is gone.
    const entry = (await run(cwd, ['ls-tree', '-z', sha, '--', p])).split('\0')[0];
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (entry && entry.slice(tab + 1) === p && (type === 'blob' || type === 'commit')) {
      edits.push(() => run(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${p}`], { env }));
    } else removals.push(p);
  }
  if (removals.length) await run(cwd, ['update-index', '--force-remove', '-z', '--stdin'], { input: removals.join('\0') + '\0', env });
  for (const edit of edits) {
    try { await edit(); } catch (e) {
      throw /file\/directory conflict|already exists|cannot add to the index|does not exist in index/i.test(e.message)
        ? new GitError('A file and a folder with the same name changed in this commit. Select both changes for the first commit, or neither.')
        : e;
    }
  }
  const tree = (await run(cwd, ['write-tree'], { env })).trim();
  const treeOf = async (rev) => (rev ? (await run(cwd, ['rev-parse', `${rev}^{tree}`])).trim() : EMPTY_TREE);
  if (tree === await treeOf(parent)) throw new GitError('Select at least one change for the first commit.');
  if (tree === await treeOf(sha)) throw new GitError('Leave at least one change for the second commit.');

  const [name, email, date] = (await run(cwd, ['show', '-s', '--date=raw', '--format=%an%x00%ae%x00%ad', sha])).split(SEP);
  const author = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date.trim() };
  // commit-tree only signs when asked, unlike commit and rebase.
  const sign = (await run(cwd, ['config', '--bool', 'commit.gpgsign'], { allowCodes: [0, 1] })).trim() === 'true';
  const make = async (t, p, msg) => (await run(cwd, ['commit-tree', ...(sign ? ['-S'] : []), t, ...(p ? ['-p', p] : []), '-F', '-'], { input: msg + '\n', env: author })).trim();
  const first = await make(tree, parent, msgs[0]);
  return [first, await make(await treeOf(sha), first, msgs[1])];
}

// Apply the selected lines of a raw (latin1) file diff to the private index, as bytes.
async function applyPartial(cwd, d, keys, env) {
  // Removing some lines of a deleted file keeps the file in the first commit.
  const minus = d.header.find((l) => l.startsWith('--- '));
  const fd = d.newPath !== '/dev/null' ? d : {
    ...d, header: d.header.filter((l) => !l.startsWith('deleted file')).map((l) => (l === '+++ /dev/null' ? '+++ ' + minus.slice(4).replace(/^("?)a\//, '$1b/') : l)),
  };
  const patch = buildPartialPatch(fd, keys, 'stage');
  if (patch) await run(cwd, ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], { input: Buffer.from(patch, 'latin1'), env });
}

// ---------------------------------------------------------------------------
// Snapshot of refs, used for unlimited undo/redo.

async function captureRefState(cwd) {
  const out = await run(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags']);
  const refs = {};
  for (const l of out.split('\n')) { if (!l) continue; const [n, o] = l.split(SEP); refs[n] = o; }
  const sym = (await run(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] })).trim();
  const oid = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim();
  // Each branch's `[branch "x"]` entries (upstream), so a redo that recreates the branch can put them back.
  const config = {};
  const cfg = await run(cwd, ['config', '--local', '-z', '--get-regexp', '^branch\\.'], { allowCodes: [0, 1] }).catch(() => '');
  for (const e of cfg.split('\0')) {
    const i = e.indexOf('\n');
    const key = i === -1 ? e : e.slice(0, i);
    const n = `refs/heads/${key.slice(7, key.lastIndexOf('.'))}`;
    if (key && n in refs) (config[n] ||= []).push([key, i === -1 ? '' : e.slice(i + 1)]);
  }
  return { refs, head: sym || null, headOid: oid || null, config };
}

async function restoreRefState(cwd, state, { soft = false, refsOnly = false } = {}) {
  let current = await captureRefState(cwd);
  const env = { GIT_OPTIONAL_LOCKS: '1' };
  // Move the working copy first so a dirty tree blocks the restore before any ref changes.
  // `soft` keeps the undone commit's changes staged (undoing a commit). `refsOnly` leaves
  // the index and working tree alone; the caller restores them from a work snapshot.
  if (!refsOnly && state.headOid && state.headOid !== current.headOid) {
    await run(cwd, ['reset', soft ? '--soft' : '--keep', state.headOid], { env });
    // The reset moved the branch HEAD is on; when HEAD goes back to another branch, that one moves back below.
    current = await captureRefState(cwd);
  }
  const lines = [];
  for (const [n, o] of Object.entries(state.refs)) if (current.refs[n] !== o) lines.push(`update ${n} ${o}`);
  for (const n of Object.keys(current.refs)) if (!(n in state.refs)) lines.push(`delete ${n}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin', '-m', 'gitlanes: undo'], { input: lines.join('\n') + '\n', env });
  // A deleted branch takes its `[branch "x"]` config (upstream) with it, as `git branch -D` does.
  for (const n of Object.keys(current.refs)) {
    if (!(n in state.refs) && n.startsWith('refs/heads/')) await run(cwd, ['config', '--remove-section', `branch.${n.slice(11)}`], { env }).catch(() => {});
  }
  // A branch brought back (redo, timeline jump) gets the config it had when the state was taken.
  for (const [n, entries] of Object.entries(state.config || {})) {
    if (n in current.refs) continue;
    await run(cwd, ['config', '--remove-section', `branch.${n.slice(11)}`], { env }).catch(() => {});
    for (const [k, v] of entries) await run(cwd, ['config', '--add', k, v], { env });
  }
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

// `write` stores the blobs; without it the snapshot is only used for comparison. `indexOnly`
// records just the index entries (staging steps), so later edits to the files don't block undo.
async function snapshotWork(cwd, paths, { write = true, indexOnly = false } = {}) {
  const files = [...new Set(paths)].sort().map((p) => ({ path: p, index: [], wt: indexOnly ? { mode: 'keep' } : null }));
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
  if (indexOnly) return { files, indexOnly };
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
    if (f.wt?.mode === 'dir' || f.wt?.mode === 'keep') continue;
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

// Paths a stash push can change: the files it's limited to, or everything dirty.
const stashPushPaths = async (cwd, message, untracked, { paths } = {}) => (paths?.length ? paths : dirtyPaths(cwd));

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

// Remove the pins under `ns` (one worktree's journal) whose keys it no longer
// keeps. Other worktrees' pins are left alone.
async function pruneUndoPins(cwd, ns, keepKeys) {
  const base = `${UNDO_REFS}/${ns}`;
  const keep = new Set(keepKeys.map(String));
  const lines = (await listRefs(cwd, base))
    .filter((ref) => !keep.has(ref.slice(base.length + 1).split('/')[0]))
    .map((ref) => `delete ${ref}`);
  if (lines.length) await run(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', env: W_ENV });
}

// Move the pins of `keys` from the shared top level (the format before pins
// were namespaced per worktree) into `ns`, in one transaction.
async function moveUndoPins(cwd, ns, keys) {
  if (!keys.length) return;
  const out = await run(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', ...keys.map((k) => `${UNDO_REFS}/${k}`)]);
  const lines = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [oid, ref] = line.split(' ');
    lines.push(`update ${UNDO_REFS}/${ns}/${ref.slice(UNDO_REFS.length + 1)} ${oid}`, `delete ${ref} ${oid}`);
  }
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

// Stash some or all uncommitted changes: `paths` limits it to those files, `staged` to the index.
async function stashPush(cwd, { message, untracked, staged, paths } = {}) {
  if (staged && untracked) throw new GitError('Staged-only stashes can’t include untracked files.');
  const args = ['stash', 'push', ...(staged ? ['--staged'] : []), ...(untracked ? ['-u'] : []), ...(message ? ['-m', message] : [])];
  // A path whose deletion is staged (the old side of a rename) isn't a pathspec git stash accepts.
  // Stash the rest (the stash's index already records the deletion), then put the old path back.
  let gone = [];
  if (paths?.length && !staged) {
    const known = new Set((await run(cwd, ['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean));
    gone = paths.filter((p) => !known.has(p) && !fs.existsSync(path.join(cwd, p)));
    if (gone.length === paths.length) gone = [];
  }
  if (paths?.length) args.push('--', ...paths.filter((p) => !gone.includes(p)));
  try {
    // With GIT_LITERAL_PATHSPECS, `stash -u` saves untracked files but leaves them in place; literal paths only matter with paths.
    await run(cwd, args, { env: paths?.length ? W_ENV : { GIT_OPTIONAL_LOCKS: '1' } });
    if (gone.length) await run(cwd, ['checkout', 'HEAD', '--', ...gone]);
  } catch (e) {
    // `stash push --staged` arrived in Git 2.35; older git rejects the option with a usage dump.
    if (staged && /unknown option|usage: git stash/i.test(`${e.stderr || ''}\n${e.message}`)) throw new GitError('Stash staged changes needs Git 2.35 or newer.');
    throw e;
  }
}

// Stash only the selected unstaged lines of one file, then take them out of the working tree.
// The stash is HEAD plus those lines, so the file may not have staged changes of its own.
async function stashLines(cwd, file, selected, message) {
  const d = await workingDiff(cwd, file, { staged: false });
  const patch = d && buildPartialPatch(d, selected, 'stage');
  if (!patch) throw new GitError('Select changed lines to stash.');
  const head = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowCodes: [0, 1] })).trim();
  if (!head) throw new GitError('There’s no commit to stash on yet.');
  const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
  if ((await run(cwd, ['diff', '--cached', '--name-only', '--', ...paths], { env: W_ENV })).trim()) {
    throw new GitError(`${file.path} has staged changes. Unstage them first, or stash the whole file.`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-stash-'));
  try {
    const env = { ...W_ENV, GIT_INDEX_FILE: path.join(tmp, 'index') };
    await run(cwd, ['read-tree', head], { env });
    await run(cwd, ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], { input: patch, env });
    const tree = (await run(cwd, ['write-tree'], { env })).trim();
    const branch = (await run(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowCodes: [0, 1] })).trim() || '(no branch)';
    const subject = (await run(cwd, ['log', '-1', '--format=%h %s', head])).trim();
    const msg = message ? `On ${branch}: ${message}` : `WIP on ${branch}: ${subject}`;
    const index = (await run(cwd, ['commit-tree', `${head}^{tree}`, '-p', head, '-m', `index on ${branch}: ${subject}`])).trim();
    const stash = (await run(cwd, ['commit-tree', tree, '-p', head, '-p', index, '-m', msg])).trim();
    await run(cwd, ['stash', 'store', '-q', '-m', msg, stash], { env: W_ENV });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await applyPatch(cwd, buildPartialPatch(d, selected, 'reverse'), { reverse: true });
}

const resetHard = (cwd, sha) => run(cwd, ['reset', '--hard', sha || 'HEAD'], { env: W_ENV });

// Index stages of one conflicted path: { 1: base oid, 2: ours oid, 3: theirs oid }, absent sides missing.
async function conflictStages(cwd, p) {
  const stages = {};
  for (const rec of (await run(cwd, ['ls-files', '-u', '-z', '--', p])).split('\0')) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t/.exec(rec);
    if (m) stages[m[2]] = m[1];
  }
  return stages;
}

// A side that deleted the file has no stage; choosing it removes the file.
async function chooseSide(cwd, p, side) {
  if (!(await conflictStages(cwd, p))[side === 'ours' ? 2 : 3]) {
    await run(cwd, ['rm', '-q', '-f', '--', p], { env: W_ENV });
    return;
  }
  await run(cwd, ['checkout', `--${side}`, '--', p], { env: W_ENV });
  await run(cwd, ['add', '--', p], { env: W_ENV });
}

// Built-in conflict editor. The editor works on the conflict markers in the working
// file, so every operation that leaves them (merge, rebase, cherry-pick, revert, stash
// apply) works the same. Binary, missing or very large files can only take a whole side.
const CONFLICT_TEXT_MAX = 2 * 1024 * 1024;
async function getConflict(cwd, p) {
  const stages = await conflictStages(cwd, p);
  const sides = { base: !!stages[1], ours: !!stages[2], theirs: !!stages[3] };
  const st = await fs.promises.lstat(path.join(cwd, p)).catch(() => null);
  if (!st?.isFile()) return { path: p, ...sides, kind: st ? 'binary' : 'missing', text: null };
  const data = await fs.promises.readFile(path.join(cwd, p));
  if (data.subarray(0, 8000).includes(0)) return { path: p, ...sides, kind: 'binary', text: null };
  if (data.length > CONFLICT_TEXT_MAX) return { path: p, ...sides, kind: 'large', text: null };
  return { path: p, ...sides, kind: 'text', text: data.toString('utf8') };
}

// Writes the edited result and stages it, which marks the path resolved.
async function resolveConflict(cwd, p, content) {
  const st = await fs.promises.lstat(path.join(cwd, p)).catch(() => null);
  if (st && !st.isFile()) throw new GitError(`${p} is not a regular file. Pick a whole side instead.`);
  if (!Object.keys(await conflictStages(cwd, p)).length) throw new GitError(`${p} has no conflict to resolve.`);
  await fs.promises.writeFile(path.join(cwd, p), content);
  await run(cwd, ['add', '--', p], { env: W_ENV });
}

const stashApply = (cwd, ref, pop) => run(cwd, ['stash', pop ? 'pop' : 'apply', '--index', ref], { env: W_ENV });
const stashDrop = (cwd, ref) => run(cwd, ['stash', 'drop', ref], { env: W_ENV });

// Resolved files of a stopped merge, rebase, cherry-pick or revert (AK-584): staged, no longer
// unmerged and changed from HEAD; limited to the conflicts git listed in MERGE_MSG when it did.
// Listed conflicts resolved to HEAD's version only: { sha: null, paths: [], unchanged: n }.
// Saved as a stash-shaped commit (parents HEAD and an index commit, both with those files over
// HEAD) so it can be applied with `git stash apply <sha>` later. Returns { sha, paths } or null.
async function saveResolved(cwd, gitDir) {
  const head = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowCodes: [0, 1] })).trim();
  if (!head) return null;
  const z = (out) => out.split('\0').filter(Boolean);
  const unmerged = new Set(z(await run(cwd, ['ls-files', '-u', '-z'], { env: W_ENV })).map((r) => r.slice(r.indexOf('\t') + 1)));
  let paths = z(await run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD'], { env: W_ENV })).filter((p) => !unmerged.has(p));
  let msg = '';
  try { msg = fs.readFileSync(path.join(gitDir, 'MERGE_MSG'), 'utf8'); } catch {}
  const at = msg.split('\n').findIndex((l) => /^\S\s*Conflicts:\s*$/.test(l));
  const listed = new Set();
  if (at !== -1) {
    for (const l of msg.split('\n').slice(at + 1)) { const m = /^\S\t(.+)$/.exec(l); if (!m) break; listed.add(m[1]); }
    paths = paths.filter((p) => listed.has(p));
  }
  if (!paths.length) {
    // Resolved to what HEAD has (all ours): nothing to save, but say so ({ sha: null, unchanged }).
    const unchanged = [...listed].filter((p) => !unmerged.has(p)).length;
    return unchanged ? { sha: null, paths: [], unchanged } : null;
  }
  const staged = new Map();
  for (const rec of z(await run(cwd, ['ls-files', '-s', '-z', '--', ...paths], { env: W_ENV }))) {
    const tab = rec.indexOf('\t');
    const [mode, oid] = rec.slice(0, tab).split(' ');
    staged.set(rec.slice(tab + 1), `${mode} ${oid}`);
  }
  const indexFile = path.join(gitDir, `gitlanes-resolved-${process.pid}.index`);
  const env = { ...W_ENV, GIT_INDEX_FILE: indexFile };
  try {
    await run(cwd, ['read-tree', head], { env });
    const info = paths.map((p) => `${staged.get(p) || `0 ${'0'.repeat(head.length)}`}\t${p}\0`).join('');
    await run(cwd, ['update-index', '-z', '--index-info'], { env, input: info });
    const tree = (await run(cwd, ['write-tree'], { env })).trim();
    const index = (await run(cwd, ['commit-tree', tree, '-p', head], { input: 'index of resolved files\n' })).trim();
    const sha = (await run(cwd, ['commit-tree', tree, '-p', head, '-p', index], { input: 'Resolved files\n' })).trim();
    return { sha, paths };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

// Put saved resolved files back (saveResolved's commit). With an operation stopped here again on
// those same files, write them and stage them (that resolves their conflicts); otherwise apply
// them to the work tree as a stash (by SHA).
async function restoreResolved(cwd, gitDir, sha) {
  const paths = await resolvedPaths(cwd, sha);
  const unmerged = new Set((await run(cwd, ['ls-files', '-u', '-z'], { env: W_ENV })).split('\0').filter(Boolean).map((r) => r.slice(r.indexOf('\t') + 1)));
  const again = (await getOperationState(gitDir)) && paths.every((p) => unmerged.has(p));
  if (!again) return run(cwd, ['stash', 'apply', '--index', sha], { env: W_ENV });
  const present = new Set((await run(cwd, ['ls-tree', '-r', '-z', '--name-only', sha, '--', ...paths], { env: W_ENV })).split('\0').filter(Boolean));
  const gone = paths.filter((p) => !present.has(p));
  if (present.size) await run(cwd, ['checkout', sha, '--', ...present], { env: W_ENV });
  if (gone.length) await run(cwd, ['rm', '-q', '-f', '--ignore-unmatch', '--', ...gone], { env: W_ENV });
}

// The files saveResolved kept in `sha` (it must look like one: two parents with the same tree).
async function resolvedPaths(cwd, sha) {
  const [tree, ...parents] = (await run(cwd, ['show', '-s', '--format=%T %P', sha])).trim().split(' ');
  const indexTree = parents.length === 2 && (await run(cwd, ['rev-parse', `${parents[1]}^{tree}`])).trim();
  if (indexTree !== tree) throw new GitError('Those saved files are not available.');
  return (await run(cwd, ['diff', '--name-only', '--no-renames', '-z', parents[0], sha], { env: W_ENV })).split('\0').filter(Boolean);
}

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
// `force` moves an existing `branch` to `base` (`-B`), so the move and the new worktree are one step.
async function addWorktree(cwd, { dir, branch, base, force = false } = {}) {
  const main = (await getWorktrees(cwd)).find((w) => w.main);
  const at = base || 'HEAD';
  dir = dir ? resolveWorktreePath(main.path, dir) : defaultWorktreePath(main.path, branch || (await run(cwd, ['rev-parse', '--short', at])).trim());
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new GitError(`${dir} already exists and is not an empty folder.`);
  const local = branch && (await run(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { allowCodes: [0, 1] })).trim();
  const args = ['worktree', 'add', '-q'];
  if (!branch) args.push('--detach', dir, at);
  else if (local && force && base) args.push('-B', branch, dir, base);
  else if (local) args.push(dir, branch);
  else args.push('-b', branch, dir, at);
  await run(cwd, args, { env: W_ENV });
  return realpath(dir);
}

// Remove a worktree's folder. Refused unless the worktree is clean (code 'dirty-worktree'
// otherwise): undo recreates it from its branch or commit.
// Ignored files (build output, dependencies) are deleted with the folder.
// `stash` first stashes its uncommitted changes (the stash's SHA is returned as `stash`);
// `abort` first aborts a stopped rebase, merge, cherry-pick or revert there (not undoable).
// `changes` (cleanup redo only, not over IPC): 'stash' or 'discard' its changes via saveWorktree,
// returned as `saved`.
async function removeWorktree(cwd, dir, { stash = false, abort = false, changes } = {}) {
  let wt = await findWorktree(cwd, dir);
  if (wt.main) throw new GitError('The main worktree can’t be removed.');
  if (wt.current) throw new GitError('This window is showing that worktree. Switch to another one first.');
  if (wt.locked || wt.missing) await checkRemovable(wt);
  if (abort) {
    const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
    if (op) await run(wt.path, [op, '--abort'], { env: W_ENV });
    // An aborted rebase puts its branch back: undo re-adds the worktree on that, not the detached HEAD.
    if (op) wt = await findWorktree(cwd, dir);
  }
  let sha = null, saved = null;
  if (stash && await worktreeChanges(wt.path)) sha = await stashWorktree(wt.path, `GitLanes: ${wt.name} before removing it`);
  else if (changes) saved = await saveWorktree(wt, changes === 'stash');
  try {
    await checkRemovable(wt);
    await run(cwd, ['worktree', 'remove', wt.path], { env: W_ENV });
  } catch (err) {
    if (sha) await popStash(wt.path, sha).catch(() => {});
    if (saved) await unstashWorktree(wt.path, saved).catch(() => {});
    throw err;
  }
  return sha ? { ...wt, stash: sha } : saved ? { ...wt, saved } : wt;
}

// Stash everything in worktree `dir` (untracked files too); returns the new stash's SHA.
async function stashWorktree(dir, message) {
  const top = () => run(dir, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowCodes: [0, 1] }).then((o) => o.trim());
  const prev = await top();
  await stashPush(dir, { message, untracked: true });
  const sha = await top();
  if (!sha || sha === prev) throw new GitError('Its changes could not be stashed.');
  return sha;
}

// Apply and drop the stash with this SHA in worktree `dir`.
async function popStash(dir, sha) {
  const i = (await getStashes(dir)).findIndex((x) => x.sha === sha);
  if (i === -1) throw new GitError('Its stash was applied or dropped since.');
  await stashApply(dir, `stash@{${i}}`, true);
}

// Cleanup (cleanupLanes): stash every uncommitted change in a worktree, untracked files too.
// `keep` leaves the stash in the list; otherwise it is dropped and only the returned commit
// ({ sha, message, kept }) has it. Null when there was nothing to stash.
async function saveWorktree(wt, keep) {
  const top = () => run(wt.path, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowCodes: [0, 1] }).then((o) => o.trim());
  const message = `Worktree ${wt.name} before it was removed`;
  const prev = await top();
  await stashPush(wt.path, { message, untracked: true });
  const sha = await top();
  if (!sha || sha === prev) return null;
  if (!keep) await run(wt.path, ['stash', 'drop', '-q', 'stash@{0}'], { env: W_ENV });
  return { sha, message, kept: keep };
}

// Put a saveWorktree commit back into the worktree at `dir`; a kept stash leaves the list.
async function unstashWorktree(dir, saved) {
  await run(dir, ['stash', 'apply', '-q', '--index', saved.sha], { env: W_ENV });
  if (saved.kept) await dropStashCommit(dir, saved.sha).catch(() => {});
}

// Put a removed worktree back at the same path, on the same branch or commit, with the changes
// `saved` stashed when it was removed.
async function restoreWorktree(cwd, { path: dir, branch, head, saved }) {
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new GitError(`${dir} is in the way.`);
  if (saved?.kept && !(await getStashes(cwd)).some((x) => x.sha === saved.sha)) throw new GitError(`the stash of ${path.basename(dir)}’s changes was applied or dropped since.`);
  await run(cwd, ['worktree', 'add', '-q', ...(branch ? [dir, branch] : ['--detach', dir, head])], { env: W_ENV });
  if (saved) await unstashWorktree(dir, saved);
}

const lockWorktree = async (cwd, dir, reason) => run(cwd, ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), (await findWorktree(cwd, dir)).path], { env: W_ENV });
const unlockWorktree = async (cwd, dir) => run(cwd, ['worktree', 'unlock', (await findWorktree(cwd, dir)).path], { env: W_ENV });
const pruneWorktrees = (cwd) => run(cwd, ['worktree', 'prune'], { env: W_ENV });

// Lanes → Clean up: remove worktrees and delete branches in bulk. Each item is
// { branch, head, worktree, force }: `head` is the branch tip the user saw (a branch that has
// moved since is kept), `force` allows removing a dirty worktree (its uncommitted files are lost to
// git, though undo brings them back), `stash` does too but keeps them in the stash list, `abort`
// aborts a rebase, merge, cherry-pick or revert stopped in it (a failure over one has `op` set).
// Worktrees go first, since a branch checked out in one can't be deleted: one `worktree remove`
// each, or a single `worktree prune` when every missing folder is selected. Branches then go in
// one `git branch -D` per 200. Never throws part-way: returns { removed, deleted, failed } so the
// journal can record exactly what happened. `onProgress({ done, total })` after each step.
async function cleanupLanes(cwd, items, { onProgress = () => {} } = {}) {
  const worktrees = await getWorktrees(cwd);
  const removed = [];
  const failed = [];
  const keep = new Set(); // branches whose worktree is still there
  const wtItems = items.filter((i) => i.worktree);
  const found = wtItems.map((i) => ({ item: i, wt: worktrees.find((w) => samePath(w.path, i.worktree)) }));
  const branches = items.filter((i) => i.branch);
  const batches = chunk(branches, 200);
  const total = wtItems.length + batches.length;
  let done = 0;
  const tick = () => onProgress({ done: ++done, total });

  const missing = worktrees.filter((w) => w.missing && !w.locked);
  const pruneAll = missing.length > 0 && missing.every((m) => found.some((f) => f.wt === m));
  if (pruneAll) {
    try { await pruneWorktrees(cwd); } catch { /* fall back to one remove each below */ }
  }
  const after = pruneAll ? await getWorktrees(cwd) : worktrees;
  for (const { item, wt } of found) {
    try {
      if (!wt) throw new GitError('That worktree no longer exists.');
      if (wt.missing && !after.some((w) => w.path === wt.path)) {
        removed.push({ path: wt.path, branch: wt.branch, head: wt.head, pruned: true, lost: 0 });
        continue;
      }
      if (wt.main) throw new GitError('The main worktree can’t be removed.');
      if (wt.current) throw new GitError('This window is showing it.');
      if (wt.locked) throw new GitError('It is locked.');
      let lost = 0;
      if (!wt.missing) {
        const op = await worktreeOp(wt.path);
        if (op && item.abort) {
          await run(wt.path, [op, '--abort'], { env: W_ENV });
          Object.assign(wt, await findWorktree(cwd, wt.path)); // the branch it was rebasing is back
        } else if (op) throw opInProgress(`It has a ${op} in progress.`, op);
        lost = await worktreeChanges(wt.path);
        if (lost && !item.force && !item.stash && !item.abort) throw new GitError(`It has ${lost} uncommitted change${lost > 1 ? 's' : ''}.`);
      }
      // Uncommitted changes are stashed first (the stash dropped again unless `stash` or `abort`), so undo has them.
      const saved = lost ? await saveWorktree(wt, !!(item.stash || item.abort)) : null;
      await run(cwd, ['worktree', 'remove', ...(lost || wt.missing ? ['--force'] : []), wt.path], { env: W_ENV });
      removed.push({ path: wt.path, branch: wt.branch, head: wt.head, pruned: wt.missing, lost, ...(saved ? { saved } : {}) });
    } catch (err) {
      failed.push({ name: wt?.name || path.basename(item.worktree), message: err.message, ...(err.op ? { op: err.op, worktree: wt.path } : {}) });
      if (item.branch) keep.add(item.branch);
    } finally {
      tick();
    }
  }

  const deleted = [];
  if (branches.length) {
    const tips = new Map((await run(cwd, ['for-each-ref', '--format=%(refname:lstrip=2)%00%(objectname)', 'refs/heads'])).split('\n').filter(Boolean).map((l) => l.split(SEP)));
    for (const batch of batches) {
      const go = [];
      for (const i of batch) {
        if (keep.has(i.branch)) continue;
        if (!tips.has(i.branch)) failed.push({ name: i.branch, message: 'That branch no longer exists.' });
        else if (i.head && tips.get(i.branch) !== i.head) failed.push({ name: i.branch, message: 'It has new commits since. Kept.' });
        else go.push(i.branch);
      }
      let error = null;
      if (go.length) await run(cwd, ['branch', '-D', '--', ...go], { env: W_ENV }).catch((err) => { error = err; });
      const left = error ? new Set((await run(cwd, ['for-each-ref', '--format=%(refname:lstrip=2)', ...go.map((b) => `refs/heads/${b}`)])).split('\n').filter(Boolean)) : new Set();
      for (const b of go) {
        if (!left.has(b)) deleted.push(b);
        else failed.push({ name: b, message: (error.stderr || error.message).split('\n').find((l) => l.includes(`'${b}'`))?.replace(/^error: /, '') || error.message });
      }
      tick();
    }
  }
  return { removed, deleted, failed };
}

// Delete branches on their remotes, one `git push --delete` per remote. `shorts` are
// remote-tracking names ("origin/feature/x"), split on the longest matching remote name.
// Never deletes a remote's default branch (its `<remote>/HEAD`) or a branch a local branch still
// tracks: run it after the local branches are gone. Duplicates are dropped.
// Not undoable. Returns { deleted, failed }.
async function deleteRemoteBranches(cwd, shorts) {
  const remotes = (await getRemotes(cwd)).map((r) => r.name).sort((a, b) => b.length - a.length);
  const tracked = new Set((await run(cwd, ['for-each-ref', '--format=%(upstream:short)', 'refs/heads'])).split('\n').filter(Boolean));
  const heads = new Map();
  const defaultOf = async (remote) => {
    // Without a known `<remote>/HEAD`, main and master both count as the default.
    if (!heads.has(remote)) {
      const head = (await run(cwd, ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
      heads.set(remote, new Set(head ? [head, `${remote}/HEAD`] : [`${remote}/main`, `${remote}/master`, `${remote}/HEAD`]));
    }
    return heads.get(remote);
  };
  const byRemote = new Map();
  const failed = [];
  for (const s of new Set(shorts)) {
    const remote = remotes.find((r) => s.startsWith(`${r}/`) && s.length > r.length + 1);
    if (!remote) { failed.push({ name: s, message: 'No such remote.' }); continue; }
    if ((await defaultOf(remote)).has(s)) { failed.push({ name: s, message: 'It’s the default branch.' }); continue; }
    if (tracked.has(s)) { failed.push({ name: s, message: 'A local branch still tracks it.' }); continue; }
    byRemote.set(remote, [...(byRemote.get(remote) || []), s.slice(remote.length + 1)]);
  }
  const deleted = [];
  for (const [remote, names] of byRemote) {
    try {
      await run(cwd, ['push', remote, '--delete', '--', ...names]);
      deleted.push(...names.map((n) => `${remote}/${n}`));
    } catch (err) {
      // A partial push still deleted some: whatever is no longer listed as a remote-tracking ref is gone.
      const left = new Set((await run(cwd, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`]).catch(() => '')).split('\n'));
      for (const n of names) (left.has(`${remote}/${n}`) ? failed.push({ name: `${remote}/${n}`, message: err.message }) : deleted.push(`${remote}/${n}`));
    }
  }
  return { deleted, failed };
}

// ---------------------------------------------------------------------------
// Merge and tidy: land a lane's branch on its base as one squashed commit, then remove the
// lane's worktree and delete the branch. The squash is built with `merge-tree --write-tree` and
// `commit-tree`, so no worktree but the base's own (when this window has it checked out) is
// touched. The journal records all of it as one step (journal.runLane).

// What merging `branch` into `base` would do, without changing anything. `blocker` stops the
// whole action; `mergeBlocker` only stops merging here (a GitHub merge can still go ahead).
// commits: newest first, [{ subject, body }]; empty when the branch has nothing left to merge.
async function mergeLanePlan(cwd, branch, base, { abort = false } = {}) {
  if (String(branch).startsWith('-')) throw new GitError(`Unknown branch ${branch}`);
  const head = (await run(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { allowCodes: [0, 1] })).trim();
  if (!head) throw new GitError(`There is no branch ${branch}.`);
  const b = await laneBase(cwd, base);
  const into = b?.local || null;
  const baseSha = into ? (await run(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${into}^{commit}`], { allowCodes: [0, 1] })).trim() : '';
  const worktrees = await getWorktrees(cwd);
  const wt = worktrees.find((w) => w.branch === branch) || (await rebasingIn(worktrees, branch));
  const baseWt = into ? worktrees.find((w) => w.branch === into) : null;
  // `keep`: the branch is checked out in this window ('current') or the main worktree ('main'), so
  // it is merged but kept, with its worktree. `baseWorktree`: the other worktree that has the base.
  const keep = wt?.current ? 'current' : wt?.main ? 'main' : null;
  const plan = { branch, head, base: into, baseSha: baseSha || null, commits: [], conflicts: [], worktree: wt && !keep ? { path: wt.path, name: wt.name } : null, keep, baseWorktree: null, blocker: null, blockerOp: null, mergeBlocker: null };
  if (wt && !keep) {
    // `abort`: an operation stopped in it is aborted when it is removed, after the merge.
    try { await checkRemovable(wt, { ignoreOp: abort }); } catch (err) { plan.blocker = err.message; plan.blockerOp = err.op || null; }
  }
  if (!into || !baseSha) plan.mergeBlocker = into ? `There is no local ${into} branch to merge into.` : 'There is no base branch (main or master) to merge into.';
  else if (into === branch) plan.blocker = `${branch} is the base branch.`;
  else if (baseWt && !baseWt.current) {
    plan.mergeBlocker = `${into} is checked out in ${baseWt.name}.`;
    plan.baseWorktree = { path: baseWt.path, name: baseWt.name };
  }
  if (plan.blocker || !baseSha) return plan;
  plan.commits = (await run(cwd, ['log', '--format=%s%x00%b%x1e', `${baseSha}..${head}`, '--'])).split('\x1e').map((r) => r.replace(/^\n+/, '')).filter(Boolean)
    .map((r) => { const i = r.indexOf('\0'); return { subject: r.slice(0, i).trim(), body: r.slice(i + 1).trim() }; });
  if (plan.commits.length) {
    const tree = await squashTree(cwd, baseSha, head).catch((err) => { plan.mergeBlocker ||= err.message; return null; });
    if (tree?.conflicts.length) {
      plan.conflicts = tree.conflicts;
      plan.mergeBlocker ||= `It conflicts with ${into} in ${tree.conflicts.length} file${tree.conflicts.length > 1 ? 's' : ''}. Rebase it or merge ${into} into it first.`;
    }
  }
  return plan;
}

// The tree of `head` merged onto `baseSha`, or the conflicted paths. Needs git 2.38.
async function squashTree(cwd, baseSha, head) {
  let out;
  try {
    out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseSha, head], { allowCodes: [0, 1] });
  } catch (err) {
    if (!(await canForecast(cwd))) throw new GitError('Merging here needs git 2.38 or later.');
    throw err;
  }
  // A clean merge prints only the tree; a conflicted one lists the conflicted paths after it.
  const [tree, ...rest] = out.split('\0');
  return { tree: tree.trim(), conflicts: [...new Set(rest.filter(Boolean))] };
}

// Whether `wt` (from getWorktrees) can be removed: unlocked, on disk, nothing in progress (unless
// `abort`: then it is aborted here, or `ignoreOp`: a later removal aborts it), clean (unless
// `dirty` is allowed). A refusal over an operation has code 'op-in-progress' and `op` set; a
// dirty one has code 'dirty-worktree' and `changes` set.
async function checkRemovable(wt, { dirty = false, abort = false, ignoreOp = false } = {}) {
  if (wt.locked) throw new GitError(`“${wt.name}” is locked${wt.lockReason ? ` (${wt.lockReason})` : ''}. Unlock it first.`);
  if (wt.missing) throw new GitError(`“${wt.name}” no longer exists on disk. Use Prune Missing Worktrees instead.`);
  const op = await worktreeOp(wt.path);
  if (op && abort) await run(wt.path, [op, '--abort'], { env: W_ENV });
  else if (op && !ignoreOp) throw opInProgress(`“${wt.name}” has a ${op} in progress. Finish or abort it first.`, op);
  const n = dirty || (op && ignoreOp) ? 0 : await worktreeChanges(wt.path);
  if (n) throw Object.assign(new GitError(`“${wt.name}” has ${n} uncommitted change${n > 1 ? 's' : ''}. Commit, stash or discard ${n > 1 ? 'them' : 'it'} first.`), { code: 'dirty-worktree', changes: n });
}

// Why worktree `wt` (from getWorktrees) can't give up its branch (HEAD detached there, so the
// branch can be checked out elsewhere), or null: it must be on disk, clean, nothing in progress.
async function freeBlocker(wt) {
  if (wt.missing) return 'Its folder no longer exists.';
  const n = await worktreeChanges(wt.path);
  if (n) return `It has ${n} uncommitted change${n > 1 ? 's' : ''}.`;
  const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
  if (op) return `It has a ${op} in progress.`;
  return null;
}

// What removing worktree `wt` (from getWorktrees) has to deal with: its uncommitted changes
// (stashed by the removal) and a stopped operation there (aborted, after asking).
async function removalFacts(wt) {
  if (wt.missing) return { changes: 0, op: null };
  const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
  return { changes: await worktreeChanges(wt.path), op };
}

// What decides whether worktree `wt` can hand its branch and its uncommitted changes to another
// worktree (Journal.moveCheckout): `blocker` (folder gone, operation in progress), else how many
// changes it has and when the newest of them was written (ms, null when none is on disk).
async function worktreeHold(wt) {
  if (wt.missing) return { blocker: 'Its folder no longer exists.' };
  const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
  if (op) return { blocker: `It has a ${op} in progress.` };
  const paths = [...new Set(await dirtyPaths(wt.path))];
  let changedAt = null;
  for (const p of paths) {
    try { changedAt = Math.max(changedAt || 0, fs.lstatSync(path.join(wt.path, p)).mtimeMs); } catch {}
  }
  return { blocker: null, changes: paths.length, changedAt };
}

// The rebase, merge, cherry-pick or revert stopped in the worktree at `dir`, or null.
async function worktreeOp(dir) {
  return getOperationState((await run(dir, ['rev-parse', '--absolute-git-dir'])).trim());
}

// The worktree stopped part-way through rebasing `branch` (git lists it as detached), or null.
async function rebasingIn(worktrees, branch) {
  for (const w of worktrees) {
    if (!w.detached || w.missing) continue;
    const dir = (await run(w.path, ['rev-parse', '--absolute-git-dir'])).trim();
    for (const d of ['rebase-merge', 'rebase-apply']) {
      try { if (fs.readFileSync(path.join(dir, d, 'head-name'), 'utf8').trim() === `refs/heads/${branch}`) return w; } catch {}
    }
  }
  return null;
}

const opInProgress = (message, op) => Object.assign(new GitError(message), { code: 'op-in-progress', op });

// Squash `branch` onto `base` with `message` (skipped when `merge` is false, or when the branch
// has nothing left to merge), then remove its worktree and delete it, unless it is checked out
// here or in the main worktree (plan.keep): then it is kept. Everything is checked
// before anything changes. `done` reports what happened, for the journal, even on a failure
// part-way: { commit, worktree } (the removed worktree, as removeWorktree returns it). `abort`
// aborts an operation stopped here (base checked out) or in the lane's worktree.
async function mergeLane(cwd, { branch, base, message = '', merge = true, abort = false } = {}, done = {}) {
  const plan = await mergeLanePlan(cwd, branch, base, { abort });
  if (plan.blocker) throw new GitError(plan.blocker);
  let tree = null;
  if (merge && plan.commits.length) {
    if (plan.mergeBlocker) throw new GitError(plan.mergeBlocker);
    if (!String(message).trim()) throw new GitError('The commit message is empty.');
    tree = (await squashTree(cwd, plan.baseSha, plan.head)).tree;
    if (tree === (await run(cwd, ['rev-parse', `${plan.baseSha}^{tree}`])).trim()) tree = null; // already on base
  }
  if (tree) {
    const commit = (await run(cwd, ['commit-tree', tree, '-p', plan.baseSha, '-F', '-'], { input: message.trim() + '\n' })).trim();
    const here = (await run(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] })).trim();
    // The base checked out here: move it with the working copy (local changes are kept, as undo does).
    if (here === `refs/heads/${plan.base}`) {
      const op = await worktreeOp(cwd);
      if (op && abort) await run(cwd, [op, '--abort'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
      else if (op) throw opInProgress(`A ${op} is in progress.`, op);
      await run(cwd, ['reset', '--keep', commit], { env: { GIT_OPTIONAL_LOCKS: '1' } });
    } else {
      await run(cwd, ['update-ref', '-m', `gitlanes: merge ${branch}`, `refs/heads/${plan.base}`, commit, plan.baseSha]);
    }
    done.commit = commit;
  }
  if (plan.keep) return { commit: done.commit || null, base: plan.base, worktree: null, kept: plan.keep };
  if (plan.worktree) done.worktree = await removeWorktree(cwd, plan.worktree.path, abort ? { abort, changes: 'stash' } : {});
  await run(cwd, ['branch', '-D', '--', branch]);
  return { commit: done.commit || null, base: plan.base, worktree: plan.worktree, kept: null };
}

// ---------------------------------------------------------------------------
// Lanes: one record per local branch and per worktree, measured against the repository's
// default branch. A fixed handful of git calls however many branches there are (one
// for-each-ref, one worktree list, one log, three patch-id passes), plus one status per worktree
// for its uncommitted-file count. Read-only.

// "Probably an agent", guessed from a lane's commits ahead of base and its branch name. Extend
// the lists here; matching is case-insensitive.
const { AGENT_HINTS } = require('./renderer/agents.js'); // shared with the renderer (AK-393)
// Lane commits read for trailers and squash checks, and base commits searched for squash merges.
const LANE_COMMITS = 5000;
// Squash merges older than BASE_COMMITS base commits aren't detected: such a branch reads merged: null.
const BASE_COMMITS = 2000;
// The base side of the squash checks (its log and patch ids) only depends on the base tip: one entry
// per repo, replaced when the base moves.
const baseSquash = new Map();
function baseSquashData(cwd, sha) {
  const hit = baseSquash.get(cwd);
  if (hit?.sha === sha) return hit.data;
  const data = Promise.all([
    run(cwd, ['log', `--max-count=${BASE_COMMITS}`, '--format=%H%x00%T%x00%s', sha, '--']),
    patchIds(cwd, ['log', '-p', '--no-merges', '--no-color', '--no-ext-diff', `--max-count=${BASE_COMMITS}`, '--format=commit %H', sha, '--']).then(newestBy),
  ]);
  baseSquash.set(cwd, { sha, data });
  // A failure, or patch ids cut short (size or time limit: empty), is not kept.
  data.then(([, ids]) => { if (!ids.size && baseSquash.get(cwd)?.data === data) baseSquash.delete(cwd); }, () => { if (baseSquash.get(cwd)?.data === data) baseSquash.delete(cwd); });
  return data;
}
// Lanes further ahead than this skip the per-commit (cherry) check: too much diff for too little.
const CHERRY_MAX = 100;
// Commits that say nothing about a lane's work: the empty commit an agent's task worktree starts
// from, and the commit that sweeps up its scratch files at the end. Merge commits (merging base
// in) are skipped by parent count.
const BASELINE = /^chore\(agent\): (?:baseline\b|uncommitted changes from task\b)/i;
// An issue key in a branch name's segment ("agent/x/ak-228", "ak-228-fix-thing") → "AK-228".
function branchKey(branch) {
  for (const seg of String(branch || '').split('/').reverse()) {
    const m = /^([a-z][a-z0-9]{0,9}-\d+)(?:[-_.]|$)/i.exec(seg);
    if (m) return m[1].toUpperCase();
  }
  return null;
}
// A commit subject as the base shows it after a squash merge: without the trailing "(#123)".
const plainSubject = (s) => String(s || '').trim().replace(/\s*\(#\d+\)$/, '').toLowerCase();
// "~/…/<last two segments>" for a worktree path; the full path stays on `worktree.path`.
function shortPath(p, home = os.homedir()) {
  const inHome = home && (p === home || p.startsWith(`${home}/`));
  const segs = (inHome ? p.slice(home.length) : p).split('/').filter(Boolean);
  const tail = segs.slice(-2).join('/');
  return `${inHome ? '~/' : '/'}${segs.length > 2 ? `…/${tail}` : tail}`;
}

function parseTrailers(text) {
  return text.split('\n').flatMap((l) => {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(l.trim());
    return m ? [{ key: m[1], value: m[2] }] : [];
  });
}

// { reason: 'trailer' | 'branch prefix', match } or null.
function agentGuess(branch, trailers = []) {
  for (const t of trailers) {
    const key = t.key.toLowerCase();
    if (AGENT_HINTS.trailers.includes(key)) return { reason: 'trailer', match: `${t.key}: ${t.value}` };
    if (key === 'co-authored-by') {
      const words = t.value.toLowerCase().split(/[^a-z0-9]+/);
      if (AGENT_HINTS.coauthors.some((n) => words.includes(n))) return { reason: 'trailer', match: `${t.key}: ${t.value}` };
    }
  }
  const b = String(branch || '').toLowerCase();
  const prefix = AGENT_HINTS.prefixes.find((p) => b.startsWith(p));
  return prefix ? { reason: 'branch prefix', match: prefix } : null;
}

const shortRef = (ref) => ref.replace(/^refs\/(heads|remotes)\//, '');

// The base lanes are measured against: `base` if given, else origin/HEAD, else main or master.
// { ref, sha, name, local } (local = the local branch name it stands for), or null when there is none.
async function laneBase(cwd, base) {
  if (base) {
    if (String(base).startsWith('-')) throw new GitError(`Unknown base ${base}`);
    const sha = (await run(cwd, ['rev-parse', '--verify', '-q', `${base}^{commit}`], { allowCodes: [0, 1] })).trim();
    if (!sha) throw new GitError(`Unknown base ${base}`);
    const ref = (await run(cwd, ['rev-parse', '--symbolic-full-name', base], { allowCodes: [0, 128] })).trim() || base;
    return { ref, sha, name: shortRef(ref), local: ref.startsWith('refs/heads/') ? shortRef(ref) : ref.startsWith('refs/remotes/') ? shortRef(ref).replace(/^[^/]+\//, '') : null };
  }
  const order = ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
  const out = await run(cwd, ['for-each-ref', '--format=%(refname)%00%(symref)', ...order]);
  const found = new Map(out.split('\n').filter(Boolean).map((l) => l.split('\0')));
  const ref = order.map((r) => (r.endsWith('/HEAD') ? found.get(r) : found.has(r) ? r : '')).find(Boolean);
  if (!ref) return null;
  const sha = (await run(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowCodes: [0, 1] })).trim();
  if (!sha) return null;
  return { ref, sha, name: shortRef(ref), local: shortRef(ref).replace(/^origin\//, '') };
}

// Review's catch-up card (AK-281): what reached the base since a checkpoint, one entry per commit
// on the base's first-parent line (a merged PR is one entry), with the files each changed against
// its first parent. `since` is { sha } (a checkpoint), { ref } (a tag) and/or { date } (ms). A sha
// or tag that is no longer part of the base (force-push) falls back to `since.date`, or to the
// commit's own date, and says so (`fallback`). Local git only. → { base, baseSha, baseDate, from,
// fallback, commits: [{ sha, parent, date, author, subject, files }], truncated, tags } or null
// without a base branch.
async function landed(cwd, { base, since = {}, limit = 300 } = {}) {
  const b = await laneBase(cwd, base);
  if (!b) return null;
  let date = since.date ?? null;
  let from = null;
  let fallback = null;
  const at = since.sha || since.ref;
  if (at) {
    if (String(at).startsWith('-')) throw new GitError(`Unknown checkpoint ${at}`);
    const sha = (await run(cwd, ['rev-parse', '--verify', '-q', `${at}^{commit}`], { allowCodes: [0, 1, 128] })).trim();
    const onBase = sha && await run(cwd, ['merge-base', '--is-ancestor', sha, b.sha]).then(() => true, () => false);
    if (onBase) from = sha;
    else {
      if (sha && date == null) date = Number((await run(cwd, ['log', '-1', '--format=%ct', sha])).trim()) * 1000;
      fallback = { sha: since.sha || since.ref, reason: sha ? 'unreachable' : 'missing' };
    }
  }
  const range = from ? [`${from}..${b.sha}`] : [b.sha, ...(date != null ? [`--since=${new Date(date).toISOString()}`] : [])];
  const [out, baseDate, tags] = await Promise.all([
    from || date != null ? run(cwd, ['log', '--first-parent', '-m', '--name-only', '-z', `--max-count=${limit + 1}`, '--format=%x1e%H%x00%P%x00%ct%x00%an%x00%s%x00', ...range, '--']) : '',
    run(cwd, ['log', '-1', '--format=%ct', b.sha]),
    run(cwd, ['for-each-ref', '--sort=-creatordate', '--count=20', '--format=%(refname:short)', 'refs/tags']),
  ]);
  const commits = [];
  for (const rec of out.split('\x1e')) {
    if (!rec) continue;
    const [sha, parents, ct, author, subject, ...rest] = rec.split('\0');
    commits.push({ sha, parent: parents.split(' ')[0] || null, date: Number(ct) * 1000, author, subject, files: [...new Set(rest.map((f) => f.replace(/^\n+/, '')).filter(Boolean))] });
  }
  const truncated = commits.length > limit;
  return { base: b.name, baseSha: b.sha, baseDate: Number(baseDate.trim()) * 1000, from, date, fallback, commits: commits.slice(0, limit), truncated, tags: tags.split('\n').filter(Boolean) };
}

// Shipped checks on top of `merged`, for lanes with commits ahead of base, cheapest first: a merged
// PR's head (by SHA: task branches are often named differently from the PR branch), the branch's
// issue key or its newest subject on a squash-merged base commit, then the net patch. Sets l.done ({ reason,
// pr?, key? }), l.prTitle, and l.netEmpty (tip tree = merge-base tree: nothing to ship, never done).
// The key matches "(AK-12)" anywhere or "AK-12:" leading a base subject.
// Batched: one merge-base per lane, one log, one diff-tree, one patch-id, then merge-tree only for
// lanes still open.
async function shipped(cwd, b, lanes, { prHeads, baseIds, baseRows, baseTree, commits = new Map() }) {
  if (!b || !lanes.length) return;
  const heads = new Map((prHeads || []).filter((p) => p && /^[0-9a-f]{40}$/.test(p.sha)).map((p) => [p.sha, p]));
  // A merged PR's head below the tip only ships the lane when everything on top of it is
  // bookkeeping: baselines and merges from base. A branch stacked on a merged PR, or new commits
  // after the merge, still have work to ship.
  const prBelow = (l) => (l.commits || []).filter((c) => c !== l.head && heads.has(c)).map((c) => heads.get(c)).find((p) => {
    const under = new Set();
    const stack = [p.sha];
    while (stack.length) {
      const sha = stack.pop();
      const c = commits.get(sha);
      if (under.has(sha) || !c) continue;
      under.add(sha);
      stack.push(...c.parents);
    }
    return l.commits.every((sha) => {
      const c = commits.get(sha);
      return under.has(sha) || !c || BASELINE.test(c.subject) || (c.parents.length > 1 && c.parents.slice(1).every((x) => !commits.has(x)));
    });
  });
  // Key and subject matches only count on base commits newer than the lane's merge-base (the
  // base log is newest first), so a subject the lane forked from never marks it shipped.
  const rowAt = new Map(baseRows.map((r, i) => [r.sha, i]));
  const since = new Map();
  const newer = (mb) => {
    if (!since.has(mb)) {
      const rows = baseRows.slice(0, rowAt.get(mb) ?? baseRows.length);
      // Subjects only of squash-merged PRs ("… (#12)"): plain subjects like "fix tests" repeat.
      const subjects = new Map();
      for (const r of rows) if (/\(#\d+\)\s*$/.test(r.subject) && !subjects.has(plainSubject(r.subject))) subjects.set(plainSubject(r.subject), r.sha);
      since.set(mb, { rows, subjects, keys: `\n${rows.map((r) => r.subject).join('\n').toUpperCase()}` });
    }
    return since.get(mb);
  };
  const mbs = await mapLimit(lanes, 8, (l) => run(cwd, ['merge-base', l.head, b.sha], { allowCodes: [0, 1] }).then((o) => o.trim() || null, () => null));
  const uniq = [...new Set(mbs.filter(Boolean))];
  const mbTrees = new Map();
  if (uniq.length) {
    const out = await run(cwd, ['log', '--no-walk=unsorted', '--format=%H %T', ...uniq, '--']);
    for (const line of out.split('\n')) { const [h, t] = line.split(' '); if (t) mbTrees.set(h, t); }
  }
  const open = [];
  lanes.forEach((l, i) => {
    l.mergeBase = mbs[i];
    l.netEmpty = l.mergeBase != null && mbTrees.get(l.mergeBase) === l.tree;
    if (l.netEmpty || l.noWork) return;
    const pr = heads.get(l.head) || prBelow(l);
    // The key in the branch name, else the one leading its newest subject ("AK-48: …").
    const key = branchKey(l.branch) || (/^([a-z][a-z0-9]{0,9}-\d+):/i.exec(l.subject || '')?.[1] || '').toUpperCase() || null;
    const subject = plainSubject(l.subject);
    const base = newer(l.mergeBase);
    if (pr) { l.done = { reason: 'pr', pr: pr.number }; l.prTitle = pr.title || null; }
    else if (l.merged) return;
    else if (key && (base.keys.includes(`(${key})`) || base.keys.includes(`\n${key}:`))) {
      const row = base.rows.find((r) => { const s = r.subject.toUpperCase(); return s.includes(`(${key})`) || s.startsWith(`${key}:`); });
      l.done = { reason: 'key', key, ...squashOf(row) };
    } else if (subject.length >= 10 && base.subjects.has(subject)) l.done = { reason: 'subject', ...squashOf(baseRows[rowAt.get(base.subjects.get(subject))]) };
    else if (l.mergeBase) open.push(l);
  });
  if (!open.length) return;
  // Net patch: the lane's whole change since its merge-base (merges of base and the empty baseline
  // drop out) is a base commit's patch, or merging the lane into base changes nothing.
  const lines = [...new Set(open.map((l) => `${l.head} ${l.mergeBase}`))];
  const ids = await patchIds(cwd, ['diff-tree', '--stdin', '-p', '--no-color', '--no-ext-diff'], { input: `${lines.join('\n')}\n` });
  const rest = open.filter((l) => {
    if (!baseIds.has(ids.get(l.head))) return true;
    l.done = { reason: 'net-patch', sha: baseIds.get(ids.get(l.head)) };
    return false;
  });
  if (!rest.length || !baseTree || !(await canForecast(cwd))) return;
  await mapLimit(rest, 8, async (l) => {
    const out = await run(cwd, ['merge-tree', '--write-tree', '--no-messages', b.sha, l.head], { allowCodes: [0, 1] }).catch(() => '');
    if (out.split('\n')[0].trim() === baseTree) l.done = { reason: 'net-patch' };
  });
}

// Branch review: the whole change of `branch` against `base` the way a pull request shows it,
// from their merge-base (`base...branch`). Each file carries its blob at the tip (the zero id
// for a deletion), which is what a "reviewed" tick is keyed by. `base` defaults to laneBase's.
async function branchReview(cwd, branch, base) {
  if (String(branch).startsWith('-')) throw new GitError(`Unknown branch ${branch}`);
  const b = await laneBase(cwd, base);
  if (!b) throw new GitError('There is no base branch (main or master) to review against.');
  const tip = (await run(cwd, ['rev-parse', '--verify', '-q', `${branch}^{commit}`], { allowCodes: [0, 1] })).trim();
  if (!tip) throw new GitError(`${branch} has no commits yet.`);
  const mergeBase = (await run(cwd, ['merge-base', b.sha, tip], { allowCodes: [0, 1] })).trim();
  if (!mergeBase) throw new GitError(`${branch} shares no history with ${b.name}.`);
  const [raw, files] = await Promise.all([
    run(cwd, ['diff-tree', '-r', '-z', '-M', '--raw', '--no-commit-id', '--abbrev=40', mergeBase, tip]),
    diffTreeFiles(cwd, mergeBase, tip),
  ]);
  const blobs = parseRawBlobsZ(raw);
  return { branch, base: b.name, baseSha: b.sha, mergeBase, tip, files: files.map((f) => ({ ...f, blob: blobs.get(f.path) || null })) };
}

// path → blob at the new side, from `diff-tree --raw -z` (":old new oldsha newsha S\0path\0[path\0]").
function parseRawBlobsZ(out) {
  const blobs = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith(':')) continue;
    const meta = parts[i].split(' ');
    const twoPaths = /^[RC]/.test(meta[4]);
    blobs.set(parts[i + (twoPaths ? 2 : 1)], meta[3]);
    i += twoPaths ? 2 : 1;
  }
  return blobs;
}

let gitVersion = null;
async function hasAheadBehind(cwd) {
  gitVersion ||= run(cwd, ['version']).then((v) => (/(\d+)\.(\d+)/.exec(v) || [0, 0, 0]).slice(1).map(Number), () => [0, 0]);
  const [major, minor] = await gitVersion;
  return major > 2 || (major === 2 && minor >= 41);
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// The base commit a key or subject match points at: its sha and, for a squash-merged PR ("… (#12)"), the number.
function squashOf(row) {
  if (!row) return {};
  const m = /\(#(\d+)\)\s*$/.exec(row.subject);
  return m ? { sha: row.sha, pr: Number(m[1]) } : { sha: row.sha };
}

// patch id → newest commit with it, from patchIds over a newest-first log.
const newestBy = (m) => { const out = new Map(); for (const [sha, id] of m) if (!out.has(id)) out.set(id, sha); return out; };

// Patch ids of a diff stream ("commit <sha>" headers) as Map(sha → patch id).
// For a diff-producing git command. Its output is piped straight into
// `git patch-id --stable`, so a huge diff (an icon repo's SVG history runs to hundreds of MB) never
// becomes a JS string. Past maxBytes or timeout both are killed and the result is empty: squash
// detection degrades, the main process keeps its heap.
const PATCH_MAX_BYTES = 1024 * 1024 * 1024;
const PATCH_TIMEOUT = 30000;
function patchIds(cwd, args, { input, maxBytes = PATCH_MAX_BYTES, timeout = PATCH_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { cwd, env: BASE_ENV, detached: process.platform !== 'win32' };
    const src = spawn('git', args, opts);
    const ids = spawn('git', ['patch-id', '--stable'], opts);
    let bytes = 0; let out = ''; let err = ''; let capped = null; let failed = null; let open = 2;
    const codes = {};
    const stop = (why) => { if (capped) return; capped = why; src.kill(); ids.kill(); };
    const timer = setTimeout(() => stop(`took over ${timeout / 1000}s`), timeout);
    const finish = () => {
      clearTimeout(timer);
      if (capped) {
        console.warn(`lanes: squash detection skipped, git ${args[0]} ${capped}`);
        resolve(new Map());
      } else if (failed || codes.src !== 0 || codes.ids !== 0) {
        const msg = (err || failed?.message || '').trim().split('\n').slice(-6).join('\n');
        reject(new GitError(msg || `git ${args[0]} failed`, { code: codes.src || codes.ids || 1, stderr: err, args }));
      } else {
        resolve(new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ').reverse())));
      }
    };
    src.stdout.on('data', (d) => { bytes += d.length; if (bytes > maxBytes) stop(`passed ${maxBytes} bytes`); });
    src.stdout.pipe(ids.stdin);
    src.stdin.on('error', () => {});
    ids.stdin.on('error', () => {}); // EPIPE once a cap kills patch-id
    for (const c of [src, ids]) {
      c.stderr.setEncoding('utf8'); c.stderr.on('data', (d) => { err += d; });
      c.on('error', (e) => { failed = failed || e; });
    }
    ids.stdout.setEncoding('utf8'); ids.stdout.on('data', (d) => { out += d; });
    src.on('close', (code) => { codes.src = code; if (!--open) finish(); });
    ids.on('close', (code) => { codes.ids = code; if (!--open) finish(); });
    src.stdin.end(input ?? undefined);
  });
}

// Newest mtime among a worktree's dirty files (capped), or 0.
function dirtyMtime(dir, paths) {
  let t = 0;
  for (const p of paths.slice(0, 500)) {
    try { t = Math.max(t, fs.lstatSync(path.join(dir, p)).mtimeMs); } catch { /* deleted */ }
  }
  return t;
}

// `aheadBehind: false` forces the rev-list fallback git before 2.41 uses (for tests).
// `prHeads` ([{ sha, number, title }], merged PRs from github.mergedPrs, only while pull requests
// are on) lets a lane count as shipped when a merged PR's head is its tip or one of its commits.
async function lanes(cwd, { base, aheadBehind, prHeads = [] } = {}) {
  const [b, worktrees] = await Promise.all([laneBase(cwd, base), getWorktrees(cwd)]);
  const fast = b && aheadBehind !== false && await hasAheadBehind(cwd);
  const fields = ['%(refname)', '%(objectname)', '%(tree)', '%(committerdate:unix)', '%(upstream:short)', '%(upstream:track)', ...(fast ? [`%(ahead-behind:${b.sha})`] : [])];
  const refs = await run(cwd, ['for-each-ref', `--format=${fields.join('%00')}`, 'refs/heads']);
  const wtByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w]));
  const list = [];
  const lane = (o) => ({ name: o.name, branch: o.branch, head: o.head, tree: o.tree, date: o.date, detached: !o.branch, isBase: false, wt: o.wt || null, upstream: o.upstream || null, upstreamGone: o.track === '[gone]', ahead: null, behind: null, ab: o.ab });
  for (const line of refs.split('\n')) {
    if (!line) continue;
    const [ref, head, tree, date, upstream, track, ab] = line.split('\0');
    const name = ref.slice('refs/heads/'.length);
    list.push(lane({ name, branch: name, head, tree, date: Number(date) * 1000, upstream, track, ab, wt: wtByBranch.get(name) }));
    wtByBranch.delete(name);
  }
  // Worktrees on an unborn branch, and detached worktrees.
  for (const w of wtByBranch.values()) list.push(lane({ name: w.branch, branch: w.branch, head: null, wt: w }));
  const detached = worktrees.filter((w) => !w.branch && w.head);
  if (detached.length) {
    const out = await run(cwd, ['log', '--no-walk=unsorted', '--format=%H%x00%T%x00%ct', ...new Set(detached.map((w) => w.head)), '--'], { allowCodes: [0, 128] });
    const info = new Map(out.split('\n').filter(Boolean).map((l) => { const [h, t, d] = l.split('\0'); return [h, { tree: t, date: Number(d) * 1000 }]; }));
    for (const w of detached) list.push(lane({ name: w.name, branch: null, head: w.head, wt: w, ...info.get(w.head) }));
  }

  if (b) {
    for (const l of list) {
      // The base itself, or the local branch a remote base stands for (main for origin/main).
      l.isBase = l.branch != null && (b.ref === `refs/heads/${l.branch}` || (b.ref.startsWith('refs/remotes/') && l.branch === b.local));
      if (l.ab) [l.ahead, l.behind] = l.ab.split(' ').map(Number);
    }
    const slow = list.filter((l) => l.head && l.ahead == null);
    await mapLimit(slow, 8, async (l) => {
      const out = await run(cwd, ['rev-list', '--left-right', '--count', `${l.head}...${b.sha}`, '--']);
      [l.ahead, l.behind] = out.trim().split(/\s+/).map(Number);
    });
  }

  // Commits ahead of base: their trailers, and which lane each belongs to (walked from each tip).
  const ahead = b ? list.filter((l) => l.ahead > 0) : [];
  const tips = [...new Set(ahead.map((l) => l.head))];
  const commits = new Map();
  if (tips.length) {
    const out = await run(cwd, ['log', '-z', `--max-count=${LANE_COMMITS}`, '--format=%H%x1f%P%x1f%s%x1f%(trailers:unfold,only)', ...tips, '--not', b.sha, '--']);
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const [sha, parents, subject, trailers] = rec.split('\x1f');
      commits.set(sha, { order: commits.size, parents: parents ? parents.split(' ') : [], subject, trailers: parseTrailers(trailers || '') });
    }
  }
  for (const l of ahead) {
    const seen = new Set();
    const boundary = new Set();
    const stack = [l.head];
    while (stack.length) {
      const sha = stack.pop();
      if (seen.has(sha)) continue;
      const c = commits.get(sha);
      if (!c) { boundary.add(sha); continue; }
      seen.add(sha);
      stack.push(...c.parents);
    }
    l.commits = [...seen];
    l.complete = l.commits.length === l.ahead;
    l.forkPoint = l.complete && boundary.size === 1 ? [...boundary][0] : null;
    // The newest commit that is the lane's own work (not a baseline, not a merge of base). No
    // such commit at all: the lane holds only agent bookkeeping, nothing to ship or forecast.
    const own = l.commits.map((c) => commits.get(c)).filter((c) => c.parents.length < 2 && !BASELINE.test(c.subject));
    l.subject = own.sort((x, y) => x.order - y.order)[0]?.subject || null;
    l.noWork = l.complete && !own.length;
  }

  // Squash-merge checks: a lane whose tip tree matches a base commit's tree, whose whole diff
  // matches a base commit's patch (squash), or whose every commit has a patch-equivalent commit
  // on base (`git cherry`; rebase-merged).
  const candidates = ahead.filter((l) => l.complete);
  let baseTrees = new Set(); let baseIds = new Map(); let laneIds = new Map(); let squashIds = new Map();
  let baseRows = []; let baseTree = null;
  if (ahead.length) {
    // Base side is bounded by count only: excluding lane tips would hide all of base whenever a
    // lane descends from the base tip (any freshly branched lane).
    const cherryTips = [...new Set(candidates.filter((l) => l.ahead <= CHERRY_MAX).map((l) => l.head))];
    const squashLines = [...new Set(candidates.filter((l) => l.forkPoint).map((l) => `${l.head} ${l.forkPoint}`))];
    let trees;
    [[trees, baseIds], laneIds, squashIds] = await Promise.all([
      baseSquashData(cwd, b.sha),
      cherryTips.length ? patchIds(cwd, ['log', '-p', '--no-merges', '--no-color', '--no-ext-diff', '--format=commit %H', ...cherryTips, '--not', b.sha, '--']) : new Map(),
      squashLines.length ? patchIds(cwd, ['diff-tree', '--stdin', '-p', '--no-color', '--no-ext-diff'], { input: `${squashLines.join('\n')}\n` }) : new Map(),
    ]);
    const rows = trees.split('\n').filter(Boolean).map((r) => r.split('\0'));
    baseTrees = new Set(rows.map((r) => r[1]));
    baseTree = rows[0]?.[1] || null;
    baseRows = rows.map((r) => ({ sha: r[0], subject: r[2] || '' }));
  }

  for (const l of list) {
    l.merged = null;
    if (l.ahead === 0 && l.behind > 0) l.merged = 'ancestor';
    else if (l.ahead > 0 && l.complete && !l.isBase) {
      const ids = l.ahead <= CHERRY_MAX ? l.commits.map((c) => laneIds.get(c)).filter(Boolean) : [];
      if (baseTrees.has(l.tree) || baseIds.has(squashIds.get(l.head)) || (ids.length && ids.every((id) => baseIds.has(id)))) {
        l.merged = 'squash';
        l.mergedAs = baseIds.get(squashIds.get(l.head)) || null; // the base commit with the same change, when one matches
      }
    }
  }
  await shipped(cwd, b, ahead.filter((l) => !l.isBase), { prHeads, baseIds, baseRows, baseTree, commits });

  const result = await Promise.all(list.map(async (l) => {
    const merged = l.merged;
    const w = l.wt;
    const prunable = w ? w.missing || !fs.existsSync(w.path) : false;
    let changes = null;
    let activity = l.date || 0;
    if (w && !prunable) {
      const dirty = [...new Set(await dirtyPaths(w.path).catch(() => []))];
      changes = dirty.length;
      activity = Math.max(activity, dirtyMtime(w.path, dirty));
    }
    const trailers = (l.commits || []).flatMap((c) => commits.get(c)?.trailers || []);
    return {
      name: l.name,
      branch: l.branch,
      head: l.head,
      detached: l.detached,
      isBase: l.isBase,
      worktree: w ? { path: w.path, short: shortPath(w.path), main: w.main, current: w.current, locked: w.locked, prunable } : null,
      upstream: l.upstream,
      upstreamGone: l.upstreamGone,
      activity: activity || null,
      ahead: l.ahead,
      behind: l.behind,
      changes,
      merged,
      mergedAs: l.mergedAs || null,
      // Shipped: { reason: 'merged' | 'pr' | 'key' | 'subject' | 'net-patch', pr?, key?, sha? } or null
      // (sha: the base commit with the same key, subject or change; pr: its pull request number). A done
      // lane is "Merged" in the list: never "needs you", never forecast. `changes` still shows
      // uncommitted files on it.
      done: l.netEmpty || l.noWork ? null : l.done || (merged ? { reason: 'merged' } : null),
      // The PR title (github.joinLanes, or the merged PR that shipped it), else the newest commit
      // subject of the lane's own work, else the branch name.
      title: l.prTitle || l.subject || l.name,
      nothingAhead: l.ahead === 0,
      // Only agent bookkeeping commits ahead (baseline, swept-up scratch files): no forecast.
      noWork: Boolean(l.noWork),
      agent: agentGuess(l.branch, trailers),
    };
  }));
  result.sort((x, y) => (y.activity || 0) - (x.activity || 0));
  return { base: b ? b.name : null, baseRef: b ? b.ref : null, baseSha: b ? b.sha : null, lanes: result };
}

// Send back (renderer/send-back.js): for each conflicting file, the commits on `base` since `head`
// left it that changed the file, newest first (at most 3 per file, 20 files). Read-only.
// { [file]: [{ sha, subject, pr }] }, pr from a squash title's "(#12)" or a merge commit; {} when
// the two have no merge base.
async function baseTouches(cwd, head, base, files = []) {
  let mb;
  try { mb = (await run(cwd, ['merge-base', head, base])).trim(); } catch { return {}; }
  if (!mb) return {};
  const out = {};
  await mapLimit(files.slice(0, 20), 4, async (f) => {
    const log = await run(cwd, ['log', '-n', '3', '--format=%h%x1f%s', `${mb}..${base}`, '--', f]).catch(() => '');
    out[f] = log.split('\n').filter(Boolean).map((l) => {
      const [sha, subject = ''] = l.split('\x1f');
      const m = /\(#(\d+)\)\s*$/.exec(subject) || /^Merge pull request #(\d+)\b/.exec(subject);
      return { sha, subject: subject.slice(0, 200), pr: m ? Number(m[1]) : null };
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Conflict forecast: which lanes would conflict, and on which files, before anyone merges. One
// `git merge-tree --write-tree` per pair (each active lane against base, then pairs of active
// lanes, newest first). merge-tree writes only objects, never refs, the index or a worktree.
// Results are cached by the two tips, so a refresh only re-runs pairs where a tip moved.

// git 2.38 added `merge-tree --write-tree`; older git gets no forecast at all.
const mergeTreeSupported = (version) => {
  const [major, minor] = (/(\d+)\.(\d+)/.exec(version) || [0, 0, 0]).slice(1).map(Number);
  return major > 2 || (major === 2 && minor >= 38);
};
let mergeTreeOk = null;
function canForecast(cwd) {
  mergeTreeOk ||= run(cwd, ['version']).then(mergeTreeSupported, () => false);
  return mergeTreeOk;
}

// Lanes untouched for longer than this are left out: nobody is about to merge them.
const FORECAST_STALE = 14 * 24 * 3600e3;
// At most this many lane-vs-lane merges per forecast (10 active lanes = 45 pairs).
const FORECAST_PAIRS = 45;
const FORECAST_CACHE = 2000;
const forecastCache = new Map(); // "tipA tipB" (sorted) -> conflicting files

// Files `git merge-tree` reports as conflicted when merging a and b, [] when it merges clean.
async function mergeConflicts(cwd, a, b) {
  const key = a < b ? `${a} ${b}` : `${b} ${a}`;
  if (forecastCache.has(key)) return forecastCache.get(key);
  // Exit 1 = conflicts. Unrelated histories and other refusals mean no forecast: [], not cached.
  let out;
  try { out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], { allowCodes: [0, 1] }); } catch { return []; }
  const files = [...new Set(out.split('\0').slice(1).filter(Boolean))].sort();
  if (forecastCache.size >= FORECAST_CACHE) forecastCache.delete(forecastCache.keys().next().value);
  forecastCache.set(key, files);
  return files;
}

// Lanes worth forecasting: real commits ahead of base, not merged or shipped, not the base, worktree not
// missing, and touched within FORECAST_STALE. Newest first, so the pair cap keeps live work.
function forecastLanes(lanes, now = Date.now()) {
  return lanes
    .filter((l) => l.head && l.ahead > 0 && !l.isBase && !l.merged && !l.done && !l.noWork && !l.worktree?.prunable && l.activity && now - l.activity < FORECAST_STALE)
    .sort((x, y) => (y.activity || 0) - (x.activity || 0));
}

// `lanes` is the git.lanes result's list, `baseSha` its baseSha. `signal` (an AbortSignal) stops
// it between merges; whatever is running finishes, the rest never starts. Returns
// { supported, pairs: [{ a, b, files }] } with only conflicting pairs; `b` is null for the base.
// Lanes come back as { name, branch, worktree: { path } | null }, enough for the renderer's laneKey.
async function forecastConflicts(cwd, lanes, { baseSha, signal, now = Date.now(), maxPairs = FORECAST_PAIRS } = {}) {
  if (!(await canForecast(cwd))) return { supported: false, pairs: [] };
  const live = forecastLanes(lanes, now);
  const jobs = [];
  if (baseSha) for (const l of live) if (l.behind > 0) jobs.push([l, null]);
  let left = maxPairs;
  for (let i = 0; i < live.length && left > 0; i++) {
    for (let j = i + 1; j < live.length && left > 0; j++) {
      if (live[i].head === live[j].head) continue;
      jobs.push([live[i], live[j]]);
      left--;
    }
  }
  const who = (l) => ({ name: l.name, branch: l.branch, worktree: l.worktree ? { path: l.worktree.path } : null });
  const res = await mapLimit(jobs, 4, async ([a, b]) => {
    if (signal?.aborted) return null;
    const files = await mergeConflicts(cwd, a.head, b ? b.head : baseSha);
    return files.length ? { a: who(a), b: b ? who(b) : null, files } : null;
  });
  if (signal?.aborted) throw Object.assign(new Error('Forecast cancelled'), { name: 'AbortError' });
  return { supported: true, pairs: res.filter(Boolean) };
}

// Merge plan (renderer/merge-plan.js): squash-merging `head` onto `tip`, simulated. merge-tree
// writes the merged tree and commit-tree a commit on top of `tip` (objects only, never refs, the
// index or a worktree), so the next PR can be simulated on top of it. The commit's identity and
// date are fixed, so the same merge always gives the same commit. → { files, commit }: commit when
// it merges clean, else null with the conflicting files ([] when git refuses, e.g. unrelated histories).
const SIM_ENV = {
  GIT_AUTHOR_NAME: 'GitLanes', GIT_AUTHOR_EMAIL: 'merge-plan@gitlanes.invalid', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'GitLanes', GIT_COMMITTER_EMAIL: 'merge-plan@gitlanes.invalid', GIT_COMMITTER_DATE: '1700000000 +0000',
};
async function simulateSquash(cwd, tip, head) {
  let out;
  try { out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', tip, head], { allowCodes: [0, 1] }); } catch { return { files: [], commit: null }; }
  const [tree, ...rest] = out.split('\0');
  const files = [...new Set(rest.filter(Boolean))].sort();
  if (files.length || !/^[0-9a-f]{40,64}$/.test(tree)) return { files, commit: null };
  const commit = (await run(cwd, ['commit-tree', tree, '-p', tip, '-m', 'GitLanes merge plan'], { env: SIM_ENV })).trim();
  return { files: [], commit };
}

// Merge plan, rebase (AK-545): `head`'s commits replayed one by one onto `tip`, simulated, the way
// GitHub's rebase merge does it, since one commit can conflict even when the whole PR merges
// clean. Each is a merge-tree against its own parent (git 2.40+ for --merge-base; older git
// simulates the PR as one squash) and a commit-tree on top of the last. Merge commits are skipped,
// like `git rebase`. Objects only, same fixed identity as simulateSquash. → { files, commit }.
const REPLAY_MAX = 250;
let replayOk = null;
async function canReplay(cwd) {
  replayOk ||= run(cwd, ['version']).then((v) => { const [, a, b] = /(\d+)\.(\d+)/.exec(v) || [0, 0, 0]; return Number(a) > 2 || (Number(a) === 2 && Number(b) >= 40); }, () => false);
  return replayOk;
}
async function simulateRebase(cwd, tip, head) {
  if (!(await canReplay(cwd))) return simulateSquash(cwd, tip, head);
  let list;
  try { list = (await run(cwd, ['rev-list', '--reverse', '--no-merges', `--max-count=${REPLAY_MAX + 1}`, head, '--not', tip, '--'])).split('\n').filter(Boolean); } catch { return { files: [], commit: null }; }
  if (list.length > REPLAY_MAX) return simulateSquash(cwd, tip, head);
  let cur = tip;
  for (const c of list) {
    let out;
    try { out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${c}^`, cur, c], { allowCodes: [0, 1] }); } catch { return { files: [], commit: null }; }
    const [tree, ...rest] = out.split('\0');
    const files = [...new Set(rest.filter(Boolean))].sort();
    if (files.length || !/^[0-9a-f]{40,64}$/.test(tree)) return { files, commit: null };
    cur = (await run(cwd, ['commit-tree', tree, '-p', cur, '-m', 'GitLanes merge plan'], { env: SIM_ENV })).trim();
  }
  return { files: [], commit: cur };
}

// Merge plan, stacks (AK-545): whether a stack's history is linear, so GitHub can merge it as one:
// each PR's head contains the one below it, and nothing between the base and the top is a merge
// commit. heads: bottom…top.
async function stackLinear(cwd, base, heads) {
  try {
    for (let i = 1; i < heads.length; i++) {
      if (!(await run(cwd, ['merge-base', '--is-ancestor', heads[i - 1], heads[i]]).then(() => true, () => false))) return false;
    }
    return (await run(cwd, ['rev-list', '--merges', '--count', heads[heads.length - 1], '--not', base, '--'])).trim() === '0';
  } catch { return false; }
}

// Rebasing a stack (AK-559), the way `gh stack rebase` cascades, but objects only: no checkout,
// index, worktree or ref moves, so it never touches your work. Bottom to top, each PR's own commits
// (those not in the PR below it nor in the base) are replayed onto the new head of the one below
// (the base for the bottom one), merge commits skipped like `git rebase`. Authors, dates and messages
// are kept; you are the committer, signed when commit.gpgsign is on. A PR that already sits on the
// one below with no merge commits is left as it is. All or nothing: the first conflict stops it.
// heads: bottom…top. → { heads: [new head per PR], changed: [bool per PR] } |
// { conflict: { index, commit, files } } (files [] when git refuses, e.g. unrelated histories).
async function rebaseStack(cwd, base, heads) {
  if (!(await canReplay(cwd))) throw new GitError('Rebasing a stack needs git 2.40 or later.');
  const sign = (await run(cwd, ['config', '--bool', 'commit.gpgsign'], { allowCodes: [0, 1] })).trim() === 'true';
  const isAncestor = (a, b) => run(cwd, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
  const out = [], changed = [];
  for (let i = 0; i < heads.length; i++) {
    const below = i ? heads[i - 1] : base, onto = i ? out[i - 1] : base;
    const not = i ? [heads[i - 1], base] : [base];
    const merges = (await run(cwd, ['rev-list', '--merges', '--count', heads[i], '--not', ...not, '--'])).trim() !== '0';
    if ((!i || !changed[i - 1]) && !merges && await isAncestor(below, heads[i])) { out.push(heads[i]); changed.push(false); continue; }
    const list = (await run(cwd, ['rev-list', '--reverse', '--no-merges', `--max-count=${REPLAY_MAX + 1}`, heads[i], '--not', ...not, '--'])).split('\n').filter(Boolean);
    if (list.length > REPLAY_MAX) throw new GitError(`A pull request in this stack has more than ${REPLAY_MAX} commits.`);
    let cur = onto;
    for (const c of list) {
      let res;
      try { res = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${c}^`, cur, c], { allowCodes: [0, 1] }); } catch { return { conflict: { index: i, commit: c, files: [] } }; }
      const [tree, ...rest] = res.split('\0');
      const files = [...new Set(rest.filter(Boolean))].sort();
      if (files.length || !/^[0-9a-f]{40,64}$/.test(tree)) return { conflict: { index: i, commit: c, files } };
      // Already there (e.g. an old copy of the part below, amended since): dropped, like `git rebase`.
      if (tree === (await run(cwd, ['rev-parse', `${cur}^{tree}`])).trim()) continue;
      const [name, email, date, msg] = (await run(cwd, ['show', '-s', '--date=raw', '--format=%an%x00%ae%x00%ad%x00%B', c])).split(SEP);
      const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date.trim() };
      cur = (await run(cwd, ['commit-tree', ...(sign ? ['-S'] : []), tree, '-p', cur, '-F', '-'], { input: msg.replace(/\n+$/, '') + '\n', env })).trim();
    }
    out.push(cur);
    changed.push(true);
  }
  return { heads: out, changed };
}

// Review (AK-305): what conflicts when `head` merges into `base`, file by file. merge-tree writes
// the merged tree with conflict markers in it (objects only, never refs, the index or a worktree);
// each conflicting blob is read back and cut into hunks: the base side, the head side, and up to
// CONFLICT_CONTEXT lines around them. A file with no markers (deleted on one side, binary, a
// rename clash) comes back with no hunks and which sides still have it.
// → { supported, files: [{ path, hunks: [{ line, before, base, head, after }], inBase, inHead }] }.
const CONFLICT_CONTEXT = 3;
const CONFLICT_FILES = 100;
const CONFLICT_BYTES = 2 * 1024 * 1024;
async function mergeConflictHunks(cwd, base, head) {
  if (!(await canForecast(cwd))) return { supported: false, files: [] };
  let out;
  try {
    out = await run(cwd, ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--no-messages', '-z', base, head], { allowCodes: [0, 1] });
  } catch { return { supported: true, files: [] }; }
  const [tree, ...rest] = out.split('\0');
  const stages = new Map(); // path -> Set of stages (1 ancestor, 2 base, 3 head)
  for (const entry of rest) {
    const m = /^\d+ [0-9a-f]+ (\d)\t(.+)$/s.exec(entry);
    if (!m) continue;
    if (!stages.has(m[2])) stages.set(m[2], new Set());
    stages.get(m[2]).add(Number(m[1]));
  }
  const paths = [...stages.keys()].sort().slice(0, CONFLICT_FILES);
  const files = await mapLimit(paths, 4, async (path) => {
    const s = stages.get(path);
    let text = '';
    try {
      const size = Number((await run(cwd, ['cat-file', '-s', `${tree}:${path}`])).trim());
      if (size <= CONFLICT_BYTES) text = await run(cwd, ['cat-file', 'blob', `${tree}:${path}`]);
    } catch { /* not in the merged tree: deleted on a side */ }
    return { path, hunks: conflictHunks(text), inBase: s.has(2), inHead: s.has(3) };
  });
  return { supported: true, files };
}

// Conflict hunks in a file with merge markers (// ||||||| ancestor section is skipped). `line` is the 1-based line of <<<<<<< in the merged file.
function conflictHunks(text) {
  if (!text || text.includes('\0')) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunks = [];
  let cur = null;
  let side = null;
  let last = 0; // first line after the previous hunk, so context never repeats one
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!cur && l.startsWith('<<<<<<<')) {
      cur = { line: i + 1, before: lines.slice(Math.max(last, i - CONFLICT_CONTEXT), i), base: [], head: [], after: [] };
      side = 'base';
    } else if (cur && l.startsWith('|||||||')) side = null;
    else if (cur && /^=======\r?$/.test(l) && side !== 'head') side = 'head'; // exactly: a markdown underline isn't one (AK-308)
    else if (cur && l.startsWith('>>>>>>>')) {
      last = i + 1;
      let j = last;
      while (j < lines.length && j < last + CONFLICT_CONTEXT && !lines[j].startsWith('<<<<<<<')) j++;
      cur.after = lines.slice(last, j);
      last = j; // the next hunk's context starts after this one's (AK-308)
      hunks.push(cur);
      cur = null;
    } else if (cur && side) cur[side].push(l);
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// External diff & merge tools (git difftool / mergetool), using the user's diff.tool and
// merge.tool. GitLanes has no terminal, so terminal-only tools (vimdiff, emerge) are refused.

const TERMINAL_TOOLS = /^(n?vimdiff\d?|emerge)$/;

// git difftool falls back to merge.tool when diff.tool is unset; mergetool uses merge.tool only.
async function getExternalTools(cwd) {
  const get = async (key) => (await run(cwd, ['config', '--get', key], { allowCodes: [0, 1] })).trim() || null;
  const [diff, merge] = await Promise.all([get('diff.tool'), get('merge.tool')]);
  return { diff: diff || merge, merge };
}

function checkTool(name, kind) {
  const key = kind === 'diff' ? 'diff.tool' : 'merge.tool';
  if (!name) throw new GitError(`No ${kind} tool set. Set ${key} in your git config (e.g. git config --global ${key} opendiff), then try again.`);
  if (TERMINAL_TOOLS.test(name)) throw new GitError(`${name} runs in a terminal, so GitLanes can't open it. Set ${key} to a graphical tool.`);
  return name;
}

// Arguments for one file: working tree vs index (default), index vs HEAD (staged), or a commit vs its parent.
function difftoolArgs(file, { staged, commit, parent } = {}) {
  const paths = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path];
  const revs = commit ? [parent || EMPTY_TREE, commit] : staged ? ['--cached'] : [];
  return ['difftool', '--no-prompt', ...revs, '--', ...paths];
}

const mergetoolArgs = (paths = []) => ['mergetool', '--no-prompt', ...(paths.length ? ['--', ...paths] : [])];

async function difftool(cwd, file, opts) {
  checkTool((await getExternalTools(cwd)).diff, 'diff');
  await run(cwd, difftoolArgs(file, opts), { maxBuffer: 16 * 1024 * 1024 });
}

// Resolves when the tool exits. Returns the paths that are still conflicted afterwards.
async function mergetool(cwd, paths = []) {
  checkTool((await getExternalTools(cwd)).merge, 'merge');
  const before = (await getStatus(cwd)).conflicts.map((f) => f.path);
  if (!before.length) throw new GitError('There are no conflicted files to merge.');
  // Exit code 1 = the tool exited without resolving; the status below says what's left.
  await run(cwd, mergetoolArgs(paths), { allowCodes: [0, 1], maxBuffer: 16 * 1024 * 1024 });
  const after = (await getStatus(cwd)).conflicts.map((f) => f.path);
  return { remaining: paths.length ? after.filter((p) => paths.includes(p)) : after };
}

// ---------------------------------------------------------------------------
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

module.exports = {
  saveResolved, restoreResolved, resolvedPaths,
  clearBaseSquashCache: () => baseSquash.clear(),
  landed,
  GitError, run, remoteFailure, pull, divergence, cherryPick, openRepo, initRepo, cloneRepo, getRefs, getLog, parseCoAuthors, streamLog, getLogDetails, hasCommitGraph, writeCommitGraph, getCommit, commitFileDiff, commitDiffs, compareDiff, branchReview,
  getStatus, getOperationState, getOperationInfo, worktreeOp, workingDiff, parseLfsPointer, parseLfsPatterns, getLfs, markLfs, parseGitmodules, getSubmodules, updateSubmodules, stashSubmodule, popSubmoduleStash, discardSubmodule, restoreDiscardedSubmodule, submoduleChanges, submoduleHead, restoreSubmodules, parseDiff, buildPartialPatch, applyPatch,
  combinedDiff, setStaged, changePaths,
  getStashes, getReflog, getConfig, getIdentity, getRemotes, remoteWebUrl, remoteLabel, changeRemote, revertRemote, saveRemote, rewriteRange, rewrite, captureRefState, restoreRefState,
  snapshotWork, workChanges, snapshotBlobs, restoreWork, resetHardPaths, stashPaths, stashPushPaths,
  pinUndo, pruneUndoPins, moveUndoPins, dropStashCommit, restoreStash,
  discardFiles, discardLines, stashPush, stashLines, resetHard, chooseSide, getConflict, resolveConflict, stashApply, stashDrop,
  rewriteRange, commitBranches, samePath, getWorktrees, findWorktree, worktreeChanges, freeBlocker, worktreeHold, removalFacts, baseTouches, defaultWorktreePath, addWorktree, removeWorktree, mergeLanePlan, mergeLane,
  restoreWorktree, stashWorktree, popStash, lockWorktree, unlockWorktree, pruneWorktrees, cleanupLanes, deleteRemoteBranches,
  AGENT_HINTS, parseTrailers, agentGuess, branchKey, plainSubject, shortPath, laneBase, lanes, patchIds, canForecast, mergeConflicts, mergeConflictHunks, conflictHunks, simulateSquash, simulateRebase, stackLinear, rebaseStack, forecastLanes, forecastConflicts,
  _forecastCache: forecastCache, mergeTreeSupported, _setForecastGate: (ok) => { mergeTreeOk = ok == null ? null : Promise.resolve(ok); },
  getExternalTools, checkTool, difftoolArgs, mergetoolArgs, difftool, mergetool,
  fileHistory, parseFileHistory, trackedFiles, blame, parseBlame,
};

