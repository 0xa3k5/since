'use strict';
// Chains vs GitHub stacks (AK-555): finding chains among open PRs (straight, branching, across a
// fork), why one can't be linked, the all-or-nothing check before `gh stack link`, and the gh calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const github = require('../github');
const { findChains, findStacks, chainWhy, isNative, linkBlocker } = require('../renderer/merge-plan.js');

const pr = (number, branch, baseBranch, fork = false) => ({ number, branch, baseBranch, head: String(number).repeat(40).slice(0, 40), fork });

test('findChains: a straight chain, a branching one and one across a fork', () => {
  const straight = findChains([pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b'), pr(9, 'z', 'dev')], 'main');
  assert.deepEqual(straight.map((c) => ({ prs: c.prs, fork: c.fork, branch: c.branch })), [{ prs: [1, 2, 3], fork: false, branch: undefined }]);
  assert.equal(chainWhy(straight[0]), null);

  const branching = findChains([pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b'), pr(4, 'd', 'b')], 'main');
  assert.deepEqual(branching[0].prs, [1, 2]);
  assert.deepEqual(branching[0].branch, { number: 2, kids: [3, 4] });
  assert.match(chainWhy(branching[0]), /#3 and #4 both build on #2/);
  assert.deepEqual(findStacks([pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b'), pr(4, 'd', 'b')], 'main'), []);

  // A fork's branch isn't a branch here: nothing stacks on it, and the chain it ends can't link.
  const fork = findChains([pr(1, 'a', 'main'), pr(2, 'b', 'a', true), pr(3, 'c', 'b')], 'main');
  assert.deepEqual(fork[0].prs, [1, 2]);
  assert.equal(fork[0].forkPr, 2);
  assert.match(chainWhy(fork[0]), /#2 comes from a fork/);
  assert.deepEqual(findStacks([pr(1, 'a', 'main'), pr(2, 'b', 'a', true)], 'main'), []);

  assert.match(chainWhy(straight[0], { host: 'git.acme.dev' }), /Enterprise Server/);
  assert.match(chainWhy(straight[0], { enabled: false }), /Pull requests are off/);
});

test('isNative: every PR in the same GitHub stack', () => {
  const chain = { prs: [1, 2] };
  assert.equal(isNative(chain, new Map([[1, { stack: { number: 7 } }], [2, { stack: { number: 7 } }]])), true);
  assert.equal(isNative(chain, new Map([[1, { stack: { number: 7 } }], [2, { stack: null }]])), false);
  assert.equal(isNative(chain, new Map([[1, { stack: { number: 7 } }], [2, { stack: { number: 8 } }]])), false);
  assert.equal(isNative(chain, new Map()), false);
});

test('linkBlocker: open, writable and on the right base, or nothing links', () => {
  const ok = (baseBranch, branch, extra = {}) => ({ state: 'open', baseBranch, branch, fork: false, canPush: true, canUpdate: true, stack: null, ...extra });
  const facts = (two) => new Map([[1, ok('main', 'a')], [2, two]]);
  assert.equal(linkBlocker([1, 2], facts(ok('a', 'b')), 'main'), null);
  assert.deepEqual(linkBlocker([1, 2], facts(ok('a', 'b', { canPush: false })), 'main'), { number: 2, reason: 'No write access to this branch.' });
  assert.deepEqual(linkBlocker([1, 2], facts(ok('a', 'b', { state: 'closed' })), 'main'), { number: 2, reason: 'It’s closed.' });
  assert.deepEqual(linkBlocker([1, 2], facts(ok('main', 'b')), 'main'), { number: 2, reason: 'It targets main, not a.' });
  assert.deepEqual(linkBlocker([1, 2], new Map([[1, ok('main', 'a')]]), 'main'), { number: 2, reason: 'GitHub didn’t return this pull request.' });
});

test('linkStack and the extension: gh calls, all or nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-gh-test-'));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  const web = (u) => ({ name: 'origin', url: u, web: git.remoteWebUrl(u) });
  const calls = [];
  let replies = [];
  const exec = async (bin, args, _in, opts) => { calls.push({ args, env: opts.env }); const r = replies.shift(); if (r instanceof Error) throw r; return r ?? ''; };
  const t = { enabled: true, remotes: [web('git@github.com:acme/app.git')], dirs: [dir], exec };
  const node = (n, base, head, extra = {}) => ({ number: n, state: 'OPEN', baseRefName: base, headRefName: head, isCrossRepository: false, viewerCanUpdate: true, headRepository: { viewerPermission: 'WRITE' }, stack: null, ...extra });
  const facts = (...nodes) => JSON.stringify({ data: { repository: Object.fromEntries(nodes.map((p) => [`p${p.number}`, p])) } });

  assert.deepEqual(github.linkArgs({ host: 'github.com', owner: 'acme', repo: 'app' }, 'main', [4, 5]), ['stack', 'link', '--base=main', 'https://github.com/acme/app/pull/4', 'https://github.com/acme/app/pull/5']);
  assert.throws(() => github.linkArgs({ host: 'github.com', owner: 'acme', repo: 'app' }, '--force', [4, 5]), /Invalid base branch/);

  // One PR fails the check: nothing links, `gh stack link` never runs.
  replies = [facts(node(4, 'main', 'a'), node(5, 'a', 'b', { headRepository: { viewerPermission: 'READ' } }))];
  assert.deepEqual(await github.linkStack({ ...t, base: 'main', numbers: [4, 5] }), { failed: { number: 5, reason: 'No write access to this branch.' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'api');
  assert.match(calls[0].args.find((a) => a.startsWith('query=')), /p4:pullRequest\(number:4\).*p5:pullRequest\(number:5\)/);

  // All pass: linked bottom to top, GH_REPO names the repo.
  calls.length = 0;
  replies = [facts(node(4, 'main', 'a'), node(5, 'a', 'b')), '', facts(node(4, 'main', 'a', { stack: { number: 3, size: 2 } }), node(5, 'a', 'b', { stack: { number: 3, size: 2 } }))];
  assert.deepEqual(await github.linkStack({ ...t, base: 'main', numbers: [4, 5] }), { linked: true, stack: 3 });
  assert.deepEqual(calls[1].args, ['stack', 'link', '--base=main', 'https://github.com/acme/app/pull/4', 'https://github.com/acme/app/pull/5']);
  assert.equal(calls[1].env.GH_REPO, 'github.com/acme/app');

  // `gh stack link` fails part-way: the first PR not in the stack is reported.
  replies = [facts(node(4, 'main', 'a'), node(5, 'a', 'b')), new Error('Linking…\n✗ failed to add #5'), facts(node(4, 'main', 'a', { stack: { number: 3 } }), node(5, 'a', 'b'))];
  assert.deepEqual(await github.linkStack({ ...t, base: 'main', numbers: [4, 5] }), { failed: { number: 5, reason: '✗ failed to add #5' } });
  replies = [facts(node(4, 'main', 'a'), node(5, 'a', 'b')), new Error('unknown command "stack" for "gh"')];
  await assert.rejects(github.linkStack({ ...t, base: 'main', numbers: [4, 5] }), (e) => e.code === 'gh-no-stack');

  // GitHub Enterprise Server: refused before any call.
  calls.length = 0;
  assert.match((await github.linkStack({ ...t, remotes: [web('git@git.acme.dev:acme/app.git')], base: 'main', numbers: [4, 5] })).failed.reason, /Enterprise Server/);
  assert.equal(calls.length, 0);
  await assert.rejects(github.linkStack({ ...t, enabled: false, base: 'main', numbers: [4, 5] }), (e) => e.code === 'gh-off');

  replies = ['gh copilot\tgithub/gh-copilot\tv1\ngh stack\tgithub/gh-stack\tv0.2.1\n'];
  assert.deepEqual(await github.stackExtension(t), { installed: true });
  replies = ['gh copilot\tgithub/gh-copilot\tv1\n'];
  assert.deepEqual(await github.stackExtension(t), { installed: false });
  calls.length = 0;
  assert.deepEqual(await github.installStackExtension(t), { installed: true });
  assert.deepEqual(calls[0].args, ['extension', 'install', 'github/gh-stack']);
  await assert.rejects(github.installStackExtension({ ...t, enabled: false }), (e) => e.code === 'gh-off');

  calls.length = 0;
  await github.retargetPr({ ...t, number: 5, base: 'main' });
  assert.deepEqual(calls[0].args, ['pr', 'edit', '5', '--repo', 'github.com/acme/app', '--base=main']);
});
