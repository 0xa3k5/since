'use strict';
// Send back (renderer/send-back.js): prompts built from a stuck row's facts, template storage per
// repository with a user-wide default, and the git and gh calls the sheet makes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const github = require('../github');

const load = () => import('../renderer/send-back.js');
const pr = (o = {}) => ({ number: 12, title: 'Add changelog', branch: 'feat/log', base: 'main', checks: 'success', failing: [], mergeable: true, ...o });
const CONFLICT = { pr: pr(), branch: 'feat/log', title: 'Add changelog', conflicts: [{ with: 'main', base: true, files: ['src/changelog.astro', 'README.md'] }] };
const CI = { pr: pr({ checks: 'failure', failing: ['test', 'lint'] }), branch: 'feat/log', title: 'Add changelog', conflicts: [] };
const BOTH = { ...CONFLICT, pr: CI.pr };

test('templateFor picks Conflict, CI failing or Both', async () => {
  const { templateFor } = await load();
  assert.equal(templateFor(CONFLICT), 'conflict');
  assert.equal(templateFor(CI), 'ci');
  assert.equal(templateFor(BOTH), 'both');
  assert.equal(templateFor({ pr: pr({ mergeable: false }), conflicts: [] }), 'conflict');
});

test('Conflict prompt: PR, head → base, files and the base commits that touched them', async () => {
  const { buildPrompt } = await load();
  const touches = { 'src/changelog.astro': [{ sha: 'abc1234', subject: 'Redo the header (#9)', pr: 9 }, { sha: 'def5678', subject: 'tweak', pr: null }] };
  const p = buildPrompt(CONFLICT, 'conflict', undefined, { base: 'main', touches });
  assert.match(p, /^PR #12 "Add changelog" \(feat\/log → main\) can't merge/);
  assert.match(p, /- src\/changelog\.astro \(with main; changed on main by #9 abc1234, def5678\)/);
  assert.match(p, /- README\.md \(with main\)/);
  assert.match(p, /Rebase feat\/log onto main/);
  assert.doesNotMatch(p, /\{\{/);
});

test('CI failing prompt: check names, the log once fetched, no gap without it', async () => {
  const { buildPrompt } = await load();
  const without = buildPrompt(CI, 'ci', undefined, { base: 'main' });
  assert.match(without, /Failing checks:\n- test\n- lint\n\nFind the cause/);
  assert.doesNotMatch(without, /\n{3}/);
  const withLog = buildPrompt(CI, 'ci', undefined, { base: 'main', log: 'Error: boom\n  at x.js:1' });
  assert.match(withLog, /Last lines of the failed log:\n```\nError: boom\n  at x\.js:1\n```/);
});

test('Both prompt has conflicts and checks; a branch without a PR names the branch', async () => {
  const { buildPrompt } = await load();
  const p = buildPrompt(BOTH, 'both', undefined, { base: 'main' });
  assert.match(p, /Conflicting files:\n- src\/changelog\.astro/);
  assert.match(p, /Failing checks:\n- test\n- lint/);
  const lane = buildPrompt({ pr: null, branch: 'fix-x', title: 'fix-x', conflicts: [{ with: 'other lane', base: false, files: ['a.js'] }] }, 'conflict', undefined, { base: 'main' });
  assert.match(lane, /^Branch fix-x \(→ main\)/);
  assert.match(lane, /- a\.js \(with other lane\)/);
  const gh = buildPrompt({ pr: pr({ mergeable: false }), conflicts: [] }, 'conflict', undefined, {});
  assert.match(gh, /GitHub reports conflicts with main/);
});

test('custom templates: placeholders filled, unknown ones kept', async () => {
  const { buildPrompt, DEFAULT_TEMPLATES } = await load();
  const t = { ...DEFAULT_TEMPLATES, ci: 'Fix {{number}} ({{reason}}) {{nope}}' };
  assert.equal(buildPrompt(CI, 'ci', t, { reason: 'CI ✗ test' }), 'Fix #12 (CI ✗ test) {{nope}}');
});

test('template storage: per repository, then the user default, then built-in', async () => {
  const { resolveTemplates, saveTemplate, DEFAULT_TEMPLATES } = await load();
  let saved = {};
  assert.equal(resolveTemplates(saved, '/r/a').ci.from, 'builtin');
  saved = saveTemplate(saved, { id: 'ci', text: 'everyone', scope: 'default' });
  saved = saveTemplate(saved, { root: '/r/a', id: 'ci', text: 'just a', scope: 'repo' });
  assert.deepEqual(resolveTemplates(saved, '/r/a').ci, { text: 'just a', from: 'repo' });
  assert.deepEqual(resolveTemplates(saved, '/r/b').ci, { text: 'everyone', from: 'default' });
  assert.deepEqual(resolveTemplates(saved, '/r/b').conflict, { text: DEFAULT_TEMPLATES.conflict, from: 'builtin' });
  // Empty text resets to the next level, and drops the repo's entry once it has none.
  const reset = saveTemplate(saved, { root: '/r/a', id: 'ci', text: '  ', scope: 'repo' });
  assert.equal(resolveTemplates(reset, '/r/a').ci.from, 'default');
  assert.deepEqual(reset.repos, {});
  assert.equal(saved.repos['/r/a'].ci, 'just a'); // not mutated
  assert.throws(() => saveTemplate(saved, { id: 'nope', text: 'x' }));
  assert.throws(() => saveTemplate(saved, { id: 'ci', text: 'x', scope: 'repo' }));
});

test('failed CI log: failing Actions runs from pr view, then run view --log-failed, last lines only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-gh-test-'));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  const ORIGIN = { name: 'origin', url: 'git@github.com:acme/app.git', web: git.remoteWebUrl('git@github.com:acme/app.git') };
  const rollup = JSON.stringify({ statusCheckRollup: [
    { name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/55/job/1' },
    { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/55/job/2' },
    { name: 'build', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/56/job/3' },
    { context: 'ext', state: 'FAILURE', targetUrl: 'https://ci.example.com/1' },
  ] });
  const lines = Array.from({ length: 30 }, (_, i) => `test\tRun tests\t2026-10-15T10:00:${String(i).padStart(2, '0')}.1234567Z \x1b[31mline ${i}\x1b[0m`).join('\n');
  const calls = [];
  const exec = async (bin, args) => { calls.push(args); return args[0] === 'pr' ? rollup : lines; };
  const res = await github.failedLog({ enabled: true, remotes: [ORIGIN], number: 12, dirs: [dir], exec });
  assert.deepEqual(calls, [
    ['pr', 'view', '12', '--repo', 'github.com/acme/app', '--json', 'statusCheckRollup'],
    ['run', 'view', '55', '--repo', 'github.com/acme/app', '--log-failed'],
  ]);
  assert.deepEqual(res.runs, ['55']);
  const out = res.log.split('\n');
  assert.equal(out.length, 20);
  assert.equal(out[0], 'line 10');
  assert.equal(out[19], 'line 29');
  // Off for the repository: nothing runs.
  await assert.rejects(github.failedLog({ enabled: false, remotes: [ORIGIN], number: 12, dirs: [dir], exec }), { code: 'gh-off' });
  await assert.rejects(github.commentPr({ enabled: false, remotes: [ORIGIN], number: 12, body: 'x', dirs: [dir], exec }), { code: 'gh-off' });
  assert.equal(calls.length, 2);
  calls.length = 0;
  await github.commentPr({ enabled: true, remotes: [ORIGIN], number: 12, body: ' fix it \n', dirs: [dir], exec });
  assert.deepEqual(calls[0], ['pr', 'comment', '12', '--repo', 'github.com/acme/app', '--body=fix it']);
  await assert.rejects(github.commentPr({ enabled: true, remotes: [ORIGIN], number: 12, body: ' ', dirs: [dir], exec }), { code: 'gh-failed' });
});

test('baseTouches: commits on the base since the branch left it, per file, with PR numbers', async () => {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-sendback-'))), 'app');
  fs.mkdirSync(dir);
  const g = (...a) => git.run(dir, a);
  const commit = async (file, text, msg) => { fs.writeFileSync(path.join(dir, file), text); await g('add', file); await g('commit', '-q', '-m', msg); };
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'Test');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'commit.gpgsign', 'false');
  await commit('a.txt', 'a\n', 'base');
  await commit('b.txt', 'b\n', 'old change to b (#1)');
  await g('checkout', '-q', '-b', 'feature');
  await commit('a.txt', 'feature\n', 'feature edit');
  await g('checkout', '-q', 'main');
  await commit('a.txt', 'main\n', 'Redo a (#9)');
  await commit('a.txt', 'main 2\n', 'tweak a');
  const t = await git.baseTouches(dir, 'feature', 'main', ['a.txt', 'b.txt']);
  assert.deepEqual(t['a.txt'].map((c) => [c.subject, c.pr]), [['tweak a', null], ['Redo a (#9)', 9]]);
  assert.match(t['a.txt'][0].sha, /^[0-9a-f]{7,}$/);
  assert.deepEqual(t['b.txt'], []); // changed before the branch left main
  assert.deepEqual(await git.baseTouches(dir, 'nope', 'main', ['a.txt']), {});
});
