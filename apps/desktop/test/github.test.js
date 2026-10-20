'use strict';
// Read-only pull request status through `gh` (github.js, renderer/prs.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const github = require('../github');

const remote = (name, url) => ({ name, url, web: require('../git').remoteWebUrl(url) });
const ORIGIN = remote('origin', 'git@github.com:acme/app.git');

// A folder with a fake `gh` so findBinary finds it; the exec stub records calls instead of running it.
function fakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-gh-test-'));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}
const recorder = (reply) => {
  const calls = [];
  const exec = async (bin, args, input, opts) => { calls.push({ bin, args, opts }); return typeof reply === 'function' ? reply(args) : reply; };
  return { calls, exec };
};

const PR = (o = {}) => ({
  number: 12, title: 'Add lanes', headRefName: 'lanes', headRepositoryOwner: { login: 'acme' }, baseRefName: 'main',
  isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [], author: { login: 'kim' },
  url: 'https://github.com/acme/app/pull/12', updatedAt: '2026-10-10T10:00:00Z', ...o,
});

test('remotes: GitHub and Enterprise remotes parse, origin wins, odd names are refused', () => {
  assert.deepEqual(github.parseRemote(ORIGIN), { name: 'origin', host: 'github.com', owner: 'acme', repo: 'app' });
  assert.deepEqual(github.parseRemote(remote('ghe', 'https://user@git.corp.example:8443/team/svc.git')), { name: 'ghe', host: 'git.corp.example', owner: 'team', repo: 'svc' });
  assert.equal(github.parseRemote(remote('local', '/srv/git/app.git')), null);
  assert.equal(github.parseRemote({ name: 'x', web: 'https://github.com/acme/app/extra' }), null);
  assert.equal(github.parseRemote({ name: 'x', web: 'https://github.com/--upload-pack=x/app' }), null);
  const fork = remote('fork', 'https://github.com/kim/app');
  assert.equal(github.pickRemote([fork, ORIGIN]).name, 'origin');
  assert.equal(github.pickRemote([remote('local', '/srv/app'), fork]).name, 'fork');
  assert.equal(github.pickRemote([]), null);
  assert.deepEqual(github.remoteOwners([fork, ORIGIN]), { fork: 'kim', origin: 'acme' });
});

