'use strict';
// Read-only pull request status through the user's own GitHub CLI (`gh`). GitLanes never sees a
// token and makes no request itself: the network call happens inside `gh`, the same way it
// happens inside `git fetch`, and only when the user fetches or refreshes pull requests. Off until
// the user turns it on for a repository (settings.json `github.repos`).
// The adapter is `detect` + `listPrs` returning plain objects, so a `glab` version can sit beside it.
// Approve, merge and close (`mergeInfo`, `approvePr`, `mergePr`, `closePr`) are remote actions:
// they can't be undone with ⌘Z, and the renderer's confirm sheets say so.

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

// The repository as `gh --repo` wants it, or a coded error. Every action starts here, so nothing
// runs while the repository's toggle is off.
function target({ enabled, remotes, dirs }) {
  if (!enabled) throw coded('Pull requests are off for this repository.', 'gh-off');
  const remote = pickRemote(remotes);
  if (!remote) throw coded('This repository has no GitHub remote.', 'gh-no-remote');
  const bin = findBinary('gh', dirs);
  if (!bin) throw coded('Couldn’t find the `gh` command. Install GitHub CLI.', 'gh-missing');
  return { bin, remote, repo: `${remote.host}/${remote.owner}/${remote.repo}` };
}

async function ghRun(bin, args, opts) {
  try { return await run(bin, args, opts); } catch (err) { throw coded(err.message, authProblem(err.message) ? 'gh-auth' : 'gh-failed'); }
}

const prNumber = (n) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw coded('Invalid pull request number.', 'gh-failed');
  return String(n);
};

const MERGE_METHODS = ['squash', 'merge', 'rebase'];
const PR_VIEW_FIELDS = ['number', 'state', 'isDraft', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'statusCheckRollup', 'headRefName'];
const REPO_VIEW_FIELDS = ['squashMergeAllowed', 'mergeCommitAllowed', 'rebaseMergeAllowed', 'deleteBranchOnMerge', 'viewerPermission'];

