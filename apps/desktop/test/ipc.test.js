'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const check = require('../ipc');

const root = path.join(__dirname, '..');
const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof check.IpcArgError && (!re || re.test(e.message)));

test('every git method the main process serves has a schema, and nothing else does', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const block = (name) => main.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`))[1];
  const keys = (src) => [...src.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  const { workOps, worktreeOps, laneOps, remoteOps } = require('../journal');
  const served = [...keys(block('reads')), ...keys(block('refMutations')), ...keys(block('plainMutations')), ...Object.keys(workOps), ...Object.keys(worktreeOps), ...Object.keys(remoteOps), ...laneOps, 'cleanupLanes', 'updateSubmodules', 'submoduleWork', 'autostashCheckout', 'switchDelete', 'switchMerge', 'switchRewrite', 'freeCheckout', 'moveCheckout', 'stashAnd', 'abortAnd', 'restoreResolved', 'undo', 'redo', 'restoreHistory'];
  assert.deepStrictEqual(Object.keys(check.gitSchemas).sort(), [...new Set(served)].sort());
});

test('calls the renderer actually makes pass', () => {
  const sha = 'a'.repeat(40);
  const file = { path: 'src/app.js', status: 'M' };
  const ok = [
    ['refs', []],
    ['log', [{ remotes: true, tags: false }]],
    ['commit', [sha]],
    ['logOpen', [{ remotes: true, tags: true, kind: 'full', preview: true, limit: 500 }]],
    ['logRead', [3]],
    ['logClose', [3]],
    ['logDetails', [[sha, 'b'.repeat(40)]]],
    ['commitFileDiff', [sha, { path: 'dir/file name.txt', status: 'M' }, null]],
    ['commitFileDiff', [sha, { path: 'new.txt', oldPath: 'old.txt', status: 'R100' }, sha]],
    ['commitDiffs', [sha]],
    ['checkSplit', [sha]],
    ['rewrite', ['split', sha, { files: { 'a.txt': 'all', 'b.txt': ['0:1', '1:4'] }, messages: ['First', 'Second'] }]],
    ['history', [200]],
    ['previewRestore', [7]],
    ['worktrees', []],
    ['worktreeChanges', ['/repos/app-feature']],
    ['addWorktree', [{ dir: null, branch: 'feature', base: sha }]],
    ['addWorktree', [{ dir: '~/wt/app-x', branch: null, base: 'HEAD' }]],
    ['removeWorktree', ['/repos/app-feature']],
    ['addRemote', ['upstream', 'git@github.com:acme/app.git']],
    ['setRemoteUrl', ['origin', 'https://github.com/acme/app.git']],
    ['renameRemote', ['origin', 'my.fork_2']],
    ['removeRemote', ['origin']],
    ['lockWorktree', ['/repos/app-feature', null]],
    ['lockWorktree', ['/repos/app-feature', 'on a USB disk']],
    ['unlockWorktree', ['/repos/app-feature']],
    ['pruneWorktrees', []],
    ['compare', [`${sha}^1`, sha]],
    ['compare', [sha, 'HEAD']],
    ['workingDiff', [file, true]],
    ['workingDiff', [{ path: 'new.txt', oldPath: 'old.txt', status: 'R' }, false]],
    ['checkout', ['feature/x']],
    ['checkoutTracking', ['origin/feature']],
    ['autostashCheckout', ['feature', 'Auto-stash on main before switching to feature', true]],
    ['createBranch', ['topic', sha, true]],
    ['createTag', ['v1.0', sha, null]],
    ['createTag', ['v1.0', sha, 'Release']],
    ['merge', ['origin/main']],
    ['rewrite', ['squash', sha]],
    ['rewrite', ['reword', sha, { message: 'New message\n' }]],
    ['createCommit', ['Subject\n\nBody\n', false]],
    ['stageFiles', [['a.txt', 'b/c.txt']]],
    ['stageLines', [file, ['0:1', '0:2']]],
    ['combinedDiff', [file]],
    ['combinedDiff', [file, [0, 3]]],
    ['stageChanges', [file, ['0:1', '2:*']]],
    ['stageChanges', [file, 'all']],
    ['unstageChanges', [{ path: 'new.txt', oldPath: 'old.txt', status: 'R' }, 'all']],
    ['discardFiles', [[{ path: 'a.txt', status: '?' }]]],
    ['discardLines', [file, ['1:3']]],
    ['chooseSide', ['conflict.txt', 'theirs']],
    ['stashApply', ['stash@{0}', true]],
    ['stashSave', ['', true]],
    ['stashSave', ['wip', false, { staged: true }]],
    ['stashSave', ['', true, { paths: ['a.txt'] }]],
    ['stashLines', [file, ['0:1'], 'wip']],
    ['push', [{ force: true }]],
    ['deleteRemoteBranch', ['origin/old']],
    ['setConfig', ['user.email', 'me@example.com']],
    ['setConfig', ['remote.origin.url', 'git@github.com:o/r.git']],
    ['unsetConfig', ['branch.main.remote']],
    ['resetHard', []],
    ['restoreHistory', [3]],
    ['undo', []],
  ];
  for (const [method, args] of ok) {
    assert.doesNotThrow(() => check.checkGit(method, args), `${method}(${JSON.stringify(args)})`);
  }
});

test('the trailing undo label is split off', () => {
  const r = check.checkGit('checkout', ['main', { __label: 'Checkout main' }]);
  assert.deepStrictEqual(r, { args: ['main'], label: 'Checkout main', worktreeArgs: [] });
  assert.deepStrictEqual(check.checkGit('undo', []), { args: [], label: null, worktreeArgs: [] });
});

test('unknown methods and prototype keys are refused', () => {
  rejects(() => check.checkGit('run', [['status']]), /Unknown method/);
  rejects(() => check.checkGit('constructor', []), /Unknown method/);
  rejects(() => check.checkGit('__proto__', []), /Unknown method/);
  rejects(() => check.checkGit(42, []), /Unknown method/);
});

test('refs that git would read as options are refused', () => {
  rejects(() => check.checkGit('checkout', ['--orphan=x']), /must not start with "-"/);
  rejects(() => check.checkGit('merge', ['-Xtheirs']));
  rejects(() => check.checkGit('deleteRemoteBranch', ['--upload-pack=touch /tmp/pwned']));
  rejects(() => check.checkGit('createBranch', ['x', '--detach']));
  rejects(() => check.checkGit('checkout', ['main\n--force']));
  rejects(() => check.checkGit('checkout', ['ma\0in']));
  rejects(() => check.checkGit('rewrite', ['drop', 'HEAD']), /hex object id/);
  rejects(() => check.checkGit('rewrite', ['exec', 'a'.repeat(40)]));
});

test('paths must stay inside the repository', () => {
  rejects(() => check.checkGit('stageFiles', [['../outside']]));
  rejects(() => check.checkGit('stageFiles', [['/etc/passwd']]));
  rejects(() => check.checkGit('workingDiff', [{ path: 'a/../../b', status: '?' }, false]));
  rejects(() => check.checkGit('markResolved', ['C:\\Windows']));
  rejects(() => check.insideRepo('/repo', '../etc/passwd'));
  assert.strictEqual(check.insideRepo('/repo', 'src/a.js'), path.resolve('/repo/src/a.js'));
});

test('argument shapes are enforced', () => {
  rejects(() => check.checkGit('checkout', []), /expected a string/);
  rejects(() => check.checkGit('checkout', ['a', 'b']), /Too many arguments/);
  rejects(() => check.checkGit('stageFiles', ['a.txt']), /expected a list/);
  rejects(() => check.checkGit('push', [{ force: 'yes' }]), /boolean/);
  rejects(() => check.checkGit('push', [{ force: true, receivePack: 'x' }]), /unexpected field/);
  rejects(() => check.checkGit('discardFiles', [[{ path: 'a', status: 'M', exec: 'x' }]]), /unexpected field/);
  rejects(() => check.checkGit('stageLines', [{ path: 'a' }, ['x']]), /hunk:line/);
  rejects(() => check.checkGit('stageChanges', [{ path: 'a' }, ['0:x']]), /hunk:\*/);
  rejects(() => check.checkGit('unstageChanges', [{ path: 'a' }, 'some']), /expected a list/);
  rejects(() => check.checkGit('combinedDiff', [{ path: '../x' }]));
  rejects(() => check.checkGit('combinedDiff', [{ path: 'a' }, [-1]]), /non-negative/);
  rejects(() => check.checkGit('restoreHistory', ['1']));
  rejects(() => check.checkGit('setConfig', ['--global', 'x']), /section.name/);
  rejects(() => check.checkGit('setConfig', ['core.sshCommand', 7]));
  for (const k of ['core.fsmonitor', 'core.sshCommand', 'core.hooksPath', 'alias.co', 'filter.lfs.smudge', 'credential.helper', 'credential.https://h.helper', 'diff.x.textconv', 'include.path', 'remote.origin.uploadpack', 'protocol.ext.allow']) {
    rejects(() => check.checkGit('setConfig', [k, 'x']), /runs commands/);
  }
  check.checkGit('unsetConfig', ['core.fsmonitor']); // removing one is harmless
  rejects(() => check.checkGit('log', [{ limit: -1 }]));
  rejects(() => check.checkGit('checkout', ['main', { __label: 5 }]));
});

test('commit file diffs take the status entry, not a bare path', () => {
  const sha = 'a'.repeat(40);
  rejects(() => check.checkGit('commitFileDiff', [sha, 'a.txt']), /expected an object/);
  rejects(() => check.checkGit('commitFileDiff', [sha, { path: '../etc/passwd' }]), /\.\./);
  rejects(() => check.checkGit('commitFileDiff', [sha, { path: 'a.txt', oldPath: '/etc/passwd' }]), /relative/);
  rejects(() => check.checkGit('commitFileDiff', [sha, { path: 'a.txt', extra: 1 }]), /unexpected field/);
});

test('worktree folders: shape in the schema, membership against git worktree list', () => {
  const { worktreeArgs } = check.checkGit('lockWorktree', ['/repos/app-x', 'reason']);
  assert.deepStrictEqual(worktreeArgs, [0]);
  assert.deepStrictEqual(check.checkGit('addWorktree', [{ dir: 'x' }]).worktreeArgs, [], 'a new worktree is not listed yet');
  for (const m of ['worktreeChanges', 'removeWorktree', 'unlockWorktree']) {
    rejects(() => check.checkGit(m, ['relative/dir']), /absolute/);
    rejects(() => check.checkGit(m, []));
  }
  rejects(() => check.checkGit('addWorktree', [{ dir: 'x', branch: '--orphan' }]), /must not start with "-"/);
  rejects(() => check.checkGit('addWorktree', [{ dir: 'x', force: true }]), /unexpected field/);
  rejects(() => check.checkGit('logOpen', [{ heads: ['--output=/tmp/x'] }]), /unexpected field/);
  rejects(() => check.checkGit('logOpen', [{ kind: 'raw' }]), /expected one of/);
  rejects(() => check.checkGit('rewrite', ['split', 'a'.repeat(40), { files: { '../x': 'all' }, messages: ['a', 'b'] }]), /\.\./);
  rejects(() => check.checkGit('rewrite', ['split', 'a'.repeat(40), { files: { 'x': ['nope'] }, messages: ['a', 'b'] }]), /hunk:line/);

  const list = [{ path: '/repos/app', main: true }, { path: '/repos/app-x' }];
  assert.strictEqual(check.knownWorktree(list, '/repos/app-x'), '/repos/app-x');
  rejects(() => check.knownWorktree(list, '/Users/me/Documents'), /not a worktree of this repository/);
  rejects(() => check.knownWorktree(list, '/repos/app-x/..'), /not a worktree/);
  rejects(() => check.knownWorktree(list, 'app-x'), /absolute/);
  // main.js passes git.samePath, which follows symlinks.
  assert.strictEqual(check.knownWorktree(list, '/private/repos/app-x', (a, b) => a.replace(/^\/private/, '') === b.replace(/^\/private/, '')), '/repos/app-x');
});

test('sessions reach no network, except the updater session to its feed host over https', () => {
  for (const url of ['file:///app/renderer/index.html', 'data:image/png;base64,AA==', 'devtools://devtools/x', 'gitlanes-media://video/' + '0'.repeat(32)]) assert.ok(check.requestAllowed(url), url);
  for (const url of ['https://github.com/x', 'http://example.com/', 'wss://example.com/', 'not a url']) assert.ok(!check.requestAllowed(url), url);
  const updater = require('../updater');
  const feed = updater.feedUrl('https://github.com/0xa3k5/gitlanes/releases/latest/download', 'arm64');
  const allow = updater.feedOrigins(feed);
  assert.deepStrictEqual(allow, ['https://github.com', 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);
  assert.ok(check.requestAllowed(feed, allow));
  assert.ok(check.requestAllowed('https://release-assets.githubusercontent.com/a/b.zip?sig=1', allow), 'GitHub redirects release downloads');
  assert.ok(!check.requestAllowed('http://github.com/0xa3k5/gitlanes/releases', allow), 'https only');
  assert.ok(!check.requestAllowed('https://evil.example/', allow));
  assert.ok(!check.requestAllowed('https://github.com.evil.example/', allow));
  assert.deepStrictEqual(updater.feedOrigins('https://updates.example.com/mac'), ['https://updates.example.com']);
  // Development feeds (GITLANES_UPDATE_FEED) may be a local http server.
  assert.ok(check.requestAllowed('http://127.0.0.1:4100/update-mac-arm64.json', updater.feedOrigins('http://127.0.0.1:4100/update-mac-arm64.json')));
  assert.ok(!check.requestAllowed('http://updates.example.com/x', updater.feedOrigins('http://updates.example.com/x')), 'remote feeds need https');
});

test('only http(s) links reach the OS', () => {
  assert.strictEqual(check.webUrl('https://github.com/o/r/commit/abc'), 'https://github.com/o/r/commit/abc');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:com.apple', 'smb://host/share', '/Applications/Calculator.app', 'https://user:pw@host/', 42]) {
    rejects(() => check.webUrl(bad));
  }
});

test('clone URLs: normal transports pass, options and helpers do not', () => {
  for (const ok of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@host:22/o/r', 'git://host/r', '/Users/me/src/repo', '/Users/me/My Repos/r', 'file:///tmp/r.git']) {
    assert.doesNotThrow(() => check.cloneUrl(ok), ok);
  }
  for (const bad of ['--upload-pack=touch /tmp/x', 'ext::sh -c touch% /tmp/x', 'fd::17', 'foo::bar', 'gopher://x/y', 'https://h/r\n-x']) {
    rejects(() => check.cloneUrl(bad), undefined);
  }
});

test('the renderer CSP allows nothing remote and no inline code', () => {
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepStrictEqual(dir['default-src'], ["'none'"]);
  assert.deepStrictEqual(dir['script-src'], ["'self'"]);
  assert.deepStrictEqual(dir['connect-src'], ["'none'"]);
  assert.deepStrictEqual(dir['object-src'], ["'none'"]);
  assert.deepStrictEqual(dir['base-uri'], ["'none'"]);
  assert.ok(!csp.includes('unsafe-'), 'no unsafe-inline / unsafe-eval');
  assert.ok(!/https?:|\*/.test(csp), 'no remote origins');
});

test('windows keep the renderer isolated', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  for (const pref of ['contextIsolation: true', 'sandbox: true', 'nodeIntegration: false', 'webviewTag: false', 'webSecurity: true']) {
    assert.ok(main.includes(pref), pref);
  }
  assert.ok(main.includes('app.enableSandbox()'));
  assert.ok(!/ipcMain\.(handle|on)\('/.test(main), 'IPC handlers go through handle(), which checks the sender');
});

test('runnable flags files that macOS would execute when opened', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-run-'));
  const exe = path.join(dir, 'run'); fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  const txt = path.join(dir, 'a.txt'); fs.writeFileSync(txt, 'x', { mode: 0o644 });
  try {
    assert.equal(check.runnable(exe), true);
    assert.equal(check.runnable(txt), false);
    assert.equal(check.runnable(path.join(dir, 'x.command')), true);
    assert.equal(check.runnable('/Applications/Calculator.app/'), true);
    assert.equal(check.runnable(path.join(dir, 'missing.md')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('commit file entries, trimmed by fileRef, pass the file-entry check (AK-131)', async () => {
  const { fileRef } = await import('../renderer/diff.js');
  const sha = 'a'.repeat(40);
  // The shape git.commitFiles returns: status entries plus numstat counts.
  const entry = { status: 'R100', oldPath: 'old.txt', path: 'new.txt', add: 3, del: 1, binary: false };
  rejects(() => check.checkGit('commitFileDiff', [sha, entry, null]), /unexpected field "add"/);
  assert.deepStrictEqual(fileRef(entry), { path: 'new.txt', oldPath: 'old.txt', status: 'R100' });
  check.checkGit('commitFileDiff', [sha, fileRef(entry), null]);
  check.checkGit('difftool', [fileRef(entry), false, sha, null]);
  check.checkGit('discardFiles', [[{ path: 'a.txt', status: 'M', lfs: true }].map(fileRef)]);
});

test('PR calls: positive PR numbers, a known remote, fixed merge options', () => {
  for (const n of [1, 42, Number.MAX_SAFE_INTEGER]) assert.strictEqual(check.prNumber(n), n);
  for (const n of [0, -1, 1.5, NaN, Infinity, '7', null, undefined, 2 ** 53]) rejects(() => check.prNumber(n), /positive integer/);
  assert.strictEqual(check.mediaId('a'.repeat(32)), 'a'.repeat(32));
  for (const v of ['A'.repeat(32), 'a'.repeat(31), 'https://github.com/x.png', null, 7]) rejects(() => check.mediaId(v), /media id/);
  const remotes = [{ name: 'origin', url: 'git@github.com:acme/app.git' }, { name: 'fork', url: 'https://github.com/kim/app' }];
  assert.strictEqual(check.knownRemote(remotes, 'fork'), remotes[1]);
  rejects(() => check.knownRemote(remotes, 'upstream'), /not a remote/);
  rejects(() => check.knownRemote(remotes, 'git@github.com:evil/app.git'), /not a remote/);
  rejects(() => check.knownRemote(remotes, 7));
  // AK-446: a missing remote is still refused, not defaulted.
  for (const v of [undefined, null, '']) rejects(() => check.knownRemote(remotes, v), /remote: (expected a string|empty)/);
  rejects(() => check.knownRemote([], 'origin'), /not a remote/);
  const method = check.oneOf(...require('../github').MERGE_METHODS);
  for (const m of ['squash', 'merge', 'rebase']) assert.strictEqual(method(m, 'merge method'), m);
  for (const m of ['--admin', 'squash --admin', '', undefined]) rejects(() => method(m, 'merge method'));
  rejects(() => check.bool('true', 'delete branch'));
  rejects(() => check.str('a\0b', 'review comment', { empty: true }), /NUL/);
});

test('main.js checks the PR number and remote before any PR action reaches gh', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const action = main.slice(main.indexOf('const prAction'), main.indexOf("handle('app:pr-merge-info'"));
  assert.ok(action.indexOf('check.prNumber(number)') > 0 && action.indexOf('check.knownRemote(') > action.indexOf('check.prNumber'), 'prAction checks the number, then the remote');
  assert.ok(action.indexOf('fn({') > action.indexOf('check.knownRemote('), 'checks run before gh');
  for (const ch of ['pr-merge-info', 'pr-approve', 'pr-merge', 'pr-close', 'pr-update-branch', 'pr-ready', 'pr-draft', 'pr-rerun-failed']) assert.match(main, new RegExp(`handle\\('app:${ch}', prAction\\(`), ch);
  const states = main.slice(main.indexOf("handle('app:pr-merge-states'"), main.indexOf('// Send back: the failed CI log'));
  assert.ok(states.indexOf('github.LIMIT') > 0 && states.indexOf('check.prNumber(') > 0, 'pr-merge-states checks the list and each number');
  assert.ok(states.indexOf('github.mergeStates(') > states.indexOf('check.knownRemote('), 'pr-merge-states checks the remote before gh');
  assert.match(main, /handle\('app:pr-list'[\s\S]{0,200}if \(!\(await prEnabled\(root\)\)\) return null;/, 'pr-list returns before gh while off or hidden');
  assert.match(main, /if \(!github\.pickRemote\(remotes\)\) return null;/, 'pr-list is quiet without a GitHub remote');
  assert.match(main, /handle\('app:pr-hide', async \(e, hide\) => \{\s*const v = check\.bool\(hide/, 'pr-hide checks its argument');
  assert.match(main, /handle\('app:pr-enable', async \(e, on\) => \{\s*const v = check\.bool\(on/, 'pr-enable checks its argument');
  // The PR switch works on the welcome screen: state, enable and detect don't need a repository.
  const prPart = main.slice(main.indexOf('async function prState('), main.indexOf("handle('app:pr-hide'"));
  assert.ok(prPart.length > 0 && !/session\(e\)/.test(prPart), 'pr-state, pr-enable and pr-detect work without a repository');
});

test('remote names and URLs are checked before git sees them', () => {
  for (const name of ['-x', 'a/b', 'a..b', 'x.lock', '', 'a b']) rejects(() => check.checkGit('addRemote', [name, 'https://example.com/a.git']));
  rejects(() => check.checkGit('addRemote', ['up', 'ext::sh -c touch% /tmp/x']), /transport helpers/);
  rejects(() => check.checkGit('setRemoteUrl', ['origin', '--upload-pack=x']), /must not start/);
  rejects(() => check.checkGit('renameRemote', ['origin', '../x']));
});

test('handoff: rebaseLane needs a branch and a base (AK-601)', () => {
  assert.equal(check.handoff({ kind: 'rebaseLane', dir: '/tmp/wt', branch: 'feature', base: 'main' }).kind, 'rebaseLane');
  assert.throws(() => check.handoff({ kind: 'rebaseLane', dir: '/tmp/wt', branch: 'feature' }));
  assert.throws(() => check.handoff({ kind: 'rebaseLane', dir: '/tmp/wt', branch: '--upload-pack=x', base: 'main' }));
  assert.throws(() => check.handoff({ kind: 'rebase', dir: '/tmp/wt', branch: 'feature', base: 'main' }));
});