test('checks: failure wins, then pending; no checks is null', () => {
  const run = (status, conclusion = '') => ({ __typename: 'CheckRun', status, conclusion });
  const ctx = (state) => ({ __typename: 'StatusContext', state });
  assert.equal(github.checksState([]), null);
  assert.equal(github.checksState(null), null);
  assert.equal(github.checksState([run('COMPLETED', 'SUCCESS'), ctx('SUCCESS'), run('COMPLETED', 'SKIPPED')]), 'success');
  assert.equal(github.checksState([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')]), 'pending');
  assert.equal(github.checksState([ctx('PENDING')]), 'pending');
  assert.equal(github.checksState([run('IN_PROGRESS'), run('COMPLETED', 'FAILURE')]), 'failure');
  assert.equal(github.checksState([ctx('ERROR'), run('QUEUED')]), 'failure');
  assert.equal(github.checksState([run('COMPLETED', 'TIMED_OUT')]), 'failure');
});

test('checkCounts: skipped and neutral pass, like the merge box; null with no checks', () => {
  const run = (status, conclusion = '') => ({ status, conclusion });
  const ctx = (state) => ({ state });
  assert.equal(github.checkCounts([]), null);
  assert.equal(github.checkCounts(undefined), null);
  assert.deepEqual(github.checkCounts([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'FAILURE'), run('IN_PROGRESS'), ctx('SUCCESS'), ctx('PENDING')]), { passed: 4, total: 7 });
});

test('parsePrs: normalizes gh JSON, drops bad entries, newest first, capped', () => {
  const out = JSON.stringify([
    PR({ number: 1, updatedAt: '2026-10-01T00:00:00Z', isDraft: true, reviewDecision: '', statusCheckRollup: [{ status: 'QUEUED' }] }),
    PR({ number: 2, reviewDecision: 'CHANGES_REQUESTED', url: 'javascript:alert(1)' }),
    { number: -3, title: 'bad' }, { number: '4' }, null,
  ]);
  const prs = github.parsePrs(out);
  assert.deepEqual(prs.map((p) => p.number), [2, 1]);
  assert.deepEqual(prs[1], { number: 1, title: 'Add lanes', branch: 'lanes', head: null, headOwner: 'acme', base: 'main', draft: true, review: null, checks: 'pending', failing: [], checkCounts: { passed: 0, total: 1 }, author: 'kim', authorName: 'kim', bot: false, url: 'https://github.com/acme/app/pull/12', updatedAt: '2026-10-01T00:00:00Z', mergeable: null, mergeState: null, reviews: [], reviewRequests: [], size: { additions: null, deletions: null, files: null }, body: '' });
  assert.equal(prs[0].review, 'changes');
  assert.equal(prs[0].url, null, 'only https links');
  assert.equal(github.parsePrs(JSON.stringify(Array.from({ length: 150 }, (_, i) => PR({ number: i + 1 })))).length, github.LIMIT);
  assert.throws(() => github.parsePrs('not json'), { code: 'gh-failed' });
  assert.throws(() => github.parsePrs('{"a":1}'), { code: 'gh-failed' });
});

test('listPrs: nothing runs while the toggle is off', async () => {
  const { calls, exec } = recorder('[]');
  assert.equal(await github.listPrs({ enabled: false, remotes: [ORIGIN], dirs: [fakeGh()], exec }), null);
  assert.equal(calls.length, 0);
});

test('the Review and Catch up reads hand their signal to every gh call', async () => {
  const { signal } = new AbortController();
  const { calls, exec } = recorder((args) => (args[0] === 'api' && args.includes('user') ? 'kim' : '[]'));
  // Its own host and repository, so the login and viewer this asks for stay out of the other tests' caches.
  const opts = { enabled: true, remotes: [remote('origin', 'https://signal.example/acme/app')], dirs: [fakeGh()], exec, signal };
  await github.listPrs(opts);
  await github.mergedPrs(opts);
  await github.inbox(opts);
  await github.baseCi({ ...opts, branch: 'main' });
  await github.mergedStacks({ ...opts, numbers: [1] }).catch(() => {});
  assert.equal(calls.length, 7);
  for (const c of calls) assert.equal(c.opts.signal, signal, c.args.join(' '));
});

test('listPrs: asks gh for this repository’s open PRs, without prompts', async () => {
  const dir = fakeGh();
  const { calls, exec } = recorder(JSON.stringify([PR()]));
  const res = await github.listPrs({ enabled: true, remotes: [remote('fork', 'https://github.com/kim/app'), ORIGIN], dirs: [dir], exec });
  assert.equal(calls.length, 2); // the PRs, then who you are (unreadable here: no viewer)
  assert.equal(res.viewer, null);
  assert.equal(calls[0].bin, path.join(dir, 'gh'));
  assert.deepEqual(calls[0].args, ['pr', 'list', '--repo', 'github.com/acme/app', '--state', 'open', '--limit', '100', '--json', github.PR_FIELDS.join(',')]);
  assert.equal(calls[0].opts.env.GH_PROMPT_DISABLED, '1');
  assert.equal(res.remote.name, 'origin');
  assert.deepEqual(res.owners, { fork: 'kim', origin: 'acme' });
  assert.equal(res.prs[0].number, 12);
});

test('listPrs: who you are on the repository, once per session; a failed lookup greys nothing (AK-577)', async () => {
  const me = (perm) => JSON.stringify({ data: { viewer: { login: 'ana' }, repository: { viewerPermission: perm } } });
  const { calls, exec } = recorder((args) => (args[0] === 'api' ? me('READ') : JSON.stringify([PR()])));
  const remotes = [remote('origin', 'git@github.com:viewer-co/app.git')];
  const res = await github.listPrs({ enabled: true, remotes, dirs: [fakeGh()], exec });
  assert.deepEqual(res.viewer, { login: 'ana', write: false });
  assert.deepEqual(calls[1].args.slice(0, 4), ['api', '--hostname', 'github.com', 'graphql']);
  assert.ok(calls[1].args.includes('owner=viewer-co') && calls[1].args.includes('name=app'));
  await github.listPrs({ enabled: true, remotes, dirs: [fakeGh()], exec });
  assert.equal(calls.length, 3); // remembered: only the PR list again
  assert.deepEqual(github.parseViewer(me('MAINTAIN')), { login: 'ana', write: true });
  assert.equal(github.parseViewer('nope'), null);
  assert.equal(github.parseViewer(JSON.stringify({ data: { viewer: { login: 'a b' }, repository: { viewerPermission: 'WRITE' } } })), null);
  const failing = async (bin, args) => { if (args[0] === 'api') throw new Error('HTTP 403'); return JSON.stringify([PR()]); };
  const off = await github.listPrs({ enabled: true, remotes: [remote('origin', 'git@github.com:viewer-co/other.git')], dirs: [fakeGh()], exec: failing });
  assert.equal(off.viewer, null);
  assert.equal(off.prs.length, 1);
});

test('listPrs / detect: missing gh, logged out and other errors', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-gh-test-'));
  await assert.rejects(github.listPrs({ enabled: true, remotes: [ORIGIN], dirs: [empty] }), { code: 'gh-missing' });
  await assert.rejects(github.listPrs({ enabled: true, remotes: [remote('l', '/srv/app')], dirs: [empty] }), { code: 'gh-no-remote' });
  const fail = (msg) => async () => { throw new Error(msg); };
  await assert.rejects(github.listPrs({ enabled: true, remotes: [ORIGIN], dirs: [fakeGh()], exec: fail('To get started with GitHub CLI, please run:  gh auth login') }), { code: 'gh-auth' });
  await assert.rejects(github.listPrs({ enabled: true, remotes: [ORIGIN], dirs: [fakeGh()], exec: fail('error connecting to api.github.com') }), { code: 'gh-failed' });

  assert.equal((await github.detect({ remotes: [ORIGIN], dirs: [empty] })).gh, 'missing');
  assert.equal((await github.detect({ remotes: [ORIGIN], dirs: [fakeGh()], exec: fail('not logged in') })).gh, 'logged-out');
  const { calls, exec } = recorder('');
  assert.equal((await github.detect({ remotes: [ORIGIN], dirs: [fakeGh()], exec })).gh, 'ready');
  assert.deepEqual(calls[0].args, ['auth', 'status', '--hostname', 'github.com']);
  // No repository open: the github.com login only, no remote needed.
  const none = recorder('');
  assert.deepEqual(await github.detect({ remotes: null, dirs: [fakeGh()], exec: none.exec }), { gh: 'ready', remote: null });
  assert.deepEqual(none.calls[0].args, ['auth', 'status', '--hostname', 'github.com']);
  await assert.rejects(github.detect({ remotes: [], dirs: [fakeGh()], exec: none.exec }), { code: 'gh-no-remote' });
});

test('settings: one user-wide flag, a per-repository hide, and the old per-repository keys migrated', () => {
  assert.deepEqual(github.normalize(undefined), { on: null, hidden: [] });
  assert.deepEqual(github.normalize({ on: false, hidden: ['/a', 3] }), { on: false, hidden: ['/a'] });
  // Upgrades: on if any repository had it on; the old `repos` key is dropped.
  assert.deepEqual(github.normalize({ repos: ['/a', 3] }), { on: true, hidden: [] });
  assert.deepEqual(github.normalize({ repos: [] }), { on: false, hidden: [] }, 'turned off in the last repository stays off');
  assert.equal(github.normalize({ on: false, repos: ['/a'] }).on, false, 'an explicit choice wins');
  let s = github.setEnabled(undefined, true);
  assert.ok(github.isEnabled(s, '/a') && github.isEnabled(s, '/b'), 'on for every repository');
  s = github.setHidden(s, '/a', true);
  s = github.setHidden(s, '/a', true);
  assert.deepEqual(s, { on: true, hidden: ['/a'] });
  assert.ok(!github.isEnabled(s, '/a') && github.isHidden(s, '/a') && github.isEnabled(s, '/b'));
  assert.ok(github.isEnabled(github.setHidden(s, '/a', false), '/a'));
  assert.ok(!github.isEnabled(github.setEnabled(s, false), '/b'), 'off everywhere');
  assert.deepEqual(github.setEnabled(s, false).hidden, ['/a'], 'turning it off keeps the hidden list');
});

test('ghStatus: the fresh-install default is on only when gh is installed and logged in', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-nogh-'));
  const fail = (msg) => async () => { throw new Error(msg); };
  assert.equal(await github.ghStatus({ dirs: [empty] }), 'missing');
  assert.equal(github.ghInstalled({ dirs: [empty] }), false);
  assert.equal(github.ghInstalled({ dirs: [fakeGh()] }), true);
  assert.equal(await github.ghStatus({ dirs: [fakeGh()], exec: fail('not logged in') }), 'logged-out');
  const { calls, exec } = recorder('');
  assert.equal(await github.ghStatus({ dirs: [fakeGh()], exec }), 'ready');
  assert.deepEqual(calls[0].args, ['auth', 'status']);
});

test('renderer: PRs land on their branches, fork PRs only on branches tracking that fork', async () => {
  const { prsByRef, prRef, prTitle } = await import('../renderer/prs.js');
  const mine = { number: 1, title: 'Mine', branch: 'lanes', headOwner: 'acme', base: 'main', draft: false, review: 'approved', checks: 'failure', author: 'kim' };
  const theirs = { number: 2, title: 'Fork', branch: 'main', headOwner: 'kim', base: 'main', draft: true, review: null, checks: null, author: 'kim' };
  const refs = [
    { kind: 'branch', short: 'lanes', target: 'a' },
    { kind: 'remote', short: 'origin/lanes', target: 'a' },
    { kind: 'branch', short: 'main', upstream: 'origin/main', target: 'b' },
    { kind: 'branch', short: 'kim-main', upstream: 'kim/main', target: 'c' },
  ];
  const data = { remote: { name: 'origin', owner: 'acme' }, owners: { origin: 'acme', kim: 'kim' }, prs: [mine, theirs] };
  const by = prsByRef(data, refs);
  assert.equal(by.get('branch:lanes'), mine);
  assert.equal(by.get('remote:origin/lanes'), mine);
  assert.equal(by.get('branch:main'), undefined, 'a fork’s "main" is not our main');
  assert.equal(by.get('branch:kim-main'), theirs);
  assert.equal(prRef(mine, refs, by).kind, 'branch');
  assert.equal(prRef(theirs, refs, by).short, 'kim-main');
  assert.equal(prsByRef(null, refs).size, 0);
  assert.equal(prTitle(mine), '#1 Mine\nby kim · lanes → main\nApproved · Checks failed');
  assert.match(prTitle(theirs, true), /Draft\nNot refreshed/);
});