function parseJson(out) {
  try { const v = JSON.parse(out); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
  throw coded('GitHub CLI returned something that isn’t JSON.', 'gh-failed');
}

// `gh pr view` + `gh repo view` → what the merge sheet needs. Squash first: the default.
function parseMergeInfo(prOut, repoOut) {
  const p = parseJson(prOut), r = parseJson(repoOut);
  const methods = [r.squashMergeAllowed && 'squash', r.mergeCommitAllowed && 'merge', r.rebaseMergeAllowed && 'rebase'].filter(Boolean);
  return {
    number: Number.isSafeInteger(p.number) ? p.number : null,
    state: text(p.state, 32).toLowerCase(), // open | closed | merged
    draft: p.isDraft === true,
    conflicts: p.mergeable === 'CONFLICTING' || p.mergeStateStatus === 'DIRTY',
    mergeState: text(p.mergeStateStatus, 32).toLowerCase(), // clean | blocked | unstable | behind | dirty | …
    review: REVIEW[p.reviewDecision] || null,
    checks: checksState(p.statusCheckRollup),
    branch: text(p.headRefName),
    methods: methods.length ? methods : ['squash'],
    deleteBranchOnMerge: r.deleteBranchOnMerge === true,
    admin: r.viewerPermission === 'ADMIN',
  };
}

// Whether the merge button is open. `hard` can't be overridden from here (draft, conflicts,
// already closed). `soft` reasons (failing checks, review required, branch protection) need the
// "merge anyway" tick; when GitHub itself blocks the merge, only an admin can bypass it (`--admin`).
function mergeGate(info) {
  const hard = info.state && info.state !== 'open' ? `This pull request is ${info.state}.`
    : info.draft ? 'It’s a draft. Mark it ready for review on GitHub first.'
    : info.conflicts ? 'It has conflicts with its base branch.'
    : null;
  const soft = [
    info.checks === 'failure' ? 'Checks are failing.' : null,
    info.checks === 'pending' ? 'Checks are still running.' : null,
    info.review === 'required' ? 'A review is required.' : null,
    info.review === 'changes' ? 'Changes were requested.' : null,
  ].filter(Boolean);
  const protectedBranch = info.mergeState === 'blocked';
  if (protectedBranch && !soft.length) soft.push('Branch protection rules block this merge.');
  return { hard, soft, needsAdmin: protectedBranch, canOverride: !protectedBranch || info.admin };
}

async function mergeInfo({ enabled, remotes, number, dirs = searchDirs(), exec } = {}) {
  const { bin, repo } = target({ enabled, remotes, dirs });
  const n = prNumber(number);
  const [prOut, repoOut] = await Promise.all([
    ghRun(bin, ['pr', 'view', n, '--repo', repo, '--json', PR_VIEW_FIELDS.join(',')], { dirs, exec }),
    ghRun(bin, ['repo', 'view', repo, '--json', REPO_VIEW_FIELDS.join(',')], { dirs, exec }),
  ]);
  const info = parseMergeInfo(prOut, repoOut);
  return { ...info, gate: mergeGate(info) };
}

const comment = (body) => (typeof body === 'string' && body.trim() ? body.trim().slice(0, 65_536) : null);

async function approvePr({ enabled, remotes, number, body, dirs = searchDirs(), exec } = {}) {
  const { bin, repo } = target({ enabled, remotes, dirs });
  const c = comment(body);
  await ghRun(bin, ['pr', 'review', prNumber(number), '--repo', repo, '--approve', ...(c ? [`--body=${c}`] : [])], { dirs, exec });
  return { number };
}

// `--repo` keeps `gh` away from any local checkout: it deletes only the remote branch, and the
// local side (fetch --prune, deleting the local branch) goes through GitLanes' journal.
async function mergePr({ enabled, remotes, number, method = 'squash', deleteBranch = false, admin = false, dirs = searchDirs(), exec } = {}) {
  const { bin, repo } = target({ enabled, remotes, dirs });
  if (!MERGE_METHODS.includes(method)) throw coded('Unknown merge method.', 'gh-failed');
  await ghRun(bin, ['pr', 'merge', prNumber(number), '--repo', repo, `--${method}`, ...(deleteBranch ? ['--delete-branch'] : []), ...(admin ? ['--admin'] : [])], { dirs, exec });
  return { number, method };
}

async function closePr({ enabled, remotes, number, body, dirs = searchDirs(), exec } = {}) {
  const { bin, repo } = target({ enabled, remotes, dirs });
  const c = comment(body);
  await ghRun(bin, ['pr', 'close', prNumber(number), '--repo', repo, ...(c ? [`--comment=${c}`] : [])], { dirs, exec });
  return { number };
}

// Checking out a PR: `gh pr view` says where its head is; git then fetches `refs/pull/<n>/head`
// from the same remote (forks included, no fork remote needed), so every ref change goes through
// the journal and ⌘Z undoes it.
const VIEW_FIELDS = ['number', 'headRefName', 'headRefOid', 'headRepositoryOwner', 'isCrossRepository', 'baseRefName', 'state'];

// The local branch, named the way `gh pr checkout` names it: the PR's head branch, or
// `owner/branch` when a fork's head branch has the same name as the base (a fork's `main`).
function branchName(head) {
  return head.cross && head.headOwner && head.branch === head.base ? `${head.headOwner}/${head.branch}` : head.branch;
}

// `gh pr view --json …` output → { number, branch, sha, cross, headOwner, base, state, local }.
// Throws on anything that couldn't be a branch name or a commit, so nothing odd reaches git.
function parsePrHead(out, number) {
  const p = parseJson(out);
  if (p.number !== number) throw coded(`GitHub CLI didn’t return pull request #${number}.`, 'gh-failed');
  const head = {
    number,
    branch: text(p.headRefName, 255),
    sha: text(p.headRefOid, 64).toLowerCase(),
    cross: p.isCrossRepository === true,
    headOwner: text(p.headRepositoryOwner?.login, 200),
    base: text(p.baseRefName, 255),
    state: text(p.state, 20).toLowerCase(),
  };
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.sha)) throw coded(`Pull request #${number} has no head commit.`, 'gh-failed');
  head.local = branchName(head);
  if (!head.branch || !/^[\w./-]+$/.test(head.local) || /^[-./]|\.\.|\/\/|[./]$|\.lock$/.test(head.local)) {
    throw coded(`Pull request #${number} has a branch name GitLanes can’t use: “${head.branch}”.`, 'gh-failed');
  }
  return head;
}

async function viewPr({ enabled, remotes, number, dirs = searchDirs(), exec } = {}) {
  const { bin, remote, repo } = target({ enabled, remotes, dirs });
  const out = await ghRun(bin, ['pr', 'view', prNumber(number), '--repo', repo, '--json', VIEW_FIELDS.join(',')], { dirs, exec });
  return { remote, head: parsePrHead(out, number) };
}

// The upstream a checked-out PR branch pulls from: the head branch on the same remote for a
// PR from this repository, else the PR's own ref (which follows the fork's pushes).
const prUpstream = (head) => (head.cross ? `refs/pull/${head.number}/head` : `refs/heads/${head.branch}`);

// Creating a PR. The sheet asks `gh repo view` for the default branch (the usual base) and fills
// the title and body from the branch's own commits; `gh pr create` then gets the body on stdin
// (`--body-file -`) and `--head`, so it never pushes or reads the local checkout itself.
function parseDefaultBranch(out) {
  const branch = text(parseJson(out).defaultBranchRef?.name, 255);
  if (!branch) throw coded('GitHub CLI didn’t say which branch is the default.', 'gh-failed');
  return branch;
}

async function defaultBranch({ enabled, remotes, dirs = searchDirs(), exec } = {}) {
  const { bin, repo } = target({ enabled, remotes, dirs });
  return parseDefaultBranch(await ghRun(bin, ['repo', 'view', repo, '--json', 'defaultBranchRef'], { dirs, exec }));
}

