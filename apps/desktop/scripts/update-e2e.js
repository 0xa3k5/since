'use strict';
// End-to-end auto-update test against two local test releases. macOS only; takes a few minutes.
//
//   pnpm --filter @gitsince/desktop test:update [-- --keep]
//
// 1. Creates a throwaway keychain holding a self-signed code-signing certificate. Squirrel.Mac only
//    installs an update signed by the same identity as the running app, so ad-hoc builds can't update.
// 2. Packages the app twice (host arch, `dir` target) as 0.0.1 and 0.0.2, both with the update feed
//    pointing at a local HTTP server, and signs both with that certificate.
// 3. Zips 0.0.2 and writes its feed with scripts/update-feed.js, exactly as a release does.
// 4. Installs 0.0.1 into a temp "Applications" folder and launches it with a test repository and the
//    Chrome DevTools port open, then waits for the "Restart to update" toast (taking light and dark
//    screenshots), and clicks it.
// 5. Checks the installed bundle is now 0.0.2 and that it relaunched, then stops it and cleans up.
//
// Nothing outside the temp dir is touched except Squirrel's own cache
// (~/Library/Caches/com.gitsince.app.ShipIt) and the relaunched app's default userData folder.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { feedName, zipName } = require('../updater');

const APP_DIR = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const ARCH = process.arch;
const OLD = '0.0.1', NEW = '0.0.2';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-update-e2e-')));
const shots = path.join(APP_DIR, 'test-results', 'update-e2e');
const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) || '').trim();
const step = (msg) => console.log(`\n▸ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plistVersion = (app) => run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents', 'Info.plist')]);

async function until(what, fn, timeout = 120_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

function makeIdentity() {
  const kc = path.join(tmp, 'update-e2e.keychain-db');
  const pw = 'since-e2e';
  const cnf = path.join(tmp, 'cert.cnf');
  fs.writeFileSync(cnf, [
    '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
    '[dn]', 'CN = Since Update E2E',
    '[ext]', 'basicConstraints = critical,CA:false', 'keyUsage = critical,digitalSignature', 'extendedKeyUsage = critical,codeSigning',
  ].join('\n'));
  const key = path.join(tmp, 'key.pem'), crt = path.join(tmp, 'cert.pem'), p12 = path.join(tmp, 'cert.p12');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', cnf, '-keyout', key, '-out', crt]);
  const legacy = /OpenSSL 3/.test(run('openssl', ['version'])) ? ['-legacy'] : [];
  run('openssl', ['pkcs12', '-export', ...legacy, '-inkey', key, '-in', crt, '-out', p12, '-passout', `pass:${pw}`]);
  run('security', ['create-keychain', '-p', pw, kc]);
  run('security', ['set-keychain-settings', kc]); // no auto-lock
  run('security', ['unlock-keychain', '-p', pw, kc]);
  run('security', ['import', p12, '-k', kc, '-P', pw, '-T', '/usr/bin/codesign']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', pw, kc]);
  const hash = run('openssl', ['x509', '-in', crt, '-noout', '-fingerprint', '-sha1']).split('=')[1].replace(/:/g, '');
  return { kc, hash, cleanup: () => { try { run('security', ['delete-keychain', kc]); } catch {} } };
}

function build(version, feed) {
  const out = path.join(tmp, `build-${version}`);
  const cfg = path.join(tmp, `builder-${version}.js`);
  fs.writeFileSync(cfg, `const base = require(${JSON.stringify(path.join(APP_DIR, 'electron-builder.config.js'))});
module.exports = { ...base, directories: { ...base.directories, output: ${JSON.stringify(out)} },
  extraMetadata: { version: ${JSON.stringify(version)}, updates: { feed: ${JSON.stringify(feed)}, page: ${JSON.stringify(feed)} } } };\n`);
  run('pnpm', ['exec', 'electron-builder', '--mac', 'dir', `--${ARCH}`, '--projectDir', APP_DIR, '--config', cfg, '--publish', 'never'], { cwd: APP_DIR, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  const app = path.join(out, ARCH === 'arm64' ? 'mac-arm64' : 'mac', 'Since.app');
  if (plistVersion(app) !== version) throw new Error(`${app} is not ${version}`);
  return app;
}

function sign(app, id) {
  run('codesign', ['--force', '--deep', '--sign', id.hash, '--keychain', id.kc, app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  fs.mkdirSync(shots, { recursive: true });
  const served = path.join(tmp, 'served');
  fs.mkdirSync(served);
  const server = http.createServer((req, res) => {
    const file = path.join(served, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
    console.log(`  [server] ${req.method} ${req.url}`);
    if (!file.startsWith(served + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feed = `http://127.0.0.1:${server.address().port}`;
  const id = makeIdentity();
  let child, relaunched = [];
  try {
    step(`Building ${OLD} and ${NEW} (${ARCH}), feed ${feed}`);
    const oldApp = build(OLD, feed), newApp = build(NEW, feed);
    step('Signing both with the throwaway certificate');
    sign(oldApp, id); sign(newApp, id);

    step(`Publishing ${NEW}: zip + feed`);
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', newApp, path.join(served, zipName(NEW, ARCH))]);
    run(process.execPath, [path.join(__dirname, 'update-feed.js'), '--version', NEW, '--base-url', feed, '--dir', served, '--notes', 'Update e2e']);
    console.log(fs.readFileSync(path.join(served, feedName(ARCH)), 'utf8'));

    step(`Installing ${OLD} and launching it`);
    const installed = path.join(tmp, 'Applications', 'Since.app');
    fs.mkdirSync(path.dirname(installed));
    run('ditto', [oldApp, installed]);
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-q', '--allow-empty', '-m', 'first']]) run('git', args, { cwd: repo });
    const userData = path.join(tmp, 'userdata');
    fs.mkdirSync(userData);
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    const cdp = 9300 + Math.floor(Math.random() * 500);
    const exe = path.join(installed, 'Contents', 'MacOS', 'Since');
    // --use-mock-keychain: each run signs with a new identity, so macOS would otherwise prompt for the
    // "Since Safe Storage" keychain item (cookie encryption) and block the window until answered.
    // -ApplePersistenceIgnoreState: skip the "reopen windows?" alert after an earlier run was killed.
    child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdp}`, '--use-mock-keychain', repo, '-ApplePersistenceIgnoreState', 'YES'], { stdio: ['ignore', 'inherit', 'inherit'] });
    const exited = new Promise((r) => child.once('exit', r));

    const browser = await until('DevTools', () => chromium.connectOverCDP(`http://127.0.0.1:${cdp}`), 120_000);
    const page = await until('the window', async () => {
      const pages = browser.contexts().flatMap((c) => c.pages());
      return pages.find((p) => p.url().includes('index.html'));
    }, 120_000);
    const ready = page.locator('.toast', { hasText: `Since ${NEW} is ready` });
    step('Waiting for the background download');
    let last = '';
    await until('the "Restart to update" toast', async () => {
      const st = await page.evaluate(() => window.since.app('update-state'));
      const line = `${st.status}${st.version ? ` ${st.version}` : ''}${st.error ? `: ${st.error}` : ''}`;
      if (line !== last) console.log(`  [app] ${(last = line)}`);
      return ready.isVisible();
    }, 240_000);
    console.log('  ✓ "Restart to update" toast shown');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, 'ready-dark.png') });
    await page.locator('.sb-top button[title^="Command menu"]').click();
    await page.locator('.palette-input').fill('Theme: Light');
    await page.locator('.palette-input').press('Enter');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, 'ready-light.png') });

    step('Clicking "Restart to update"');
    await ready.locator('.toast-action').click();
    await Promise.race([exited, sleep(30_000).then(() => { throw new Error(`${OLD} did not quit`); })]);
    browser.close().catch(() => {});
    console.log(`  ✓ ${OLD} quit`);
    await until(`the installed app to become ${NEW}`, async () => plistVersion(installed) === NEW, 90_000);
    console.log(`  ✓ installed bundle is now ${NEW}`);
    run('codesign', ['--verify', '--deep', '--strict', installed]);
    relaunched = await until('the relaunch', async () => {
      const pids = run('pgrep', ['-f', `^${exe}`]).split('\n').filter(Boolean).map(Number);
      return pids.length ? pids : null;
    }, 30_000);
    console.log(`  ✓ ${NEW} relaunched (pid ${relaunched.join(', ')})`);
    console.log(`\nPASS. Screenshots in ${path.relative(process.cwd(), shots)}`);
  } finally {
    // Stop only the processes we started from the temp bundle.
    try { for (const pid of run('pgrep', ['-f', `^${path.join(tmp, 'Applications')}`]).split('\n').filter(Boolean)) process.kill(Number(pid)); } catch {}
    if (child && child.exitCode === null) child.kill();
    server.close();
    id.cleanup();
    if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`Kept ${tmp}`);
  }
}

main().catch((err) => { console.error(`\nFAIL: ${err.stack || err}`); process.exit(1); });
