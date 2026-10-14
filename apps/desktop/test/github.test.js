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

test('parsePrs: normalizes gh JSON, drops bad entries, newest first, capped', () => {
  const out = JSON.stringify([
    PR({ number: 1, updatedAt: '2026-10-01T00:00:00Z', isDraft: true, reviewDecision: '', statusCheckRollup: [{ status: 'QUEUED' }] }),
    PR({ number: 2, reviewDecision: 'CHANGES_REQUESTED', url: 'javascript:alert(1)' }),
    { number: -3, title: 'bad' }, { number: '4' }, null,
  ]);
  const prs = github.parsePrs(out);
  assert.deepEqual(prs.map((p) => p.number), [2, 1]);
  assert.deepEqual(prs[1], { number: 1, title: 'Add lanes', branch: 'lanes', headOwner: 'acme', base: 'main', draft: true, review: null, checks: 'pending', author: 'kim', url: 'https://github.com/acme/app/pull/12', updatedAt: '2026-10-01T00:00:00Z' });
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

test('listPrs: asks gh for this repository’s open PRs, without prompts', async () => {
  const dir = fakeGh();
  const { calls, exec } = recorder(JSON.stringify([PR()]));
  const res = await github.listPrs({ enabled: true, remotes: [remote('fork', 'https://github.com/kim/app'), ORIGIN], dirs: [dir], exec });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, path.join(dir, 'gh'));
  assert.deepEqual(calls[0].args, ['pr', 'list', '--repo', 'github.com/acme/app', '--state', 'open', '--limit', '100', '--json', github.PR_FIELDS.join(',')]);
  assert.equal(calls[0].opts.env.GH_PROMPT_DISABLED, '1');
  assert.equal(res.remote.name, 'origin');
  assert.deepEqual(res.owners, { fork: 'kim', origin: 'acme' });
  assert.equal(res.prs[0].number, 12);
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
});

test('settings: per-repository toggle', () => {
  assert.deepEqual(github.normalize(undefined), { repos: [] });
  assert.deepEqual(github.normalize({ repos: ['/a', 3] }), { repos: ['/a'] });
  let s = github.setEnabled(undefined, '/a', true);
  s = github.setEnabled(s, '/b', true);
  s = github.setEnabled(s, '/a', true);
  assert.deepEqual(s.repos, ['/b', '/a']);
  assert.ok(github.isEnabled(s, '/a'));
  assert.ok(!github.isEnabled(github.setEnabled(s, '/a', false), '/a'));
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
  assert.deepEqual(gate(), { hard: null, soft: [], needsAdmin: false, canOverride: true });
  assert.match(gate({ isDraft: true }).hard, /draft/);
  assert.match(gate({ state: 'MERGED' }).hard, /merged/);
  assert.match(gate({ mergeStateStatus: 'DIRTY' }).hard, /conflicts/);
  // Failing checks GitHub doesn't require: anyone can tick "merge anyway".
  const unstable = gate({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ state: 'FAILURE' }] });
  assert.deepEqual(unstable.soft, ['Checks are failing.']);
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
  assert.deepEqual(await run('approvePr'), ['pr', 'review', '7', '--repo', 'github.com/acme/app', '--approve']);
  assert.deepEqual(await run('approvePr', { body: ' --admin looks good ' }), ['pr', 'review', '7', '--repo', 'github.com/acme/app', '--approve', '--body=--admin looks good']);
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