const SHA = 'a'.repeat(40);
const HEAD = (o = {}) => JSON.stringify({ number: 12, headRefName: 'lanes', headRefOid: SHA, headRepositoryOwner: { login: 'acme' }, isCrossRepository: false, baseRefName: 'main', state: 'OPEN', ...o });

test('parsePrHead: branch named like gh, fork heads track the PR ref', () => {
  const mine = github.parsePrHead(HEAD(), 12);
  assert.deepEqual(mine, { number: 12, branch: 'lanes', sha: SHA, cross: false, headOwner: 'acme', base: 'main', state: 'open', local: 'lanes' });
  assert.equal(github.prUpstream(mine), 'refs/heads/lanes');
  const fork = github.parsePrHead(HEAD({ headRefName: 'fix/x', isCrossRepository: true, headRepositoryOwner: { login: 'kim' } }), 12);
  assert.equal(fork.local, 'fix/x');
  assert.equal(github.prUpstream(fork), 'refs/pull/12/head');
  // A fork's `main` would clash with ours: gh calls it `owner/main`.
  assert.equal(github.parsePrHead(HEAD({ headRefName: 'main', isCrossRepository: true, headRepositoryOwner: { login: 'kim' } }), 12).local, 'kim/main');
  assert.equal(github.parsePrHead(HEAD({ headRefName: 'main' }), 12).local, 'main');
});

test('parsePrHead: refuses odd output, wrong PR, bad shas and unsafe branch names', () => {
  assert.throws(() => github.parsePrHead('nope', 12), { code: 'gh-failed' });
  assert.throws(() => github.parsePrHead('[]', 12), { code: 'gh-failed' });
  assert.throws(() => github.parsePrHead(HEAD(), 13), { code: 'gh-failed' });
  assert.throws(() => github.parsePrHead(HEAD({ headRefOid: 'HEAD' }), 12), /no head commit/);
  for (const name of ['', '--upload-pack=x', '-b', 'a..b', 'a b', 'x.lock', 'a//b', 'end/', '.hidden', 'a/.b', 'a~b', 'a:b', 'a?b', 'a[b', 'a\\b', '@', 'x@{1}', 'dot.']) {
    assert.throws(() => github.parsePrHead(HEAD({ headRefName: name }), 12), { code: 'gh-failed' }, name);
  }
});

test('parsePrHead: takes any branch name git accepts', () => {
  for (const name of ['fix+x', 'issue#12', 'me@work', 'café/ñ', 'semi;colon', 'a.b/c-d_e']) {
    assert.equal(github.parsePrHead(HEAD({ headRefName: name }), 12).local, name);
  }
});

test('viewPr: off, bad numbers and missing gh run nothing; asks gh for one PR', async () => {
  const dir = fakeGh();
  const { calls, exec } = recorder(HEAD());
  await assert.rejects(github.viewPr({ enabled: false, remotes: [ORIGIN], number: 12, dirs: [dir], exec }), { code: 'gh-off' });
  for (const n of [0, -1, 1.5, '12', null]) await assert.rejects(github.viewPr({ enabled: true, remotes: [ORIGIN], number: n, dirs: [dir], exec }));
  await assert.rejects(github.viewPr({ enabled: true, remotes: [], number: 12, dirs: [dir], exec }), { code: 'gh-no-remote' });
  await assert.rejects(github.viewPr({ enabled: true, remotes: [ORIGIN], number: 12, dirs: [fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-gh-none-'))], exec }), { code: 'gh-missing' });
  assert.equal(calls.length, 0);
  const res = await github.viewPr({ enabled: true, remotes: [ORIGIN], number: 12, dirs: [dir], exec });
  assert.deepEqual(calls[0].args, ['pr', 'view', '12', '--repo', 'github.com/acme/app', '--json', github.VIEW_FIELDS.join(',')]);
  assert.equal(res.remote.name, 'origin');
  assert.equal(res.head.local, 'lanes');
  const fail = async () => { throw new Error('HTTP 401: Bad credentials'); };
  await assert.rejects(github.viewPr({ enabled: true, remotes: [ORIGIN], number: 12, dirs: [dir], exec: fail }), { code: 'gh-auth' });
});

// Approve, merge and close (AK-173).
const VIEW = (o = {}) => JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], headRefName: 'feat', ...o });
const REPO = (o = {}) => JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, deleteBranchOnMerge: false, viewerPermission: 'WRITE', ...o });

test('parseMergeInfo: allowed methods (squash first), state and checks', () => {
  const i = github.parseMergeInfo(VIEW(), REPO());
  assert.deepEqual(i.methods, ['squash', 'rebase']);
  assert.equal(i.state, 'open');
  assert.equal(i.checks, 'success');
  assert.equal(i.review, 'approved');
  assert.equal(i.admin, false);
  assert.deepEqual(github.parseMergeInfo(VIEW(), REPO({ squashMergeAllowed: false, rebaseMergeAllowed: false, mergeCommitAllowed: false })).methods, ['squash']);
  assert.equal(github.parseMergeInfo(VIEW({ mergeable: 'CONFLICTING' }), REPO()).conflicts, true);
  assert.throws(() => github.parseMergeInfo('nope', REPO()), { code: 'gh-failed' });
  assert.throws(() => github.parseMergeInfo('[]', REPO()), { code: 'gh-failed' });
});

test('mergeGate: hard blocks, soft blocks and who can override', () => {
  const gate = (pr, repo) => github.mergeGate(github.parseMergeInfo(VIEW(pr), REPO(repo)));
  assert.deepEqual(gate(), { hard: null, soft: [], failing: false, needsAdmin: false, canOverride: true });
  assert.match(gate({ isDraft: true }).hard, /draft/);
  assert.match(gate({ state: 'MERGED' }).hard, /merged/);
  assert.match(gate({ mergeStateStatus: 'DIRTY' }).hard, /conflicts/);
  // Failing checks GitHub doesn't require: no "merge anyway", a plain confirm that names them (AK-521).
  const unstable = gate({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ state: 'FAILURE' }] });
  assert.deepEqual(unstable.soft, []);
  assert.equal(unstable.failing, true);
  assert.equal(unstable.needsAdmin, false);
  assert.equal(unstable.canOverride, true);
  // Branch protection: only an admin can bypass.
  const blocked = gate({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' });
  assert.deepEqual(blocked.soft, ['A review is required.']);
  assert.equal(blocked.needsAdmin, true);
  assert.equal(blocked.canOverride, false);
  assert.equal(gate({ mergeStateStatus: 'BLOCKED' }, { viewerPermission: 'ADMIN' }).canOverride, true);
  assert.match(gate({ mergeStateStatus: 'BLOCKED' }).soft[0], /protection/);
});

test('PR actions: nothing runs while off; numbers must be positive integers', async () => {
  const { calls, exec } = recorder('');
  await assert.rejects(github.mergePr({ enabled: false, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec }), { code: 'gh-off' });
  await assert.rejects(github.approvePr({ enabled: true, remotes: [ORIGIN], number: 0, dirs: [fakeGh()], exec }), { code: 'gh-failed' });
  await assert.rejects(github.closePr({ enabled: true, remotes: [ORIGIN], number: 1.5, dirs: [fakeGh()], exec }), { code: 'gh-failed' });
  await assert.rejects(github.mergePr({ enabled: true, remotes: [ORIGIN], number: 7, method: '--admin', dirs: [fakeGh()], exec }), { code: 'gh-failed' });
  assert.equal(calls.length, 0);
});

