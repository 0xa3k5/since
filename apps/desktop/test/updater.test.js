'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { compareVersions, buildFeed, readFeed, feedUrl, feedName, zipName, isSignedOutput } = require('../updater');
const pkg = require('../package.json');

test('compareVersions follows semver precedence', () => {
  const ordered = ['0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-beta.11', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '0.10.0', '1.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.strictEqual(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.strictEqual(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.strictEqual(compareVersions('1.2.3+build.5', '1.2.3'), 0);
});

test('garbage versions never count as newer', () => {
  for (const bad of ['', 'latest', '1.2', null, undefined, '1.2.3.4']) {
    assert.strictEqual(compareVersions(bad, '0.1.0'), -1, String(bad));
  }
});

test('a built feed reads back, in the shape Squirrel.Mac expects', () => {
  const feed = buildFeed({ version: '0.2.0', url: 'https://example.com/Since-0.2.0-arm64-mac.zip', notes: 'Fixes' });
  assert.strictEqual(feed.currentRelease, '0.2.0');
  assert.deepStrictEqual(Object.keys(feed.releases[0].updateTo).sort(), ['name', 'notes', 'pub_date', 'url', 'version']);
  assert.deepStrictEqual(readFeed(feed), { version: '0.2.0', url: 'https://example.com/Since-0.2.0-arm64-mac.zip', notes: 'Fixes' });
});

test('malformed feeds are rejected', () => {
  const good = buildFeed({ version: '0.2.0', url: 'https://example.com/a.zip' });
  const cases = [
    null,
    {},
    { ...good, currentRelease: 'nope' },
    { ...good, currentRelease: '0.3.0' }, // no matching release entry
    buildFeed({ version: '0.2.0', url: 'file:///etc/passwd' }),
    buildFeed({ version: '0.2.0', url: 42 }),
  ];
  for (const feed of cases) assert.throws(() => readFeed(feed), /malformed/);
});

test('feed URLs and the packaged zip names agree', () => {
  assert.strictEqual(feedUrl('https://x.test/dl/', 'arm64'), 'https://x.test/dl/update-mac-arm64.json');
  const config = require('../electron-builder.config.js');
  const expanded = config.mac.artifactName.replace('${productName}', 'Since').replace('${version}', '1.2.3').replace('${arch}', 'x64').replace('${ext}', 'zip');
  assert.strictEqual(expanded, zipName('1.2.3', 'x64'));
  assert.match(pkg.updates.feed, /^https:\/\//);
  assert.match(pkg.updates.page, /^https:\/\//);
});

test('update-feed.js writes one feed per zip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-feed-'));
  try {
    fs.writeFileSync(path.join(dir, zipName('0.3.0', 'arm64')), '');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'update-feed.js'), '--version', '0.3.0', '--base-url', 'https://dl.test/v0.3.0/', '--dir', dir], { stdio: 'pipe' });
    const feed = JSON.parse(fs.readFileSync(path.join(dir, feedName('arm64')), 'utf8'));
    assert.strictEqual(readFeed(feed).url, 'https://dl.test/v0.3.0/Since-0.3.0-arm64-mac.zip');
    assert.ok(!fs.existsSync(path.join(dir, feedName('x64'))), 'no x64 zip, so no x64 feed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only bundles with a real signing identity are handed to Squirrel', () => {
  assert.equal(isSignedOutput('Executable=/x\nAuthority=Developer ID Application: A (T)\nTeamIdentifier=T'), true);
  assert.equal(isSignedOutput('Authority=Since Update Test'), true);
  assert.equal(isSignedOutput('Executable=/x\nSignature=adhoc\nTeamIdentifier=not set'), false);
  assert.equal(isSignedOutput('/x: code object is not signed at all'), false);
  assert.equal(isSignedOutput(''), false);
});
