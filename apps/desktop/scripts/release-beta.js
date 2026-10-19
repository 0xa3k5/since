'use strict';
// `pnpm release:beta`: builds, signs, notarizes and publishes a beta from AK's Mac, with no GitHub Actions.
//
//   pnpm release:beta [0.1.0-beta.3] [--skip-e2e]
//
// Preflight → next X.Y.Z-beta.N → pnpm test + pnpm test:e2e → signed beta build → codesign/spctl/stapler
// checks → feeds + R2 upload (beta-publish.js, shared with release.yml) → push the vX.Y.Z-beta.N tag.
// The R2 keys are read from the login keychain at run time and only handed to curl on stdin.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const publisher = require('./beta-publish');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const DIST = path.join(DESKTOP, 'dist');
const NOTARY_PROFILE = 'gitlanes-notary';
const KEYCHAIN = { accountId: 'gitlanes-r2-account-id', accessKeyId: 'gitlanes-r2-access-key-id', secretAccessKey: 'gitlanes-r2-secret-access-key' };

/** The next beta for `base` (e.g. 0.1.0) given existing tag names, or the override after checking it. */
function nextBetaVersion(base, tags, override) {
  const taken = new Set(tags.map((t) => String(t).trim().replace(/^v/, '')));
  if (override) {
    const v = override.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(v)) throw new Error(`${override} is not a beta version (expected e.g. ${base}-beta.1)`);
    if (taken.has(v)) throw new Error(`Tag v${v} already exists. Pick another version.`);
    return v;
  }
  const prefix = `${base}-beta.`;
  const ns = [...taken].filter((t) => t.startsWith(prefix) && /^\d+$/.test(t.slice(prefix.length))).map((t) => Number(t.slice(prefix.length)));
  return `${prefix}${ns.length ? Math.max(...ns) + 1 : 1}`;
}

/** The pnpm version pinned by the root package.json `packageManager` (`pnpm@10.34.7`, with or without a `+sha…` hash), or ''. */
const pinnedPnpm = (packageManager) => (String(packageManager || '').match(/^pnpm@(\d+\.\d+\.\d+[^+\s]*)/) || [])[1] || '';

/** Why the pnpm on PATH (`actual`, from `pnpm -v`) can't run this release, or '' when it is the pinned one. */
function pnpmMismatch(pinned, actual) {
  if (!pinned) return '';
  const have = String(actual || '').trim().replace(/^v/, '');
  if (!have) return `pnpm was not found on PATH; this repo pins pnpm@${pinned}.`;
  if (have !== pinned) return `pnpm ${have} is on PATH, but this repo pins pnpm@${pinned}. Another pnpm forwards arguments differently and has built a release under the wrong version before.`;
  return '';
}

/** Why `files` (apps/desktop/dist after a build) are not a build of `version`, or '' when its artifacts are there. */
function wrongBuildVersion(version, files) {
  const expected = new RegExp(`^GitLanes-${version.replace(/[.+]/g, '\\$&')}-(${publisher.ARCHES.join('|')})[-.]`);
  if (files.some((f) => expected.test(f))) return '';
  const built = files.filter((f) => /^GitLanes-.*\.(dmg|zip)$/.test(f)).sort();
  return `electron-builder built ${built.length ? built.join(', ') : 'no GitLanes-* artifacts'} instead of ${version}; the version override did not apply.`;
}

function parseArgs(argv) {
  const opts = { skipE2e: false, version: '' };
  for (const a of argv) {
    if (a === '--skip-e2e') opts.skipE2e = true;
    else if (a === '--') continue;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}. Usage: pnpm release:beta [X.Y.Z-beta.N] [--skip-e2e]`);
    else opts.version = a;
  }
  return opts;
}

// --- Shell helpers -------------------------------------------------------------------------------------

class Abort extends Error {}
const fail = (msg, fix) => { throw new Abort(fix ? `${msg}\n  Fix: ${fix}` : msg); };
const step = (msg) => console.log(`\n▸ ${msg}`);

/** Runs quietly and returns { ok, out }. Output is never echoed, so keychain reads can't leak. */
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Runs with inherited output and aborts on failure. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`);
}

