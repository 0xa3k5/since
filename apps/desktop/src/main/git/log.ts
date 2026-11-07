import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { run, SEP, REC, BASE_ENV, gitPath, GitError, EMPTY_TREE } from './run.ts';
import { parseDiff } from './status.ts';
import type { CoAuthor, Commit, CommitDetails, CommitFile, FileDiff, Head, Ref, RefKind, Refs, Signature } from '../../shared/git-types.ts';

/** Which refs a log walks: local branches and HEAD always; tags, remotes and `heads` (other worktrees' detached HEADs) optional. */
export interface LogScope { remotes?: boolean; tags?: boolean; heads?: readonly string[] }
export interface LogStream { read(): Promise<string | null>; close(): void }

// History + refs

export async function getRefs(cwd: string): Promise<Refs> {
  const out = await run(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)',
  ]);
  const refs: Ref[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [name = '', oid = '', peeled, upstream, track, date] = line.split(SEP);
    if (name === 'refs/stash') continue;
    let kind: RefKind, short: string;
    if (name.startsWith('refs/heads/')) { kind = 'branch'; short = name.slice(11); }
    else if (name.startsWith('refs/remotes/')) {
      kind = 'remote'; short = name.slice(13);
      if (short.endsWith('/HEAD')) continue;
    } else if (name.startsWith('refs/tags/')) { kind = 'tag'; short = name.slice(10); }
    else continue;
    let ahead = 0, behind = 0;
    if (track) {
      const a = /ahead (\d+)/.exec(track); if (a) ahead = Number(a[1]);
      const b = /behind (\d+)/.exec(track); if (b) behind = Number(b[1]);
    }
    refs.push({ name, short, kind, target: peeled || oid, upstream: upstream || null, ahead, behind, gone: track === 'gone', date: Number(date) || 0 });
  }
  const head: Head = { detached: false, branch: null, oid: null };
  try {
    const sym = (await run(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] })).trim();
    head.branch = sym ? sym.replace(/^refs\/heads\//, '') : null;
    head.detached = !sym;
    head.oid = (await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] })).trim() || null;
  } catch { /* empty repo */ }
  return { refs, head };
}

// `heads`: extra commits to include, such as other worktrees' detached HEADs.
function logArgs({ remotes = true, tags = true, heads = [] }: LogScope = {}): string[] {
  return ['log', '--branches', ...(tags ? ['--tags'] : []), ...(remotes ? ['--remotes'] : []), 'HEAD', ...heads, '--date-order'];
}

// Log formats. Records end in REC; git adds a newline after each, which parsers skip.
// TOPO is read from git's commit-graph without opening commit objects, so it is several times
// faster than DETAILS, which needs every commit inflated.
// CO_AUTHORS is the values of Co-authored-by trailers, \x1f-separated, so bodies aren't fetched.
const CO_AUTHORS = '%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1f)';
export const LOG_FORMATS = {
  topo: `--format=%H%x00%P${REC}`,
  details: `--format=%H%x00%an%x00%ae%x00%at%x00%s%x00${CO_AUTHORS}${REC}`,
  full: `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00${CO_AUTHORS}${REC}`,
};

// `Name <email>` trailer values (\x1f-separated) to [{ name, email }], deduped by email and
// without the author. Same as parseCoAuthors in renderer/log.js.
export function parseCoAuthors(raw: string | null | undefined, author: string | null | undefined): CoAuthor[] {
  if (!raw) return [];
  const seen = new Set([(author || '').toLowerCase()]), out: CoAuthor[] = [];
  for (const v of raw.split('\x1f')) {
    const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(v);
    if (!m) continue;
    const [, name = '', email = ''] = m;
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ name: name || email, email });
  }
  return out;
}

// History reads never go to the network: in a partial clone, a tag pointing at a missing tree
// would otherwise make every log wait on a fetch.
export const LOG_ENV = { ...BASE_ENV, GIT_NO_LAZY_FETCH: '1' };

