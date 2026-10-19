'use strict';
// GitHub setup and merge gates (AK-588): the fix offered when GitHub or gh refuses a PR action
// (renderer/gh-gates.js), and the login script Terminal runs (github.loginScript).
const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../github');

const load = () => import('../renderer/gh-gates.js');
const info = (o) => ({ state: 'open', ...o, gate: github.mergeGate({ state: 'open', ...o }) });

test('mergeGateFix: a draft is marked ready, then merged', async () => {
  const { mergeGateFix } = await load();
  const fix = mergeGateFix(info({ draft: true }));
  assert.equal(fix.reason, 'It’s a draft.');
  assert.deepEqual(fix.actions, [{ id: 'ready', label: 'Mark ready and merge' }]);
});

test('mergeGateFix: a conflicting PR is rebased, checked out first when it isn’t local', async () => {
  const { mergeGateFix } = await load();
  assert.deepEqual(mergeGateFix(info({ conflicts: true })).actions, [{ id: 'rebase', label: 'Check out and rebase' }]);
  assert.deepEqual(mergeGateFix(info({ conflicts: true }), { local: true }).actions, [{ id: 'rebase', label: 'Rebase' }]);
});

test('mergeGateFix: nothing to fix for a closed PR or an open gate', async () => {
  const { mergeGateFix } = await load();
  assert.equal(mergeGateFix(info({ state: 'closed', draft: true })), null);
  assert.equal(mergeGateFix(info({})), null);
  assert.equal(mergeGateFix(null), null);
});

test('methodFix: names the methods that are on and offers each', async () => {
  const { methodFix } = await load();
  assert.equal(methodFix(['squash', 'merge'], 'squash'), null);
  const one = methodFix(['merge'], 'squash');
  assert.equal(one.reason, 'Squash merging is off in this repo’s settings; merge commits is on.');
  assert.deepEqual(one.actions, [{ id: 'merge', label: 'Merge with a merge commit' }]);
  const two = methodFix(['merge', 'rebase'], 'squash');
  assert.match(two.reason, /merge commits and rebase merging are on\.$/);
  assert.deepEqual(two.actions.map((a) => a.id), ['merge', 'rebase']);
});

test('ghErrorFix: logged out opens Terminal, no remote adds one, no gh-stack installs it', async () => {
  const { ghErrorFix } = await load();
  assert.deepEqual(ghErrorFix({ code: 'gh-auth' }), { id: 'login', label: 'Open Terminal' });
  assert.deepEqual(ghErrorFix({ code: 'gh-no-remote' }), { id: 'addRemote', label: 'Add remote…' });
  assert.deepEqual(ghErrorFix({ code: 'no-remote' }), { id: 'addRemote', label: 'Add remote…' });
  assert.deepEqual(ghErrorFix({ code: 'gh-no-stack' }), { id: 'installStack', label: 'Install' });
  assert.equal(ghErrorFix({ code: 'gh-failed' }), null);
  assert.equal(ghErrorFix(undefined), null);
});

test('loginScript: gh auth login for the host, then a shell; odd hosts are refused', () => {
  assert.equal(github.loginScript(), '#!/bin/sh\ngh auth login\nexec "${SHELL:-/bin/zsh}" -l\n');
  assert.match(github.loginScript('ghe.example.com:8443'), /^gh auth login --hostname ghe\.example\.com:8443$/m);
  for (const bad of ['a b', 'x;rm -rf ~', '$(id)', '-oops', '', 'host\nnext', 42]) assert.throws(() => github.loginScript(bad), /Invalid GitHub host/);
});

test('mergeGateFix: a draft PR with a local branch, merged from Review, gets the draft sheet', async () => {
  const { mergeGateFix } = await load();
  const fix = mergeGateFix(info({ draft: true, conflicts: true }), { local: true });
  assert.equal(fix.reason, 'It’s a draft.');
  assert.deepEqual(fix.actions, [{ id: 'ready', label: 'Mark ready and merge' }]);
});

test('mergeViaNote: GitHub warns it can’t be undone, here says the PR stays open', async () => {
  const { mergeViaNote } = await load();
  assert.deepEqual(mergeViaNote('github', 1), { text: 'Can’t be undone on GitHub.', warn: true });
  assert.deepEqual(mergeViaNote('here', 1), { text: '#1 stays open on GitHub.' });
});
