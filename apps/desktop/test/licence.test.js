'use strict';
// Trial clock, licence validation and the Polar adapter. No network: Polar is replayed from fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Licensing, DAY } = require('../licence');
const { polarStore, mockStore, createStore, StoreError } = require('../licence/stores');
const { loadConfig, releaseProfile, PROFILES } = require('../licence/config');

const T0 = Date.parse('2026-10-13T12:00:00Z');
const config = { ...loadConfig({ GITLANES_STORE: 'sandbox' }) };
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'polar', name + '.json'), 'utf8'));

// A Licensing instance on a fake clock, with its files in a throwaway temp dir.
function setup({ store = mockStore(config), machine = 'mac-A', dir } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-licence-'));
  const clock = { t: T0 };
  const files = { stateFile: path.join(dir, 'state', 'licence.json'), mirrorFile: path.join(dir, 'prefs', 'trial') };
  const make = (opts = {}) => new Licensing({ ...files, config, store, machine, now: () => clock.t, ...opts });
  return { dir, clock, files, store, make, lic: make() };
}

test('trial: starts on first launch and counts down 14 days', () => {
  const { clock, lic } = setup();
  let s = lic.status();
  assert.equal(s.mode, 'trial');
  assert.equal(s.trialDaysLeft, 14);
  assert.equal(s.canMutate, true);
  clock.t = T0 + 13.5 * DAY;
  s = lic.status();
  assert.equal(s.trialDaysLeft, 1);
  assert.equal(s.canMutate, true);
  clock.t = T0 + 14 * DAY;
  s = lic.status();
  assert.equal(s.mode, 'expired');
  assert.equal(s.trialDaysLeft, 0);
  assert.equal(s.canMutate, false);
});

test('trial: survives restarts and does not restart', () => {
  const { clock, make } = setup();
  clock.t = T0 + 10 * DAY;
  assert.equal(make().status().trialDaysLeft, 4);
  clock.t = T0 + 20 * DAY;
  assert.equal(make().status().mode, 'expired');
});

test('trial: rolling the clock back does not extend it', () => {
  const { clock, make, lic } = setup();
  clock.t = T0 + 15 * DAY;
  assert.equal(lic.status().mode, 'expired');
  clock.t = T0 + 1 * DAY; // user sets the clock back
  assert.equal(lic.status().mode, 'expired', 'same session');
  assert.equal(make().status().mode, 'expired', 'after restart');
  clock.t = T0 - 30 * DAY; // before the trial even started
  assert.equal(make().status().mode, 'expired');
});

test('trial: rolling back mid-trial freezes the countdown instead of rewinding it', () => {
  const { clock, make } = setup();
  clock.t = T0 + 10 * DAY;
  make().status();
  clock.t = T0 + 2 * DAY;
  assert.equal(make().status().trialDaysLeft, 4);
});

test('trial: deleting one state file keeps the trial clock', () => {
  const { clock, files, make } = setup();
  clock.t = T0 + 20 * DAY;
  make().status();
  fs.rmSync(files.stateFile);
  assert.equal(make().status().mode, 'expired', 'mirror remembers');
  fs.rmSync(files.mirrorFile);
  make(); // rewrites both from the state file
  fs.rmSync(files.mirrorFile);
  assert.equal(make().status().mode, 'expired', 'state file remembers');
});

test('trial: deleting both files is a fresh install', () => {
  const { clock, files, make } = setup();
  clock.t = T0 + 20 * DAY;
  make();
  fs.rmSync(files.stateFile);
  fs.rmSync(files.mirrorFile);
  assert.equal(make().status().mode, 'trial');
});

test('tamper: edited state is not trusted and does not grant a new trial', () => {
  const { clock, files, make } = setup();
  clock.t = T0 + 20 * DAY;
  make();
  for (const f of [files.stateFile, files.mirrorFile]) {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.payload.trialStart = clock.t; // try to restart the trial without re-signing
    fs.writeFileSync(f, JSON.stringify(doc));
  }
  assert.equal(make().status().mode, 'expired');
});

