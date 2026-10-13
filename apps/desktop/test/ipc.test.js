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
  const { workOps } = require('../journal');
  const served = [...keys(block('reads')), ...keys(block('refMutations')), ...keys(block('plainMutations')), ...Object.keys(workOps), 'undo', 'redo', 'restoreHistory'];
  assert.deepStrictEqual(Object.keys(check.gitSchemas).sort(), [...new Set(served)].sort());
});

test('calls the renderer actually makes pass', () => {
  const sha = 'a'.repeat(40);
  const file = { path: 'src/app.js', status: 'M' };
  const ok = [
    ['refs', []],
    ['log', [{ remotes: true, tags: false }]],
    ['commit', [sha]],
    ['commitFileDiff', [sha, 'dir/file name.txt', null]],
    ['compare', [`${sha}^1`, sha]],
    ['compare', [sha, 'HEAD']],
    ['workingDiff', [file, true]],
    ['workingDiff', [{ path: 'new.txt', oldPath: 'old.txt', status: 'R' }, false]],
    ['checkout', ['feature/x']],
    ['checkoutTracking', ['origin/feature']],
    ['createBranch', ['topic', sha, true]],
    ['createTag', ['v1.0', sha, null]],
    ['createTag', ['v1.0', sha, 'Release']],
    ['merge', ['origin/main']],
    ['rewrite', ['squash', sha]],
    ['rewrite', ['reword', sha, { message: 'New message\n' }]],
    ['createCommit', ['Subject\n\nBody\n', false]],
    ['stageFiles', [['a.txt', 'b/c.txt']]],
    ['stageLines', [file, ['0:1', '0:2']]],
    ['discardFiles', [[{ path: 'a.txt', status: '?' }]]],
    ['discardLines', [file, ['1:3']]],
    ['chooseSide', ['conflict.txt', 'theirs']],
    ['stashApply', ['stash@{0}', true]],
    ['stashSave', ['', true]],
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
  assert.deepStrictEqual(r, { args: ['main'], label: 'Checkout main' });
  assert.deepStrictEqual(check.checkGit('undo', []), { args: [], label: null });
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
  rejects(() => check.checkGit('restoreHistory', ['1']));
  rejects(() => check.checkGit('setConfig', ['--global', 'x']), /section.name/);
  rejects(() => check.checkGit('setConfig', ['core.sshCommand', 7]));
  rejects(() => check.checkGit('log', [{ limit: -1 }]));
  rejects(() => check.checkGit('checkout', ['main', { __label: 5 }]));
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
