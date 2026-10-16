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
