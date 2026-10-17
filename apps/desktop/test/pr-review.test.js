'use strict';
// Reviewing a PR from the Inbox: github.fetchPrHead (temp repos, no ref moves) and the review
// page's state/action wiring (renderer/pr-review.js) with a mocked `app:` call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const github = require('../github');
const git = require('../git');

const load = () => import('../renderer/pr-review.js');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('fetchPrHead: fetches refs/pull/<n>/head into FETCH_HEAD only; branchReview diffs it', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-prreview-')));
  try {
    const up = path.join(tmp, 'up');
    fs.mkdirSync(up);
    sh(up, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(up, 'a.txt'), 'a\n');
    sh(up, 'add', '.');
    sh(up, 'commit', '-qm', 'base');
    sh(up, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(up, 'b.txt'), 'b\n');
    sh(up, 'add', '.');
    sh(up, 'commit', '-qm', 'feature');
    const head = sh(up, 'rev-parse', 'HEAD');
    sh(up, 'update-ref', 'refs/pull/3/head', head);
    sh(up, 'checkout', '-q', 'main');
    sh(up, 'branch', '-D', 'feature');
    const clone = path.join(tmp, 'clone');
    sh(tmp, 'clone', '-q', up, clone);
    const refs = sh(clone, 'for-each-ref');
    const run = (args) => git.run(clone, args);
    assert.equal(await github.fetchPrHead(run, 'origin', 3), head);
    assert.equal(sh(clone, 'for-each-ref'), refs, 'fetching a PR head moved a ref');
    const r = await git.branchReview(clone, head, 'origin/main');
    assert.deepEqual(r.files.map((f) => f.path), ['b.txt']);
    assert.equal(r.base, 'origin/main');
    await assert.rejects(github.fetchPrHead(run, 'origin', 0), { code: 'gh-failed' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

const PR = { number: 12, title: 'Add swatches', branch: 'swatch', base: 'main', author: 'ak' };

test('loadPrReview: fetches the head and builds the review record', async () => {
  const { loadPrReview, prLaneKey } = await load();
  const calls = [];
  const call = async (...a) => { calls.push(a); return { ok: { sha: 'f'.repeat(40), base: 'origin/main' } }; };
  const { review } = await loadPrReview(PR, 'origin', call);
  assert.deepEqual(calls, [['pr-review-head', 'origin', 12, 'main']]);
  assert.deepEqual(review.lane, { key: prLaneKey(PR), name: '#12 Add swatches', rev: 'f'.repeat(40) });
  assert.equal(review.base, 'origin/main');
  assert.equal(review.source.branch, null, 'a PR review never offers local merge and tidy');
  assert.equal(review.pr.remote, 'origin');
  assert.equal(review.pr.number, 12);
});

test('loadPrReview: errors pass through; no remote makes no call', async () => {
  const { loadPrReview } = await load();
  let n = 0;
  const failing = async () => { n++; return { error: { message: 'off', code: 'gh-off' } }; };
  assert.deepEqual(await loadPrReview(PR, 'origin', failing), { error: { message: 'off', code: 'gh-off' } });
  const throwing = async () => { n++; throw new Error('boom'); };
  assert.equal((await loadPrReview(PR, 'origin', throwing)).error.message, 'boom');
  assert.ok((await loadPrReview(PR, null, failing)).error);
  assert.equal(n, 2);
});

test('PR actions: every action has a review key; keys map back; merge and close leave', async () => {
  const { PR_ACTIONS, prActionFor, leavesPage } = await load();
  const keymap = await import('../renderer/keymap.js');
  assert.deepEqual(PR_ACTIONS.map((a) => a.id), ['approve', 'changes', 'merge', 'close', 'checkout']);
  for (const a of PR_ACTIONS) {
    assert.ok(keymap.keys(a.key).length, `${a.key} has no key`);
    assert.equal(prActionFor(a.key), a.id);
  }
  assert.equal(prActionFor('review.tick'), null);
  assert.equal(prActionFor('review.close'), null, 'Esc goes back, it never closes the PR');
  assert.deepEqual(PR_ACTIONS.filter((a) => leavesPage(a.id)).map((a) => a.id), ['merge', 'close']);
});

test('prDescription: plain text without template comments, null when not sent', async () => {
  const { prDescription } = await load();
  assert.equal(prDescription({}), null);
  assert.equal(prDescription(null), null);
  assert.equal(prDescription({ body: '' }), '');
  assert.equal(prDescription({ body: '<!-- Describe your change -->\r\n\r\n' }), '');
  assert.equal(prDescription({ body: 'Fixes the graph.  \r\n\r\n\r\n\r\n- one\n- two\n<!-- unclosed' }), 'Fixes the graph.\n\n- one\n- two');
});

test('fixActions: a stuck row offers its fixes in order, with keys in both scopes', async () => {
  const { fixActions } = await import('../renderer/pr-review.js');
  const { COMMANDS } = await import('../renderer/keymap.js');
  const ids = new Set(COMMANDS.map((c) => c.id));
  const pr = { number: 7, url: 'https://github.com/o/r/pull/7', checks: 'failure' };
  const lane = { branch: 'feat', name: 'feat' };
  assert.deepEqual(fixActions({ stage: 'ready', pr }, { base: 'main', conflicts: true }), []);
  const here = fixActions({ stage: 'stuck', pr, lane }, { base: 'main', conflicts: true });
  assert.deepEqual(here.map((a) => a.id), ['rebase', 'showConflicts', 'checks', 'sendBack']);
  assert.equal(here[0].label, 'Rebase onto main');
  for (const a of here) assert.ok(ids.has(a.key) && ids.has(a.listKey), a.id);
  const away = fixActions({ stage: 'stuck', pr }, { base: 'main', conflicts: true });
  assert.deepEqual(away.map((a) => a.id), ['checkout', 'updateBranch', 'showConflicts', 'checks', 'sendBack']);
  for (const a of away) assert.ok(ids.has(a.key) && ids.has(a.listKey), a.id);
  assert.deepEqual(fixActions({ stage: 'stuck', pr: { ...pr, mergeState: 'behind' } }, { base: 'main' }).map((a) => a.id), ['updateBranch', 'checks', 'sendBack']);
  assert.deepEqual(fixActions({ stage: 'stuck', pr: { ...pr, mergeState: 'behind' }, lane }, { base: 'main' }).map((a) => a.id), ['checks', 'sendBack']);
  assert.deepEqual(fixActions({ stage: 'stuck', pr: { ...pr, checks: 'success' }, lane }, { base: 'main' }).map((a) => a.id), ['sendBack']);
});

test('updateBranchBlock: U only updates what the pane offers, else says why', async () => {
  const { updateBranchBlock } = await import('../renderer/pr-review.js');
  const pr = { number: 7, mergeState: 'behind' };
  assert.equal(updateBranchBlock({ stage: 'stuck', title: 'A', pr }, { base: 'main' }), null);
  assert.equal(updateBranchBlock({ stage: 'stuck', title: 'A', pr: { number: 7 } }, { base: 'main', conflicts: true }), null);
  assert.match(updateBranchBlock({ stage: 'stuck', title: 'A', pr, lane: { branch: 'a' } }, { base: 'main' }), /checked out here/);
  assert.match(updateBranchBlock({ stage: 'ready', title: 'A', pr }, { base: 'main' }), /doesn’t need updating/);
  assert.match(updateBranchBlock({ stage: 'stuck', title: 'A', pr: { number: 7 } }, { base: 'main' }), /doesn’t need updating/);
  assert.match(updateBranchBlock({ stage: 'stuck', title: 'A' }, { base: 'main' }), /no pull request/);
});

test('fetchPrHead: two fetches at once each get their own PR head (AK-277)', async () => {
  let fetchHead = null;
  const heads = { 5: 'a'.repeat(40), 6: 'b'.repeat(40) };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  // A fake git: the fetch writes FETCH_HEAD, the rev-parse reads it a moment later.
  const run = async (args) => {
    if (args[0] === 'fetch') { await tick(); fetchHead = heads[args.at(-1).split('/')[2]]; return ''; }
    await tick();
    return fetchHead;
  };
  const [a, b] = await Promise.all([github.fetchPrHead(run, 'origin', 5), github.fetchPrHead(run, 'origin', 6)]);
  assert.equal(a, heads[5]);
  assert.equal(b, heads[6]);
});