test('tamper: state copied from another Mac is not trusted', async () => {
  const a = setup({ machine: 'mac-A' });
  await a.lic.activate('GL-TEST-COPY-1234');
  const b = setup({ machine: 'mac-B', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-licence-')) });
  fs.mkdirSync(path.dirname(b.files.stateFile), { recursive: true });
  fs.copyFileSync(a.files.stateFile, b.files.stateFile);
  const s = b.make().status();
  assert.equal(s.licence, null, 'the copied licence is ignored');
  assert.equal(s.mode, 'trial', 'Mac B keeps only its own trial');
});

test('licence: activates with a test key, unlocks mutations after the trial and persists', async () => {
  const { clock, make, lic } = setup();
  clock.t = T0 + 30 * DAY;
  assert.equal(lic.canMutate(), false);
  const s = await lic.activate('  GL-TEST-ABCD-1234 ');
  assert.equal(s.mode, 'licensed');
  assert.equal(s.canMutate, true);
  assert.equal(s.licence.maskedKey, 'GL-T••••1234');
  assert.equal(s.licence.key, undefined, 'the full key is not exposed to the UI');
  assert.equal(make().status().mode, 'licensed');
});

test('licence: invalid key and activation limit are reported, state unchanged', async () => {
  const { lic } = setup();
  await assert.rejects(lic.activate('nope'), (e) => e instanceof StoreError && e.kind === 'rejected');
  await assert.rejects(lic.activate('GL-TEST-FULL-0001'), (e) => e.kind === 'limit' && /3 Macs/.test(e.message));
  await assert.rejects(lic.activate(''), (e) => e.kind === 'rejected');
  assert.equal(lic.status().mode, 'trial');
});

test('licence: works offline for 30 days after the last validation, then asks again', async () => {
  const { clock, store, make, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-GRACE-0001');
  const offline = { ...store, validate: async () => { throw new StoreError('network', 'offline'); } };
  clock.t = T0 + 49 * DAY;
  let l = make({ store: offline });
  let s = await l.refresh();
  assert.equal(s.mode, 'licensed');
  assert.equal(s.licence.offlineDaysLeft, 1);
  assert.equal(s.lastError, 'offline');
  clock.t = T0 + 50 * DAY + 1;
  s = await make({ store: offline }).refresh();
  assert.equal(s.mode, 'unverified');
  assert.equal(s.canMutate, false);
  // Back online: one good validation restores it and restarts the grace period.
  l = make();
  s = await l.refresh();
  assert.equal(s.mode, 'licensed');
  assert.equal(s.licence.offlineDaysLeft, 30);
});

test('licence: rolling the clock back does not stretch the offline grace period', async () => {
  const { clock, store, make, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-ROLL-0001');
  clock.t = T0 + 60 * DAY;
  const offline = { ...store, validate: async () => { throw new StoreError('network', 'offline'); } };
  assert.equal((await make({ store: offline }).refresh()).mode, 'unverified');
  clock.t = T0 + 25 * DAY;
  assert.equal(make({ store: offline }).status().mode, 'unverified');
});

test('licence: a revoked or refunded key goes read-only but stays stored as revoked', async () => {
  const { clock, make, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-REVOKED-0001');
  const s = await lic.refresh();
  assert.equal(s.mode, 'revoked');
  assert.equal(s.canMutate, false);
  assert.equal(s.licence.revoked, true);
  assert.equal(s.licence.maskedKey, 'GL-T••••0001', 'the key is kept so it can be re-checked or deactivated');
  assert.equal(s.notice.kind, 'revoked');
  assert.equal(make().status().mode, 'revoked', 'persists across restarts');
  lic.dismissNotice();
  assert.equal(lic.status().notice, null);
  assert.equal(lic.status().mode, 'revoked');
});

test('licence: a revoked key during the trial keeps the trial running', async () => {
  const { lic } = setup();
  await lic.activate('GL-TEST-REVOKED-0002');
  const s = await lic.refresh();
  assert.equal(s.mode, 'revoked');
  assert.equal(s.canMutate, true);
});

test('licence: re-checking a revoked key restores it when the store accepts it again', async () => {
  const { clock, store, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-BACK-0001');
  const validate = store.validate;
  store.validate = async () => { throw new StoreError('rejected', 'gone'); };
  assert.equal((await lic.refresh()).mode, 'revoked');
  store.validate = validate;
  const s = await lic.refresh();
  assert.equal(s.mode, 'licensed');
  assert.equal(s.licence.revoked, false);
  assert.equal(s.notice, null);
});

test('licence: a revoked key can be deactivated, even when the server already dropped it or is offline', async () => {
  const { clock, store, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-REVOKED-0003');
  await lic.refresh();
  store.deactivate = async () => { throw new StoreError('network', 'offline'); };
  const s = await lic.deactivate();
  assert.equal(s.licence, null);
  assert.equal(s.mode, 'expired');
});

test('licence: network trouble never revokes or deletes a stored key', async () => {
  const { clock, store, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-KEEP-0001');
  for (const kind of ['network', 'invalid', 'config']) {
    store.validate = async () => { throw new StoreError(kind, `${kind} trouble`); };
    const s = await lic.refresh();
    assert.equal(s.mode, 'licensed', kind);
    assert.equal(s.lastError, `${kind} trouble`);
  }
});

test('licence: re-validates about daily in long sessions, and retries failed checks hourly', async () => {
  const { clock, store, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-LONG-0001');
  let calls = 0;
  const validate = store.validate;
  store.validate = async (a) => { calls++; return validate(a); };
  clock.t += 23 * 3600e3;
  assert.equal(lic.maybeRefresh(), null, 'not due yet');
  clock.t += 2 * 3600e3;
  assert.equal((await lic.maybeRefresh()).mode, 'licensed');
  assert.equal(calls, 1);
  assert.equal(lic.maybeRefresh(), null, 'just validated');
  // Offline for a while: one attempt per hour, not one per focus.
  store.validate = async () => { calls++; throw new StoreError('network', 'offline'); };
  clock.t += DAY + 1;
  await lic.maybeRefresh();
  assert.equal(lic.maybeRefresh(), null);
  clock.t += 3600e3;
  await lic.maybeRefresh();
  assert.equal(calls, 3);
});

test('licence: concurrent refreshes share one request', async () => {
  const { store, lic } = setup();
  await lic.activate('GL-TEST-ONCE-0001');
  let calls = 0;
  const validate = store.validate;
  store.validate = async (a) => { calls++; return validate(a); };
  await Promise.all([lic.refresh(), lic.refresh(), lic.refresh()]);
  assert.equal(calls, 1);
});

test('licence: past the offline grace, a change re-checks the licence before being refused', async () => {
  const { clock, store, make, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-GATE-0001');
  clock.t = T0 + 51 * DAY; // a session left open past validatedAt + 30 days
  const l = make();
  assert.equal(l.canMutate(), false);
  assert.equal(await l.ensureCanMutate(), true, 'online: silently re-validated');
  clock.t = T0 + 90 * DAY;
  store.validate = async () => { throw new StoreError('network', 'offline'); };
  assert.equal(await make().ensureCanMutate(), false, 'offline: stays read-only');
});

test('licence: deactivating frees the seat and returns to the trial state', async () => {
  const { lic, store } = setup();
  await lic.activate('GL-TEST-DEACT-0001');
  assert.equal(store.activations.size, 1);
  const s = await lic.deactivate();
  assert.equal(store.activations.size, 0);
  assert.equal(s.mode, 'trial');
});

test('licence: deactivation that fails offline keeps the licence', async () => {
  const { lic, store } = setup();
  await lic.activate('GL-TEST-DEACT-0002');
  store.deactivate = async () => { throw new StoreError('network', 'offline'); };
  await assert.rejects(lic.deactivate(), (e) => e.kind === 'network');
  assert.equal(lic.status().mode, 'licensed');
});

// --- Polar adapter -----------------------------------------------------------------

function replay(...names) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const f = fixture(names.shift());
    return { ok: f.status >= 200 && f.status < 300, status: f.status, text: async () => JSON.stringify(f.body) };
  };
  return { fetch, calls };
}

test('polar: activate and validate send the right requests and map the response', async () => {
  const { fetch, calls } = replay('activate-200', 'validate-200');
  const store = polarStore(config, { fetch });
  const a = await store.activate({ key: 'GITLANES-6F1C2A9B-4D7E-4B8A-9C3D-2E1F0A9B8C7D', label: 'Test MacBook', meta: { mac: '0123456789abcdef' } });
  assert.equal(calls[0].url, 'https://sandbox-api.polar.sh/v1/customer-portal/license-keys/activate');
  assert.deepEqual(calls[0].body, { organization_id: config.organizationId, key: 'GITLANES-6F1C2A9B-4D7E-4B8A-9C3D-2E1F0A9B8C7D', label: 'Test MacBook', meta: { mac: '0123456789abcdef' } });
  assert.equal(a.activationId, '9b0c5f9e-2a51-4c1e-9d0e-3f6a1b2c4d5e');
  assert.deepEqual(a.licence, { key: 'GITLANES-6F1C2A9B-4D7E-4B8A-9C3D-2E1F0A9B8C7D', displayKey: '****-8C7D', email: 'buyer@example.com', name: 'Test Buyer', limit: 3, benefitId: config.benefitId });
  const v = await store.validate({ key: a.licence.key, activationId: a.activationId });
  assert.equal(calls[1].url, 'https://sandbox-api.polar.sh/v1/customer-portal/license-keys/validate');
  assert.deepEqual(calls[1].body, { organization_id: config.organizationId, key: a.licence.key, activation_id: a.activationId, benefit_id: config.benefitId });
  assert.equal(v.licence.email, 'buyer@example.com');
});

test('polar: errors map to rejected / limit / network', async () => {
  const kind = async (name, call = 'activate') => {
    const store = polarStore(config, replay(name));
    try { await store[call]({ key: 'k', label: 'l', activationId: 'a' }); } catch (e) { return e.kind; }
  };
  assert.equal(await kind('activate-404'), 'rejected');
  assert.equal(await kind('activate-403-limit'), 'limit');
  assert.equal(await kind('validate-404', 'validate'), 'rejected');
  assert.equal(await kind('validate-422', 'validate'), 'invalid');
  const offline = polarStore(config, { fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.validate({ key: 'k', activationId: 'a' }), (e) => e.kind === 'network');
  const down = polarStore(config, { fetch: async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' }) });
  await assert.rejects(down.validate({ key: 'k', activationId: 'a' }), (e) => e.kind === 'network');
});

// A fake fetch returning one raw response.
const raw = (status, body, type = 'application/json') => ({
  fetch: async () => ({ ok: status >= 200 && status < 300, status, headers: { get: () => type }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }),
});

test('polar: only Polar-shaped errors count as rejections; proxies and odd replies are network trouble', async () => {
  const kind = async (res, call = 'validate') => {
    try { await polarStore(config, res)[call]({ key: 'k', label: 'l', activationId: 'a' }); } catch (e) { return e.kind; }
  };
  assert.equal(await kind(raw(403, '<html><body>Forbidden by your network administrator</body></html>', 'text/html')), 'network', 'proxy 403 HTML');
  assert.equal(await kind(raw(403, { message: 'Forbidden' })), 'network', 'JSON 403 without Polar’s shape');
  assert.equal(await kind(raw(404, '<html>Not Found</html>', 'text/html')), 'network', 'captive portal 404');
  assert.equal(await kind(raw(404, { detail: 'Not Found' })), 'network', 'bare 404 from a gateway');
  assert.equal(await kind(raw(400, 'Bad Request', 'text/plain')), 'network');
  assert.equal(await kind(raw(200, '<html>Sign in to Wi-Fi</html>', 'text/html')), 'network', '200 login page');
  assert.equal(await kind(raw(200, { unexpected: true })), 'network', '200 with a changed schema');
  assert.equal(await kind(raw(422, { error: 'RequestValidationError', detail: [{ loc: ['body', 'benefit_id'], msg: 'Extra inputs are not permitted' }] })), 'invalid', 'schema drift');
  assert.equal(await kind(raw(403, { error: 'NotPermitted', detail: 'License key is revoked' })), 'rejected', 'real revocation');
  assert.equal(await kind(raw(404, { error: 'ResourceNotFound', detail: 'Not found' })), 'rejected', 'real unknown key');
});

test('polar: a proxy 403 or a 422 from schema drift keeps the licence; a real revocation marks it revoked', async () => {
  const run = async (res) => {
    let next = replay('activate-200').fetch;
    const store = polarStore(config, { fetch: (...a) => next(...a) });
    const { clock, lic } = setup({ store });
    clock.t = T0 + 20 * DAY;
    await lic.activate('GITLANES-6F1C2A9B-4D7E-4B8A-9C3D-2E1F0A9B8C7D');
    next = res.fetch;
    return lic.refresh();
  };
  let s = await run(raw(403, '<html>Forbidden</html>', 'text/html'));
  assert.equal(s.mode, 'licensed');
  assert.ok(s.licence);
  assert.match(s.lastError, /licence server/);
  s = await run(raw(422, { error: 'RequestValidationError', detail: [{ type: 'missing', loc: ['body', 'new_field'], msg: 'Field required' }] }));
  assert.equal(s.mode, 'licensed');
  assert.ok(s.licence);
  const revoked = fixture('validate-200').body;
  s = await run(raw(200, { ...revoked, status: 'revoked' }));
  assert.equal(s.mode, 'revoked');
  assert.equal(s.licence.maskedKey, 'GITL••••8C7D');
  s = await run(raw(403, { error: 'NotPermitted', detail: 'License key is revoked' }));
  assert.equal(s.mode, 'revoked');
});

test('polar: deactivate accepts an empty 204 reply', async () => {
  const store = polarStore(config, { fetch: async () => ({ ok: true, status: 204, text: async () => '' }) });
  assert.equal(await store.deactivate({ key: 'k', activationId: 'a' }), undefined);
});

test('polar: a key for another product is rejected and its seat is given back', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    const f = fixture('activate-200');
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/activate') ? f.body : null) };
  };
  const store = polarStore({ ...config, benefitId: 'another-benefit' }, { fetch });
  await assert.rejects(store.activate({ key: 'k', label: 'l' }), (e) => e.kind === 'rejected');
  assert.deepEqual(calls.map((u) => u.split('/').pop()), ['activate', 'deactivate']);
});

test('polar: end to end through Licensing with recorded responses', async () => {
  const { fetch } = replay('activate-200', 'validate-404');
  const { clock, lic } = setup({ store: polarStore(config, { fetch }) });
  clock.t = T0 + 20 * DAY;
  assert.equal((await lic.activate('GITLANES-6F1C2A9B-4D7E-4B8A-9C3D-2E1F0A9B8C7D')).mode, 'licensed');
  // Refunded later: the next session's validation 404s.
  const s = await lic.refresh();
  assert.equal(s.mode, 'revoked');
  assert.equal(s.notice.kind, 'revoked');
});

test('config: sandbox by default, profile selectable, production unset until the owner provides it', async () => {
  assert.equal(loadConfig({}).profile, 'sandbox');
  assert.equal(loadConfig({ GITLANES_STORE: 'mock' }).provider, 'mock');
  assert.equal(loadConfig({ GITLANES_STORE: 'bogus' }).profile, 'sandbox');
  const sb = loadConfig({ GITLANES_STORE: 'sandbox' });
  assert.equal(sb.apiBase, 'https://sandbox-api.polar.sh');
  assert.equal(sb.trialDays, 14);
  assert.equal(sb.activationLimit, 3);
  assert.equal(PROFILES.production.apiBase, 'https://api.polar.sh');
  await assert.rejects(polarStore(loadConfig({ GITLANES_STORE: 'production' })).validate({ key: 'k', activationId: 'a' }), (e) => e.kind === 'config');
});

test('config: packaged builds use only the baked profile; the environment and mock never apply', () => {
  const packaged = (env, baked) => loadConfig(env, { packaged: true, baked });
  assert.equal(packaged({ GITLANES_STORE: 'mock' }, 'production').profile, 'production');
  assert.equal(packaged({ GITLANES_STORE: 'mock' }, undefined).profile, 'production', 'no bake: production, never the test store');
  assert.equal(packaged({ GITLANES_STORE: 'sandbox' }, 'production').profile, 'production');
  assert.equal(packaged({ GITLANES_STORE: 'production' }, 'sandbox').profile, 'sandbox');
  assert.equal(packaged({}, 'mock').profile, 'production', 'a baked mock is ignored too');
  assert.equal(packaged({}, 'bogus').profile, 'production');
  for (const env of [{}, { GITLANES_STORE: 'mock' }]) assert.notEqual(packaged(env, 'mock').provider, 'mock');
  // Unpackaged (pnpm start) still follows the environment.
  assert.equal(loadConfig({ GITLANES_STORE: 'mock' }, { packaged: false, baked: 'production' }).provider, 'mock');
});

test('config: release builds fail closed', () => {
  assert.throws(() => releaseProfile('mock'), /can't be packaged/);
  assert.throws(() => releaseProfile('bogus'), /can't be packaged/);
  assert.throws(() => releaseProfile('production'), /isn't filled in/, 'until the owner provides production values');
  assert.equal(releaseProfile('sandbox'), 'sandbox');
});

test('beta: packaged with no licence, no trial and no store calls', async () => {
  assert.equal(releaseProfile('beta'), 'beta');
  const beta = loadConfig({}, { packaged: true, baked: 'beta' });
  assert.equal(beta.profile, 'beta');
  assert.equal(loadConfig({ GITLANES_STORE: 'beta' }).profile, 'beta', 'pnpm start can try it too');
  // The real store factory, with a fetch that records every call.
  const calls = [];
  const fetch = async (url) => { calls.push(url); throw new Error('no network'); };
  const store = createStore(beta, { fetch });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-licence-'));
  const files = { stateFile: path.join(dir, 'licence.json'), mirrorFile: path.join(dir, 'trial') };
  let t = T0;
  const lic = new Licensing({ ...files, config: beta, store, machine: 'mac-A', now: () => t });
  const s = lic.status();
  assert.equal(s.mode, 'beta');
  assert.equal(s.canMutate, true);
  assert.equal(s.licence, null);
  assert.equal(s.checkoutUrl, null);
  t += 400 * DAY; // never expires
  assert.equal(lic.status().canMutate, true);
  assert.equal(await lic.ensureCanMutate(), true);
  assert.equal(lic.maybeRefresh(), null);
  assert.equal((await lic.refresh()).mode, 'beta');
  await assert.rejects(lic.activate('GL-TEST-1'), (e) => e instanceof StoreError && e.kind === 'config');
  await assert.rejects(store.validate({ key: 'k', activationId: 'a' }), (e) => e.kind === 'config');
  assert.deepEqual(calls, [], 'no request to the store');
  assert.ok(!fs.existsSync(files.stateFile) && !fs.existsSync(files.mirrorFile), 'no trial clock written');
});

test('beta: updates come from the beta bucket; other profiles use package.json', () => {
  const { feedUrl, feedOrigins } = require('../updater');
  const { updates } = PROFILES.beta;
  assert.equal(updates.feed, 'https://pub-1b56c7c361874048ab3f67ebe6cdac1b.r2.dev/beta');
  assert.equal(updates.page, 'https://gitlanes.akml.io/download');
  assert.equal(feedUrl(updates.feed, 'arm64'), 'https://pub-1b56c7c361874048ab3f67ebe6cdac1b.r2.dev/beta/update-mac-arm64.json');
  assert.deepEqual(feedOrigins(feedUrl(updates.feed, 'x64')), ['https://pub-1b56c7c361874048ab3f67ebe6cdac1b.r2.dev']);
  for (const name of ['production', 'sandbox', 'mock']) assert.equal(PROFILES[name].updates, undefined, name);
});