test('PR actions: gh arguments', async () => {
  const run = async (fn, o) => { const { calls, exec } = recorder(''); await github[fn]({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec, ...o }); return calls[0].args; };
  assert.deepEqual(await run('mergePr'), ['pr', 'merge', '7', '--repo', 'github.com/acme/app', '--squash']);
  assert.deepEqual(await run('mergePr', { method: 'rebase', deleteBranch: true, admin: true }), ['pr', 'merge', '7', '--repo', 'github.com/acme/app', '--rebase', '--delete-branch', '--admin']);
  assert.deepEqual(await run('mergePr', { matchHead: 'abc123' }), ['pr', 'merge', '7', '--repo', 'github.com/acme/app', '--squash', '--match-head-commit', 'abc123']);
  assert.equal(github.headMoved(new Error('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)')), true);
  assert.equal(github.headMoved(new Error('Pull request is not mergeable')), false);
  assert.deepEqual(await run('approvePr'), ['pr', 'review', '7', '--repo', 'github.com/acme/app', '--approve']);
  assert.deepEqual(await run('approvePr', { body: ' --admin looks good ' }), ['pr', 'review', '7', '--repo', 'github.com/acme/app', '--approve', '--body=--admin looks good']);
  assert.deepEqual(await run('updatePrBranch'), ['pr', 'update-branch', '7', '--repo', 'github.com/acme/app']);
  assert.deepEqual(await run('updatePrBranch', { rebase: true }), ['pr', 'update-branch', '7', '--repo', 'github.com/acme/app', '--rebase']);
  assert.deepEqual(await run('closePr', { body: 'superseded' }), ['pr', 'close', '7', '--repo', 'github.com/acme/app', '--comment=superseded']);
  const fail = async () => { throw new Error('HTTP 401: Bad credentials'); };
  await assert.rejects(github.closePr({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec: fail }), { code: 'gh-auth' });
});

test('mergeInfo: one pr view and one repo view, with the gate', async () => {
  const { calls, exec } = recorder((args) => (args[0] === 'pr' ? VIEW({ mergeStateStatus: 'BLOCKED' }) : REPO()));
  const i = await github.mergeInfo({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec });
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [['pr', 'view'], ['repo', 'view']]);
  assert.equal(i.gate.needsAdmin, true);
});

test('ipc: prNumber and knownRemote', () => {
  const check = require('../ipc');
  assert.equal(check.prNumber(3), 3);
  for (const bad of [0, -1, 1.5, '3', null]) assert.throws(() => check.prNumber(bad), check.IpcArgError);
  assert.equal(check.knownRemote([ORIGIN], 'origin'), ORIGIN);
  assert.throws(() => check.knownRemote([ORIGIN], 'upstream'), check.IpcArgError);
});

test('toggle off: no PR call spawns gh, with the real runner', async () => {
  // A `gh` that leaves a mark if it ever runs; no exec stub, so this goes through ai.runCli.
  const dir = fakeGh();
  const mark = path.join(dir, 'ran');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\n/usr/bin/touch '${mark}'\necho '[]'\n`, { mode: 0o755 });
  const off = { enabled: false, remotes: [ORIGIN], number: 7, dirs: [dir] };
  assert.equal(await github.listPrs(off), null);
  for (const fn of ['mergeInfo', 'approvePr', 'mergePr', 'closePr', 'updatePrBranch']) await assert.rejects(github[fn](off), { code: 'gh-off' }, fn);
  assert.equal(fs.existsSync(mark), false, 'gh ran while pull requests were off');
  // The same gh does run once the toggle is on, so the mark would have shown up.
  await github.listPrs({ ...off, enabled: true });
  assert.equal(fs.existsSync(mark), true);
});

test('create PR: default branch, prefill from commits, parsed link', () => {
  assert.equal(github.parseDefaultBranch('{"defaultBranchRef":{"name":"main"}}'), 'main');
  assert.throws(() => github.parseDefaultBranch('{"defaultBranchRef":null}'), { code: 'gh-failed' });
  // `git log --format=%s%x00%b%x1e`, newest first.
  const log = 'Add tests\0\x1e\nAdd the sheet\0Longer body\nline two\n\x1e\n';
  const commits = github.parseCommits(log);
  assert.deepEqual(commits, [{ subject: 'Add tests', body: '' }, { subject: 'Add the sheet', body: 'Longer body\nline two' }]);
  assert.deepEqual(github.prDraft(commits.slice(1)), { title: 'Add the sheet', body: 'Longer body\nline two' });
  assert.deepEqual(github.prDraft(commits), { title: 'Add the sheet', body: '- Add the sheet\n- Add tests' });
  assert.deepEqual(github.prDraft([]), { title: '', body: '' });
  assert.deepEqual(github.parseCreated('Creating pull request…\nhttps://github.com/acme/app/pull/42\n'), { url: 'https://github.com/acme/app/pull/42', number: 42 });
  assert.throws(() => github.parseCreated('oops'), { code: 'gh-failed' });
  for (const ok of ['main', 'feat/x', 'fork-owner:feat/x']) assert.equal(github.branchArg(ok, 'head'), ok);
  for (const bad of ['--force', '-x', 'a..b', 'a b', 'x.lock', 'a/', '', 'bad owner:x', 'x@{1}']) assert.throws(() => github.branchArg(bad, 'head'), { code: 'gh-failed' }, bad);
});

test('create PR: gh pr create gets plain flags and the body on stdin', async () => {
  const calls = [];
  const exec = async (bin, args, input) => { calls.push({ args, input }); return 'https://github.com/acme/app/pull/9\n'; };
  const t = { enabled: true, remotes: [ORIGIN], dirs: [fakeGh()], exec };
  const res = await github.createPr({ ...t, base: 'main', head: 'feat/x', title: '  --title  trick ', body: '- one\n- two', draft: true });
  assert.deepEqual(res, { url: 'https://github.com/acme/app/pull/9', number: 9 });
  assert.deepEqual(calls[0].args, ['pr', 'create', '--repo', 'github.com/acme/app', '--base=main', '--head=feat/x', '--title=--title trick', '--body-file', '-', '--draft']);
  assert.equal(calls[0].input, '- one\n- two');
  await assert.rejects(github.createPr({ ...t, base: 'main', head: 'feat/x', title: ' ' }), { code: 'gh-failed' });
  await assert.rejects(github.createPr({ ...t, base: '--admin', head: 'feat/x', title: 'x' }), { code: 'gh-failed' });
  await assert.rejects(github.createPr({ ...t, enabled: false, base: 'main', head: 'feat/x', title: 'x' }), { code: 'gh-off' });
  assert.equal(calls.length, 1);
});

test('joinLanes: PRs attach by upstream branch, forks only to lanes tracking them, off means null', () => {
  const pr = (number, branch, headOwner, extra = {}) => ({ number, title: `PR ${number}`, branch, headOwner, draft: false, checks: 'success', review: 'approved', url: `https://github.com/acme/app/pull/${number}`, ...extra });
  const listed = { owners: { origin: 'acme', fork: 'bob' }, prs: [pr(1, 'feat', 'acme', { draft: true, checks: 'pending' }), pr(2, 'fix', 'bob'), pr(3, 'local-only', 'acme'), pr(4, 'main', 'acme')] };
  const lanes = [
    { name: 'feat', branch: 'feat', upstream: 'origin/feat' },
    { name: 'my-fix', branch: 'my-fix', upstream: 'fork/fix' },
    { name: 'fix', branch: 'fix', upstream: 'origin/fix' },
    { name: 'local-only', branch: 'local-only', upstream: null },
    { name: 'main', branch: 'main', upstream: 'origin/main', isBase: true },
    { name: 'det', branch: null, upstream: null },
  ];
  const out = github.joinLanes(lanes, listed);
  assert.deepEqual(out.map((l) => l.pr?.number ?? null), [1, 2, null, 3, null, null]);
  assert.deepEqual(out[0].pr, { number: 1, title: 'PR 1', state: 'open', draft: true, checks: 'pending', review: 'approved', url: 'https://github.com/acme/app/pull/1' });
  assert.equal(out[0].name, 'feat', 'lane fields kept');
  assert.ok(github.joinLanes(lanes, null).every((l) => l.pr === null));
});

