'use strict';
// One last upload to the Cloudflare R2 bucket the beta builds read their update feed from. Beta installs
// only accept a feed on that host (updater.js limits the update session to the feed's origin), so they
// can't follow a feed on GitHub. This publishes the final release to the bucket; once a beta install
// updates to it, it reads GitHub Releases like every other build. The bucket and this script go once
// the beta installs have moved.
//
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node scripts/bucket-publish.js --version 0.1.0 [--dir dist]
//
// --dir must hold these four files from the v0.1.0 GitHub Release:
//   Since-0.1.0-arm64.dmg  Since-0.1.0-x64.dmg  Since-0.1.0-arm64-mac.zip  Since-0.1.0-x64-mac.zip
// The script writes update-mac-arm64.json and update-mac-x64.json next to them itself (pointing at the
// bucket, not GitHub), so don't download the GitHub Release's feeds into the same folder. Squirrel only
// installs an update signed by the same Developer ID as the running beta, so the release must be signed.
//
// Bucket layout: beta/<version>/ holds the DMGs and update zips, beta/latest/Since-<arch>.dmg are stable
// download links, and beta/update-mac-<arch>.json are the feeds. Versioned files go up first and the
// feeds last, so a feed never names a file that isn't there yet. The last KEEP versions are kept.
//
// The HTTP layer is curl's built-in SigV4 signing (no aws CLI, no npm S3 client). The keys go to curl
// through a config on stdin, never through argv, so they don't show up in `ps`.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { compareVersions, parseVersion, feedName, zipName } = require('../updater');

const BUCKET = 'gitlanes-beta';
// The feed host baked into every beta build.
const PUBLIC_URL = 'https://pub-1b56c7c361874048ab3f67ebe6cdac1b.r2.dev';
const ARCHES = ['arm64', 'x64'];
const KEEP = 5;

const dmgName = (version, arch) => `Since-${version}-${arch}.dmg`;
const baseUrl = (version) => `${PUBLIC_URL}/beta/${version}`;
const downloadUrls = () => ARCHES.map((arch) => `${PUBLIC_URL}/beta/latest/Since-${arch}.dmg`);

/** Writes update-mac-<arch>.json into dir with update-feed.js, pointing at this version's folder in the bucket. */
function writeFeeds(version, dir) {
  execFileSync(process.execPath, [path.join(__dirname, 'update-feed.js'), '--version', version, '--base-url', baseUrl(version), '--dir', dir], { stdio: 'inherit' });
}

/** The uploads in order: versioned files, then the stable latest DMGs, then the feeds. Throws if a file is missing. */
function planUploads(version, files) {
  const need = ARCHES.flatMap((arch) => [dmgName(version, arch), zipName(version, arch), feedName(arch)]);
  const missing = need.filter((f) => !files.includes(f));
  if (missing.length) throw new Error(`Missing build output: ${missing.join(', ')}`);
  const immutable = 'public, max-age=31536000, immutable';
  return [
    ...ARCHES.flatMap((arch) => [
      { file: dmgName(version, arch), key: `beta/${version}/${dmgName(version, arch)}`, cacheControl: immutable, contentType: 'application/x-apple-diskimage' },
      { file: zipName(version, arch), key: `beta/${version}/${zipName(version, arch)}`, cacheControl: immutable, contentType: 'application/zip' },
    ]),
    ...ARCHES.map((arch) => ({
      file: dmgName(version, arch), key: `beta/latest/Since-${arch}.dmg`, cacheControl: 'public, max-age=300',
      contentType: 'application/x-apple-diskimage', contentDisposition: `attachment; filename="${dmgName(version, arch)}"`,
    })),
    ...ARCHES.map((arch) => ({ file: feedName(arch), key: `beta/${feedName(arch)}`, cacheControl: 'no-cache', contentType: 'application/json' })),
  ];
}

/** Versions to delete: everything but the newest `keep` (semver order, as the updater compares), never `current`. */
function pruneList(versions, current, keep = KEEP) {
  const sorted = versions.filter(parseVersion).sort(compareVersions).reverse();
  return sorted.slice(keep).filter((v) => v !== current);
}

const xmlValues = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);

