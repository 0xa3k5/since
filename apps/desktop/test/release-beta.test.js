'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextBetaVersion, parseArgs, pinnedPnpm, pnpmMismatch, wrongBuildVersion } = require('../scripts/release-beta');
const { planUploads, pruneList, r2Client, publish, PUBLIC_URL } = require('../scripts/beta-publish');

test('nextBetaVersion starts at beta.1 and counts up from the highest tag of this version', () => {
  assert.equal(nextBetaVersion('0.1.0', ['v0.1.0-rc.1', 'v0.1.0-rc.2']), '0.1.0-beta.1');
  assert.equal(nextBetaVersion('0.1.0', ['v0.1.0-beta.1', 'v0.1.0-beta.10', 'v0.1.0-beta.2', 'v0.2.0-beta.40']), '0.1.0-beta.11');
  assert.equal(nextBetaVersion('0.1.0', ['v0.1.0-beta.x', 'v0.1.0-beta.3.1']), '0.1.0-beta.1');
});

test('nextBetaVersion accepts an unused beta override and rejects anything else', () => {
  assert.equal(nextBetaVersion('0.1.0', ['v0.1.0-beta.1'], 'v0.1.0-beta.5'), '0.1.0-beta.5');
  assert.throws(() => nextBetaVersion('0.1.0', ['v0.1.0-beta.1'], '0.1.0-beta.1'), /already exists/);
  assert.throws(() => nextBetaVersion('0.1.0', [], '0.1.0-rc.1'), /not a beta version/);
});

test('parseArgs reads the version override and --skip-e2e, and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--', '0.1.0-beta.2', '--skip-e2e']), { skipE2e: true, version: '0.1.0-beta.2' });
  assert.deepEqual(parseArgs([]), { skipE2e: false, version: '' });
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
});

test('pnpmMismatch passes only the pinned pnpm, with or without a leading v, and says when pnpm is missing', () => {
  assert.equal(pinnedPnpm('pnpm@10.34.7'), '10.34.7');
  assert.equal(pinnedPnpm('pnpm@10.34.7+sha512.abc123'), '10.34.7');
  assert.equal(pinnedPnpm(undefined), '');
  assert.equal(pinnedPnpm('yarn@4.0.0'), '');
  assert.equal(pnpmMismatch('10.34.7', '10.34.7\n'), '');
  assert.equal(pnpmMismatch('10.34.7', 'v10.34.7'), '');
  assert.match(pnpmMismatch('10.34.7', '10.20.0'), /^pnpm 10\.20\.0 is on PATH, but this repo pins pnpm@10\.34\.7\./);
  assert.match(pnpmMismatch('10.34.7', '10.34.70'), /pins pnpm@10\.34\.7\./);
  assert.match(pnpmMismatch('10.34.7', ''), /pnpm was not found on PATH; this repo pins pnpm@10\.34\.7\./);
  assert.equal(pnpmMismatch('', '10.20.0'), '', 'no pin, nothing to compare');
});

const V = '0.1.0-beta.2';
const built = [`GitLanes-${V}-arm64.dmg`, `GitLanes-${V}-x64.dmg`, `GitLanes-${V}-arm64-mac.zip`, `GitLanes-${V}-x64-mac.zip`, 'update-mac-arm64.json', 'update-mac-x64.json'];

test('wrongBuildVersion names what electron-builder built when the version override did not apply', () => {
  assert.equal(wrongBuildVersion(V, [...built, 'mac-arm64', 'mac', 'builder-debug.yml']), '');
  assert.equal(wrongBuildVersion(V, [`GitLanes-${V}-arm64-mac.zip`]), '', 'any artifact of the version is enough; planUploads reports missing files');
  assert.equal(
    wrongBuildVersion(V, ['mac-arm64', 'GitLanes-0.1.0-arm64.dmg', 'GitLanes-0.1.0-arm64-mac.zip', 'GitLanes-0.1.0-x64.dmg', 'builder-debug.yml']),
    'electron-builder built GitLanes-0.1.0-arm64-mac.zip, GitLanes-0.1.0-arm64.dmg, GitLanes-0.1.0-x64.dmg instead of 0.1.0-beta.2; the version override did not apply.',
  );
  assert.match(wrongBuildVersion(V, []), /built no GitLanes-\* artifacts instead of 0\.1\.0-beta\.2/);
  // A build of beta.20 is not a build of beta.2.
  assert.match(wrongBuildVersion(V, ['GitLanes-0.1.0-beta.20-arm64.dmg']), /instead of 0\.1\.0-beta\.2;/);
});

test('planUploads puts versioned files first, then the latest DMGs, then the no-cache feeds', () => {
  const plan = planUploads(V, built);
  assert.deepEqual(plan.map((u) => u.key), [
    `beta/${V}/GitLanes-${V}-arm64.dmg`, `beta/${V}/GitLanes-${V}-arm64-mac.zip`,
    `beta/${V}/GitLanes-${V}-x64.dmg`, `beta/${V}/GitLanes-${V}-x64-mac.zip`,
    'beta/latest/GitLanes-arm64.dmg', 'beta/latest/GitLanes-x64.dmg',
    'beta/update-mac-arm64.json', 'beta/update-mac-x64.json',
  ]);
  assert.equal(plan[4].contentDisposition, `attachment; filename="GitLanes-${V}-arm64.dmg"`);
  assert.ok(plan.slice(6).every((u) => u.cacheControl === 'no-cache' && u.contentType === 'application/json'));
  assert.throws(() => planUploads(V, built.filter((f) => !f.endsWith('x64.dmg'))), /Missing build output: GitLanes-0\.1\.0-beta\.2-x64\.dmg/);
});

