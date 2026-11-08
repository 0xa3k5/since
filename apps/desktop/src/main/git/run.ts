import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GIT_NEEDS, GIT_FEATURES } from '../../renderer/lib/git-version.js';
import type { GitInfo } from '../../shared/git-types.ts';

// Thin, dependency-free wrapper around the git CLI. Every read uses
// GIT_OPTIONAL_LOCKS=0 so the file watcher never fights over index.lock.

// GPG_TTY is dropped so a terminal pinentry never waits on a terminal the user can't see.
// ssh/ssh-keygen ask through SSH_ASKPASS instead of /dev/tty, so a locked SSH key fails
// fast; a user's own askpass helper is kept.
const { GPG_TTY: _tty, ...PARENT_ENV } = process.env;
export const BASE_ENV: NodeJS.ProcessEnv = {
  ...PARENT_ENV,
  SSH_ASKPASS: PARENT_ENV.SSH_ASKPASS || '/usr/bin/false',
  SSH_ASKPASS_REQUIRE: PARENT_ENV.SSH_ASKPASS_REQUIRE || 'force',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
};

/** Why a git failure happened, beyond git's exit code: 'rejected', 'diverged', 'auth', 'git-version', 'not-git', … */
export type GitErrorCode = number | string;
export interface GitErrorInfo { code?: GitErrorCode | undefined; stderr?: string; stdout?: string; args?: readonly string[] }

export class GitError extends Error {
  code: GitErrorCode | undefined;
  stderr: string | undefined;
  stdout: string | undefined;
  args: readonly string[] | undefined;
  /** What a failed step had already moved, for the renderer to report (journal.js). */
  moved?: unknown;
  /** The step a multi-step operation stopped at. */
  step?: unknown;
  constructor(message: string, { code, stderr, stdout, args }: GitErrorInfo = {}) {
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
function signingError(stderr: string): string | null {
  if (!SIGN_FAIL.test(stderr)) return null;
  const detail = stderr.trim().split('\n').map((l) => l.replace(/^(error|fatal): /, '').trim()).find((l) => l && !/failed to write commit object/.test(l)) || '';
  return `Couldn't sign the commit. Unlock your GPG key, or add your SSH signing key to ssh-agent (ssh-add), then try again.${detail ? `\n${detail}` : ''}`;
}

// Push, pull and fetch failures we can offer a fix for, from git's output: 'rejected' (the remote
// has commits this branch doesn't), 'diverged' (pull needs a rebase or merge) or 'auth' (message cut
// to git's one line about it). Anything else keeps git's output.
const AUTH_FAIL = /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|Invalid username or (?:password|token)|The requested URL returned error: 40[13]/i;
export function remoteFailure<E extends { message: string; stderr?: string | undefined; code?: GitErrorCode | undefined }>(err: E): E {
  const text = `${err.stderr || ''}\n${err.message}`;
  if (/\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/.test(text)) err.code = 'rejected';
  else if (/divergent branches|Need to specify how to reconcile/i.test(text)) err.code = 'diverged';
  else if (AUTH_FAIL.test(text)) {
    err.code = 'auth';
    err.message = text.split('\n').map((l) => l.replace(/^(?:remote: |fatal: |error: )+/, '').trim()).find((l) => AUTH_FAIL.test(l)) || err.message;
  }
  return err;
}

// The git binary: `git` on PATH, or the one picked with Use another git… (AK-586).
let GIT = 'git';
export const gitPath = (): string => GIT;
// Caches that depend on which git runs (version, merge-tree and replay support) reset here.
const gitPathResets: (() => void)[] = [];
export const onGitPathChange = (reset: () => void): void => { gitPathResets.push(reset); };
export function setGitPath(p: string | null | undefined): void {
  GIT = p || 'git';
  for (const reset of gitPathResets) reset();
}
// The git in use (or `bin`): { path, version }, e.g. { path: '/usr/bin/git', version: '2.39.5' }.
export function gitInfo(bin = GIT): Promise<GitInfo> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { env: BASE_ENV, timeout: 10e3 }, (err, out) => {
      const m = !err && /^git version (\d+\.\d+(?:\.\d+)?)/.exec(String(out));
      if (!m) return reject(new GitError(err?.code === 'ENOENT' ? 'No git found.' : 'That isn’t a git program.', { code: 'not-git' }));
      resolve({ path: bin === 'git' ? onPath('git') : bin, version: m[1] ?? '' });
    });
  });
}
function onPath(name: string): string {
  for (const dir of (BASE_ENV.PATH || '').split(':').filter(Boolean)) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return name;
}
// A feature git is too old for: the message names the version, `code` lets the app offer Update git.
export const tooOld = (feature: keyof typeof GIT_NEEDS): GitError => new GitError(`${GIT_FEATURES[feature]} needs git ${GIT_NEEDS[feature]} or later.`, { code: 'git-version' });

export interface RunOptions {
  input?: string | Buffer | null | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Exit codes that count as success (their output is returned). */
  allowCodes?: readonly number[];
  maxBuffer?: number;
  encoding?: 'utf8' | 'buffer';
}

export function run(cwd: string, args: readonly string[], opts?: RunOptions & { encoding?: 'utf8' }): Promise<string>;
export function run(cwd: string, args: readonly string[], opts: RunOptions & { encoding: 'buffer' }): Promise<Buffer>;
export function run(cwd: string, args: readonly string[], { input, env, allowCodes = [0], maxBuffer = 512 * 1024 * 1024, encoding = 'utf8' }: RunOptions = {}): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: ExecFileException | null, out: string | Buffer, errOut: string | Buffer) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (err && !allowCodes.includes(code)) {
        const stderr = String(errOut || ''), stdout = String(out || '');
        const msg = signingError(stderr) || (stderr || stdout || err.message).trim().split('\n').slice(-6).join('\n');
        reject(new GitError(msg || `git ${args[0]} failed`, { code, stderr, stdout, args }));
      } else {
        resolve(out);
      }
    };
    // detached = own session with no controlling terminal, so gpg and ssh-keygen fail
    // fast instead of waiting for a passphrase typed into a terminal.
    const options = { cwd, env: { ...BASE_ENV, ...env }, maxBuffer, detached: process.platform !== 'win32' };
    const child = encoding === 'buffer'
      ? execFile(GIT, args, { ...options, encoding: 'buffer' }, done)
      : execFile(GIT, args, { ...options, encoding: 'utf8' }, done);
    // Always close stdin: with no terminal, ssh-keygen reads a passphrase from it and would wait forever.
    child.stdin?.end(input ?? undefined);
  });
}

export const SEP = '\x00';
export const REC = '\x1e';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Work snapshots: the exact index entries and working-tree bytes of a set of
// paths. Destructive working-copy operations record one before and one after
// they run, so undo and redo can put either state back byte for byte.

export const W_ENV = { GIT_OPTIONAL_LOCKS: '1', GIT_LITERAL_PATHSPECS: '1' };
export const UNDO_REFS = 'refs/since/undo';

export function chunk<T>(list: readonly T[], n = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k] as T); } }));
  return out;
}
