'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');
const check = require('../ipc');
const cf = require('../change-facts');

const FIXTURES = path.join(__dirname, 'fixtures', 'change-facts');
function fixture(name) {
  const read = (f) => fs.readFileSync(path.join(FIXTURES, name, f), 'utf8');
  const meta = JSON.parse(read('meta.json'));
  return cf.analyze({ numstat: read('numstat.txt'), summary: read('summary.txt'), patch: read('patch.diff'), manifests: meta.manifests, internal: meta.internal });
}
const flags = (r) => r.facts.filter((f) => f.level === 'flag');
const fact = (r, id) => r.facts.find((f) => f.id === id);

// Skip markers are built at run time so this file doesn't contain them itself.
const SKIP_IT = 'x' + 'it(';

test('calibration: only the expected pull requests raise flags', () => {
  const expected = {
    'gitlanes-211': [['tests-deleted', ['apps/desktop/test/inbox.test.js']]],
    'web3icons-217': [['dependencies', ['next 15.5.21 → 15.5.24 (apps/website/package.json)']]],
    'web3icons-218': [['dependencies', ['next 15.5.21 → 15.5.24 (bun.lock)']]],
  };
  const names = fs.readdirSync(FIXTURES).sort();
  assert.equal(names.length, 20);
  for (const name of names) {
    const got = flags(fixture(name)).map((f) => [f.id, f.details]);
    assert.deepEqual(got, expected[name] || [], name);
  }
});

test('calibration: size and spread leave out assets, lockfiles and release notes', () => {
  const icons = fixture('web3icons-221');
  assert.ok(icons.size.assets > 0);
  assert.ok(!icons.size.areas.some((a) => a.area === '.changeset'));
  assert.deepEqual(icons.size.areas.map((a) => a.area).sort(), ['docs', 'packages/common', 'packages/core', 'packages/react']);
  const lock = fixture('web3icons-218');
  assert.deepEqual(lock.size.lockfiles, [{ path: 'bun.lock', added: 11, deleted: 11 }]);
  assert.equal(lock.size.lines, lock.size.added + lock.size.deleted);
  assert.equal(fixture('gitlanes-211').size.areas[0].area, 'apps/desktop');
});

test('calibration: neutral details', () => {
  assert.equal(fact(fixture('gitlanes-212'), 'tests-changed').count, 7);
  assert.equal(fact(fixture('gitlanes-217'), 'tests-changed').title, 'tests: none changed');
  assert.deepEqual(fact(fixture('gitlanes-219'), 'deleted').details, ['vercel.json']);
  // A `latest` dev dependency that moved in the lockfile is a detail, not a flag.
  assert.deepEqual(fact(fixture('web3icons-214'), 'lockfile-drift').details, ['bun-types 1.3.14 → 1.4.2 (bun.lock)']);
  // Version Packages: internal workspace bumps and "version" fields say nothing.
  for (const n of ['212', '219', '222', '224']) assert.equal(fact(fixture(`web3icons-${n}`), 'lockfile-drift'), undefined);
});

test('package.json: dependency sections only, never the version field or workspace packages', () => {
  const before = JSON.stringify({ name: 'a', version: '1.0.0', scripts: { b: 'x' }, dependencies: { left: '1.0.0', '@me/core': '1.0.0', kept: '^2' }, devDependencies: { local: 'workspace:*' } });
  const after = JSON.stringify({ name: 'a', version: '1.1.0', scripts: { b: 'y' }, dependencies: { '@me/core': '1.1.0', kept: '^2', added: '3.0.0' }, devDependencies: { local: 'workspace:^' }, peerDependencies: { react: '^19' } });
  const r = cf.analyze({ numstat: '3\t3\tpackage.json\n', manifests: { 'package.json': { before, after } }, internal: ['@me/core'] });
  assert.deepEqual(fact(r, 'dependencies').details, ['left 1.0.0 removed (package.json)', 'added 3.0.0 added (package.json)', 'react ^19 added (package.json)']);
  const versionOnly = cf.analyze({ numstat: '1\t1\tpackage.json\n', manifests: { 'package.json': { before: '{"version":"1"}', after: '{"version":"2"}' } } });
  assert.equal(fact(versionOnly, 'dependencies'), undefined);
});