// Commits (newest first, as `git log` lists them) → { title, body }. One commit: its message.
// Several: the oldest subject as the title and every subject as a bullet, oldest first.
function prDraft(commits = []) {
  const list = commits.filter((c) => c && c.subject);
  if (!list.length) return { title: '', body: '' };
  if (list.length === 1) return { title: list[0].subject, body: (list[0].body || '').trim() };
  const oldest = [...list].reverse();
  return { title: oldest[0].subject, body: oldest.map((c) => `- ${c.subject}`).join('\n') };
}

// `git log --format=%s%x00%b%x1e` output → [{ subject, body }].
const parseCommits = (out) => String(out || '').split('\x1e').map((rec) => rec.replace(/^\n+/, '')).filter(Boolean)
  .map((rec) => { const i = rec.indexOf('\0'); return { subject: (i < 0 ? rec : rec.slice(0, i)).trim(), body: i < 0 ? '' : rec.slice(i + 1).trim() }; });

// Branch names as they reach `gh`: plain names only, never something that reads as an option.
// A head can carry a fork owner (`owner:branch`).
const BRANCH = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{))[\w./-]+(?<![./]|\.lock)$/;
function branchArg(v, what) {
  const s = typeof v === 'string' ? v : '';
  const i = s.indexOf(':');
  const owner = i < 0 ? null : s.slice(0, i), name = i < 0 ? s : s.slice(i + 1);
  if (!BRANCH.test(name) || name.length > 255 || (owner !== null && !/^[\w.-]{1,100}$/.test(owner))) throw coded(`Invalid ${what} branch.`, 'gh-failed');
  return s;
}

// `gh pr create` prints the new PR's URL last.
function parseCreated(out) {
  const m = /(https:\/\/\S+\/pull\/(\d+))\s*$/.exec(String(out || '').trim());
  if (!m) throw coded('GitHub CLI didn’t return the new pull request’s link.', 'gh-failed');
  return { url: m[1], number: Number(m[2]) };
}

async function createPr({ enabled, remotes, base, head, title, body = '', draft = false, dirs = searchDirs(), exec = runCli } = {}) {
  const { bin, repo } = target({ enabled, remotes, dirs });
  const t = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : '';
  if (!t) throw coded('A pull request needs a title.', 'gh-failed');
  const args = ['pr', 'create', '--repo', repo, `--base=${branchArg(base, 'base')}`, `--head=${branchArg(head, 'head')}`, `--title=${t.slice(0, 256)}`, '--body-file', '-', ...(draft ? ['--draft'] : [])];
  let out;
  try {
    out = await exec(bin, args, typeof body === 'string' ? body.slice(0, 65_536) : '', { dirs, timeout: TIMEOUT, env: GH_ENV });
  } catch (err) { throw coded(err.message, authProblem(err.message) ? 'gh-auth' : 'gh-failed'); }
  return parseCreated(out);
}

// settings.json `github`: { on, hidden: [repository roots the user hid PRs for] }. One user-wide
// flag; `on: null` means not decided yet (a fresh install, see ghStatus). Older versions kept a
// per-repository `repos` list: any repository on there means it was on.
function normalize(saved = {}) {
  const hidden = Array.isArray(saved?.hidden) ? saved.hidden.filter((r) => typeof r === 'string') : [];
  const on = typeof saved?.on === 'boolean' ? saved.on : Array.isArray(saved?.repos) && saved.repos.some((r) => typeof r === 'string') ? true : null;
  return { on, hidden };
}
const isHidden = (saved, root) => normalize(saved).hidden.includes(root);
const isEnabled = (saved, root) => normalize(saved).on === true && !isHidden(saved, root);
const setEnabled = (saved, on) => ({ ...normalize(saved), on: Boolean(on) });
function setHidden(saved, root, hide) {
  const hidden = normalize(saved).hidden.filter((r) => r !== root);
  return { ...normalize(saved), hidden: hide ? [...hidden, root] : hidden };
}

// Whether `gh` is on the PATH or in the usual places. Only a lookup; no process runs.
const ghInstalled = ({ dirs = searchDirs() } = {}) => Boolean(findBinary('gh', dirs));

// The fresh-install default: on when `gh` is installed and logged in. Returns 'missing' |
// 'logged-out' | 'ready'.
async function ghStatus({ dirs = searchDirs(), exec } = {}) {
  const bin = findBinary('gh', dirs);
  if (!bin) return 'missing';
  try {
    await run(bin, ['auth', 'status'], { dirs, exec });
    return 'ready';
  } catch {
    return 'logged-out';
  }
}

module.exports = { PR_FIELDS, LIMIT, INSTALL_URL, parseRemote, pickRemote, remoteOwners, checksState, normalizePr, parsePrs, detect, listPrs, MERGE_METHODS, parseMergeInfo, mergeGate, mergeInfo, approvePr, mergePr, closePr, VIEW_FIELDS, branchName, parsePrHead, viewPr, prUpstream, parseDefaultBranch, defaultBranch, prDraft, parseCommits, branchArg, parseCreated, createPr, normalize, isEnabled, isHidden, setEnabled, setHidden, ghInstalled, ghStatus };
