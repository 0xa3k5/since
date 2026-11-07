'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { GIT_NEEDS, GIT_FEATURES } = require('../../renderer/lib/git-version.js');

// Thin, dependency-free wrapper around the git CLI. Every read uses
// GIT_OPTIONAL_LOCKS=0 so the file watcher never fights over index.lock.

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

// The git binary: `git` on PATH, or the one picked with Use another git… (AK-586).
let GIT = 'git';
const gitPath = () => GIT;
// Caches that depend on which git runs (version, merge-tree and replay support) reset here.
const gitPathResets = [];
const onGitPathChange = (reset) => { gitPathResets.push(reset); };
function setGitPath(p) {
  GIT = p || 'git';
  for (const reset of gitPathResets) reset();
}
// The git in use (or `bin`): { path, version }, e.g. { path: '/usr/bin/git', version: '2.39.5' }.
function gitInfo(bin = GIT) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { env: BASE_ENV, timeout: 10e3 }, (err, out) => {
      const m = !err && /^git version (\d+\.\d+(?:\.\d+)?)/.exec(String(out));
      if (!m) return reject(new GitError(err?.code === 'ENOENT' ? 'No git found.' : 'That isn’t a git program.', { code: 'not-git' }));
      resolve({ path: bin === 'git' ? onPath('git') : bin, version: m[1] });
    });
  });
}
function onPath(name) {
  for (const dir of (BASE_ENV.PATH || '').split(':').filter(Boolean)) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return name;
}
// A feature git is too old for: the message names the version, `code` lets the app offer Update git.
const tooOld = (feature) => new GitError(`${GIT_FEATURES[feature]} needs git ${GIT_NEEDS[feature]} or later.`, { code: 'git-version' });

function run(cwd, args, { input, env, allowCodes = [0], maxBuffer = 512 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      GIT,
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


const SEP = '\x00';
const REC = '\x1e';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Work snapshots: the exact index entries and working-tree bytes of a set of
// paths. Destructive working-copy operations record one before and one after
// they run, so undo and redo can put either state back byte for byte.

const W_ENV = { GIT_OPTIONAL_LOCKS: '1', GIT_LITERAL_PATHSPECS: '1' };
const UNDO_REFS = 'refs/since/undo';

function chunk(list, n = 500) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

module.exports = { run, GitError, gitPath, BASE_ENV, SEP, REC, EMPTY_TREE, W_ENV, chunk, UNDO_REFS, tooOld, mapLimit, onGitPathChange, setGitPath, gitInfo, remoteFailure };