test('other manifests', () => {
  const deps = (file, text) => Object.fromEntries(cf.manifestDeps(file, text));
  assert.deepEqual(deps('go.mod', 'module x\n\ngo 1.22\n\nrequire github.com/a/b v1.2.0\nrequire (\n\tgolang.org/x/net v0.3.0 // indirect\n)\n'), { 'github.com/a/b': 'v1.2.0', 'golang.org/x/net': 'v0.3.0' });
  assert.deepEqual(deps('Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.38", features = ["full"] }\n\n[dev-dependencies.insta]\nversion = "1.39"\n'), { serde: '1.0', tokio: '1.38', insta: '1.39' });
  assert.deepEqual(deps('pyproject.toml', '[project]\nname = "x"\nversion = "1"\ndependencies = [\n  "requests>=2.31",\n  "rich",\n]\n\n[tool.poetry.dependencies]\npython = "^3.12"\n'), { requests: '>=2.31', rich: '*', python: '^3.12' });
  assert.deepEqual(deps('requirements-dev.txt', '# tools\nDjango==5.0.1\n-r base.txt\npytest>=8 ; python_version > "3.8"\n'), { django: '==5.0.1', pytest: '>=8' });
  assert.deepEqual(deps('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem \"puma\"\n"), { rails: '~> 7.1', puma: '*' });
  assert.deepEqual(deps('composer.json', '{"require":{"php":">=8.2","laravel/framework":"^11.0"},"version":"1"}'), { php: '>=8.2', 'laravel/framework': '^11.0' });
});

test('lockfiles: direct entries flag, resolved-only moves are details', () => {
  const pnpm = [
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    '--- a/pnpm-lock.yaml', '+++ b/pnpm-lock.yaml',
    '@@ -10,8 +10,8 @@ importers:',
    '     dependencies:',
    '       next:',
    '-        specifier: 15.0.0',
    '-        version: 15.0.0(react@19.0.0)',
    '+        specifier: 15.1.0',
    '+        version: 15.1.0(react@19.0.0)',
    '@@ -40,7 +40,7 @@ packages:',
    "-  '@next/env@15.0.0':",
    "+  '@next/env@15.1.0':",
    '     resolution: {integrity: sha512-x}',
    '',
  ].join('\n');
  const r = cf.analyze({ numstat: '4\t4\tpnpm-lock.yaml\n', patch: pnpm });
  assert.deepEqual(fact(r, 'dependencies').details, ['next 15.0.0 → 15.1.0 (pnpm-lock.yaml)']);
  assert.deepEqual(fact(r, 'lockfile-drift').details, ['@next/env 15.0.0 → 15.1.0 (pnpm-lock.yaml)']);
  assert.deepEqual(r.size.lockfiles, [{ path: 'pnpm-lock.yaml', added: 4, deleted: 4 }]);
  assert.equal(r.size.lines, 0);

  const npm = [
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json', '+++ b/package-lock.json',
    '@@ -5,9 +5,9 @@',
    '     "": {',
    '       "dependencies": {',
    '-        "lodash": "^4.17.20"',
    '+        "lodash": "^4.17.21"',
    '       }',
    '     },',
    '     "node_modules/lodash": {',
    '-      "version": "4.17.20",',
    '+      "version": "4.17.21",',
    '',
  ].join('\n');
  const n = cf.analyze({ numstat: '2\t2\tpackage-lock.json\n', patch: npm });
  assert.deepEqual(fact(n, 'dependencies').details, ['lodash ^4.17.20 → ^4.17.21 (package-lock.json)']);
  // Already reported as a direct change, so not repeated as a moved version.
  assert.equal(fact(n, 'lockfile-drift'), undefined);

  const goSum = cf.lockChanges('go.sum', cf.parsePatch('diff --git a/go.sum b/go.sum\n@@ -1,2 +1,2 @@\n-golang.org/x/net v0.3.0 h1:abc=\n+golang.org/x/net v0.4.0 h1:def=\n').flatMap((f) => f.hunks));
  assert.deepEqual(goSum.resolved, [{ name: 'golang.org/x/net', from: 'v0.3.0', to: 'v0.4.0', file: 'go.sum' }]);
});

test('CI, test deletions, skips, modes and binaries', () => {
  const numstat = ['3\t1\t.github/workflows/ci.yml', '1\t0\tdocker/Dockerfile.dev', '2\t0\tinfra/main.tf', '0\t9\tsrc/__tests__/a.js', '4\t0\ttest/b.test.js', '-\t-\tbin/tool.zip', '-\t-\tdocs/shot.png', '0\t0\tscripts/run.sh', '5\t0\t.changeset/x.md'].join('\n');
  const summary = ' delete mode 100644 src/__tests__/a.js\n mode change 100644 => 100755 scripts/run.sh\n create mode 100644 .changeset/x.md\n';
  const patch = `diff --git a/test/b.test.js b/test/b.test.js\n--- a/test/b.test.js\n+++ b/test/b.test.js\n@@ -1,2 +1,6 @@\n test('a', () => {});\n+${SKIP_IT}'b', () => {});\n+test('c', { skip: true }, () => {});\n+test.sk` + `ip('d', () => {});\n+test('e', () => {});\n`;
  const r = cf.analyze({ numstat, summary, patch });
  const byId = Object.fromEntries(flags(r).map((f) => [f.id, f.details]));
  assert.deepEqual(byId.ci, ['.github/workflows/ci.yml', 'docker/Dockerfile.dev', 'infra/main.tf']);
  assert.deepEqual(byId['tests-deleted'], ['src/__tests__/a.js']);
  assert.equal(byId['tests-skipped'].length, 3);
  assert.deepEqual(byId.modes, ['scripts/run.sh 100644 → 100755']);
  assert.deepEqual(byId.binaries, ['bin/tool.zip']);
  assert.equal(fact(r, 'tests-changed').count, 2);
  assert.equal(r.size.files, 8); // the .changeset note is ignored
  assert.equal(r.size.assets, 1);
});

test('renames are not deletions and count under the new path', () => {
  const r = cf.analyze({ numstat: '1\t1\ttest/{old.test.js => new.test.js}\n', summary: ' rename test/{old.test.js => new.test.js} (90%)\n' });
  assert.deepEqual(flags(r), []);
  assert.deepEqual(fact(r, 'tests-changed').paths, ['test/new.test.js']);
});

test('fragile files: a share with a minimum, not a raw count', () => {
  const commits = (file, total, fixes) => Array.from({ length: total }, (_, i) => ({ subject: i < fixes ? (i % 2 ? 'fix(desktop): x' : 'Revert "y"') : 'feat: z', files: [file] }));
  const history = [...commits('small.js', 6, 3), ...commits('big.js', 120, 30), ...commits('few.js', 4, 4), ...commits('test/a.test.js', 10, 10)];
  const got = cf.fragileFiles(history, ['small.js', 'big.js', 'few.js', 'test/a.test.js']);
  assert.deepEqual(got.map((f) => f.path), ['small.js']);
  assert.deepEqual(got[0], { path: 'small.js', commits: 6, fixes: 3, share: 0.5 });
  // "fixture:" and "prefix" aren't fixes.
  assert.deepEqual(cf.fragileFiles([...Array(6)].map(() => ({ subject: 'fixture: tidy', files: ['a.js'] })), ['a.js']), []);
});

async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-cf-')));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Test']);
  await git.run(dir, ['config', 'user.email', 't@example.com']);
  await git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