function readKeychain(service) {
  const r = capture('security', ['find-generic-password', '-a', os.userInfo().username, '-s', service, '-w']);
  return r.ok && r.out ? r.out : '';
}

// --- Steps ---------------------------------------------------------------------------------------------

function preflight() {
  step('Preflight');
  if (process.platform !== 'darwin') fail('Releases are built on macOS.');
  // packageManager is only enforced through corepack; a stray global pnpm is the usual way a release goes wrong on a dev Mac.
  const pinned = pinnedPnpm(require(path.join(ROOT, 'package.json')).packageManager);
  const pnpm = pnpmMismatch(pinned, capture('pnpm', ['-v']).out);
  if (pnpm) fail(pnpm, `corepack enable && corepack prepare  (or: npm i -g pnpm@${pinned})`);
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch !== 'main') fail(`On branch "${branch}", not main.`, 'git switch main');
  if (capture('git', ['status', '--porcelain']).out) fail('The working tree has uncommitted changes.', 'commit or stash them, then run again');
  if (!capture('git', ['fetch', '--quiet', '--tags', 'origin', 'main']).ok) fail('git fetch origin failed.', 'check your network and GitHub access');
  if (capture('git', ['rev-parse', 'HEAD']).out !== capture('git', ['rev-parse', 'origin/main']).out) {
    fail('main is not the same as origin/main.', 'git pull --ff-only (and push any local commits through a PR)');
  }
  if (!capture('security', ['find-identity', '-v', '-p', 'codesigning']).out.includes('Developer ID Application')) {
    fail('No "Developer ID Application" certificate in the login keychain.',
      'import it in Keychain Access (File → Import Items…, the .p12 from developer.apple.com), then check with: security find-identity -v -p codesigning');
  }
  if (!capture('xcrun', ['notarytool', 'history', '--keychain-profile', NOTARY_PROFILE]).ok) {
    fail(`The notarytool keychain profile "${NOTARY_PROFILE}" is missing or doesn't work.`,
      `xcrun notarytool store-credentials ${NOTARY_PROFILE} --apple-id <apple-id> --team-id YCL3UNGMGC  (it asks for an app-specific password)`);
  }
  for (const service of Object.values(KEYCHAIN)) {
    if (!capture('security', ['find-generic-password', '-a', os.userInfo().username, '-s', service]).ok) {
      fail(`The keychain item "${service}" is missing.`, `security add-generic-password -a "$USER" -s ${service} -w  (it asks for the value)`);
    }
  }
  if (!capture('curl', ['--help', 'all']).out.includes('--aws-sigv4')) fail('This curl has no --aws-sigv4 support.', 'update macOS, or brew install curl and put it first on PATH');
}

function pickVersion(override) {
  const base = require(path.join(DESKTOP, 'package.json')).version;
  const tags = capture('git', ['tag', '-l', 'v*']).out.split('\n').filter(Boolean);
  try { return nextBetaVersion(base, tags, override); } catch (e) { return fail(e.message); }
}

function tests(skipE2e) {
  step('Unit tests');
  run('pnpm', ['test']);
  if (skipE2e) {
    console.warn('\n⚠ --skip-e2e: the end-to-end suite did not run. Only skip it for a build you have already tested.');
    return;
  }
  step('End-to-end tests');
  run('pnpm', ['test:e2e']);
}

