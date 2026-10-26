'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planUploads, pruneList, r2Client, publish, PUBLIC_URL } = require('../scripts/bucket-publish');

const V = '0.1.0';
const built = [`Since-${V}-arm64.dmg`, `Since-${V}-x64.dmg`, `Since-${V}-arm64-mac.zip`, `Since-${V}-x64-mac.zip`, 'update-mac-arm64.json', 'update-mac-x64.json'];

test('planUploads puts versioned files first, then the latest DMGs, then the no-cache feeds', () => {
  const plan = planUploads(V, built);
  assert.deepEqual(plan.map((u) => u.key), [
    `beta/${V}/Since-${V}-arm64.dmg`, `beta/${V}/Since-${V}-arm64-mac.zip`,
    `beta/${V}/Since-${V}-x64.dmg`, `beta/${V}/Since-${V}-x64-mac.zip`,
    'beta/latest/Since-arm64.dmg', 'beta/latest/Since-x64.dmg',
    'beta/update-mac-arm64.json', 'beta/update-mac-x64.json',
  ]);
  assert.equal(plan[4].contentDisposition, `attachment; filename="Since-${V}-arm64.dmg"`);
  assert.ok(plan.slice(6).every((u) => u.cacheControl === 'no-cache' && u.contentType === 'application/json'));
  assert.throws(() => planUploads(V, built.filter((f) => !f.endsWith('x64.dmg'))), /Missing build output: Since-0\.1\.0-x64\.dmg/);
});

test('pruneList keeps the newest five versions in semver order and never the current one', () => {
  const versions = ['0.1.0-beta.1', '0.1.0-beta.10', '0.1.0-beta.2', '0.1.0-beta.3', '0.1.0-beta.9', '0.1.0-beta.4', 'latest'];
  assert.deepEqual(pruneList([...versions, '0.1.0-beta.11'], '0.1.0-beta.11'), ['0.1.0-beta.2', '0.1.0-beta.1']);
  assert.deepEqual(pruneList(versions, '0.1.0-beta.10'), ['0.1.0-beta.1']);
  assert.deepEqual(pruneList(versions, '0.1.0-beta.1'), []);
  assert.deepEqual(pruneList(['0.1.0-beta.1'], '0.1.0-beta.1'), []);
  // The final release sorts above every beta of the same version.
  assert.deepEqual(pruneList([...versions, '0.1.0'], '0.1.0'), ['0.1.0-beta.2', '0.1.0-beta.1']);
  assert.deepEqual(pruneList(['0.1.0-beta.1', '0.1.0', '0.1.0-beta.3', '0.1.0-beta.2'], '0.1.0', 1), ['0.1.0-beta.3', '0.1.0-beta.2', '0.1.0-beta.1']);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-beta-'));
  for (const f of built.filter((f) => !f.endsWith('.json'))) fs.writeFileSync(path.join(dir, f), 'x');
  const old = ['0.1.0-beta.1', '0.1.0-beta.0', '0.0.9-beta.1', '0.0.9-beta.2', '0.0.9-beta.3'];
  const bucket = fakeBucket([...old.flatMap((v) => [`beta/${v}/Since-${v}-arm64.dmg`, `beta/${v}/Since-${v}-x64.dmg`]), 'beta/latest/Since-arm64.dmg', 'beta/update-mac-arm64.json']);
  const urls = publish({ version: V, dir, client: r2Client({ accountId: 'acct', send: bucket.send }), log: () => {} });

  const feed = JSON.parse(fs.readFileSync(path.join(dir, 'update-mac-arm64.json'), 'utf8'));
  assert.equal(feed.releases[0].updateTo.url, `${PUBLIC_URL}/beta/${V}/Since-${V}-arm64-mac.zip`);

  const puts = bucket.calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.key), planUploads(V, built).map((u) => u.key));
  assert.equal(puts.at(-1).headers['Cache-Control'], 'no-cache');
  // Nothing is listed or deleted before the feeds are up.
  const lastPut = bucket.calls.lastIndexOf(puts.at(-1));
  assert.ok(bucket.calls.slice(0, lastPut).every((c) => c.method === 'PUT'));
  // Six versions now; the oldest (0.0.9-beta.1) goes, with every file in it.
  assert.deepEqual(bucket.calls.filter((c) => c.method === 'DELETE').map((c) => c.key), ['beta/0.0.9-beta.1/Since-0.0.9-beta.1-arm64.dmg', 'beta/0.0.9-beta.1/Since-0.0.9-beta.1-x64.dmg']);
  assert.ok(bucket.objects.has('beta/latest/Since-arm64.dmg'));
  assert.deepEqual(urls, [`${PUBLIC_URL}/beta/latest/Since-arm64.dmg`, `${PUBLIC_URL}/beta/latest/Since-x64.dmg`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish stops at the first failed upload, before the feeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-beta-'));
  for (const f of built.filter((f) => !f.endsWith('.json'))) fs.writeFileSync(path.join(dir, f), 'x');
  const keys = [];
  const send = ({ method, url }) => { keys.push(url); return method === 'PUT' && url.includes('x64-mac.zip') ? { status: 403, body: 'AccessDenied' } : { status: 200, body: '' }; };
  assert.throws(() => publish({ version: V, dir, client: r2Client({ accountId: 'acct', send }), log: () => {} }), /HTTP 403 AccessDenied/);
  assert.ok(keys.every((u) => !u.includes('update-mac') && !u.includes('/latest/')));
  assert.throws(() => publish({ version: '0.1.0-beta.3', dir, client: r2Client({ accountId: 'acct', send }) }), /Not a final version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