async function commit(dir, files, msg) {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    if (content === null) fs.rmSync(path.join(dir, f));
    else fs.writeFileSync(path.join(dir, f), content);
  }
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', msg]);
}

test('changeFacts on a repository: merge base, fragile history, internal packages, cache', async () => {
  const dir = await repo();
  await commit(dir, {
    'package.json': JSON.stringify({ name: 'root', dependencies: { left: '1.0.0' } }),
    'packages/core/package.json': JSON.stringify({ name: '@me/core', version: '1.0.0' }),
    'src/app.js': 'a0', 'src/calm.js': 'c0', 'test/a.test.js': 't0',
  }, 'feat: start');
  for (let i = 1; i <= 6; i++) await commit(dir, { 'src/app.js': `a${i}` }, i <= 4 ? `fix(core): bug ${i}` : `feat: more ${i}`);
  for (let i = 1; i <= 6; i++) await commit(dir, { 'src/calm.js': `c${i}` }, i === 1 ? 'fix: once' : `feat: calm ${i}`);
  await git.run(dir, ['checkout', '-q', '-b', 'lane']);
  await commit(dir, {
    'package.json': JSON.stringify({ name: 'root', version: '2.0.0', dependencies: { left: '1.1.0', '@me/core': '1.0.0' } }),
    'src/app.js': 'lane', 'src/calm.js': 'lane', 'test/a.test.js': null,
  }, 'fix: the lane fixes calm.js too');
  for (let i = 0; i < 5; i++) await commit(dir, { 'src/calm.js': `lane ${i}` }, `fix: lane ${i}`);
  await git.run(dir, ['checkout', '-q', 'main']);
  await commit(dir, { 'other.js': 'main moved on' }, 'feat: main moves');

  cf._clearCache();
  const r = await cf.changeFacts(dir, 'main', 'lane');
  assert.equal(r.mergeBase, (await git.run(dir, ['merge-base', 'main', 'lane'])).trim());
  const byId = Object.fromEntries(flags(r).map((f) => [f.id, f.details]));
  assert.deepEqual(Object.keys(byId).sort(), ['dependencies', 'fragile', 'tests-deleted']);
  assert.deepEqual(byId.dependencies, ['left 1.0.0 → 1.1.0 (package.json)']);
  // calm.js had one fix before the branch; the branch's own fix commits don't make it fragile.
  assert.deepEqual(byId.fragile, ['src/app.js: 4 of 7 commits in 90 days were fixes']);
  assert.deepEqual(byId['tests-deleted'], ['test/a.test.js']);
  assert.ok(!r.size.areas.some((a) => a.area === '.' && a.files > 1), 'other.js on main is not part of the diff');
  // Same pair, same object; a moved head is a new entry.
  assert.equal(await cf.changeFacts(dir, 'main', 'lane'), r);
  await git.run(dir, ['checkout', '-q', 'lane']);
  await commit(dir, { 'README.md': 'hi' }, 'docs: readme');
  assert.notEqual(await cf.changeFacts(dir, 'main', 'lane'), r);
});

