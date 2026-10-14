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