function build(version) {
  step(`Build ${version} (signed, notarized, GITLANES_STORE=beta)`);
  fs.rmSync(DIST, { recursive: true, force: true });
  const env = { ...process.env, GITLANES_STORE: 'beta', APPLE_KEYCHAIN_PROFILE: NOTARY_PROFILE };
  // Only the keychain profile notarizes; stray Apple ID or API key variables would take precedence.
  for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete env[k];
  // The version goes through the environment (electron-builder.config.js reads GITLANES_VERSION): a `--`
  // argument has to cross two `pnpm run` layers and not every pnpm strips it, which built 0.1.0 as beta.2 (AK-571).
  run('pnpm', ['dist'], { env: { ...env, GITLANES_VERSION: version } });
  const wrong = wrongBuildVersion(version, fs.existsSync(DIST) ? fs.readdirSync(DIST) : []);
  if (wrong) fail(wrong, 'GITLANES_VERSION must reach apps/desktop/electron-builder.config.js through `pnpm dist`');
}

function verifyApp(app) {
  for (const [cmd, args] of [
    ['codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]],
    ['spctl', ['-a', '-t', 'exec', '-vv', app]],
    ['xcrun', ['stapler', 'validate', app]],
  ]) {
    const r = capture(cmd, args);
    if (!r.ok) fail(`${cmd} rejected ${path.relative(ROOT, app)}:\n${r.err || r.out}`);
  }
}

/** Checks every built app, and the app inside every DMG (what a downloader actually opens). */
function verify(version) {
  step('Verify signatures and notarization');
  const apps = fs.readdirSync(DIST).filter((d) => d.startsWith('mac')).map((d) => path.join(DIST, d, 'GitLanes.app')).filter((p) => fs.existsSync(p));
  if (!apps.length) fail('No GitLanes.app in apps/desktop/dist.');
  for (const app of apps) { verifyApp(app); console.log(`  ✓ ${path.relative(ROOT, app)}`); }
  for (const arch of publisher.ARCHES) {
    const dmg = path.join(DIST, publisher.dmgName(version, arch));
    if (!fs.existsSync(dmg)) fail(`${path.relative(ROOT, dmg)} is missing (an unsigned build is named …-unsigned.dmg).`);
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-dmg-'));
    const attached = capture('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
    if (!attached.ok) fail(`Could not open ${path.basename(dmg)}: ${attached.err}`);
    try { verifyApp(path.join(mount, 'GitLanes.app')); } finally { capture('hdiutil', ['detach', mount, '-quiet']); fs.rmSync(mount, { recursive: true, force: true }); }
    console.log(`  ✓ ${path.basename(dmg)}`);
  }
}

function upload(version) {
  step('Write feeds and upload to R2');
  const creds = Object.fromEntries(Object.entries(KEYCHAIN).map(([k, service]) => [k, readKeychain(service)]));
  const empty = Object.entries(creds).filter(([, v]) => !v).map(([k]) => KEYCHAIN[k]);
  if (empty.length) fail(`Could not read ${empty.join(', ')} from the keychain.`, 'allow access when macOS asks, or re-add the item with security add-generic-password -U');
  const client = publisher.r2Client({ accountId: creds.accountId, send: publisher.curlSender(creds) });
  try { return publisher.publish({ version, dir: DIST, client }); } catch (e) { return fail(e.message); }
}

function tag(version) {
  step(`Tag v${version}`);
  run('git', ['tag', '-a', `v${version}`, '-m', `GitLanes ${version} (beta)`]);
  run('git', ['push', 'origin', `refs/tags/v${version}`]);
}

function main(argv) {
  const opts = parseArgs(argv);
  preflight();
  const version = pickVersion(opts.version);
  console.log(`  version: ${version}`);
  tests(opts.skipE2e);
  build(version);
  verify(version);
  const urls = upload(version);
  tag(version);
  console.log(`\n✓ GitLanes ${version} is live${opts.skipE2e ? ' (e2e skipped)' : ''}.`);
  for (const u of urls) console.log(`  ${u}`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) {
    console.error(`\n✗ ${e instanceof Abort ? e.message : e.stack}`);
    process.exit(1);
  }
}

module.exports = { nextBetaVersion, parseArgs, pinnedPnpm, pnpmMismatch, wrongBuildVersion };