test('changeFacts IPC arguments are validated', () => {
  assert.deepEqual(check.checkGit('changeFacts', ['main', 'lane']).args, ['main', 'lane']);
  assert.throws(() => check.checkGit('changeFacts', ['main', '--output=/tmp/x']), check.IpcArgError);
  assert.throws(() => check.checkGit('changeFacts', ['main']), check.IpcArgError);
  assert.throws(() => check.checkGit('changeFacts', ['main', 'lane', 'extra']), check.IpcArgError);
});

test('changeFacts on a repository: a moved package or test file reads its old side', async () => {
  const dir = await repo();
  await commit(dir, {
    'packages/a/package.json': JSON.stringify({ name: 'a', dependencies: { 'left-pad': '1.0.0' } }),
    'test/old.test.js': `test.skip('x', () => {});\nconst a = 1;\nconst b = 2;\nconst c = 3;\n`,
  }, 'init');
  await git.run(dir, ['checkout', '-q', '-b', 'lane']);
  await git.run(dir, ['mv', 'packages/a', 'packages/b']);
  await git.run(dir, ['mv', 'test/old.test.js', 'test/new.test.js']);
  await git.run(dir, ['commit', '-q', '-m', 'move']);
  const r = await cf.changeFacts(dir, 'main', 'lane');
  assert.deepEqual(flags(r), []);
});
