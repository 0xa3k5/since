'use strict';
// Trial clock, licence validation and the Polar adapter. No network: Polar is replayed from fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Licensing, DAY } = require('../licence');
const { polarStore, mockStore, StoreError } = require('../licence/stores');
const { loadConfig, PROFILES } = require('../licence/config');

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

test('licence: a revoked or refunded key goes back to read-only with a notice', async () => {
  const { clock, lic } = setup();
  clock.t = T0 + 20 * DAY;
  await lic.activate('GL-TEST-REVOKED-0001');
  const s = await lic.refresh();
  assert.equal(s.mode, 'expired');
  assert.equal(s.licence, null);
  assert.equal(s.notice.kind, 'revoked');
  lic.dismissNotice();
  assert.equal(lic.status().notice, null);
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
  assert.equal(await kind('validate-422', 'validate'), 'rejected');
  const offline = polarStore(config, { fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.validate({ key: 'k', activationId: 'a' }), (e) => e.kind === 'network');
  const down = polarStore(config, { fetch: async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' }) });
  await assert.rejects(down.validate({ key: 'k', activationId: 'a' }), (e) => e.kind === 'network');
});

test('polar: a key for another product is rejected', async () => {
  const store = polarStore({ ...config, benefitId: 'another-benefit' }, replay('activate-200'));
  await assert.rejects(store.activate({ key: 'k', label: 'l' }), (e) => e.kind === 'rejected');
});

test('polar: end to end through Licensing with recorded responses', async () => {
  const { fetch } = replay('activate-200', 'validate-404');
  const { clock, lic } = setup({ store: polarStore(config, { fetch }) });
  clock.t = T0 + 20 * DAY;
  assert.equal((await lic.activate('GITLANES-6F1C2A9B-4D7E-4B8A-9C3D-2E1F0A9B8C7D')).mode, 'licensed');
  // Refunded later: the next session's validation 404s.
  const s = await lic.refresh();
  assert.equal(s.mode, 'expired');
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