test('normalizePr: GitHub’s mergeable state as true, false or null', () => {
  assert.equal(github.normalizePr(PR({ mergeable: 'MERGEABLE' })).mergeable, true);
  assert.equal(github.normalizePr(PR({ mergeable: 'CONFLICTING' })).mergeable, false);
  assert.equal(github.normalizePr(PR({ mergeable: 'UNKNOWN' })).mergeable, null);
  assert.ok(github.PR_FIELDS.includes('mergeable'));
});

test('normalizePr: GitHub’s merge state in lower case, null when missing or unknown to us (AK-321)', () => {
  for (const s of ['CLEAN', 'UNSTABLE', 'BEHIND', 'BLOCKED', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN']) assert.equal(github.normalizePr(PR({ mergeStateStatus: s })).mergeState, s.toLowerCase());
  assert.equal(github.normalizePr(PR({ mergeStateStatus: 'WEIRD' })).mergeState, null);
  assert.equal(github.normalizePr(PR({})).mergeState, null);
  assert.ok(github.PR_FIELDS.includes('mergeStateStatus'));
});

test('normalizePr: the PR description, empty when missing, capped at 20,000 characters (AK-357)', () => {
  assert.equal(github.normalizePr(PR({ body: 'Fixes the thing.\n\nDetails' })).body, 'Fixes the thing.\n\nDetails');
  assert.equal(github.normalizePr(PR({})).body, '');
  assert.equal(github.normalizePr(PR({ body: null })).body, '');
  assert.equal(github.normalizePr(PR({ body: 'x'.repeat(25000) })).body.length, 20000);
  assert.ok(github.PR_FIELDS.includes('body'));
});

test('inbox: nothing runs while off; review requests and the login, the login asked once per host', async () => {
  const off = recorder('[]');
  await assert.rejects(github.inbox({ enabled: false, remotes: [ORIGIN], dirs: [fakeGh()], exec: off.exec }), { code: 'gh-off' });
  assert.equal(off.calls.length, 0);
  const { calls, exec } = recorder((args) => (args[0] === 'api' ? 'kim\n' : JSON.stringify([{ number: 3 }, { number: 7 }, { number: -1 }])));
  const dirs = [fakeGh()];
  assert.deepEqual(await github.inbox({ enabled: true, remotes: [ORIGIN], dirs, exec }), { me: 'kim', requested: [3, 7] });
  assert.deepEqual(calls.map((c) => c.args), [
    ['api', 'user', '--hostname', 'github.com', '--jq', '.login'],
    ['pr', 'list', '--repo', 'github.com/acme/app', '--state', 'open', '--search', 'review-requested:@me', '--limit', '100', '--json', 'number'],
  ]);
  await github.inbox({ enabled: true, remotes: [ORIGIN], dirs, exec });
  assert.equal(calls.filter((c) => c.args[0] === 'api').length, 1);
  assert.throws(() => github.parseNumbers('{}'), { code: 'gh-failed' });
});

test('prPushPlan pushes new PR branches to the GitHub remote and keeps a mirror upstream', () => {
  const mirror = remote('origin', '/srv/mirror/app.git');
  const gh = remote('github', 'git@github.com:acme/app.git');
  const remotes = [mirror, gh];
  const target = github.pickRemote(remotes);
  // No upstream: push to GitHub and start tracking it.
  let p = github.prPushPlan({ branch: 'feat', upRemote: '', upRef: '', track: '', remotes, target });
  assert.deepEqual(p.pushArgs, ['push', '-u', '--', 'github', 'refs/heads/feat:refs/heads/feat']);
  assert.equal(p.head, 'feat');
  // Tracks the non-GitHub mirror: push to GitHub without re-pointing the upstream.
  p = github.prPushPlan({ branch: 'feat', upRemote: 'origin', upRef: 'refs/heads/feat', track: 'ahead 2', remotes, target });
  assert.deepEqual(p.pushArgs, ['push', '--', 'github', 'refs/heads/feat:refs/heads/feat']);
  // Tracks GitHub and is up to date: nothing to push.
  p = github.prPushPlan({ branch: 'feat', upRemote: 'github', upRef: 'refs/heads/feat', track: '', remotes, target });
  assert.equal(p.push, null);
  assert.equal(p.pushArgs, null);
});

test('parseMergeInfo: head commit and the still-checking state', () => {
  const oid = 'a'.repeat(40);
  assert.equal(github.parseMergeInfo(VIEW({ headRefOid: oid }), REPO()).headOid, oid);
  assert.equal(github.parseMergeInfo(VIEW({ headRefOid: 'nope' }), REPO()).headOid, null);
  assert.equal(github.parseMergeInfo(VIEW({ mergeable: 'UNKNOWN' }), REPO()).checking, true);
  assert.equal(github.parseMergeInfo(VIEW(), REPO()).checking, false);
});

test('mergedPrs: parses merged heads, drops bad SHAs; joinLanes takes the open PR title', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(github.parseMerged(JSON.stringify([{ number: 5, title: 'Ship it', headRefOid: sha, headRefName: 'x' }, { number: 6, headRefOid: '--evil' }])), [{ number: 5, title: 'Ship it', sha, branch: 'x', merge: null, mergedAt: null, body: undefined, author: '', authorName: '', bot: false }]);
  assert.deepEqual((({ author, authorName, bot }) => ({ author, authorName, bot }))(github.parseMerged(JSON.stringify([{ number: 8, headRefOid: sha, author: { login: 'ada', name: 'Ada Lovelace' } }]))[0]), { author: 'ada', authorName: 'Ada Lovelace', bot: false });
  assert.deepEqual((({ author, authorName, bot }) => ({ author, authorName, bot }))(github.parseMerged(JSON.stringify([{ number: 9, headRefOid: sha, author: { login: 'app/dependabot', is_bot: true } }]))[0]), { author: 'app/dependabot', authorName: github.botLogin('app/dependabot'), bot: true });
  assert.equal(github.parseMerged(JSON.stringify([{ number: 7, headRefOid: sha, body: 'Why it changed' }]))[0].body, 'Why it changed');
  assert.equal(github.parseMerged(JSON.stringify([{ number: 7, headRefOid: sha, body: 42 }]))[0].body, undefined);
  assert.throws(() => github.parseMerged('{}'), /list/);
  const out = github.joinLanes([{ name: 'f', branch: 'f', title: 'commit subject' }], { owners: {}, prs: [{ number: 1, title: 'PR title', branch: 'f' }] });
  assert.equal(out[0].title, 'PR title');
});

test('requestChangesPr: needs a message; gh arguments; off runs nothing', async () => {
  const { calls, exec } = recorder('');
  const t = { enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec };
  await assert.rejects(github.requestChangesPr({ ...t, body: '  ' }), { code: 'gh-failed' });
  await assert.rejects(github.requestChangesPr({ ...t, enabled: false, body: 'fix it' }), { code: 'gh-off' });
  assert.equal(calls.length, 0);
  await github.requestChangesPr({ ...t, body: ' --admin rename this ' });
  assert.deepEqual(calls[0].args, ['pr', 'review', '7', '--repo', 'github.com/acme/app', '--request-changes', '--body=--admin rename this']);
});

test('normalizePr: bot authors, names, drafts, mixed reviews and pending requests', () => {
  const bot = github.normalizePr(PR({ author: { login: 'app/dependabot', is_bot: true }, isDraft: true, updatedAt: '2026-10-14T08:00:00Z' }));
  assert.equal(bot.author, 'app/dependabot');
  assert.equal(bot.authorName, 'dependabot');
  assert.equal(bot.bot, true);
  assert.equal(bot.draft, true);
  assert.equal(bot.updatedAt, '2026-10-14T08:00:00Z');
  const named = github.normalizePr(PR({ author: { login: 'kim', name: 'Kim Lee', is_bot: false } }));
  assert.deepEqual([named.author, named.authorName, named.bot], ['kim', 'Kim Lee', false]);
  const p = github.normalizePr(PR({
    reviewDecision: 'CHANGES_REQUESTED',
    latestReviews: [
      { author: { login: 'ana', name: 'Ana' }, state: 'APPROVED', submittedAt: '2026-10-12T00:00:00Z', body: 'secret' },
      { author: { login: 'bo' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-11T00:00:00Z' },
      { author: { login: 'copilot[bot]' }, state: 'COMMENTED' },
      { author: { login: 'dee' }, state: 'DISMISSED' },
      { author: { login: 'eve' }, state: 'PENDING' },
    ],
    reviewRequests: [{ __typename: 'User', login: 'fay' }, { __typename: 'Team', name: 'Core', slug: 'core' }, { __typename: 'User', login: 'fay' }, {}],
  }));
  assert.equal(p.review, 'changes');
  assert.deepEqual(p.reviews, [
    { login: 'ana', name: 'Ana', state: 'approved', submittedAt: '2026-10-12T00:00:00Z' },
    { login: 'bo', name: 'bo', state: 'changes', submittedAt: '2026-10-11T00:00:00Z' },
    { login: 'copilot[bot]', name: 'copilot', state: 'commented', submittedAt: '' },
    { login: 'dee', name: 'dee', state: 'dismissed', submittedAt: '' },
  ]);
  assert.deepEqual(p.reviewRequests, [{ login: 'fay', name: 'fay', team: false }, { login: 'core', name: 'Core', team: true }]);
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.ok(github.PR_FIELDS.includes('reviewRequests'));
});

test('AK-461: the PR remote can be chosen per repository, and non-GitHub hosts never are', () => {
  const fork = remote('fork', 'https://github.com/kim/app');
  const lab = remote('origin', 'https://gitlab.com/acme/app');
  // Default: origin on GitHub, else the first GitHub remote; GitLab and friends are skipped.
  assert.equal(github.pickRemote([fork, ORIGIN]).name, 'origin');
  assert.equal(github.pickRemote([lab, fork]).name, 'fork');
  assert.equal(github.pickRemote([lab]), null);
  assert.deepEqual(github.prCandidates([lab, fork, ORIGIN]).map((r) => r.name), ['fork', 'origin']);
  // The chosen remote (main.js marks it `pr: true`) wins, unless it isn't a GitHub remote.
  assert.equal(github.pickRemote([ORIGIN, { ...fork, pr: true }]).name, 'fork');
  assert.equal(github.pickRemote([{ ...lab, pr: true }, fork]).name, 'fork');
  // Saved per repository; null goes back to the default and drops the key.
  let s = github.setChosenRemote({ on: true, hidden: [] }, '/a', 'fork');
  assert.equal(github.chosenRemote(s, '/a'), 'fork');
  assert.equal(github.chosenRemote(s, '/b'), null);
  assert.ok(github.isEnabled(s, '/a'), 'other settings survive');
  s = github.setChosenRemote(s, '/a', null);
  assert.deepEqual(s, { on: true, hidden: [] });
  assert.deepEqual(github.normalize({ on: true, remotes: { '/a': 'fork', '/b': 3, '/c': '' } }).remotes, { '/a': 'fork' });
});

test('AK-198: a branch tracking a non-GitHub origin pushes its new PR to the GitHub remote', () => {
  const lab = remote('origin', 'https://gitlab.com/acme/app');
  const gh = remote('github', 'https://github.com/acme/app');
  const remotes = [lab, gh];
  const target = github.pickRemote(remotes);
  assert.equal(target.name, 'github');
  const p = github.prPushPlan({ branch: 'feat', upRemote: 'origin', upRef: 'refs/heads/feat', track: '', remotes, target });
  assert.deepEqual(p.pushArgs, ['push', '--', 'github', 'refs/heads/feat:refs/heads/feat']);
  assert.equal(p.head, 'feat');
});

// AK-519: PR evidence for the reader, from recorded `gh` output (test/fixtures/evidence).
const FIX = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'evidence', f), 'utf8');
const evidenceGh = (over = {}) => recorder((args) => {
  if (args[0] === 'pr') return over.pr ?? FIX('pr-view.json');
  if (args[0] === 'run') return FIX('log-failed.txt');
  if (args.includes('graphql')) return over.threads ?? FIX('threads.json');
  if (args.some((a) => a.includes('/annotations'))) return FIX('annotations.json');
  throw new Error(`unexpected gh ${args.join(' ')}`);
});

test('evidence: checks, failed log lines, annotations, media, approvals and open threads', async () => {
  const dir = fakeGh();
  const { calls, exec } = evidenceGh();
  const ev = await github.evidence({ enabled: true, remotes: [ORIGIN], number: 12, dirs: [dir], exec });
  assert.deepEqual(calls.map((c) => c.args), [
    ['pr', 'view', '12', '--repo', 'github.com/acme/app', '--json', github.EVIDENCE_FIELDS],
    ['run', 'view', '55', '--repo', 'github.com/acme/app', '--log-failed'],
    ['api', '--hostname', 'github.com', 'repos/acme/app/check-runs/901/annotations?per_page=50'],
    ['api', '--hostname', 'github.com', 'graphql', '-f', calls[3].args[5], '-f', 'owner=acme', '-f', 'name=app', '-F', 'number=12'],
  ]);
  assert.match(calls[3].args[5], /reviewThreads\(first:100\)\{totalCount nodes\{isResolved isOutdated path line originalLine comments\(first:1\)\{nodes\{author\{login\} body url\}\}\}\}/);
  assert.equal(ev.head, '1111111111111111111111111111111111111111');
  assert.deepEqual(ev.checks, [
    { name: 'test', result: 'failure', duration: 200, url: 'https://github.com/acme/app/actions/runs/55/job/901' },
    { name: 'lint', result: 'success', duration: 60, url: 'https://github.com/acme/app/actions/runs/55/job/902' },
    { name: 'e2e', result: 'pending', url: 'https://github.com/acme/app/actions/runs/56/job/903' },
    { name: 'ci/external', result: 'success', url: 'https://ci.example.com/build/1' },
  ]);
  assert.deepEqual(ev.logs, [{ run: '55', log: 'not ok 1 - lanes\nAssertionError: expected 3 to equal 2' }]);
  assert.deepEqual(ev.annotations, [
    { check: 'test', path: 'apps/desktop/github.js', line: 42, level: 'failure', message: 'AssertionError: expected 3 to equal 2' },
    { check: 'test', path: '.github', line: 1, level: 'warning', message: 'Node.js 16 actions are deprecated.' },
  ]);
  assert.deepEqual(ev.media, [
    { url: 'https://github.com/user-attachments/assets/0b6c1a7e-1111-4c1e-9d8f-aaaaaaaaaaaa', kind: 'image', alt: 'lanes in dark', from: 'description', author: 'kim' },
    { url: 'https://github.com/user-attachments/assets/0b6c1a7e-2222-4c1e-9d8f-bbbbbbbbbbbb', kind: 'image', alt: 'light theme', from: 'description', author: 'kim' },
    { url: 'https://github.com/user-attachments/assets/0b6c1a7e-3333-4c1e-9d8f-cccccccccccc', kind: 'video', from: 'description', author: 'kim' },
    { url: 'https://user-images.githubusercontent.com/1/before.mov', kind: 'video', from: 'comment', author: 'sam' },
    { url: 'https://user-images.githubusercontent.com/2/spacing.png', kind: 'image', alt: 'spacing', from: 'review', author: 'lee' },
  ]);
  assert.deepEqual(ev.reviews, [{ login: 'sam', state: 'approved' }]);
  // Open threads only, each with its line (the original one once outdated), author, first line and link.
  assert.deepEqual(ev.threads, { total: 3, open: 2, outdated: 1, items: [
    { path: 'apps/desktop/github.js', line: 42, author: 'sam', text: 'Should this count skipped checks too?', url: 'https://github.com/acme/app/pull/12#discussion_r101', outdated: false },
    { path: 'apps/desktop/renderer/reader.js', line: 7, text: 'Typo', outdated: true },
  ] });
  assert.equal('ciMissing' in ev, false);
  // No PR comment or review text reaches the evidence (only a review thread's first line does).
  assert.doesNotMatch(JSON.stringify(ev), /Thanks, fixed|Spacing looks off|Adds the lanes view/);

  // Cached per head: the same head runs nothing; another head fetches again.
  calls.length = 0;
  assert.equal(await github.evidence({ enabled: true, remotes: [ORIGIN], number: 12, head: ev.head, dirs: [dir], exec }), ev);
  assert.equal(calls.length, 0);
  await github.evidence({ enabled: true, remotes: [ORIGIN], number: 12, head: '2'.repeat(40), dirs: [dir], exec });
  assert.equal(calls[0].args[0], 'pr');
});

test('evidence: only what is there; "CI didn’t run" only when the head has CI set up', async () => {
  const dir = fakeGh();
  const bare = JSON.stringify({ headRefOid: '3'.repeat(40), statusCheckRollup: [], latestReviews: [], body: 'No pictures. https://example.com/a.png', comments: [], reviews: [] });
  const noThreads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } });
  const { calls, exec } = evidenceGh({ pr: bare, threads: noThreads });
  const asked = [];
  const ev = await github.evidence({ enabled: true, remotes: [ORIGIN], number: 13, dirs: [dir], exec, ciConfigured: async (h) => { asked.push(h); return false; } });
  assert.deepEqual(ev, { head: '3'.repeat(40) });
  assert.deepEqual(asked, ['3'.repeat(40)]);
  assert.deepEqual(calls.map((c) => c.args[0]), ['pr', 'api']);
  const withCi = await github.evidence({ enabled: true, remotes: [ORIGIN], number: 14, dirs: [dir], exec, ciConfigured: async () => true });
  assert.deepEqual(withCi, { head: '3'.repeat(40), ciMissing: true });
  // A failing optional call leaves its field out instead of failing the evidence.
  const flaky = recorder((args) => { if (args[0] === 'pr') return FIX('pr-view.json'); throw new Error('HTTP 502'); });
  const partial = await github.evidence({ enabled: true, remotes: [ORIGIN], number: 15, dirs: [dir], exec: flaky.exec });
  assert.deepEqual(Object.keys(partial), ['head', 'checks', 'media', 'reviews']);
});