/** An S3 client for one R2 bucket. `send` is the HTTP layer: ({ method, url, file?, headers }) → { status, body }. */
function r2Client({ accountId, bucket = BUCKET, send }) {
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
  const call = (method, key, { query = '', file, headers = {} } = {}) => {
    const url = `${endpoint}/${key.split('/').map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;
    const res = send({ method, url, file, headers });
    if (res.status < 200 || res.status >= 300) throw new Error(`R2 ${method} ${key || '/'} failed: HTTP ${res.status} ${String(res.body).slice(0, 300)}`);
    return res.body;
  };
  // ListObjectsV2, following continuation tokens.
  const list = (prefix, delimiter) => {
    const out = { keys: [], prefixes: [] };
    let token = '';
    do {
      const q = ['list-type=2', `prefix=${encodeURIComponent(prefix)}`];
      if (delimiter) q.push(`delimiter=${encodeURIComponent(delimiter)}`);
      if (token) q.push(`continuation-token=${encodeURIComponent(token)}`);
      const xml = call('GET', '', { query: q.join('&') });
      out.keys.push(...xmlValues(xml, 'Key'));
      out.prefixes.push(...xmlValues(xml, 'Prefix').filter((p) => p !== prefix));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xmlValues(xml, 'NextContinuationToken')[0] || '') : '';
    } while (token);
    return out;
  };
  return {
    put: (key, file, { cacheControl, contentType, contentDisposition } = {}) => call('PUT', key, {
      file,
      headers: { 'Cache-Control': cacheControl, 'Content-Type': contentType, 'Content-Disposition': contentDisposition },
    }),
    remove: (key) => call('DELETE', key),
    list,
  };
}

/** curl as the HTTP layer. Credentials arrive on stdin as a curl config, so they never appear in argv. */
function curlSender({ accessKeyId, secretAccessKey }) {
  if (!/^[\w-]+$/.test(accessKeyId) || !/^[\w+/=-]+$/.test(secretAccessKey)) throw new Error('R2 access key id or secret has unexpected characters');
  const config = `user = "${accessKeyId}:${secretAccessKey}"\n`;
  return ({ method, url, file, headers = {} }) => {
    const args = ['-sS', '--retry', '3', '--aws-sigv4', 'aws:amz:auto:s3', '-K', '-', '-X', method, '-o', '-', '-w', '\n%{http_code}'];
    // R2 accepts unsigned payloads, so curl doesn't have to hash a 150 MB DMG.
    if (file) args.push('-T', file, '-H', 'x-amz-content-sha256: UNSIGNED-PAYLOAD');
    for (const [k, v] of Object.entries(headers)) if (v) args.push('-H', `${k}: ${v}`);
    args.push(url);
    const r = spawnSync('curl', args, { input: config, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`curl ${method} ${url} failed (exit ${r.status}): ${String(r.stderr).trim()}`);
    const i = r.stdout.lastIndexOf('\n');
    return { status: Number(r.stdout.slice(i + 1)), body: r.stdout.slice(0, i) };
  };
}

/** Writes the feeds, uploads in order, prunes. Returns the website download URLs. */
function publish({ version, dir, client, log = console.log }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a final version: ${version}`);
  writeFeeds(version, dir);
  for (const u of planUploads(version, fs.readdirSync(dir))) {
    log(`  • ${u.key}`);
    client.put(u.key, path.join(dir, u.file), u);
  }
  const versions = client.list('beta/', '/').prefixes.map((p) => p.replace(/^beta\//, '').replace(/\/$/, ''));
  for (const old of pruneList(versions, version)) {
    log(`  • removing beta/${old}/`);
    for (const key of client.list(`beta/${old}/`).keys) client.remove(key);
  }
  return downloadUrls();
}

if (require.main === module) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!args.version || !R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.error('usage: R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… bucket-publish.js --version <x.y.z> [--dir <dist>]');
    process.exit(2);
  }
  try {
    const client = r2Client({ accountId: R2_ACCOUNT_ID, send: curlSender({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }) });
    const urls = publish({ version: args.version, dir: path.resolve(args.dir || path.join(__dirname, '..', 'dist')), client });
    console.log(`Uploaded ${args.version}: ${urls.join(', ')}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { BUCKET, PUBLIC_URL, ARCHES, KEEP, dmgName, baseUrl, downloadUrls, writeFeeds, planUploads, pruneList, r2Client, curlSender, publish };