export async function getLog(cwd: string, { limit, ...opts }: LogScope & { limit?: number } = {}): Promise<Commit[]> {
  const args = [...logArgs(opts), ...(limit ? [`--max-count=${limit}`] : []), LOG_FORMATS.full];
  const out = await run(cwd, args, { allowCodes: [0, 128], env: LOG_ENV }).catch(() => '');
  const commits: Commit[] = [];
  for (const rec of out.split(REC)) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const [sha = '', parents, author = '', email = '', time, subject = '', co] = r.split(SEP);
    commits.push({ sha, parents: parents ? parents.split(' ') : [], author, email, time: Number(time), subject, coAuthors: parseCoAuthors(co, email) });
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
export interface StreamLogOptions extends LogScope { kind?: keyof typeof LOG_FORMATS; preview?: boolean; limit?: number; batch?: number; linger?: number; highWater?: number }
export function streamLog(cwd: string, { kind = 'topo', preview = false, limit, batch = 256 << 10, linger = 25, highWater = 8 << 20, ...opts }: StreamLogOptions = {}): LogStream {
  const args = logArgs(opts).filter((a) => !(preview && a === '--date-order'));
  if (limit) args.push(`--max-count=${limit}`);
  args.push(LOG_FORMATS[kind]);
  const child = spawn(gitPath(), args, { cwd, env: LOG_ENV });
  const chunks: string[] = [];
  let size = 0, tail = '', ended = false, waiting: (() => void) | null = null, first = true, closed = false, failure: string | null = null;
  const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
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
  const arrival = (ms?: number) => new Promise<void>((r) => {
    const t = ms == null ? undefined : setTimeout(() => { waiting = null; r(); }, ms);
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
      const text = chunks.length === 1 ? chunks[0] as string : chunks.join('');
      chunks.length = 0; size = 0;
      child.stdout.resume();
      return text;
    },
    close() { closed = ended = true; chunks.length = 0; if (child.exitCode === null) child.kill(); wake(); },
  };
}

// Details (DETAILS format) for specific commits, in the order given.
export async function getLogDetails(cwd: string, shas: readonly string[]): Promise<string> {
  if (!shas.length) return '';
  return run(cwd, ['log', '--no-walk=unsorted', '--stdin', LOG_FORMATS.details], { input: shas.join('\n') + '\n', allowCodes: [0, 128], env: LOG_ENV });
}

export async function hasCommitGraph(cwd: string): Promise<boolean> {
  const info = path.resolve(cwd, (await run(cwd, ['rev-parse', '--git-path', 'objects/info'])).trim());
  return fs.existsSync(path.join(info, 'commit-graph')) || fs.existsSync(path.join(info, 'commit-graphs', 'commit-graph-chain'));
}

// git's commit-graph cache makes ordered logs stream immediately and topology reads ~5x faster.
// Fresh clones often lack it; `git gc` and `git maintenance` would write the same file.
export function writeCommitGraph(cwd: string): Promise<string> {
  return run(cwd, ['commit-graph', 'write', '--reachable'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
}

export async function getCommit(cwd: string, sha: string): Promise<CommitDetails> {
  const out = await run(cwd, ['show', '-s', `--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%G?%x00%GS%x00${CO_AUTHORS}%x00%B`, sha]);
  const [h = '', parents, author = '', email = '', atime, committer = '', cemail = '', ctime, sig, signer, co, body = ''] = out.split(SEP);
  const ps = parents ? parents.split(' ') : [];
  const files = await diffTreeFiles(cwd, ps[0] || null, h);
  // Git reports an SSH signature it can't check (no allowed signers file) as unsigned; read the header instead.
  const signed = sig !== 'N' || /^gpgsig(-sha256)? /m.test((await run(cwd, ['cat-file', 'commit', h])).split('\n\n')[0] ?? '');
  return { sha: h, parents: ps, author, email, time: Number(atime), committer, committerEmail: cemail, commitTime: Number(ctime), signature: signed ? signatureStatus(sig === 'N' ? 'E' : sig, signer) : null, coAuthors: parseCoAuthors(co, email), message: body.replace(/\n+$/, ''), files };
}

// %G? codes: G good, U good but untrusted key, X/Y expired signature/key, R revoked,
// B bad, E can't be checked (key or allowed-signers file missing), N unsigned.
function signatureStatus(code: string | undefined, signer: string | undefined): Signature | null {
  const states: Partial<Record<string, Signature['state']>> = { G: 'good', U: 'good', X: 'expired', Y: 'expired', R: 'revoked', B: 'bad', E: 'unverified' };
  const state = states[code ?? ''];
  return state ? { state, signer: signer || '' } : null;
}

export async function diffTreeFiles(cwd: string, from: string | null, to: string): Promise<CommitFile[]> {
  const out = await run(cwd, ['diff-tree', '-r', '-z', '-M', '--numstat', '--no-commit-id', from || EMPTY_TREE, to]);
  const status = await run(cwd, ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', from || EMPTY_TREE, to]);
  const st = parseNameStatusZ(status);
  const stats = parseNumstatZ(out);
  return st.map((f) => ({ ...f, ...(stats.get(f.path) || { add: 0, del: 0, binary: false }) }));
}

function parseNameStatusZ(out: string): Pick<CommitFile, 'status' | 'path' | 'oldPath'>[] {
  const parts = out.split('\0');
  const files: Pick<CommitFile, 'status' | 'path' | 'oldPath'>[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const s = code.charAt(0);
    if (s === 'R' || s === 'C') {
      files.push({ status: s, oldPath: parts[i + 1] ?? '', path: parts[i + 2] ?? '' });
      i += 2;
    } else {
      files.push({ status: s, path: parts[i + 1] ?? '' });
      i += 1;
    }
  }
  return files;
}

function parseNumstatZ(out: string): Map<string, Pick<CommitFile, 'add' | 'del' | 'binary'>> {
  const map = new Map<string, Pick<CommitFile, 'add' | 'del' | 'binary'>>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!m) continue;
    let file = m[3] ?? '';
    if (file === '') { file = parts[i + 2] ?? ''; i += 2; } // rename: old, new follow
    map.set(file, { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  return map;
}

export async function commitFileDiff(cwd: string, sha: string, file: { path: string; oldPath?: string | null }, parent?: string | null): Promise<FileDiff | null> {
  const base = parent || (await run(cwd, ['rev-parse', '-q', '--verify', `${sha}^`], { allowCodes: [0, 1] })).trim() || EMPTY_TREE;
  const out = await run(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, sha, '--', file.oldPath || file.path, file.path]);
  return parseDiff(out)[0] || null;
}

// Every file diff of a commit against its first parent, without rename
// detection: the commit splitter selects lines from these.
export async function commitDiffs(cwd: string, sha: string): Promise<FileDiff[]> {
  return (await readCommitDiffs(cwd, sha)).map(([d]) => d);
}

// Pairs of [text, raw] for each file: the same diff decoded as UTF-8 for display
// and as latin1, which maps every byte to one char, so patches built from it
// round-trip byte-exactly. Line breaks are the same bytes in both, so hunk and
// line indices (the selection keys) match.
export async function readCommitDiffs(cwd: string, sha: string): Promise<[FileDiff, FileDiff][]> {
  const parent = (await run(cwd, ['rev-parse', '-q', '--verify', `${sha}^`], { allowCodes: [0, 1] })).trim() || EMPTY_TREE;
  const buf = await run(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', parent, sha], { encoding: 'buffer' });
  const raw = parseDiff(buf.toString('latin1'));
  return parseDiff(buf.toString('utf8')).map((d, i): [FileDiff, FileDiff] => {
    const r = raw[i] as FileDiff; // the same bytes parse into the same files
    r.path = d.path = diffPath(d.header[0] ?? '');
    // A submodule bump has no lines to pick; it goes whole into one commit.
    if (d.header.slice(1).some((l) => / 160000$/.test(l))) { d.hunks = []; r.hunks = []; d.gitlink = r.gitlink = true; }
    return [d, r];
  });
}

// Without renames both sides of "diff --git a/<p> b/<p>" are the same path; binary
// and mode-only diffs have no ---/+++ lines, so read it from there. Git C-quotes
// names containing '"', '\\', or control characters even with core.quotePath=false.
function diffPath(line: string): string {
  const rest = line.slice('diff --git '.length);
  if (rest[0] !== '"') return rest.slice(2, 2 + (rest.length - 5) / 2);
  const bytes: number[] = [];
  const esc: Partial<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 1; i < rest.length && rest[i] !== '"'; i++) {
    let c = String.fromCodePoint(rest.codePointAt(i) ?? 0);
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); i += c.length - 1; continue; }
    c = rest[++i] ?? '';
    if (/[0-7]/.test(c)) { bytes.push(parseInt(rest.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(esc[c] ?? c.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8').slice(2);
}

export async function compareDiff(cwd: string, from: string, to: string): Promise<FileDiff[]> {
  const out = await run(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', from, to]);
  return parseDiff(out);
}

