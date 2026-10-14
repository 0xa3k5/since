'use strict';
// Read-only pull request status through the user's own GitHub CLI (`gh`). GitLanes never sees a
// token and makes no request itself: the network call happens inside `gh`, the same way it
// happens inside `git fetch`, and only when the user fetches or refreshes pull requests. Off until
// the user turns it on for a repository (settings.json `github.repos`).
// The adapter is `detect` + `listPrs` returning plain objects, so a `glab` version can sit beside it.

const { findBinary, runCli, searchDirs } = require('./ai');

const PR_FIELDS = ['number', 'title', 'headRefName', 'headRepositoryOwner', 'baseRefName', 'isDraft', 'reviewDecision', 'statusCheckRollup', 'author', 'url', 'updatedAt'];
const LIMIT = 100;
const TIMEOUT = 30_000;
// Never prompt (there's no terminal), no update nags or colour codes in the output.
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' };
const INSTALL_URL = 'https://cli.github.com';

const coded = (message, code) => Object.assign(new Error(message), { code });

// A remote (from git.getRemotes, whose `web` is "https://host/owner/repo") as { name, host, owner, repo }.
// Only plain names, so nothing from a remote URL can reach `gh` as an option.
function parseRemote(r) {
  const m = /^https:\/\/([a-z0-9.-]+)(?::\d+)?\/([\w.-]+)\/([\w.-]+)$/i.exec(r?.web || '');
  if (!m || m[2].startsWith('.') || m[3].startsWith('.')) return null;
  return { name: r.name, host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
}

// The repository to ask about: origin if it's on a web host, else the first remote that is.
function pickRemote(remotes = []) {
  const parsed = remotes.map(parseRemote).filter(Boolean);
  return parsed.find((r) => r.name === 'origin') || parsed[0] || null;
}

// Owner per remote name, so the renderer can place fork PRs on branches that track a fork.
const remoteOwners = (remotes = []) => Object.fromEntries(remotes.map(parseRemote).filter(Boolean).map((r) => [r.name, r.owner]));

const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' };
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

// statusCheckRollup mixes check runs ({ status, conclusion }) and commit statuses ({ state }).
// Any failure wins, then anything still running; no checks at all is null.
function checksState(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let pending = false;
  for (const c of rollup) {
    const v = String(c?.conclusion || c?.state || '').toUpperCase();
    if (FAILED.has(v)) return 'failure';
    if ((c?.status && c.status !== 'COMPLETED') || v === 'PENDING' || v === 'EXPECTED' || !v) pending = true;
  }
  return pending ? 'pending' : 'success';
}

const text = (v, max = 1024) => (typeof v === 'string' ? v.slice(0, max) : '');

function normalizePr(p) {
  if (!p || typeof p !== 'object' || !Number.isSafeInteger(p.number) || p.number <= 0) return null;
  const url = text(p.url, 2048);
  return {
    number: p.number,
    title: text(p.title),
    branch: text(p.headRefName),
    headOwner: text(p.headRepositoryOwner?.login, 200),
    base: text(p.baseRefName),
    draft: p.isDraft === true,
    review: REVIEW[p.reviewDecision] || null,
    checks: checksState(p.statusCheckRollup),
    author: text(p.author?.login, 200),
    url: url.startsWith('https://') ? url : null,
    updatedAt: text(p.updatedAt, 64),
  };
}

// `gh pr list --json …` output → PRs, newest update first. Throws on anything that isn't a list.
function parsePrs(out) {
  let list;
  try { list = JSON.parse(out); } catch { throw coded('GitHub CLI returned something that isn’t JSON.', 'gh-failed'); }
  if (!Array.isArray(list)) throw coded('GitHub CLI returned something that isn’t a list.', 'gh-failed');
  return list.map(normalizePr).filter(Boolean)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.number - a.number))
    .slice(0, LIMIT);
}

const authProblem = (msg) => /auth login|not logged in|authenticat|HTTP 401|bad credentials/i.test(msg || '');

const run = (bin, args, { dirs, timeout = TIMEOUT, exec = runCli }) => exec(bin, args, '', { dirs, timeout, env: GH_ENV });

// The enable sheet's check, after the user chose to turn it on: is `gh` installed, and logged in
// to this remote's host? Returns { gh: 'missing' | 'logged-out' | 'ready', remote }.
async function detect({ remotes, dirs = searchDirs(), exec } = {}) {
  const remote = pickRemote(remotes);
  if (!remote) throw coded('This repository has no GitHub remote.', 'gh-no-remote');
  const bin = findBinary('gh', dirs);
  if (!bin) return { gh: 'missing', remote };
  try {
    await run(bin, ['auth', 'status', '--hostname', remote.host], { dirs, exec });
    return { gh: 'ready', remote };
  } catch {
    return { gh: 'logged-out', remote };
  }
}

// One refresh. While the repository's toggle is off, nothing runs: no binary lookup, no process.
async function listPrs({ enabled, remotes, dirs = searchDirs(), exec } = {}) {
  if (!enabled) return null;
  const remote = pickRemote(remotes);
  if (!remote) throw coded('This repository has no GitHub remote.', 'gh-no-remote');
  const bin = findBinary('gh', dirs);
  if (!bin) throw coded('Couldn’t find the `gh` command. Install GitHub CLI.', 'gh-missing');
  let out;
  try {
    out = await run(bin, ['pr', 'list', '--repo', `${remote.host}/${remote.owner}/${remote.repo}`, '--state', 'open', '--limit', String(LIMIT), '--json', PR_FIELDS.join(',')], { dirs, exec });
  } catch (err) {
    throw coded(err.message, authProblem(err.message) ? 'gh-auth' : 'gh-failed');
  }
  return { remote, owners: remoteOwners(remotes), prs: parsePrs(out), at: Date.now() };
}

// settings.json `github`: { repos: [repository roots with PR status on] }.
function normalize(saved = {}) {
  return { repos: Array.isArray(saved?.repos) ? saved.repos.filter((r) => typeof r === 'string') : [] };
}
const isEnabled = (saved, root) => normalize(saved).repos.includes(root);
function setEnabled(saved, root, on) {
  const repos = normalize(saved).repos.filter((r) => r !== root);
  return { ...normalize(saved), repos: on ? [...repos, root] : repos };
}

module.exports = { PR_FIELDS, LIMIT, INSTALL_URL, parseRemote, pickRemote, remoteOwners, checksState, normalizePr, parsePrs, detect, listPrs, normalize, isEnabled, setEnabled };