test('evidence: with pull requests off, nothing runs and no token is read', async () => {
  const dir = fakeGh();
  const { calls, exec } = evidenceGh();
  await assert.rejects(github.evidence({ enabled: false, remotes: [ORIGIN], number: 12, dirs: [dir], exec }), { code: 'gh-off' });
  await assert.rejects(github.evidence({ enabled: true, remotes: [ORIGIN], number: 0, dirs: [dir], exec }), { code: 'gh-failed' });
  assert.equal(await github.authToken({ host: 'github.com --x', dirs: [dir], exec }), '');
  assert.equal(calls.length, 0);
  const tok = recorder('gho_abc\n');
  assert.equal(await github.authToken({ host: 'github.com', dirs: [dir], exec: tok.exec }), 'gho_abc');
  assert.deepEqual(tok.calls[0].args, ['auth', 'token', '--hostname', 'github.com']);
});

test('findMedia: markdown, img, video/source and bare attachment links; https only, deduplicated, capped', () => {
  const body = [
    '![a](https://github.com/x.png "title") ![b](<https://github.com/y.gif>)',
    '<img src=\'https://github.com/x.png\'> <img data-src="https://github.com/no.png">',
    '<video><source src="https://github.com/v.webm" type="video/webm"></video>',
    'https://private-user-images.githubusercontent.com/9/shot.jpg?jwt=a&amp;b=1',
    '![c](http://github.com/plain.png) ![d](javascript:alert(1))',
  ].join('\n');
  assert.deepEqual(github.findMedia([{ from: 'description', body }]).map((m) => [m.url, m.kind, m.alt]), [
    ['https://github.com/x.png', 'image', 'a'],
    ['https://github.com/y.gif', 'image', 'b'],
    ['https://github.com/v.webm', 'video', undefined],
    ['https://private-user-images.githubusercontent.com/9/shot.jpg?jwt=a&b=1', 'image', undefined],
  ]);
  const many = Array.from({ length: 80 }, (_, i) => `![${i}](https://github.com/${i}.png)`).join(' ');
  assert.equal(github.findMedia([{ from: 'comment', body: many }]).length, 50);
});