test('pruneList keeps the newest five versions in semver order and never the current one', () => {
  const versions = ['0.1.0-beta.1', '0.1.0-beta.10', '0.1.0-beta.2', '0.1.0-beta.3', '0.1.0-beta.9', '0.1.0-beta.4', 'latest'];
  assert.deepEqual(pruneList([...versions, '0.1.0-beta.11'], '0.1.0-beta.11'), ['0.1.0-beta.2', '0.1.0-beta.1']);
  assert.deepEqual(pruneList(versions, '0.1.0-beta.10'), ['0.1.0-beta.1']);
  assert.deepEqual(pruneList(versions, '0.1.0-beta.1'), []);
  assert.deepEqual(pruneList(['0.1.0-beta.1'], '0.1.0-beta.1'), []);
});

/** A fake bucket behind the HTTP layer: records every request in order. */
function fakeBucket(keys) {
  const objects = new Set(keys);
  const calls = [];
  const send = ({ method, url, file, headers }) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\/gitlanes-beta\/?/, ''));
    calls.push({ method, key, file, headers });
    if (method === 'PUT') { objects.add(key); return { status: 200, body: '' }; }
    if (method === 'DELETE') { objects.delete(key); return { status: 204, body: '' }; }
    const prefix = u.searchParams.get('prefix'), delimiter = u.searchParams.get('delimiter');
    const matching = [...objects].filter((k) => k.startsWith(prefix));
    const body = delimiter
      ? [...new Set(matching.map((k) => k.slice(prefix.length)).filter((r) => r.includes('/')).map((r) => prefix + r.split('/')[0] + '/'))]
        .map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')
      : matching.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
    return { status: 200, body: `<ListBucketResult><Prefix>${prefix}</Prefix>${body}<IsTruncated>false</IsTruncated></ListBucketResult>` };
  };
  return { objects, calls, send };
}

test('publish writes feeds, uploads in order, then prunes the oldest versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-beta-'));
  for (const f of built.filter((f) => !f.endsWith('.json'))) fs.writeFileSync(path.join(dir, f), 'x');
  const old = ['0.1.0-beta.1', '0.1.0-beta.0', '0.0.9-beta.1', '0.0.9-beta.2', '0.0.9-beta.3'];
  const bucket = fakeBucket([...old.flatMap((v) => [`beta/${v}/GitLanes-${v}-arm64.dmg`, `beta/${v}/GitLanes-${v}-x64.dmg`]), 'beta/latest/GitLanes-arm64.dmg', 'beta/update-mac-arm64.json']);
  const urls = publish({ version: V, dir, client: r2Client({ accountId: 'acct', send: bucket.send }), log: () => {} });

  const feed = JSON.parse(fs.readFileSync(path.join(dir, 'update-mac-arm64.json'), 'utf8'));
  assert.equal(feed.releases[0].updateTo.url, `${PUBLIC_URL}/beta/${V}/GitLanes-${V}-arm64-mac.zip`);

  const puts = bucket.calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.key), planUploads(V, built).map((u) => u.key));
  assert.equal(puts.at(-1).headers['Cache-Control'], 'no-cache');
  // Nothing is listed or deleted before the feeds are up.
  const lastPut = bucket.calls.lastIndexOf(puts.at(-1));
  assert.ok(bucket.calls.slice(0, lastPut).every((c) => c.method === 'PUT'));
  // Six versions now; the oldest (0.0.9-beta.1) goes, with every file in it.
  assert.deepEqual(bucket.calls.filter((c) => c.method === 'DELETE').map((c) => c.key), ['beta/0.0.9-beta.1/GitLanes-0.0.9-beta.1-arm64.dmg', 'beta/0.0.9-beta.1/GitLanes-0.0.9-beta.1-x64.dmg']);
  assert.ok(bucket.objects.has('beta/latest/GitLanes-arm64.dmg'));
  assert.deepEqual(urls, [`${PUBLIC_URL}/beta/latest/GitLanes-arm64.dmg`, `${PUBLIC_URL}/beta/latest/GitLanes-x64.dmg`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish stops at the first failed upload, before the feeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-beta-'));
  for (const f of built.filter((f) => !f.endsWith('.json'))) fs.writeFileSync(path.join(dir, f), 'x');
  const keys = [];
  const send = ({ method, url }) => { keys.push(url); return method === 'PUT' && url.includes('x64-mac.zip') ? { status: 403, body: 'AccessDenied' } : { status: 200, body: '' }; };
  assert.throws(() => publish({ version: V, dir, client: r2Client({ accountId: 'acct', send }), log: () => {} }), /HTTP 403 AccessDenied/);
  assert.ok(keys.every((u) => !u.includes('update-mac') && !u.includes('/latest/')));
  assert.throws(() => publish({ version: '0.1.0', dir, client: r2Client({ accountId: 'acct', send }) }), /Not a beta version/);
  fs.rmSync(dir, { recursive: true, force: true });
});