test('planFacts: required checks, review rule and who may approve, from one GraphQL call (AK-550)', async () => {
  const ctx = [
    { __typename: 'CheckRun', name: 'changes', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/9/job/1', startedAt: '2026-10-18T10:41:43Z', completedAt: '2026-10-18T10:41:45Z', isRequired: false },
    { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://ci.example.com/1', isRequired: true },
    { __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS', targetUrl: null, isRequired: true },
    {},
  ];
  const reply = (o = {}) => JSON.stringify({ data: { viewer: { login: 'me' }, repository: { viewerPermission: 'WRITE', pullRequest: { number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', headRefName: 'feat', headRefOid: 'a'.repeat(40), author: { login: 'ana' }, reviewRequests: { nodes: [{ requestedReviewer: { login: 'bo' } }, { requestedReviewer: { name: 'core' } }] }, latestReviews: { nodes: [] }, baseRef: { refUpdateRule: { requiredApprovingReviewCount: 2 }, branchProtectionRule: null }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: ctx } } } }] }, ...o } } } });
  const { calls, exec } = recorder(reply());
  const f = await github.planFacts({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec });
  assert.deepEqual(calls[0].args.slice(0, 4), ['api', '--hostname', 'github.com', 'graphql']);
  assert.deepEqual(calls[0].args.slice(-6), ['-f', 'owner=acme', '-f', 'name=app', '-F', 'number=7']);
  assert.equal(calls[0].args.length, 12);
  assert.deepEqual([f.state, f.mergeState, f.review, f.checks, f.approvals, f.author, f.canApprove], ['open', 'blocked', 'required', 'failure', 2, 'ana', true]);
  assert.deepEqual(f.requested, ['bo', 'core']);
  assert.deepEqual(f.checkList.map((c) => [c.name, c.result, c.required, c.duration, c.run]), [['changes', 'failure', false, 2, '9'], ['test', 'pending', true, undefined, undefined], ['ci/lint', 'success', true, undefined, undefined]]);
  // Your own PR, or one you already approved: no Approve.
  assert.equal(github.parsePlanFacts(reply({ author: { login: 'me' } })).canApprove, false);
  assert.equal(github.parsePlanFacts(reply({ latestReviews: { nodes: [{ author: { login: 'me' }, state: 'APPROVED' }] } })).canApprove, false);
  assert.throws(() => github.parsePlanFacts('{"data":{"repository":{"pullRequest":null}}}'), { code: 'gh-failed' });
});

test('markReady, markDraft and rerunFailed: gh arguments, Actions runs only (AK-550, AK-610)', async () => {
  const { calls, exec } = recorder('');
  await github.markReady({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec });
  assert.deepEqual(calls[0].args, ['pr', 'ready', '7', '--repo', 'github.com/acme/app']);
  // Back to draft (AK-610): the same command with --undo.
  assert.deepEqual(await github.markDraft({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec }), { number: 7, draft: true });
  assert.deepEqual(calls[1].args, ['pr', 'ready', '7', '--repo', 'github.com/acme/app', '--undo']);
  assert.deepEqual(github.readyArgs(3, 'github.com/acme/app'), ['pr', 'ready', '3', '--repo', 'github.com/acme/app']);
  for (const bad of [0, -1, 1.5, '7; rm', null]) assert.throws(() => github.readyArgs(bad, 'github.com/acme/app', { draft: true }), { code: 'gh-failed' }, String(bad));
  const rollup = JSON.stringify({ statusCheckRollup: [{ conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/9/job/1' }, { state: 'FAILURE', targetUrl: 'https://ci.example.com/2' }, { conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/8/job/2' }] });
  const r = recorder((args) => (args[0] === 'pr' ? rollup : ''));
  const res = await github.rerunFailed({ enabled: true, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec: r.exec });
  assert.deepEqual(res, { number: 7, runs: ['9'] });
  assert.deepEqual(r.calls[1].args, ['run', 'rerun', '9', '--repo', 'github.com/acme/app', '--failed']);
  for (const fn of ['planFacts', 'markReady', 'markDraft', 'rerunFailed']) await assert.rejects(github[fn]({ enabled: false, remotes: [ORIGIN], number: 7, dirs: [fakeGh()], exec }), { code: 'gh-off' }, fn);
});

test('joinLanes: a lane’s PR keeps its author, so Approve is greyed on your own (AK-577)', async () => {
  const { approveWhy } = await import('../renderer/prs.js');
  const [lane] = github.joinLanes([{ name: 'f', branch: 'f' }], { owners: {}, prs: [{ number: 4, title: 'Mine', branch: 'f', author: '0xa3k5' }] });
  assert.equal(lane.pr.author, '0xa3k5');
  assert.equal(approveWhy(lane.pr, { login: '0xA3K5', write: true }), 'Your own pull request');
  assert.equal(approveWhy(lane.pr, { login: 'someone', write: true }), null);
});

test('mergeStates: asks again in batches of 20, skips a failed batch, numbers checked (AK-625)', async () => {
  await assert.rejects(github.mergeStates({ enabled: false, remotes: [ORIGIN], numbers: [1], dirs: [fakeGh()] }), { code: 'gh-off' });
  const ns = Array.from({ length: 45 }, (_, i) => i + 1);
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args);
    if (calls.length === 2) throw new Error('HTTP 502');
    const asked = [...args[5].matchAll(/p(\d+):pullRequest\(number:(\d+)\)/g)].map((m) => Number(m[2]));
    return JSON.stringify({ data: { repository: Object.fromEntries(asked.map((n) => [`p${n}`, { number: n, mergeable: n === 1 ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: n === 2 ? 'UNKNOWN' : 'UNSTABLE' }])) } });
  };
  const dirs = [fakeGh()];
  const out = await github.mergeStates({ enabled: true, remotes: [ORIGIN], numbers: [...ns, 1], dirs, exec });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, 4), ['api', '--hostname', 'github.com', 'graphql']);
  assert.match(calls[0][5], /\{p1:pullRequest\(number:1\)\{number mergeable mergeStateStatus\} p2:/);
  assert.equal(calls[0][5].match(/pullRequest/g).length, 20);
  assert.equal(calls[2][5].match(/pullRequest/g).length, 5);
  assert.deepEqual(out.map((x) => x.number), [...ns.slice(0, 20), ...ns.slice(40)]); // 21–40 failed: skipped
  assert.deepEqual(out[0], { number: 1, mergeable: false, mergeState: 'unstable' });
  assert.deepEqual(out[1], { number: 2, mergeable: true, mergeState: 'unknown' });
  await assert.rejects(github.mergeStates({ enabled: true, remotes: [ORIGIN], numbers: ['1){x}'], dirs, exec }));
});

test('mergedStacks: one GraphQL call for the merged PRs in range, numbers checked (AK-616)', async () => {
  await assert.rejects(github.mergedStacks({ enabled: false, remotes: [ORIGIN], numbers: [1], dirs: [fakeGh()] }), { code: 'gh-off' });
  const { calls, exec } = recorder(JSON.stringify({ data: { repository: { p3: { number: 3, additions: 1, deletions: 0, changedFiles: 1, stack: { number: 2, size: 2, entries: { nodes: [{ position: 2, pullRequest: { number: 4 } }, { position: 1, pullRequest: { number: 3 } }] } } } } } }));
  const dirs = [fakeGh()];
  const facts = await github.mergedStacks({ enabled: true, remotes: [ORIGIN], numbers: [3, 3], dirs, exec });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), ['api', '--hostname', 'github.com', 'graphql']);
  assert.match(calls[0].args[5], /\{p3:pullRequest\(number:3\)\{number additions deletions changedFiles stack\{number size entries/);
  assert.doesNotMatch(calls[0].args[5], /p3.*p3/);
  assert.deepEqual(facts.get(3).stack, { number: 2, size: 2, parts: [3, 4] });
  assert.deepEqual(await github.mergedStacks({ enabled: true, remotes: [ORIGIN], numbers: [], dirs, exec }), new Map());
  assert.equal(calls.length, 1);
  await assert.rejects(github.mergedStacks({ enabled: true, remotes: [ORIGIN], numbers: ['1){x}'], dirs, exec }));
  // gh failing rejects; app:catchup then lists the merged PRs ungrouped (joinStacks with null).
  await assert.rejects(github.mergedStacks({ enabled: true, remotes: [ORIGIN], numbers: [3], dirs, exec: async () => { throw new Error('HTTP 502'); } }));
});
